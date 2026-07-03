import { kalshiFetch, parseUrl, sendJson, uuid } from './shared.mjs';

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on?.('data', (chunk) => { raw += chunk; });
    request.on?.('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    request.on?.('error', reject);
    if (!request.on) resolve(request.body || {});
  });
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return sendJson(response, 405, { ok: false, error: 'Method not allowed' });
  }
  if (process.env.KALSHI_TRADING_ENABLED !== 'true') {
    return sendJson(response, 403, {
      ok: false,
      error: 'Live Kalshi trading is disabled. Set KALSHI_TRADING_ENABLED=true only after paper testing.'
    });
  }
  if (request.headers?.['x-edge15-live-confirm'] !== 'I_UNDERSTAND_REAL_MONEY_RISK') {
    return sendJson(response, 403, { ok: false, error: 'Missing live-trading confirmation header.' });
  }

  let body;
  try { body = await readBody(request); }
  catch { return sendJson(response, 400, { ok: false, error: 'Invalid JSON body' }); }

  const ticker = String(body.ticker || '').trim();
  const side = body.side === 'ask' ? 'ask' : 'bid';
  const count = Number(body.count || 1);
  const price = Number(body.price || 0);
  const timeInForce = body.time_in_force || 'immediate_or_cancel';
  if (!ticker) return sendJson(response, 400, { ok: false, error: 'Missing ticker' });
  if (!Number.isFinite(count) || count <= 0) return sendJson(response, 400, { ok: false, error: 'Invalid count' });
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return sendJson(response, 400, { ok: false, error: 'Invalid price. Use decimal dollars such as 0.7600.' });

  const order = {
    action: 'buy',
    client_order_id: body.client_order_id || uuid(),
    count,
    side,
    ticker,
    type: 'limit',
    yes_price: Math.round(price * 100),
    time_in_force: timeInForce
  };

  try {
    const data = await kalshiFetch('/portfolio/orders', {
      method: 'POST',
      bodyObj: order,
      authenticated: true
    });
    return sendJson(response, 200, { ok: true, order: data, sent: order });
  } catch (error) {
    return sendJson(response, error.status || 500, {
      ok: false,
      error: error.message || 'Kalshi order failed',
      sent: order,
      details: error.data || null
    });
  }
}
