export default async function handler(req, res) {
  try {
    if (req.method && req.method !== 'GET') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const granularity = clampNumber(Number(url.searchParams.get('granularity') || 60), 60, 900);
    const minutes = clampNumber(Number(url.searchParams.get('minutes') || 90), 15, 240);
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - minutes * 60;
    const endpoint = new URL('https://api.exchange.coinbase.com/products/BTC-USD/candles');
    endpoint.searchParams.set('granularity', String(granularity));
    endpoint.searchParams.set('start', new Date(startSec * 1000).toISOString());
    endpoint.searchParams.set('end', new Date(endSec * 1000).toISOString());

    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        'user-agent': 'edge15-decision-engine/1.0'
      }
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(data)) {
      return res.status(response.status || 502).json({
        ok: false,
        error: data?.message || data?.error || 'Coinbase candle request failed'
      });
    }

    const candles = data.map((row) => ({
      time: Number(row[0]),
      ts: Number(row[0]) * 1000,
      low: Number(row[1]),
      high: Number(row[2]),
      open: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    })).filter((candle) => Number.isFinite(candle.ts) && Number.isFinite(candle.close))
      .sort((a, b) => a.ts - b.ts);

    return res.status(200).json({ ok: true, source: 'coinbase_exchange_candles', granularity, candles });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Unexpected candle route error' });
  }
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
