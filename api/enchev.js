// READ-ONLY bridge from this lab to the PUBLIC Enchev Auctions endpoints (the "Реални данни" view).
// • GET/HEAD only. Fixed allow-list of upstream paths: the browser never chooses a URL (no SSRF).
// • No cookies, credentials or client headers are forwarded; redirects are not followed; 8 s timeout.
// • Only allow-listed fields are passed through. Nothing is ever written upstream.
// • Real bidding is NOT available here (see /api/bids → 501). Upstream: ENCHEV_UPSTREAM_BASE env var,
//   default = the public Enchev Auctions site. Responses are edge-cached for 20 s to spare upstream.
const DEFAULT_UPSTREAM = 'https://enchev-auctions.vercel.app';

export const RESOURCES = Object.freeze({
  catalog: '/api/buyer/catalog',
  'health-web': '/api/health/web',
  'health-api': '/api/health/api',
  'health-realtime': '/api/health/realtime',
  'health-worker': '/api/health/worker',
});

const LOT_FIELDS = ['id', 'lot_number', 'title', 'make', 'model', 'model_year', 'country_code', 'condition_summary', 'mileage_km',
  'fuel_type', 'transmission', 'power_kw', 'body_type', 'starting_price', 'price_currency', 'status', 'auction_starts_at', 'auction_ends_at'];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function pick(o, keys) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of keys) {
    if (!has(o, k)) continue;
    const v = o[k];
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 300);
  }
  return out;
}

/** Keeps only known, non-sensitive fields of an upstream JSON body. */
export function sanitize(resource, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (resource === 'catalog') {
    return {
      ...pick(body, ['ok', 'available', 'realMoneyEnabled', 'error']),
      lots: Array.isArray(body.lots) ? body.lots.slice(0, 100).map((l) => pick(l, LOT_FIELDS)) : [],
    };
  }
  return pick(body, ['ok', 'component', 'ready', 'status']);
}

export async function readUpstream(resource, opts = {}) {
  const path = has(RESOURCES, resource) ? RESOURCES[resource] : null;
  if (!path) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const origin = new URL(opts.base ?? process.env.ENCHEV_UPSTREAM_BASE ?? DEFAULT_UPSTREAM).origin; // scheme + host only
  const t0 = Date.now();
  const base = { resource, upstream: origin + path, fetchedAt: new Date().toISOString() };
  try {
    const r = await fetchImpl(origin + path, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    let body = null;
    try { body = sanitize(resource, JSON.parse((await r.text()).slice(0, 1_000_000))); } catch { body = null; }
    return { ...base, reachable: true, upstreamStatus: r.status, latencyMs: Date.now() - t0, body };
  } catch (e) {
    return { ...base, reachable: false, upstreamStatus: 0, error: e && e.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE', latencyMs: Date.now() - t0, body: null };
  }
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'READ_ONLY', message: 'Само четене: тази връзка към Enchev Auctions не приема записи.' });
  }
  const resource = String((req.query && req.query.r) || '');
  const out = await readUpstream(resource);
  if (!out) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'UNKNOWN_RESOURCE', allowed: Object.keys(RESOURCES) });
  }
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=40');
  return res.status(200).json({ readOnly: true, ...out });
}
