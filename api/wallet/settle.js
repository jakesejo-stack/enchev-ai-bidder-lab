// POST /api/wallet/settle {orderId, action, amount?} — "Изход", OPERATOR ONLY (Bearer ENCHEV_OPS_TOKEN).
//   release : the bidder lost / the auction was cancelled → cancel the hold, money stays with the buyer
//   forfeit : the winner declined or did not pay → capture the penalty (≤ the hold)
//   refund  : return a captured amount to the original card
// The browser of a bidder can never call this with success: who won is decided by the auction server.
import { ORDER_RE, config, readJson, refusal, revolut, safeEqual, send } from '../_lib/revolut.js';

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD' });
  const cfg = deps.cfg ?? config();
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!cfg.opsToken || !safeEqual(auth, cfg.opsToken)) return send(res, 401, { error: 'UNAUTHORISED', message: 'Само за оператор.' });
  const r = refusal(cfg);
  if (r) return send(res, 503, { error: r.code, message: r.message });
  const body = await readJson(req);
  const orderId = String(body?.orderId ?? ''), action = body?.action;
  if (!ORDER_RE.test(orderId) || !['release', 'forfeit', 'refund'].includes(action)) return send(res, 400, { error: 'BAD_REQUEST' });
  try {
    const o = await revolut(cfg, 'GET', `/api/orders/${orderId}`, null, deps.fetch);
    if (o?.metadata?.kind !== 'deposit') return send(res, 409, { error: 'NOT_A_DEPOSIT' });
    const state = String(o.state || '').toLowerCase();
    const amount = body.amount === undefined ? Number(o.amount) : Number(body.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > Number(o.amount)) return send(res, 400, { error: 'BAD_AMOUNT' });
    let result;
    if (action === 'release') {
      if (state !== 'authorised' && state !== 'pending') return send(res, 409, { error: 'STATE', message: `Не може да се освободи в състояние ${state}.` });
      result = await revolut(cfg, 'POST', `/api/orders/${orderId}/cancel`, null, deps.fetch);
    } else if (action === 'forfeit') {
      if (state !== 'authorised') return send(res, 409, { error: 'STATE', message: `Санкция се взима само от задържан депозит (сега: ${state}).` });
      result = await revolut(cfg, 'POST', `/api/orders/${orderId}/capture`, { amount }, deps.fetch);
    } else {
      if (state !== 'completed') return send(res, 409, { error: 'STATE', message: `Връщане само след взета сума (сега: ${state}).` });
      result = await revolut(cfg, 'POST', `/api/orders/${orderId}/refund`, { amount, currency: o.currency || 'EUR', description: 'ENCHEV връщане на депозит' }, deps.fetch);
    }
    console.info('[wallet] settle', action, orderId, amount);
    return send(res, 200, { ok: true, action, orderId, state: String(result?.state ?? '').toLowerCase() || null });
  } catch (e) {
    console.error('[wallet] settle failed', action, e.status, e.detail);
    return send(res, 502, { error: 'PROVIDER', message: 'Revolut не изпълни действието.' });
  }
}
