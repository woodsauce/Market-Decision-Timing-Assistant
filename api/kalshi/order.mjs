import crypto from 'node:crypto';
import { kalshiBaseUrl, kalshiHeaders } from '../../lib/kalshi-signing.mjs';

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  response.status(status).json(payload);
}

function validSide(side) {
  return side === 'bid' || side === 'ask';
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
  if (Buffer.isBuffer(request.body)) return JSON.parse(request.body.toString('utf8') || '{}');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    if (process.env.KALSHI_TRADING_ENABLED !== 'true') {
      return send(response, 403, {
        ok: false,
        error: 'Live Kalshi trading is disabled. Set KALSHI_TRADING_ENABLED=true only after paper testing.'
      });
    }

    const liveConfirm = request.headers['x-edge15-live-confirm'];
    if (liveConfirm !== 'I_UNDERSTAND_REAL_MONEY_RISK') {
      return send(response, 403, {
        ok: false,
        error: 'Missing live-trade confirmation header.'
      });
    }

    const body = await readJsonBody(request);
    const ticker = String(body.ticker || '').trim();
    const side = String(body.side || '').trim();
    const count = String(body.count || '').trim();
    const price = String(body.price || '').trim();

    if (!ticker || !validSide(side) || !count || !price) {
      return send(response, 400, { ok: false, error: 'ticker, side, count, and price are required.' });
    }

    const payload = {
      ticker,
      client_order_id: body.client_order_id || crypto.randomUUID(),
      side,
      count,
      price,
      time_in_force: body.time_in_force || 'immediate_or_cancel',
      self_trade_prevention_type: body.self_trade_prevention_type || 'taker_at_cross',
      post_only: Boolean(body.post_only || false),
      cancel_order_on_pause: Boolean(body.cancel_order_on_pause || true),
      reduce_only: Boolean(body.reduce_only || false)
    };

    const path = '/portfolio/events/orders';
    const method = 'POST';
    const upstream = await fetch(`${kalshiBaseUrl()}${path}`, {
      method,
      headers: kalshiHeaders({ method, path }),
      body: JSON.stringify(payload)
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return send(response, upstream.status, { ok: false, error: 'Kalshi order failed', detail: data });
    }
    send(response, 200, { ok: true, order: data, submitted: payload });
  } catch (error) {
    send(response, 500, { ok: false, error: error.message });
  }
}
