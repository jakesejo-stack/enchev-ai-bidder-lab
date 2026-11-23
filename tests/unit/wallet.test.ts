import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
// @ts-expect-error — plain JS Vercel function without type declarations
import { config, depositFor, ledgerEntry, refusal, verifySignature } from '../../api/_lib/revolut.js';
// @ts-expect-error — plain JS Vercel function without type declarations
import deposit from '../../api/wallet/deposit.js';
// @ts-expect-error — plain JS Vercel function without type declarations
import ledger from '../../api/wallet/ledger.js';
// @ts-expect-error — plain JS Vercel function without type declarations
import settle from '../../api/wallet/settle.js';
// @ts-expect-error — plain JS Vercel function without type declarations
import webhook from '../../api/wallet/webhook.js';
// @ts-expect-error — plain JS Vercel function without type declarations
import payout from '../../api/wallet/payout.js';

const BIDDER = 'b_AAAAAAAAAAAAAAAAAAAAAA';
const ORDER = '6516e61c-d279-a454-a837-bc52ce55ed49';
const SANDBOX = { REVOLUT_SECRET_KEY: 'sk_test', REVOLUT_WEBHOOK_SECRET: 'wsk_test', ENCHEV_OPS_TOKEN: 'ops-secret-token' };

function req(method: string, { body, headers = {}, url = '/' }: { body?: unknown; headers?: Record<string, string>; url?: string } = {}) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const r = Readable.from(raw ? [Buffer.from(raw)] : []) as Readable & { method: string; headers: Record<string, string>; url: string };
  r.method = method;
  r.headers = { host: 'lab.test', ...headers };
  r.url = url;
  return r;
}
function res() {
  const out: { status: number; body: unknown; headers: Record<string, string>; ended: boolean } = { status: 0, body: null, headers: {}, ended: false };
  const o = {
    setHeader(k: string, v: string) { out.headers[k] = v; },
    status(s: number) { out.status = s; return o; },
    json(b: unknown) { out.body = b; out.ended = true; return o; },
    end() { out.ended = true; return o; },
  };
  return { o, out };
}
type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
function fakeRevolut(reply: (c: Call) => unknown) {
  const calls: Call[] = [];
  const f = async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    const c = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers };
    calls.push(c);
    return new Response(JSON.stringify(reply(c)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { f, calls };
}

test('config: sandbox by default; production refused until the owner approves real money', () => {
  assert.equal(config({}).mode, 'sandbox');
  assert.equal(refusal(config({}))?.code, 'NOT_CONFIGURED');
  assert.equal(refusal(config(SANDBOX)), null);
  assert.equal(refusal(config({ ...SANDBOX, REVOLUT_ENV: 'production' }))?.code, 'LIVE_NOT_APPROVED');
  assert.equal(refusal(config({ ...SANDBOX, REVOLUT_ENV: 'production', ENCHEV_REAL_MONEY: 'yes' }))?.code, 'LIVE_NOT_APPROVED');
  assert.equal(refusal(config({ ...SANDBOX, REVOLUT_ENV: 'production', ENCHEV_REAL_MONEY: 'approved' })), null);
  assert.equal(config({ ...SANDBOX, REVOLUT_ENV: 'production' }).base, 'https://merchant.revolut.com');
  assert.equal(config(SANDBOX).base, 'https://sandbox-merchant.revolut.com');
});

test('deposit rule is configurable: 10 % with a minimum, or a fixed test amount (e.g. 0,01 €)', () => {
  const r = config(SANDBOX).rules;
  assert.equal(depositFor(2_500_000, r), 250_000);
  assert.equal(depositFor(100_000, r), 30_000);
  assert.equal(depositFor(2_500_000, config({ ...SANDBOX, DEPOSIT_FIXED_CENTS: '1' }).rules), 1);
});

test('Вход: deposit creates a manual-capture pre-authorisation in Revolut; amount set by the server', async () => {
  const rv = fakeRevolut(() => ({ id: ORDER, token: 'tok', checkout_url: 'https://sandbox-merchant.revolut.com/pay/tok', state: 'pending' }));
  const { o, out } = res();
  await deposit(req('POST', { body: { bidder: BIDDER, lotId: 'DEMO-0001', maxBid: 2_500_000, amount: 1 } }) as never, o as never, { cfg: config(SANDBOX), fetch: rv.f });
  assert.equal(out.status, 200);
  const c = rv.calls[0]!;
  assert.equal(c.url, 'https://sandbox-merchant.revolut.com/api/orders');
  assert.equal(c.headers.Authorization, 'Bearer sk_test');
  assert.ok(c.headers['Revolut-Api-Version']);
  const b = c.body as Record<string, unknown>;
  assert.equal(b.amount, 250_000, 'the client-sent "amount" is ignored');
  assert.equal(b.capture_mode, 'manual');
  assert.equal(b.authorisation_type, 'pre_authorisation');
  assert.deepEqual(b.metadata, { kind: 'deposit', bidder: BIDDER, lot: 'DEMO-0001', max_bid: '2500000' });
  assert.equal((out.body as { checkoutUrl: string }).checkoutUrl, 'https://sandbox-merchant.revolut.com/pay/tok');
});

test('deposit refuses bad input and a missing key', async () => {
  const a = res();
  await deposit(req('POST', { body: { bidder: 'x', lotId: 'DEMO-0001', maxBid: 100 } }) as never, a.o as never, { cfg: config(SANDBOX) });
  assert.equal(a.out.status, 400);
  const b = res();
  await deposit(req('POST', { body: { bidder: BIDDER, lotId: 'DEMO-0001', maxBid: 100 } }) as never, b.o as never, { cfg: config({}) });
  assert.equal(b.out.status, 503);
});

test('ledger: read-only, only this profile’s orders, states from Revolut', async () => {
  const rv = fakeRevolut(() => ({ orders: [
    { id: ORDER, amount: 250_000, currency: 'EUR', state: 'AUTHORISED', metadata: { kind: 'deposit', bidder: BIDDER, lot: 'DEMO-0001' }, created_at: '2026-11-23T18:00:00Z' },
    { id: 'x', amount: 1, currency: 'EUR', state: 'completed', metadata: { kind: 'deposit', bidder: 'b_BBBBBBBBBBBBBBBBBBBBBB' } },
  ] }));
  const { o, out } = res();
  await ledger(req('GET', { url: `/api/wallet/ledger?bidder=${BIDDER}` }) as never, o as never, { cfg: config(SANDBOX), fetch: rv.f });
  const entries = (out.body as { entries: { orderId: string; label: string }[] }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.label, 'Задържан (вход)');
  assert.equal(rv.calls[0]!.method, 'GET');
  assert.equal(ledgerEntry({ id: ORDER, amount: 100, refunded_amount: 100, state: 'completed', metadata: { kind: 'deposit' } }).label, 'Върнат изцяло (изход)');
});

test('Изход: only the operator can release / forfeit / refund, and only in the right state', async () => {
  const cfg = config(SANDBOX);
  const anon = res();
  await settle(req('POST', { body: { orderId: ORDER, action: 'release' } }) as never, anon.o as never, { cfg });
  assert.equal(anon.out.status, 401, 'a bidder’s browser cannot release a deposit');
  const auth = { authorization: 'Bearer ops-secret-token' };
  const rv = fakeRevolut((c) => (c.method === 'GET' ? { id: ORDER, amount: 250_000, currency: 'EUR', state: 'authorised', metadata: { kind: 'deposit' } } : { state: 'cancelled' }));
  const ok = res();
  await settle(req('POST', { body: { orderId: ORDER, action: 'release' }, headers: auth }) as never, ok.o as never, { cfg, fetch: rv.f });
  assert.equal(ok.out.status, 200);
  assert.ok(rv.calls[1]!.url.endsWith(`/api/orders/${ORDER}/cancel`));
  const rv2 = fakeRevolut(() => ({ id: ORDER, amount: 250_000, currency: 'EUR', state: 'authorised', metadata: { kind: 'deposit' } }));
  const big = res();
  await settle(req('POST', { body: { orderId: ORDER, action: 'forfeit', amount: 300_000 }, headers: auth }) as never, big.o as never, { cfg, fetch: rv2.f });
  assert.equal(big.out.status, 400, 'cannot take more than the hold');
  const wrong = res();
  await settle(req('POST', { body: { orderId: ORDER, action: 'refund' }, headers: auth }) as never, wrong.o as never, { cfg, fetch: rv2.f });
  assert.equal(wrong.out.status, 409, 'refund only after a capture');
});

test('webhook: signature over v1.{timestamp}.{raw body}, 5-minute window, then the order is read back from Revolut', () => {
  const raw = JSON.stringify({ event: 'ORDER_AUTHORISED', order_id: ORDER });
  const ts = '1795450000000';
  const sig = `v1=${createHmac('sha256', 'wsk_test').update(`v1.${ts}.${raw}`).digest('hex')}`;
  assert.equal(verifySignature(raw, ts, sig, 'wsk_test', 1795450000000 + 60_000), true);
  assert.equal(verifySignature(raw, ts, `v1=deadbeef,${sig}`, 'wsk_test', 1795450000000), true, 'any of several signatures');
  assert.equal(verifySignature(raw + ' ', ts, sig, 'wsk_test', 1795450000000), false, 'body changed');
  assert.equal(verifySignature(raw, ts, sig, 'wsk_test', 1795450000000 + 6 * 60_000), false, 'too old');
  assert.equal(verifySignature(raw, ts, sig, '', 1795450000000), false, 'no secret configured');
});

test('webhook handler: bad signature 401; good one re-reads the order and answers 204', async () => {
  const raw = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: ORDER });
  const now = Date.now(), ts = String(now);
  const sig = `v1=${createHmac('sha256', 'wsk_test').update(`v1.${ts}.${raw}`).digest('hex')}`;
  const bad = res();
  await webhook(req('POST', { body: raw, headers: { 'revolut-request-timestamp': ts, 'revolut-signature': 'v1=00' } }) as never, bad.o as never, { cfg: config(SANDBOX), now });
  assert.equal(bad.out.status, 401);
  const rv = fakeRevolut(() => ({ id: ORDER, amount: 1, currency: 'EUR', state: 'completed', metadata: { kind: 'payment' } }));
  const good = res();
  await webhook(req('POST', { body: raw, headers: { 'revolut-request-timestamp': ts, 'revolut-signature': sig } }) as never, good.o as never, { cfg: config(SANDBOX), fetch: rv.f, now });
  assert.equal(good.out.status, 204);
  assert.ok(rv.calls[0]!.url.endsWith(`/api/orders/${ORDER}`));
});

test('seller payout stays off (501) until KYB, contract, legal review and approval', () => {
  const { o, out } = res();
  payout(req('POST') as never, o as never);
  assert.equal(out.status, 501);
});
