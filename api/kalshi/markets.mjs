import { filterMarkets, kalshiPublicFetch, normalizeMarkets, parseUrl, sendJson } from './shared.mjs';

export default async function handler(request, response) {
  if (request.method && request.method !== 'GET') {
    return sendJson(response, 405, { ok: false, error: 'Method not allowed' });
  }
  const url = parseUrl(request);
  const search = url.searchParams.get('search') || '';
  const status = url.searchParams.get('status') || 'open';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 500), 1), 1000);
  const cursor = url.searchParams.get('cursor') || '';
  const params = new URLSearchParams({ status, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);

  try {
    const data = await kalshiPublicFetch(`/markets?${params.toString()}`);
    const markets = normalizeMarkets(data);
    const filtered = filterMarkets(markets, search).slice(0, 50);
    return sendJson(response, 200, {
      ok: true,
      count: filtered.length,
      markets: filtered,
      cursor: data.cursor || data.next_cursor || null,
      sourceCount: markets.length
    });
  } catch (error) {
    return sendJson(response, error.status || 500, {
      ok: false,
      error: error.message || 'Kalshi markets request failed',
      details: error.data || null
    });
  }
}
