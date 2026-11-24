import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainLog, verifyChain, type ChainEvent } from '../../src/deal/chain.js';
import { DEAL_RULES, DECIDE_MS, invoiceOf, payDeadline, penaltyFor, type Actor, type DealBody, type DealState, type WonInfo } from '../../src/deal/office.js';
import { CITIES, quoteTransport, roadKm } from '../../src/deal/transport.js';
import { encodeQr } from '../../src/deal/qr.js';
import { runnerUps } from '../../src/deal/book.js';
import { checkVin } from '../../src/deal/vin.js';
import { euros } from '../../src/domain/money.js';

const T0 = new Date(2026, 10, 23, 18, 0, 0).getTime(); // Monday 23 Nov 2026, 18:00 local
const WON: WonInfo = {
  dealId: 'd1', lotId: 'DEMO-0001', title: 'E&A концептуално купе', vin: 'EADEMXC0NCEPT0001', amount: euros(43_000), origin: 'EU',
  location: 'София, BG', wonAt: T0, specs: [], viaSecondChance: false, runnerUps: [{ bidderId: 'Купувач-7', amount: euros(42_500) }],
};

function newLog(clock: { t: number }) { return new ChainLog<Actor, DealBody, DealState>(DEAL_RULES, () => clock.t); }

async function wonWithDeposit(clock: { t: number }) {
  const log = newLog(clock);
  assert.equal((await log.append('server', { type: 'won', ...WON })).ok, true);
  assert.equal((await log.append('provider', { type: 'deposit_held', amount: penaltyFor(WON.amount), captureBy: T0 + 29 * 864e5 })).ok, true);
  return log;
}

test('policy: penalty is 10 % with a 300 € minimum; payment due end of the 3rd business day', () => {
  assert.equal(penaltyFor(euros(43_000)), euros(4_300));
  assert.equal(penaltyFor(euros(1_000)), euros(300));
  const due = new Date(payDeadline(T0)); // Mon → Wed
  assert.deepEqual([due.getDate(), due.getHours(), due.getMinutes()], [25, 23, 59]);
  const fri = new Date(2026, 10, 27, 12).getTime();
  assert.equal(new Date(payDeadline(fri)).getDate(), 1, 'Fri sale → Tue 1 Dec (weekend skipped)');
  const sat = new Date(2026, 10, 28, 12).getTime();
  assert.equal(new Date(payDeadline(sat)).getDate(), 2, 'Sat sale → Wed 2 Dec (day of sale not a business day)');
});

test('authority: only the server records the winner, only the provider confirms payment', async () => {
  const clock = { t: T0 };
  const log = newLog(clock);
  assert.equal((await log.append('buyer', { type: 'won', ...WON })).ok, false, 'a buyer cannot make himself the winner');
  await log.append('server', { type: 'won', ...WON });
  const r = await log.append('buyer', { type: 'deposit_held', amount: penaltyFor(WON.amount), captureBy: 0 });
  assert.equal(r.ok, false);
  assert.equal((await log.append('buyer', { type: 'approved' })).ok, false, 'cannot approve before the deposit is held');
});

test('happy path: approve → delivery → sign → pay exactly the invoice → documents → transport → protocol', async () => {
  const clock = { t: T0 + 60_000 };
  const log = await wonWithDeposit(clock);
  assert.equal((await log.append('buyer', { type: 'approved' })).ok, true);
  assert.equal((await log.append('esign', { type: 'signed', contractHash: 'a'.repeat(64) })).ok, false, 'no signing before delivery is chosen');
  assert.equal((await log.append('buyer', { type: 'delivery_chosen', mode: 'delivery', cityId: 'varna', carriage: 'truck' })).ok, true);
  assert.equal((await log.append('esign', { type: 'signed', contractHash: 'a'.repeat(64) })).ok, true);
  const inv = invoiceOf(log.state)!;
  assert.equal(inv.due, inv.gross - euros(4_300), 'deposit is deducted');
  assert.ok(inv.lines.some((l) => l.key === 'transport'), 'transport line in the invoice');
  assert.equal((await log.append('buyer', { type: 'paid', amount: inv.due, ref: 'x' })).ok, false, 'a button cannot mark it paid');
  assert.equal((await log.append('provider', { type: 'paid', amount: inv.due - 1, ref: 'x' })).ok, false, 'amount must match the invoice');
  assert.equal((await log.append('provider', { type: 'paid', amount: inv.due, ref: 'x' })).ok, true);
  assert.equal((await log.append('server', { type: 'docs_issued', docs: [{ kind: 'invoice', hash: 'b'.repeat(64) }] })).ok, true);
  assert.equal((await log.append('carrier', { type: 'picked_up' })).ok, true);
  assert.equal((await log.append('carrier', { type: 'gps', progress: 0.5, lat: 43, lng: 25 })).ok, true);
  assert.equal((await log.append('carrier', { type: 'gps', progress: 0.4, lat: 43, lng: 25 })).ok, false, 'GPS never goes back');
  assert.equal((await log.append('buyer', { type: 'received', carOk: true, docsOk: true })).ok, false, 'not before delivery');
  assert.equal((await log.append('carrier', { type: 'delivered' })).ok, true);
  assert.equal((await log.append('buyer', { type: 'received', carOk: true, docsOk: true })).ok, true);
  assert.equal(log.state.phase, 'completed');
  assert.equal((await verifyChain(log.events, DEAL_RULES)).ok, true);
});

