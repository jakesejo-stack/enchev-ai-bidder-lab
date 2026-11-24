// GET /api/wallet/ledger?bidder=… — read-only list of this profile's deposits and payments, read
// directly from Revolut (no balance is stored by ENCHEV). In the real system the profile comes from the
// authenticated session, not from a query parameter.
import { BIDDER_RE, config, ledgerEntry, refusal, revolut, send } from '../_lib/revolut.js';

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD' });
  const cfg = deps.cfg ?? config();
  const r = refusal(cfg);
  if (r) return send(res, 503, { error: r.code, message: r.message, entries: [] });
  const bidder = new URL(req.url, 'http://x').searchParams.get('bidder') ?? '';
  if (!BIDDER_RE.test(bidder)) return send(res, 400, { error: 'BAD_REQUEST', entries: [] });
  try {
    const data = await revolut(cfg, 'GET', '/api/orders?limit=100', null, deps.fetch);
    const orders = Array.isArray(data) ? data : Array.isArray(data?.orders) ? data.orders : [];
    const entries = orders.filter((o) => o?.metadata?.bidder === bidder).map(ledgerEntry);
    return send(res, 200, { environment: cfg.mode, entries, source: 'Revolut Merchant API (само за четене)' });
  } catch (e) {
    console.error('[wallet] ledger failed', e.status, e.detail);
    return send(res, 502, { error: 'PROVIDER', message: 'Revolut не отговори.', entries: [] });
  }
}
