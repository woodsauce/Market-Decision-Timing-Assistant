export default function handler(request, response) {
  response.status(200).json({ ok: true, name: 'Edge15 Decision Engine', ts: Date.now() });
}
