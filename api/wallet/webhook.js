// POST /api/wallet/webhook — Revolut events (ORDER_AUTHORISED, ORDER_COMPLETED, ORDER_CANCELLED, …).
// 1. Signature: HMAC-SHA256 over "v1.{Revolut-Request-Timestamp}.{raw body}", 5-minute tolerance.
// 2. The event is never trusted alone: the order is read back from Revolut (server to server).
// 3. Idempotent: the result depends only on Revolut's order state, so a repeated event changes nothing.
// The lab has no database: the buyer's ledger is read from Revolut directly, and this endpoint writes an
// audit line to the Vercel logs. In ENCHEV the same handler writes the payment record (unique provider_reference).
import { ORDER_RE, config, ledgerEntry, readRaw, revolut, send, verifySignature } from '../_lib/revolut.js';

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD' });
  const cfg = deps.cfg ?? config();
  let raw;
  try { raw = await readRaw(req); } catch { return send(res, 413, { error: 'TOO_LARGE' }); }
  const ok = verifySignature(raw, req.headers['revolut-request-timestamp'], req.headers['revolut-signature'], cfg.webhookSecret, deps.now ?? Date.now());
  if (!ok) return send(res, 401, { error: 'BAD_SIGNATURE' });
  let event;
  try { event = JSON.parse(raw); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
  const orderId = String(event?.order_id ?? '');
  if (!ORDER_RE.test(orderId)) return send(res, 400, { error: 'NO_ORDER' });
  try {
    const order = await revolut(cfg, 'GET', `/api/orders/${orderId}`, null, deps.fetch);
    const entry = ledgerEntry(order);
    console.info('[wallet] webhook', String(event.event || '').slice(0, 40), orderId, entry.state, entry.amount);
    res.status(204).end();
  } catch (e) {
    // A non-2xx makes Revolut retry later (3 more times, 10 minutes apart).
    console.error('[wallet] webhook verify failed', e.status, e.detail);
    return send(res, 502, { error: 'PROVIDER' });
  }
}
