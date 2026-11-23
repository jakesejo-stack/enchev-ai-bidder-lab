// POST /api/wallet/pair {bidder}  → {code}   (on the computer: the QR code for the phone)
// POST /api/wallet/pair {code}    → {bidder} (on the phone: the same profile)
// The code expires after 5 minutes and is signed with ENCHEV_PAIR_SECRET (HMAC-SHA256), so a QR code
// cannot be forged or reused later. Without the secret, unsigned pairing is allowed ONLY in sandbox.
// In ENCHEV the QR carries a one-time sign-in token of the user's account instead.
import { createHmac } from 'node:crypto';
import { BIDDER_RE, config, readJson, safeEqual, send } from '../_lib/revolut.js';

const TTL = 5 * 60_000;
const sign = (secret, bidder, exp) => createHmac('sha256', secret).update(`pair|${bidder}|${exp}`).digest('base64url').slice(0, 32);

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD' });
  const cfg = deps.cfg ?? config();
  const secret = (deps.env ?? process.env).ENCHEV_PAIR_SECRET || '';
  const now = deps.now ?? Date.now();
  if (!secret && cfg.mode !== 'sandbox') return send(res, 503, { error: 'NOT_CONFIGURED', message: 'Липсва ENCHEV_PAIR_SECRET.' });
  const body = await readJson(req);
  if (typeof body?.bidder === 'string') {
    if (!BIDDER_RE.test(body.bidder)) return send(res, 400, { error: 'BAD_REQUEST' });
    const exp = now + TTL;
    return send(res, 200, { code: `${body.bidder}.${exp}.${secret ? sign(secret, body.bidder, exp) : 'u'}`, expiresAt: exp, signed: !!secret });
  }
  const [bidder = '', expS = '', sig = ''] = String(body?.code ?? '').split('.');
  const exp = Number(expS);
  if (!BIDDER_RE.test(bidder) || !Number.isFinite(exp)) return send(res, 400, { error: 'BAD_CODE', message: 'Невалиден код.' });
  if (now > exp) return send(res, 410, { error: 'EXPIRED', message: 'Кодът изтече. Покажи нов QR код.' });
  if (secret ? !safeEqual(sig, sign(secret, bidder, exp)) : sig !== 'u') return send(res, 401, { error: 'BAD_SIGNATURE', message: 'Кодът не е издаден от ENCHEV.' });
  return send(res, 200, { bidder, signed: !!secret });
}
