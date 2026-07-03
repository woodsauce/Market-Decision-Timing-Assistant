import { kalshiPublicFetch, normalizeOrderbook, parseUrl, sendJson } from './shared.mjs';

export default async function handler(request, response) {
  if (request.method && request.method !== 'GET') {
    return sendJson(response, 405, { ok: false, error: 'Method not allowed' });
  }
  const url = parseUrl(request);
  const ticker = (url.searchParams.get('ticker') || '').trim();
  if (!ticker) return sendJson(response, 400, { ok: false, error: 'Missing ticker' });

  try {
    const data = await kalshiPublicFetch(`/markets/${encodeURIComponent(ticker)}/orderbook`);
    const orderbook = normalizeOrderbook(data);
    return sendJson(response, 200, { ok: true, ticker, orderbook });
  } catch (error) {
    return sendJson(response, error.status || 500, {
      ok: false,
      error: error.message || 'Kalshi orderbook request failed',
      details: error.data || null
    });
  }
}
