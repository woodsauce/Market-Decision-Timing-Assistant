import { parseCoinbasePredictionPage } from '../../lib/coinbase-predictions.mjs';

const SOURCE_URLS = [
  'https://www.coinbase.com/predictions/crypto/BTC/15%20min',
  'https://www.coinbase.com/predictions/crypto/15%20min',
  'https://www.coinbase.com/predictions/crypto/BTC'
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const attempts = [];
  for (const url of SOURCE_URLS) {
    try {
      const response = await fetch(url, {
        headers: {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'user-agent': 'Mozilla/5.0 Edge15DecisionEngine/1.2 (+https://vercel.com)'
        }
      });
      const html = await response.text();
      attempts.push({ url, status: response.status, bytes: html.length });
      if (!response.ok) continue;
      const parsed = parseCoinbasePredictionPage(html);
      if (parsed?.targetPrice) {
        return res.status(200).json({ ...parsed, url, attempts });
      }
    } catch (error) {
      attempts.push({ url, error: error.message });
    }
  }

  return res.status(502).json({
    ok: false,
    error: 'Could not auto-detect the Coinbase BTC 15-minute prediction market from the public pages.',
    attempts,
    fallback: 'Use the manual target/time controls or paste the current target from Coinbase.'
  });
}
