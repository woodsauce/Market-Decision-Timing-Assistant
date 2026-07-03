# Edge15 Tracker Lock 10

BTC 15-minute prediction-market decision assistant.

## Version file

`edge15-tracker-lock-10.zip`

## What is new in version 10

- Performance Tracker now counts official tracker-locked calls only.
- No official lock = skipped.
- Each completed ladder shows lock source minute and lock type.
- Main auto record includes lock minute, profile, source, confidence, flip risk, and final result.
- Live market chart now shows about 5 minutes instead of a few seconds.
- Keeps Entry Minute Tracker, 6m Priority Mode, Timing Engine, Learning Engine, last 10 ladders, and checkpoint accuracy.

## Tracker rule

A prediction is counted in Performance Tracker only after the app creates an official tracker lock.
The main lock is biased toward the 6-minute window, with early/late locks allowed only when the signal is strong enough.

## Deploy settings on Vercel

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
