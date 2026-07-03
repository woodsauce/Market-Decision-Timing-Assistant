import { kalshiBaseUrl } from '../../lib/kalshi-signing.mjs';

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  response.status(status).json(payload);
}

export default async function handler(request, response) {
  try {
    const url = new URL(request.url, `https://${request.headers.host || 'edge15.local'}`);
    const ticker = url.searchParams.get('ticker');
    if (!ticker) return send(response, 400, { ok: false, error: 'Missing ticker' });
    const path = `/markets/${encodeURIComponent(ticker)}/orderbook`;
    const upstream = await fetch(`${kalshiBaseUrl()}${path}`, { headers: { Accept: 'application/json' } });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return send(response, upstream.status, { ok: false, error: 'Kalshi orderbook request failed', detail: payload });
    }
    send(response, 200, { ok: true, ...payload });
  } catch (error) {
    send(response, 500, { ok: false, error: error.message });
  }
}
