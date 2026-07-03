# Edge15 Decision Engine

A ground-up BTC 15-minute prediction-market decision assistant designed for GitHub + Vercel.

## What it does

- Streams live BTC-USD from Coinbase Advanced Trade WebSocket.
- Updates the dashboard continuously, with a decision refresh cadence set to 3 seconds by default.
- Builds a 12m / 10m / 8m / 6m / 4m / 2m decision ladder.
- Tracks wins, losses, skipped trades, profile performance, checkpoint decisions, and result history in browser storage.
- Includes Kalshi market and orderbook proxy functions at `/api/kalshi/markets` and `/api/kalshi/orderbook`.
- Includes a heavily gated Kalshi live-order endpoint that is disabled by default.
- Includes manual fallback controls: use current BTC as target, start a fresh 15-minute timer, and reset the ladder.

## Deploy on Vercel

1. Upload this folder to GitHub.
2. In Vercel, import the GitHub repo.
3. Framework preset: **Other**.
4. Build command: leave blank, or use `npm run vercel-build`.
5. Output directory: `.`
6. Root directory: `./` unless the files are nested in another folder.
7. Deploy.

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
2. Click **Use current BTC as target** to test the decision engine manually, or load/select a Kalshi market to infer the real target.
3. Click **Start 15m timer** for a manual session if no Kalshi close time is loaded.
4. Let the ladder run through checkpoints.
5. Use **Paper trade**, **Record decision**, or **Record skip**.
6. Mark each record as Win/Loss/Skip when the market closes.

## Tests

```bash
npm test
```

The included tests verify the decision engine, checkpoints, tracker settlement, Kalshi signature helper, and Kalshi API route normalization without touching real money.

## Safety notes

This is a decision assistant, not a guarantee. It should be used with manual review, position limits, and paper tracking before live orders.
