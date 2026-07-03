import { readFileSync } from 'node:fs';
import { createSign, randomUUID } from 'node:crypto';

export const DEFAULT_KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
export const FALLBACK_KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2';

export function getKalshiBase() {
  return (process.env.KALSHI_API_BASE || DEFAULT_KALSHI_BASE).replace(/\/$/, '');
}

export function sendJson(response, status, payload) {
  response.status(status).json(payload);
}

export function parseUrl(request) {
  const host = request.headers?.host || 'localhost';
  return new URL(request.url || '/', `https://${host}`);
}

export function normalizePrivateKey(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {}
  return trimmed;
}

export function signKalshiRequest({ method, path, body = '' }) {
  const keyId = process.env.KALSHI_API_KEY_ID || '';
  const privateKey = normalizePrivateKey(process.env.KALSHI_PRIVATE_KEY || '');
  if (!keyId || !privateKey) return {};
  const timestamp = String(Date.now());
  const message = `${timestamp}${method.toUpperCase()}${path}${body}`;
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  const signature = signer.sign({ key: privateKey, padding: 6, saltLength: 32 }, 'base64');
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature
  };
}

export async function kalshiFetch(path, { method = 'GET', bodyObj = null, authenticated = false } = {}) {
  const base = getKalshiBase();
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const headers = {
    accept: 'application/json'
  };
  if (body) headers['content-type'] = 'application/json';
  if (authenticated) Object.assign(headers, signKalshiRequest({ method, path, body }));

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body || undefined
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || data?.error || `Kalshi HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}


export async function kalshiPublicFetch(path) {
  const bases = [...new Set([getKalshiBase(), FALLBACK_KALSHI_BASE])];
  let lastError = null;
  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}`, { method: 'GET', headers: { accept: 'application/json' } });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { raw: text }; }
      if (!response.ok) {
        const message = data?.error?.message || data?.message || data?.error || `Kalshi HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Kalshi public request failed');
}

export function safeString(value) {
  return String(value ?? '').toLowerCase();
}

export function marketSearchText(market = {}) {
  return [
    market.ticker,
    market.market_ticker,
    market.event_ticker,
    market.title,
    market.subtitle,
    market.yes_sub_title,
    market.no_sub_title,
    market.rules_primary,
    market.rules_secondary,
    market.category
  ].filter(Boolean).join(' ');
}

export function marketLooksBitcoin15(market = {}) {
  const text = safeString(marketSearchText(market));
  const hasBtc = /\b(btc|bitcoin|crypto)\b/.test(text);
  const hasTime = /(15|fifteen|quarter-hour|quarter hour|15-minute|15 minute)/.test(text);
  return hasBtc && hasTime;
}

export function filterMarkets(markets = [], search = '') {
  const q = safeString(search).trim();
  const terms = q.split(/\s+/).filter(Boolean);
  let filtered = markets;
  if (terms.length) {
    filtered = markets.filter((market) => {
      const haystack = safeString(marketSearchText(market));
      return terms.every((term) => haystack.includes(term));
    });
  }
  if (!filtered.length && /bitcoin|btc|crypto|15/.test(q)) {
    filtered = markets.filter(marketLooksBitcoin15);
  }
  return filtered;
}

export function normalizeMarkets(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.markets)) return data.markets;
  if (Array.isArray(data?.result?.markets)) return data.result.markets;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

export function normalizeOrderbook(raw = {}) {
  const book = raw.orderbook || raw.order_book || raw;
  const yes = Array.isArray(book.yes) ? book.yes : Array.isArray(book.yes_orders) ? book.yes_orders : [];
  const no = Array.isArray(book.no) ? book.no : Array.isArray(book.no_orders) ? book.no_orders : [];
  const rowPrice = (row) => {
    if (Array.isArray(row)) return Number(row[0]);
    return Number(row.price ?? row.yes_price ?? row.no_price ?? row[0]);
  };
  const bestYes = yes.length ? Math.max(...yes.map(rowPrice).filter(Number.isFinite)) : null;
  const bestNo = no.length ? Math.max(...no.map(rowPrice).filter(Number.isFinite)) : null;
  return {
    yesPrice: bestYes == null ? null : bestYes,
    noPrice: bestNo == null ? null : bestNo,
    yes,
    no,
    raw
  };
}

export function uuid() {
  try { return randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}
