import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepFor, nextValidBid, checkBid, extendedEnd, highestBid, alignBid, currentStep } from '../../src/domain/rules.js';
import { applyEvent, checkGap, initialAuctionState, GAP_TIMEOUT_MS } from '../../src/domain/reducer.js';
import { ServerClock, formatCountdown } from '../../src/domain/clock.js';
import { advise, NO_PROBABILITY } from '../../src/domain/advisor.js';
import { euros, formatEur, parseEurInput } from '../../src/domain/money.js';
import { DEMO_LOT, DEMO_RULES } from '../../src/adapters/demo-server.js';
import type { AuctionEvent, BidRecord, SnapshotEvent } from '../../src/domain/types.js';

const bid = (id: string, who: string, eur: number, t = 1000): BidRecord => ({ bidId: id, bidderId: who, amount: euros(eur), serverTime: t });

test('increment bands', () => {
  assert.equal(stepFor(euros(5_000), DEMO_RULES), euros(100));
  assert.equal(stepFor(euros(42_500), DEMO_RULES), euros(500));
  assert.equal(stepFor(euros(50_000), DEMO_RULES), euros(1_000));
});

test('next valid bid = current + step; start price when empty', () => {
  assert.equal(DEMO_LOT.startPrice, 0, 'the demo auction starts from 0 €');
  assert.equal(nextValidBid(DEMO_LOT, DEMO_RULES, []), euros(100), 'a 0 € start opens at the first increment');
  assert.equal(nextValidBid({ ...DEMO_LOT, startPrice: euros(40_000) }, DEMO_RULES, []), euros(40_000));
  assert.equal(nextValidBid(DEMO_LOT, DEMO_RULES, [bid('a', 'x', 42_000), bid('b', 'y', 42_500)]), euros(43_000));
  assert.equal(nextValidBid(DEMO_LOT, DEMO_RULES, [bid('a', 'x', 49_500)]), euros(50_000));
  assert.equal(nextValidBid(DEMO_LOT, DEMO_RULES, [bid('a', 'x', 50_000)]), euros(51_000));
});

const ctx = (over: Partial<Parameters<typeof checkBid>[1]> = {}) => ({
  lot: DEMO_LOT, rules: DEMO_RULES, status: 'active' as const, bids: [bid('a', 'other', 42_500)],
  endsAt: 10_000, serverNow: 5_000, bidderId: 'me', authenticated: true, lotId: DEMO_LOT.lotId, ...over,
});

test('bid validation (server rules)', () => {
  assert.equal(checkBid(euros(43_000), ctx()).ok, true);
  assert.equal(checkBid(euros(44_000), ctx()).ok, true, 'above minimum on step is allowed');
  assert.equal(checkBid(euros(42_500), ctx()).code, 'BELOW_MINIMUM', 'current price is not a valid bid');
  assert.equal(checkBid(euros(43_250), ctx()).code, 'NOT_ON_STEP');
  assert.equal(checkBid(euros(43_000), ctx({ authenticated: false })).code, 'UNAUTHENTICATED');
  assert.equal(checkBid(euros(43_000), ctx({ serverNow: 10_000 })).code, 'ENDED');
  assert.equal(checkBid(euros(43_000), ctx({ status: 'suspended' })).code, 'NOT_ACTIVE');
  assert.equal(checkBid(euros(43_000), ctx({ bids: [bid('a', 'me', 42_500)] })).code, 'ALREADY_HIGHEST');
  assert.equal(checkBid(euros(43_000), ctx({ lotId: 'OTHER' })).code, 'WRONG_LOT');
  assert.equal(checkBid(euros(1_000_500), ctx()).code, 'ABOVE_HOUSE_MAX', 'the backend maximum is 1 000 000 €');
  assert.equal(checkBid(euros(1_000_000), ctx()).ok, true);
});

test('anti-sniping extension', () => {
  assert.equal(extendedEnd(100_000, 70_000, DEMO_RULES), null);
  assert.equal(extendedEnd(100_000, 85_000, DEMO_RULES), 105_000);
});

const ev = (seq: number, eur: number): AuctionEvent => ({ type: 'bid', seq, serverTime: seq, bid: bid(`b${seq}`, 'x', eur, seq) });
const snap = (seq: number): SnapshotEvent => ({ type: 'snapshot', seq, serverTime: 0, lot: DEMO_LOT, rules: DEMO_RULES, status: 'active', endsAt: 1e9, bids: [bid('b0', 'x', 40_000)] });

test('reducer: in order, duplicates, out-of-order, gaps and resync', () => {
  let s = applyEvent(initialAuctionState(), snap(1), 0).state;
  s = applyEvent(s, ev(2, 40_500), 0).state;
  s = applyEvent(s, ev(2, 40_500), 0).state; // duplicate
  assert.equal(s.bids.length, 2);
  assert.equal(s.stats.duplicates, 1);
  // 4 arrives before 3 → buffered, then drained when 3 arrives
  let r = applyEvent(s, ev(4, 41_500), 100);
  assert.equal(r.applied.length, 0);
  assert.equal(r.state.buffer.length, 1);
  r = applyEvent(r.state, ev(3, 41_000), 200);
  assert.deepEqual(r.applied.map((e) => e.seq), [3, 4]);
  assert.equal(highestBid(r.state.bids)!.amount, euros(41_500));
  assert.equal(r.state.gapSince, null);
  // gap that never fills → resync flagged after timeout, snapshot clears it
  let g = applyEvent(r.state, ev(7, 43_000), 1000).state;
  assert.equal(checkGap(g, 1000 + GAP_TIMEOUT_MS - 1).needsResync, false);
  g = checkGap(g, 1000 + GAP_TIMEOUT_MS + 1);
  assert.equal(g.needsResync, true);
  const fresh = applyEvent(g, { ...snap(9), bids: [bid('z', 'q', 44_000)] }, 3000).state;
  assert.equal(fresh.needsResync, false);
  assert.equal(fresh.buffer.length, 0, 'buffered events older than the snapshot are dropped');
  assert.equal(highestBid(fresh.bids)!.amount, euros(44_000));
});

