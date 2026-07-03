import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoinbasePredictionPage, parseKx15mCloseTime, nextQuarterHour } from '../lib/coinbase-predictions.mjs';

test('parses Coinbase BTC 15-minute target and prices from listing text', () => {
  const html = `
    <a href="/predictions/event/KXBTC15M-26JUL030100">BTC 15 min · $61,241.48 target</a>
    <span>Yes · 34%</span><span>No · 67%</span><span>$1,012,798 vol</span>
  `;
  const now = Date.UTC(2026, 6, 3, 0, 50, 0);
  const parsed = parseCoinbasePredictionPage(html, now);
  assert.equal(parsed.targetPrice, 61241.48);
  assert.equal(parsed.yesPrice, 34);
  assert.equal(parsed.noPrice, 67);
  assert.equal(parsed.ticker, 'KXBTC15M-26JUL030100');
  assert.equal(parsed.closeTime, '2026-07-03T01:00:00.000Z');
  assert.equal(parsed.closeTimeSource, 'ticker');
});

test('derives next quarter-hour close if ticker is absent', () => {
  const html = 'BTC 15 min · $61,241.48 target Yes · 81% No · 20%';
  const now = Date.UTC(2026, 6, 3, 0, 47, 0);
  const parsed = parseCoinbasePredictionPage(html, now);
  assert.equal(parsed.targetPrice, 61241.48);
  assert.equal(parsed.ticker, null);
  assert.equal(parsed.closeTime, '2026-07-03T01:00:00.000Z');
  assert.equal(parsed.closeTimeSource, 'derived_next_15m_boundary');
});

test('parses KXBTC15M ticker close time as UTC', () => {
  assert.equal(new Date(parseKx15mCloseTime('KXBTC15M-26APR061800')).toISOString(), '2026-04-06T18:00:00.000Z');
});

test('nextQuarterHour skips boundary if already at edge', () => {
  const now = Date.UTC(2026, 6, 3, 1, 0, 0);
  assert.equal(new Date(nextQuarterHour(now)).toISOString(), '2026-07-03T01:15:00.000Z');
});
