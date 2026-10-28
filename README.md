# Zilla Pine Runner

Runs a Pine Script® `strategy()` (v5 or v6) on the candles it receives, with
[PineTS](https://www.npmjs.com/package/pinets) by LuxAlgo, and returns only data:
closed and open trades, pending exit orders (stop loss / take profit), position and stats.

This service is isolated on purpose: it holds **no trading keys, no database access and no wallet**.
It only computes. Zilla Engine sends the script and the candles, then decides what to do with the result.

## API

`POST /api/run` with header `x-runner-token: <RUNNER_TOKEN>`

```json
{
  "code": "//@version=6\nstrategy(\"My strategy\") ...",
  "timeframe": "15",
  "symbol": "BTC",
  "mintick": 1,
  "candles": [{ "t": 1761000000000, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1 }]
}
```

Timeframes: `1`, `5`, `15`, `30`, `60`, `240`, `1D`. Between 50 and 5,000 candles.

## Safety rules

- Only real Pine Script v5/v6 is accepted (a single `//@version=5` or `//@version=6` line).
  The PineTS JavaScript syntax is refused.
- No `import` of external libraries (they would be downloaded from the internet).
- Market data comes only from the request: the script cannot fetch anything.
- 25 second time limit per run.

## Deploy

Vercel project from this repository, with one environment variable: `RUNNER_TOKEN`.

## License

GNU AGPL-3.0, like PineTS. "Pine Script" and "TradingView" are trademarks of TradingView, Inc.
This project is not affiliated with TradingView or LuxAlgo.
