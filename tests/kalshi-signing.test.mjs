import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { kalshiSignature, normalizePrivateKey } from '../lib/kalshi-signing.mjs';

test('normalizes escaped PEM newlines', () => {
  assert.equal(normalizePrivateKey('a\\nb'), 'a\nb');
});

test('creates a base64 RSA-PSS signature for Kalshi headers', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const signature = kalshiSignature({
    privateKeyPem,
    timestampMs: 1715793600123,
    method: 'GET',
    path: '/trade-api/v2/portfolio/orders?limit=5'
  });
  assert.match(signature, /^[A-Za-z0-9+/=]+$/);
  assert.ok(signature.length > 100);
});