test('think and consult: once each; the broker may extend once by 24 h', async () => {
  const clock = { t: T0 + 1000 };
  const log = await wonWithDeposit(clock);
  assert.equal((await log.append('buyer', { type: 'think' })).ok, true);
  assert.equal((await log.append('buyer', { type: 'think' })).ok, false);
  assert.equal((await log.append('broker', { type: 'consult_extended' })).ok, false, 'no extension without a consultation');
  assert.equal((await log.append('buyer', { type: 'consult_requested' })).ok, true);
  assert.equal((await log.append('broker', { type: 'consult_extended' })).ok, true);
  assert.equal(log.state.decideBy, T0 + 2 * DECIDE_MS);
  assert.equal((await log.append('broker', { type: 'consult_extended' })).ok, false);
  assert.equal((await log.append('broker', { type: 'approved' })).ok, false, 'the broker cannot decide for the buyer');
});

test('decline: penalty from the deposit, then the second chance; expiry only after the deadline', async () => {
  const clock = { t: T0 + 1000 };
  const log = await wonWithDeposit(clock);
  assert.equal((await log.append('server', { type: 'declined', penalty: euros(4_300), reason: 'expired' })).ok, false, 'not expired yet');
  assert.equal((await log.append('buyer', { type: 'declined', penalty: euros(100), reason: 'buyer' })).ok, false, 'penalty fixed by the rules');
  assert.equal((await log.append('buyer', { type: 'declined', penalty: euros(4_300), reason: 'buyer' })).ok, true);
  assert.equal((await log.append('provider', { type: 'penalty_captured', amount: euros(4_300) })).ok, true);
  assert.equal((await log.append('server', { type: 'resold', to: 'x', amount: 1 })).ok, false, 'no result before an offer');
  assert.equal((await log.append('server', { type: 'passed_on', to: 'Купувач-7', amount: euros(42_500) })).ok, true);
  assert.equal((await log.append('server', { type: 'resold', to: 'Купувач-7', amount: euros(42_500) })).ok, true);
  assert.equal(log.state.secondChance?.result, 'resold');

  const c2 = { t: T0 + 1000 };
  const log2 = await wonWithDeposit(c2);
  c2.t = T0 + DECIDE_MS + 1;
  assert.equal((await log2.append('buyer', { type: 'approved' })).ok, false, 'too late to approve');
  assert.equal((await log2.append('server', { type: 'declined', penalty: euros(4_300), reason: 'expired' })).ok, true);
});

test('tampering with any event breaks the chain', async () => {
  const clock = { t: T0 + 1000 };
  const log = await wonWithDeposit(clock);
  await log.append('buyer', { type: 'approved' });
  const forged = JSON.parse(JSON.stringify(log.events)) as ChainEvent<Actor, DealBody>[];
  (forged[0]!.body as { amount: number }).amount = euros(1_000);
  const r = await verifyChain(forged, DEAL_RULES);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 1);
  const dropped = log.events.filter((e) => e.seq !== 2);
  assert.equal((await verifyChain(dropped, DEAL_RULES)).ok, false);
});

test('transport quote: formula lines add up, VAT 20 %, distance ≈ straight line × 1.25', () => {
  const sofia = CITIES.find((c) => c.id === 'sofia')!, varna = CITIES.find((c) => c.id === 'varna')!;
  const km = roadKm(sofia, varna);
  assert.ok(km > 450 && km < 500, `Sofia–Varna ≈ ${km} km`);
  const q = quoteTransport(sofia, varna, 'truck', true, euros(40_000));
  assert.equal(q.net, q.lines.reduce((s, l) => s + l.amount, 0));
  assert.equal(q.vat, Math.round(q.net * 0.2));
  assert.equal(q.total, q.net + q.vat);
  const notRunning = quoteTransport(sofia, varna, 'truck', false, euros(40_000));
  assert.ok(notRunning.total > q.total, 'a car that does not run costs more');
});

test('QR: picks the smallest version, draws the three finder patterns', () => {
  const q = encodeQr('https://example.test/#/passport/EADEMXC0NCEPT0001');
  assert.ok(q.version >= 3 && q.version <= 5);
  assert.equal(q.size, q.version * 4 + 17);
  for (const [x, y] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]] as const) {
    assert.equal(q.modules[y]![x], true);
    assert.equal(q.modules[y + 1]![x + 1], false);
    assert.equal(q.modules[y + 3]![x + 3], true);
  }
  assert.throws(() => encodeQr('x'.repeat(400)));
});

test('second chance: runner-ups are each other bidder’s best bid, highest first; demo VINs are valid', () => {
  const bids = [
    { bidId: '1', bidderId: 'A', amount: 100, serverTime: 1 }, { bidId: '2', bidderId: 'B', amount: 200, serverTime: 2 },
    { bidId: '3', bidderId: 'A', amount: 300, serverTime: 3 }, { bidId: '4', bidderId: 'Ти', amount: 400, serverTime: 4 },
  ];
  assert.deepEqual(runnerUps(bids, 'Ти'), [{ bidderId: 'A', amount: 300 }, { bidderId: 'B', amount: 200 }]);
  assert.equal(checkVin('EADEMXC0NCEPT0001').ok, true);
  assert.equal(checkVin('WP0ZZZ99ZNSDEM001').ok, true);
});
