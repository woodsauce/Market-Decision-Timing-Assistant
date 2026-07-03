# Edge15 Decision Engine

A ground-up BTC 15-minute prediction-market decision assistant designed for GitHub + Vercel.

## What it does

- Streams live BTC-USD from Coinbase Advanced Trade WebSocket.
- Auto-loads the current Coinbase Predictions BTC 15-minute target and countdown through `/api/coinbase/prediction-btc`, with a local 15-minute Coinbase BTC fallback if the public page cannot be read.
- Updates the dashboard continuously, with a decision refresh cadence set to 3 seconds by default and a rolling signal-history lock to reduce Skip/Over/Under flicker.
- Builds a 12m / 10m / 8m / 6m / 4m / 2m decision ladder.
- Tracks wins, losses, skipped trades, profile performance, checkpoint decisions, and result history in browser storage.
- Preloads recent Coinbase 1-minute candles through `/api/coinbase/candles` so the assistant has startup context instead of waiting several minutes for live ticks only.
- Keeps optional Kalshi market and orderbook proxy functions at `/api/kalshi/markets` and `/api/kalshi/orderbook` for API testing.
- Includes a heavily gated optional live-order endpoint that is disabled by default.
- Includes manual fallback controls: use current BTC as target, start a fresh 15-minute timer, and reset the ladder.

## Deploy on Vercel

1. Upload this folder to GitHub.
2. In Vercel, import the GitHub repo.
3. Framework preset: **Other**.
4. Build command: leave blank, or use `npm run vercel-build`.
5. Output directory: `.`
6. Root directory: `./` unless the files are nested in another folder.
7. Deploy.

## Coinbase Predictions auto-load

No Coinbase key is required for the auto target/time loader. The Vercel function reads Coinbase public prediction pages and extracts the BTC 15-minute target, Yes/No percentages, and close time when available. If Coinbase changes the page structure or blocks public access, the app now falls back to a local 15-minute Coinbase BTC window. That fallback freezes the target from the first BTC tick/candle available in the active 15-minute window and counts down to the next 15-minute boundary. Manual target/timer controls remain available as a last fallback.

Coinbase Predictions order execution is not enabled in this package because Coinbase does not expose a clearly documented public prediction-market trading API in the standard Coinbase Advanced Trade API. Use Coinbase manually for real entries unless/until an official prediction-market trading API is available.

## Optional Kalshi environment variables

Public market/orderbook routes are attempted without API keys. Live trading requires all of these:

```bash
KALSHI_API_BASE=https://api.elections.kalshi.com/trade-api/v2
KALSHI_API_KEY_ID=your_key_id
KALSHI_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
KALSHI_TRADING_ENABLED=false
```

Keep `KALSHI_TRADING_ENABLED=false` until you have tested everything in paper/manual mode. If Kalshi public routes fail because the base URL changes, set `KALSHI_API_BASE` in Vercel to the current Kalshi trade API base URL and redeploy.

## First-use checklist

1. Wait until the Coinbase status says live and BTC-USD is updating.
2. Wait for **Predictions: auto**. The target and countdown should fill themselves.
3. If auto-load fails, click **Refresh Coinbase target/time**, or use **Use current BTC as target** and **Start 15m timer** as manual fallback.
4. Let the ladder run through checkpoints.
5. Use **Paper trade**, **Record decision**, or **Record skip**.
6. Mark each record as Win/Loss/Skip when the market closes.

## Tests

```bash
npm test
```

The included tests verify the decision engine, checkpoints, tracker settlement, Coinbase Predictions parser, Coinbase candle route, Kalshi signature helper, and Kalshi API route normalization without touching real money.

## Safety notes

This is a decision assistant, not a guarantee. It should be used with manual review, position limits, and paper tracking before live orders.
