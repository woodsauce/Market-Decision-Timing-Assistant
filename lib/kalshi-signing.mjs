import crypto from 'node:crypto';

export function normalizePrivateKey(pem = '') {
  return String(pem || '').replace(/\\n/g, '\n').trim();
}

export function kalshiSignature({ privateKeyPem, timestampMs, method, path }) {
  if (!privateKeyPem) throw new Error('Missing Kalshi private key');
  if (!timestampMs) throw new Error('Missing timestamp');
  if (!method) throw new Error('Missing method');
  if (!path) throw new Error('Missing path');
  const cleanPath = String(path).split('?')[0];
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${timestampMs}${String(method).toUpperCase()}${cleanPath}`);
  sign.end();
  return sign.sign({
    key: normalizePrivateKey(privateKeyPem),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64');
}

export function kalshiHeaders({ method, path, body = null, env = process.env, timestampMs = Date.now() }) {
  const key = env.KALSHI_ACCESS_KEY;
  const privateKeyPem = normalizePrivateKey(env.KALSHI_PRIVATE_KEY);
  if (!key || !privateKeyPem) throw new Error('Kalshi credentials are not configured');
  return {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': key,
    'KALSHI-ACCESS-TIMESTAMP': String(timestampMs),
    'KALSHI-ACCESS-SIGNATURE': kalshiSignature({ privateKeyPem, timestampMs, method, path })
  };
}

export function kalshiBaseUrl(env = process.env) {
  return env.KALSHI_API_BASE || 'https://external-api.kalshi.com/trade-api/v2';
}
