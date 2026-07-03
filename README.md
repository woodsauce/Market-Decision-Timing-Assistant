# Edge15 Entry Minute 9

BTC 15-minute prediction-market decision assistant.

## Version file

`edge15-entry-minute-9.zip`

## What is new in version 9

- Entry Minute Tracker.
- Best Money Window estimate.
- 6m Priority Mode.
- Top profiles first: Balanced, Aggressive, No Chase.
- Best entry minute shown in completed ladders.
- Compact Timing Engine and Learning Engine remain.
- Trade Panel and Kalshi/API loader remain removed.

## Core flow

1. Live Coinbase BTC feed loads.
2. Coinbase Predictions target/time auto-loads when available.
3. Local 15-minute fallback runs if Coinbase Predictions cannot load.
4. Decision engine tracks raw signal and locked prediction.
5. Entry Minute Tracker records 15m through 1m snapshots.
6. Completed ladders are auto-scored after each 15-minute period.

## Deploy settings on Vercel

Use these settings:

- Framework Preset: Other
- Build Command: blank
- Output Directory: .
- Install Command: npm install
- Root Directory: ./

## Run tests

```bash
npm test
```

## Notes

This app does not place real trades. It is a decision and tracking assistant.
