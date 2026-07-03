import test from 'node:test';
import assert from 'node:assert/strict';
import marketsHandler from '../api/kalshi/markets.mjs';
import orderbookHandler from '../api/kalshi/orderbook.mjs';
import { filterMarkets, normalizeOrderbook } from '../api/kalshi/shared.mjs';

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('filters bitcoin 15-minute markets locally', () => {
  const markets = [
    { ticker: 'BTC-15-1', title: 'Bitcoin price above $100,000 in 15 minutes' },
    { ticker: 'ETH-15-1', title: 'Ethereum price above $3,000 in 15 minutes' },
    { ticker: 'BTC-DAY', title: 'Bitcoin daily close' }
  ];
  const filtered = filterMarkets(markets, 'bitcoin 15');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].ticker, 'BTC-15-1');
});

test('normalizes orderbook prices', () => {
  const normalized = normalizeOrderbook({ orderbook: { yes: [[61, 10], [64, 2]], no: [[35, 1], [37, 2]] } });
  assert.equal(normalized.yesPrice, 64);
  assert.equal(normalized.noPrice, 37);
});

test('markets API route returns filtered results from mocked Kalshi response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ markets: [
    { ticker: 'BTC-15-1', title: 'Bitcoin price above $100,000 in 15 minutes', status: 'open' },
    { ticker: 'ETH-15-1', title: 'Ethereum price above $3,000 in 15 minutes', status: 'open' }
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const req = { method: 'GET', url: '/api/kalshi/markets?search=bitcoin%2015&limit=10', headers: { host: 'example.test' } };
    const res = makeResponse();
    await marketsHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.markets[0].ticker, 'BTC-15-1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('orderbook API route returns normalized book from mocked Kalshi response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ orderbook: { yes: [[60, 3], [62, 1]], no: [[38, 1]] } }), { status: 200 });
  try {
    const req = { method: 'GET', url: '/api/kalshi/orderbook?ticker=BTC-15-1', headers: { host: 'example.test' } };
    const res = makeResponse();
    await orderbookHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.orderbook.yesPrice, 62);
    assert.equal(res.body.orderbook.noPrice, 38);
  } finally {
    global.fetch = originalFetch;
  }
});
