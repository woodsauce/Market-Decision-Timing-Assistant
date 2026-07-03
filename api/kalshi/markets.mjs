import { kalshiBaseUrl } from '../../lib/kalshi-signing.mjs';

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  response.status(status).json(payload);
}

function textMatch(market, search) {
  if (!search) return true;
  const haystack = [
    market.ticker,
    market.market_ticker,
    market.title,
    market.subtitle,
    market.event_ticker,
    market.series_ticker,
    market.category,
    market.rules_primary,
    market.rules_secondary
  ].filter(Boolean).join(' ').toLowerCase();
  return search.toLowerCase().split(/\s+/).every((part) => haystack.includes(part));
}

export default async function handler(request, response) {
  try {
    const url = new URL(request.url, `https://${request.headers.host || 'edge15.local'}`);
    const status = url.searchParams.get('status') || 'open';
    const limit = url.searchParams.get('limit') || '200';
    const search = url.searchParams.get('search') || 'bitcoin btc 15';
    const seriesTicker = url.searchParams.get('series_ticker') || '';
    const params = new URLSearchParams({ status, limit });
    if (seriesTicker) params.set('series_ticker', seriesTicker);
    const kalshiUrl = `${kalshiBaseUrl()}/markets?${params.toString()}`;
    const upstream = await fetch(kalshiUrl, { headers: { Accept: 'application/json' } });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return send(response, upstream.status, { ok: false, error: 'Kalshi markets request failed', detail: payload });
    }
    const markets = Array.isArray(payload.markets) ? payload.markets : [];
    const filtered = markets.filter((market) => textMatch(market, search));
    send(response, 200, { ok: true, count: filtered.length, markets: filtered, rawCount: markets.length });
  } catch (error) {
    send(response, 500, { ok: false, error: error.message });
  }
}
