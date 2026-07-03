# Edge15 Decision Engine

A ground-up BTC 15-minute prediction-market decision assistant designed for GitHub + Vercel.

## What it does

- Streams live BTC-USD from Coinbase Advanced Trade WebSocket.
- Updates the dashboard continuously, with a decision refresh cadence set to 3 seconds by default.
- Builds a 12m / 10m / 8m / 6m / 4m / 2m decision ladder.
- Tracks wins, losses, skipped trades, profile performance, checkpoint decisions, and result history in browser storage.
- Includes Kalshi public market and orderbook proxy functions.
- Includes a heavily gated Kalshi live-order endpoint that is disabled by default.

## Deploy on Vercel

1. Upload this folder to GitHub, ideally your existing repo:

```bash
git init
git remote add origin https://github.com/woodsauce/edge15.git
git add .
git commit -m "Genesis Edge15 decision engine"
git branch -M main
git push -u origin main
```

2. In Vercel, import `woodsauce/edge15`.
3. Framework preset: Other.
4. Build command: leave blank or use `npm run vercel-build`.
5. Output directory: leave blank.
6. Deploy.

## Optional Kalshi environment variables

Public market/orderbook routes work without API keys. Live trading requires all of these:

```bash
KALSHI_API_BASE=https://external-api.kalshi.com/trade-api/v2
KALSHI_ACCESS_KEY=your_key_id
KALSHI_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
KALSHI_TRADING_ENABLED=false
```

Keep `KALSHI_TRADING_ENABLED=false` until you have tested everything in demo or paper mode.

## Tests

```bash
npm test
```

The included tests verify the decision engine, checkpoints, tracker settlement, and Kalshi signature helper without touching real money.

## Safety notes

This is a decision assistant, not a guarantee. It should be used with manual review, position limits, and paper tracking before live orders.


## Vercel runtime fix

This project intentionally does **not** set `functions.runtime` in `vercel.json`. Vercel automatically detects Node.js functions inside `/api`. Set the Node.js major version in the Vercel project settings if needed.
