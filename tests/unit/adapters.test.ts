import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoAuctionServer, type Competitor } from '../../src/adapters/demo-server.js';
import { parseAuctionEvent } from '../../src/adapters/real-adapter.js';
import { euros } from '../../src/domain/money.js';
import { currentStep, highestBid, nextValidBid } from '../../src/domain/rules.js';
import type { AuctionEvent, BidRecord } from '../../src/domain/types.js';

function server(now: { t: number }, durationMs = 180_000) {
  return new DemoAuctionServer({ now: () => now.t, clockSkewMs: 0, durationMs, competitors: false, seed: 1, openingBids: true });
}
const me = { bidderId: 'me', authenticated: true };
const req = (eur: number, key: string) => ({ lotId: 'DEMO-0001', amount: euros(eur), currency: 'EUR' as const, idempotencyKey: key });

test('demo server: idempotent bids — same key never creates a second bid', () => {
  const now = { t: 1_000_000 };
  const s = server(now);
  const events: AuctionEvent[] = [];
  s.subscribe((e) => events.push(e));
  const r1 = s.placeBid(req(43_000, 'k1'), me);
  const r2 = s.placeBid(req(43_000, 'k1'), me);
  assert.equal(r1.status, 'accepted');
  assert.equal(r2.status, 'accepted');
  assert.equal(r2.status === 'accepted' && r2.duplicate, true);
  assert.equal(events.filter((e) => e.type === 'bid').length, 1);
  s.stop();
});

test('demo server: validation, rate limit, audit trail', () => {
  const now = { t: 1_000_000 };
  const s = server(now);
  assert.equal(s.placeBid(req(42_500, 'a'), me).status, 'rejected'); // equal to current
  const ok = s.placeBid(req(43_000, 'b'), me);
  assert.equal(ok.status, 'accepted');
  const again = s.placeBid(req(43_500, 'c'), me);
  assert.ok(again.status === 'rejected' && (again.code === 'RATE_LIMITED' || again.code === 'ALREADY_HIGHEST'));
  assert.equal(s.placeBid(req(44_000, 'd'), { bidderId: 'anon', authenticated: false }).status, 'rejected');
  assert.ok(s.audit.length >= 3);
  s.stop();
});

test('demo server: anti-sniping extends and ended auctions reject bids', () => {
  const now = { t: 1_000_000 };
  const s = server(now, 30_000);
  const events: AuctionEvent[] = [];
  s.subscribe((e) => events.push(e));
  now.t += 15_000; // 15 s left, inside the 20 s window
  assert.equal(s.placeBid(req(43_000, 'x'), me).status, 'accepted');
  const ext = events.find((e) => e.type === 'extension');
  assert.ok(ext && ext.type === 'extension' && ext.endsAt === now.t + 20_000);
  now.t += 60_000;
  const late = s.placeBid(req(43_500, 'y'), { bidderId: 'other', authenticated: true });
  assert.ok(late.status === 'rejected' && late.code === 'ENDED');
  s.stop();
});

test('real adapter rejects malformed stream messages', () => {
  assert.equal(parseAuctionEvent(null), null);
  assert.equal(parseAuctionEvent({ type: 'bid', seq: 1, serverTime: 1, bid: { bidId: 'x', bidderId: 'y', amount: -5, serverTime: 1 } }), null);
  assert.equal(parseAuctionEvent({ type: 'bid', seq: 1.5, serverTime: 1, bid: {} }), null);
  assert.equal(parseAuctionEvent({ type: 'hack', seq: 1, serverTime: 1 }), null);
  assert.ok(parseAuctionEvent({ type: 'bid', seq: 2, serverTime: 1, bid: { bidId: 'x', bidderId: 'y', amount: 100, serverTime: 1 } }));
  assert.ok(parseAuctionEvent({ type: 'status', seq: 3, serverTime: 1, status: 'ended' }));
});

test('demo server: starts from 0 € by default; the maximum (1 000 000 €) is enforced by the server', () => {
  const now = { t: 1_000_000 };
  const s = new DemoAuctionServer({ now: () => now.t, clockSkewMs: 0, competitors: false, seed: 2 });
  const snap = s.snapshot();
  assert.ok(snap.type === 'snapshot' && snap.bids.length === 0 && snap.lot.startPrice === 0);
  assert.equal(nextValidBid(snap.lot, snap.rules, snap.bids), euros(100));
  assert.equal(s.placeBid(req(1_000_100, 'too-much'), me).status, 'rejected');
  const r = s.placeBid(req(1_000_000, 'max'), me);
  assert.equal(r.status, 'accepted', 'exactly the maximum is allowed');
  s.stop();
});

test('demo server: competitors bid valid amounts from 0 € and never above their private maximum', () => {
  const now = { t: 2_000_000 };
  const s = new DemoAuctionServer({ now: () => now.t, clockSkewMs: 0, competitors: false, seed: 5 });
  const c: Competitor = { id: 'Участник 3', max: euros(60_000), eagerness: 1 };
  let other = 0;
  for (let i = 0; i < 40; i++) {
    const snap = s.snapshot();
    if (snap.type !== 'snapshot') throw new Error('snapshot expected');
    const next = nextValidBid(snap.lot, snap.rules, snap.bids);
    if (next > c.max) break;
    const amount = s.competitorAmount(c, next);
    const step = currentStep(snap.lot, snap.rules, snap.bids);
    assert.ok(amount >= next && amount <= c.max, `amount ${amount} within [${next}, ${c.max}]`);
    assert.equal((amount - next) % step, 0, 'on the step grid');
    now.t += 1_500;
    assert.equal(s.placeBid({ lotId: snap.lot.lotId, amount, currency: 'EUR', idempotencyKey: `c${i}` }, { bidderId: `p${other++ % 2}`, authenticated: true }).status, 'accepted');
  }
  const top = highestBid(s.snapshot().type === 'snapshot' ? (s.snapshot() as { bids: BidRecord[] }).bids : []);
  assert.ok(top && top.amount > euros(20_000) && top.amount <= c.max, `price rose from 0 € to ${top?.amount}`);
  s.stop();
});
