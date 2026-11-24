import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS Vercel function without type declarations
import handler, { readUpstream, sanitize } from '../../api/enchev.js';
import { toCatalogView, toServiceView, lotCountdown, loadReadOnly, parseEnvelope } from '../../src/adapters/enchev-readonly.js';

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function mockRes() {
  return {
    code: 0, headers: {} as Record<string, string>, body: null as unknown,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    status(c: number) { this.code = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

test('read-only bridge: fixed allow-list, GET only, no client headers, unknown fields dropped', async () => {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(200, { ok: true, component: 'web', ready: true, status: 'healthy', token: 'must-not-pass' }); };
  const out = await readUpstream('health-web', { fetchImpl, base: 'https://upstream.test/ignored/path?x=1' });
  assert.equal(calls[0]!.url, 'https://upstream.test/api/health/web', 'only the origin of the base is used');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.deepEqual(Object.keys(calls[0]!.init.headers as Record<string, string>), ['Accept']);
  assert.deepEqual(out.body, { ok: true, component: 'web', ready: true, status: 'healthy' });
  assert.equal(await readUpstream('https://elsewhere.example/', { fetchImpl }), null);
  assert.equal(await readUpstream('__proto__', { fetchImpl }), null);
  assert.equal(calls.length, 1, 'no request for unknown resources');
});

test('read-only bridge: catalog keeps lot fields only; timeouts are reported, not thrown', async () => {
  const body = sanitize('catalog', { ok: true, available: true, realMoneyEnabled: false, lots: [{ lot_number: 'EA-20001', title: 'Лот', image_url: 'https://x/y.jpg', seller_id: 'u1', starting_price: 100 }] });
  assert.deepEqual(body, { ok: true, available: true, realMoneyEnabled: false, lots: [{ lot_number: 'EA-20001', title: 'Лот', starting_price: 100 }] });
  const timeout = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  const out = await readUpstream('catalog', { fetchImpl: timeout, base: 'https://upstream.test' });
  assert.equal(out.reachable, false);
  assert.equal(out.error, 'TIMEOUT');
});

test('read-only bridge: handler refuses writes (405) and unknown resources (404)', async () => {
  const post = mockRes();
  await handler({ method: 'POST', query: { r: 'catalog' } }, post);
  assert.equal(post.code, 405);
  assert.equal(post.headers['allow'], 'GET, HEAD');
  const bids = mockRes();
  await handler({ method: 'GET', query: { r: 'bids' } }, bids);
  assert.equal(bids.code, 404);
});

test('real data: catalog states — unreachable, unavailable (with upstream reason), ok', () => {
  assert.equal(toCatalogView(null).state, 'unreachable');
  const unavailable = toCatalogView(parseEnvelope({ resource: 'catalog', reachable: true, upstreamStatus: 503, fetchedAt: '', body: { ok: false, available: false, lots: [], error: 'Real vehicle catalogue is awaiting production identity configuration.' } }));
  assert.equal(unavailable.state, 'unavailable');
  assert.match(unavailable.reason, /HTTP 503.*awaiting production identity/);
  const ok = toCatalogView(parseEnvelope({ resource: 'catalog', reachable: true, upstreamStatus: 200, fetchedAt: '', body: { ok: true, available: true, realMoneyEnabled: false, lots: [
    { id: 'a', lot_number: 'EA-20001', title: 'BMW 320d', make: 'BMW', model: '320d', model_year: 2019, starting_price: 12500.5, price_currency: 'EUR', status: 'live', auction_ends_at: '2026-11-23T10:00:00Z' },
    { lot_number: 'EA-20002' }, // no title → ignored
  ] } }));
  assert.equal(ok.state, 'ok');
  assert.equal(ok.lots.length, 1);
  assert.equal(ok.lots[0]!.startingPrice, 1_250_050);
  assert.equal(ok.lots[0]!.status, 'live');
  assert.equal(ok.realMoneyEnabled, false);
});

test('real data: service readiness and lot countdowns come only from published data', () => {
  const rt = toServiceView('realtime', parseEnvelope({ resource: 'health-realtime', reachable: true, upstreamStatus: 503, fetchedAt: '', body: { ok: false, component: 'realtime', ready: false, status: 'service-pending' } }));
  assert.deepEqual([rt.state, rt.status], ['not_ready', 'service-pending']);
  assert.equal(toServiceView('web', parseEnvelope({ resource: 'health-web', reachable: true, upstreamStatus: 200, fetchedAt: '', body: { ready: true, status: 'healthy' } })).state, 'ready');
  assert.equal(toServiceView('api', null).state, 'unreachable');
  const lot = { id: 'a', lotNumber: 'EA-1', title: 't', subtitle: '', status: 'scheduled' as const, startingPrice: null, startsAt: 10_000, endsAt: 20_000 };
  assert.deepEqual(lotCountdown(lot, 4_000), { label: 'Започва след', ms: 6_000 });
  assert.deepEqual(lotCountdown(lot, 15_000), { label: 'Остават', ms: 5_000 });
  assert.deepEqual(lotCountdown(lot, 25_000), { label: 'Приключил', ms: 0 });
  assert.equal(lotCountdown({ ...lot, startsAt: null, endsAt: null }, 0).ms, null);
});

test('real data: loader uses only GET /api/enchev and survives non-JSON responses', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    return url.includes('catalog') ? new Response('<!doctype html>', { status: 200 }) : json(200, { resource: 'x', reachable: true, upstreamStatus: 200, fetchedAt: '', body: { ready: true, status: 'healthy' } });
  }) as unknown as typeof fetch;
  const snap = await loadReadOnly(fetchImpl);
  assert.equal(snap.catalog.state, 'unreachable');
  assert.equal(snap.services.length, 4);
  assert.ok(seen.every((s) => s.startsWith('GET /api/enchev?r=')), seen.join(', '));
});