test('reducer: extensions never move the end earlier', () => {
  let s = applyEvent(initialAuctionState(), snap(1), 0).state;
  s = applyEvent(s, { type: 'extension', seq: 2, serverTime: 0, endsAt: 5, byMs: 0 }, 0).state;
  assert.equal(s.endsAt, 1e9);
});

test('server clock: corrects skew from round-trip samples', () => {
  let local = 1_000_000;
  const c = new ServerClock(() => local);
  // server is 2 300 ms ahead; RTT 100 ms
  c.sample({ sentAt: local - 100, serverTime: local - 50 + 2300, receivedAt: local });
  assert.ok(Math.abs(c.offsetMs - 2300) < 1);
  local += 10_000;
  assert.equal(c.remainingMs(local + 2300 + 60_000), 60_000);
  assert.equal(formatCountdown(61_000), '01:01');
  assert.equal(formatCountdown(400), '00:01');
  assert.equal(formatCountdown(0), '00:00');
});

const stateWith = (bids: BidRecord[], status: 'active' | 'ended' = 'active') => ({
  ...initialAuctionState(), lot: DEMO_LOT, rules: DEMO_RULES, status, endsAt: 200_000, bids,
});

test('advisor never shows a success probability and explains itself', () => {
  const a = advise({ auction: stateWith([bid('a', 'other', 42_500, 100_000)]), cap: euros(48_000), myBidderId: 'me', serverNow: 100_000, connection: 'online' });
  assert.equal(a.action, 'can_bid');
  assert.equal(a.nextValid, euros(43_000));
  assert.equal(a.probabilityText, NO_PROBABILITY);
  assert.ok(a.reasons.length >= 2);
  assert.ok(!/%/.test(JSON.stringify(a)), 'no percentages anywhere in the advice');
});

test('chosen bid amounts are rounded up to valid bids on the step grid', () => {
  assert.equal(alignBid(euros(43_250), euros(43_000), euros(500)), euros(43_500));
  assert.equal(alignBid(euros(42_000), euros(43_000), euros(500)), euros(43_000), 'never below the next valid bid');
  assert.equal(alignBid(euros(53_000), euros(43_000), euros(500)), euros(53_000));
  assert.equal(currentStep(DEMO_LOT, DEMO_RULES, []), euros(100));
  assert.equal(currentStep(DEMO_LOT, DEMO_RULES, [bid('a', 'x', 50_000)]), euros(1_000));
});

test('advisor without a personal limit: declared retail value is the only reference', () => {
  const retail = DEMO_LOT.retailValue!;
  const a = advise({ auction: stateWith([bid('a', 'other', 48_000, 100_000)]), cap: null, myBidderId: 'me', serverNow: 100_000, connection: 'online' });
  assert.equal(a.action, 'can_bid');
  assert.equal(a.reference, 'retail');
  assert.equal(a.nextValid, euros(48_500));
  assert.match(a.headline, new RegExp(`${Math.round((euros(48_500) / retail) * 100)} % от обявената retail стойност`));
  assert.ok(a.reasons.some((r) => r.includes('не наша оценка')), 'states that retail is lot data, not an estimate');
  assert.equal(a.probabilityText, NO_PROBABILITY);
  const over = advise({ auction: stateWith([bid('a', 'other', retail / 100, 100_000)]), cap: null, myBidderId: 'me', serverNow: 100_000, connection: 'online' });
  assert.equal(over.risk, 'над retail');
  assert.match(over.headline, /^Внимание/);
  const none = advise({ auction: { ...stateWith([bid('a', 'other', 1_000, 100_000)]), lot: { ...DEMO_LOT, retailValue: null } }, cap: null, myBidderId: 'me', serverNow: 100_000, connection: 'online' });
  assert.equal(none.reference, null);
  assert.equal(none.headline, `Следващата валидна оферта е ${formatEur(euros(1_100))}.`);
});

test('advisor: over limit, leading, offline, ended, no limit', () => {
  const s = stateWith([bid('a', 'other', 48_000, 100_000)]);
  assert.equal(advise({ auction: s, cap: euros(48_000), myBidderId: 'me', serverNow: 100_000, connection: 'online' }).action, 'stop_over_limit');
  assert.equal(advise({ auction: stateWith([bid('a', 'me', 42_500, 100_000)]), cap: euros(48_000), myBidderId: 'me', serverNow: 100_000, connection: 'online' }).action, 'wait_leading');
  assert.equal(advise({ auction: s, cap: euros(60_000), myBidderId: 'me', serverNow: 100_000, connection: 'offline' }).action, 'offline');
  assert.equal(advise({ auction: stateWith([], 'ended'), cap: euros(60_000), myBidderId: 'me', serverNow: 100_000, connection: 'online' }).action, 'ended');
  assert.equal(advise({ auction: s, cap: null, myBidderId: 'me', serverNow: 100_000, connection: 'online' }).action, 'can_bid', 'no personal limit: bidding is allowed');
});

test('money formatting and parsing (bg-BG)', () => {
  assert.equal(formatEur(euros(42_500)), '42 500 €');
  assert.equal(parseEurInput('48 000'), euros(48_000));
  assert.equal(parseEurInput('48 000 €'), euros(48_000));
  assert.equal(parseEurInput('abc'), null);
  assert.equal(parseEurInput('-5'), null);
});
