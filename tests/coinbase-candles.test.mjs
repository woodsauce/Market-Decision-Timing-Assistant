import test from 'node:test';
import assert from 'node:assert/strict';
import candlesHandler from '../api/coinbase/candles.mjs';

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('Coinbase candles route normalizes candle arrays', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify([
    [1783008000, 100, 110, 101, 108, 4],
    [1783007940, 98, 105, 100, 102, 3]
  ]), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const req = { method: 'GET', url: '/api/coinbase/candles?granularity=60&minutes=90', headers: { host: 'example.test' } };
    const res = makeResponse();
    await candlesHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.candles.length, 2);
    assert.equal(res.body.candles[0].close, 102);
    assert.equal(res.body.candles[1].close, 108);
  } finally {
    global.fetch = originalFetch;
  }
});
