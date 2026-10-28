// ─────────────────────────────────────────────────────────────────────────
// ZILLA PINE RUNNER
// Exécute une stratégie Pine Script® (strategy()) sur des bougies fournies,
// grâce à PineTS (AGPL-3.0), et renvoie UNIQUEMENT des données :
// trades, ordres de sortie en attente (stop / take profit), position, statistiques.
//
// Ce service est volontairement isolé : il ne possède AUCUNE clé de trading,
// aucun accès à une base de données ni à un wallet. Il ne fait que calculer.
// Licence : AGPL-3.0 (voir LICENSE).
// ─────────────────────────────────────────────────────────────────────────
import { PineTS } from "pinets";

export const config = { maxDuration: 60 };

const MAX_CODE = 100_000;     // caractères
const MAX_BARS = 5_000;
const TIMEOUT_MS = 25_000;

function bad(res, status, error) {
  res.status(status).json({ ok: false, error });
}

// Bougies validées : { t, o, h, l, c, v } → format PineTS
function toKlines(raw, stepMs) {
  if (!Array.isArray(raw) || raw.length < 50 || raw.length > MAX_BARS) return null;
  const out = [];
  for (const k of raw) {
    const t = Number(k?.t), o = Number(k?.o), h = Number(k?.h), l = Number(k?.l), c = Number(k?.c), v = Number(k?.v ?? 0);
    if (![t, o, h, l, c, v].every(Number.isFinite) || h < l) return null;
    out.push({ openTime: t, open: o, high: h, low: l, close: c, volume: v, closeTime: t + stepMs - 1,
      quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

const TF = { "1": 60_000, "5": 300_000, "15": 900_000, "30": 1_800_000, "60": 3_600_000, "240": 14_400_000, "1D": 86_400_000 };

const tradeOut = (t) => ({
  entry_id: t.entry_id, exit_id: t.exit_id ?? null,
  side: t.size >= 0 ? "long" : "short", size: Math.abs(t.size),
  entry_price: t.entry_price, exit_price: t.exit_price ?? null,
  entry_bar: t.entry_bar_index, exit_bar: t.exit_bar_index ?? null,
  entry_time: t.entry_time, exit_time: t.exit_time ?? null,
  profit: t.profit ?? null, commission: t.commission ?? null,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return bad(res, 405, "POST only");
  // Jeton partagé avec Zilla : évite que n'importe qui utilise le service (ce n'est pas une clé de trading)
  const token = process.env.RUNNER_TOKEN;
  if (!token || req.headers["x-runner-token"] !== token) return bad(res, 401, "Unauthorized");

  const body = req.body || {};
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim() || code.length > MAX_CODE) return bad(res, 400, "Missing or too long script.");
  // SÉCURITÉ : PineTS accepte aussi du JavaScript. On n'accepte QUE du vrai Pine Script v5/v6,
  // traduit par son transpileur (qui refuse tout ce qui n'existe pas en Pine : process, this…).
  const versions = [...code.matchAll(/@version\s*=\s*(\d+)/gi)].map((m) => m[1]);
  if (versions.length !== 1 || !["5", "6"].includes(versions[0]) || !/^\s*\/\/\s*@version\s*=\s*[56]\s*$/m.test(code)) {
    return bad(res, 400, "Start the script with //@version=5 or //@version=6 (Pine Script only).");
  }
  if (/@PineTS/i.test(code)) return bad(res, 400, "Pine Script only.");
  if (!/^\s*strategy\s*\(/m.test(code)) return bad(res, 400, "The script must be a strategy(): use strategy.entry() and strategy.exit().");
  // Pas de bibliothèque externe : elle serait téléchargée depuis internet
  if (/^\s*import\s+/m.test(code)) return bad(res, 400, "Libraries (import) are not supported yet.");

  const stepMs = TF[body.timeframe];
  if (!stepMs) return bad(res, 400, "Unknown timeframe.");
  const klines = toKlines(body.candles, stepMs);
  if (!klines) return bad(res, 400, `Send between 50 and ${MAX_BARS} valid candles.`);
  const symbol = typeof body.symbol === "string" && /^[A-Za-z0-9]{1,20}$/.test(body.symbol) ? body.symbol : "ASSET";
  const mintick = Number(body.mintick) > 0 ? Number(body.mintick) : 0.0001;

  // Fournisseur de données « fermé » : seulement les bougies reçues, rien depuis internet
  const provider = {
    configure() {},
    async getMarketData(ticker, timeframe) {
      return ticker === symbol && String(timeframe) === String(body.timeframe) ? klines : [];
    },
    async getSymbolInfo(ticker) {
      return {
        ticker, tickerid: `HYPERLIQUID:${ticker}`, prefix: "HYPERLIQUID", root: ticker, description: ticker,
        type: "crypto", currency: "USD", basecurrency: ticker, timezone: "Etc/UTC", session: "24x7",
        mintick, minmove: 1, pricescale: Math.round(1 / mintick), pointvalue: 1, mincontract: 0, volumetype: "base",
      };
    },
  };

  const started = Date.now();
  try {
    const run = new PineTS(provider, symbol, body.timeframe, klines.length).run(code);
    const ctx = await Promise.race([
      run,
      new Promise((_, rej) => setTimeout(() => rej(new Error("Script took too long to run.")), TIMEOUT_MS)),
    ]);
    const st = ctx.strategy;
    if (!st) return bad(res, 400, "No strategy results: is it a strategy() script?");

    const lastBar = klines.length - 1;
    res.status(200).json({
      ok: true,
      ms: Date.now() - started,
      bars: klines.length,
      last_bar: lastBar,
      last_time: klines[lastBar].openTime,
      position: {
        size: st.position_size || 0,
        avg_price: st.position_avg_price || null,
        entry_name: st.position_entry_name || null,
      },
      // Ordres encore en attente à la fin : c'est là que se trouvent le stop et les TP actuels
      pending: (st.pending_orders || []).filter((o) => o.status === "pending").map((o) => ({
        id: o.id, category: o.category || null, type: o.type, direction: o.direction,
        limit: Number.isFinite(o.limit) ? o.limit : null,
        stop: Number.isFinite(o.stop) ? o.stop : null,
        qty: o.qty || 0, qty_percent: o.qty_percent ?? null, from_entry: o.from_entry || null,
        trail_points: o.trail_points ?? null, trail_offset: o.trail_offset ?? null,
      })),
      open_trades: (st.opentrades || []).map(tradeOut),
      closed_trades: (st.closedtrades || []).slice(-500).map(tradeOut),
      stats: {
        net_profit: st.netprofit ?? 0,
        gross_profit: st.grossprofit ?? 0,
        gross_loss: st.grossloss ?? 0,
        max_drawdown: st.max_drawdown ?? 0,
        initial_capital: st.initial_capital ?? null,
        buy_and_hold_pct: st.buy_and_hold_per_gain ?? null,
      },
    });
  } catch (err) {
    bad(res, 400, `Script error: ${String(err?.message || err).slice(0, 300)}`);
  }
}
