// POST /api/wallet/deposit {bidder, lotId, maxBid} — "Вход": a deposit HOLD on the buyer's card through
// Revolut (manual capture, pre-authorisation). The amount comes from the server rule, never from the
// browser. Nothing is "paid" here: the buyer completes Revolut's hosted checkout, and the state shown
// later is read back from Revolut.
import { BIDDER_RE, LOT_RE, config, depositFor, readJson, refusal, revolut, send } from '../_lib/revolut.js';

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD' });
  const cfg = deps.cfg ?? config();
  const r = refusal(cfg);
  if (r) return send(res, 503, { error: r.code, message: r.message });
  const body = await readJson(req);
  const bidder = body?.bidder, lotId = body?.lotId, maxBid = Number(body?.maxBid);
  if (!BIDDER_RE.test(String(bidder)) || !LOT_RE.test(String(lotId)) || !Number.isInteger(maxBid) || maxBid < 1 || maxBid > 100_000_000) {
    return send(res, 400, { error: 'BAD_REQUEST', message: 'Невалиден профил, лот или максимална оферта.' });
  }
  const amount = depositFor(maxBid, cfg.rules);
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  try {
    const order = await revolut(cfg, 'POST', '/api/orders', {
      amount, currency: 'EUR', capture_mode: 'manual', authorisation_type: 'pre_authorisation', cancel_authorised_after: 'P29D',
      description: `ENCHEV депозит · лот ${lotId}`,
      merchant_order_data: { reference: `ENCHEV-DEP-${lotId}-${Date.now().toString(36)}` },
      metadata: { kind: 'deposit', bidder, lot: lotId, max_bid: String(maxBid) },
      redirect_url: `${origin}/#/wallet`,
    }, deps.fetch);
    return send(res, 200, { orderId: order.id, token: order.token, checkoutUrl: order.checkout_url ?? null, amount, currency: 'EUR', environment: cfg.mode });
  } catch (e) {
    console.error('[wallet] deposit failed', e.status, e.detail);
    return send(res, 502, { error: 'PROVIDER', message: 'Revolut не прие заявката. Опитай пак.' });
  }
}
