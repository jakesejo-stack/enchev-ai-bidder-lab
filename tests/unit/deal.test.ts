import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVin } from '../../src/deal/vin.js';
import { sniffMime, memoryFileStore, verifyStoredFile } from '../../src/deal/files.js';
import { DealLog, hashEvent, verifyChain } from '../../src/deal/chain.js';
import { AUTHORITY, CHECKLIST_TOTAL, checklistDone, currentStage, docStatus, nextStep, refuse, type Actor, type DealBody, type DocType, type FileMeta } from '../../src/deal/model.js';
import { DealService, vinOf } from '../../src/deal/service.js';
import { CONCEPT_LOT, PORSCHE_LOT } from '../../src/adapters/demo-lots.js';
import { DEMO_RULES } from '../../src/adapters/demo-server.js';
import { applyEvent, initialAuctionState } from '../../src/domain/reducer.js';
import type { AuctionEvent } from '../../src/domain/types.js';

const VIN = 'EADEMXC0NCEPT0001';
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
let n = 0;
const file = (extra: Partial<FileMeta> = {}): FileMeta => ({ fileId: `f${++n}`, name: 'doc.pdf', mime: 'application/pdf', size: 1000, sha256: 'a'.repeat(64), ...extra });
const PDF = () => new Blob([new TextEncoder().encode(`%PDF-1.4 sample ${++n}`)]);

async function opened(): Promise<DealLog> {
  let t = 1_000;
  const log = new DealLog(() => (t += 1000));
  const r = await log.append('auction_server', { type: 'deal_opened', lotId: 'DEMO-0001', vin: VIN, title: 'E&A', demo: true });
  assert.ok(r.ok);
  return log;
}
async function ok(log: DealLog, actor: Actor, body: DealBody) {
  const r = await log.append(actor, body);
  assert.ok(r.ok, r.ok ? '' : `${actor} ${body.type}: ${r.code} ${r.message}`);
}
async function up(log: DealLog, actor: Actor, doc: DocType, extra: Partial<FileMeta> = {}) { await ok(log, actor, { type: 'doc_uploaded', doc, file: file(extra) }); }
async function approve(log: DealLog, doc: DocType, vinMatches?: boolean) {
  const f = log.state.docs[doc].versions.at(-1)!;
  await ok(log, 'admin', { type: 'doc_reviewed', doc, fileId: f.fileId, decision: 'approved', note: '', ...(vinMatches !== undefined ? { vinMatches } : {}) });
}

test('VIN: 17 chars without I/O/Q; check digit only a warning', () => {
  assert.equal(checkVin(VIN).ok, true);
  assert.equal(checkVin('wp0zzz99znsdem001').vin, 'WP0ZZZ99ZNSDEM001');
  assert.equal(checkVin('1M8GDM9AXKP042788').checkDigitOk, true); // ISO 3779 textbook example
  assert.equal(checkVin('1M8GDM9A1KP042788').checkDigitOk, false);
  assert.equal(checkVin('1M8GDM9A1KP042788').ok, true);
  assert.equal(checkVin('EADEMO00000000001').ok, false); // contains O
  assert.equal(checkVin('SHORT').ok, false);
  assert.equal(vinOf(CONCEPT_LOT), VIN);
  assert.equal(vinOf(PORSCHE_LOT), 'WP0ZZZ99ZNSDEM001');
});

test('file type comes from the bytes, not the name', () => {
  const b = (...x: number[]) => new Uint8Array(x);
  assert.equal(sniffMime(new TextEncoder().encode('%PDF-1.7')), 'application/pdf');
  assert.equal(sniffMime(b(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(new TextEncoder().encode('\0\0\0\x18ftypheic')), 'image/heic');
  assert.equal(sniffMime(new TextEncoder().encode('MZ\x90\0 not allowed')), null);
  assert.equal(sniffMime(new TextEncoder().encode('<html>')), null);
});

test('full deal: 8 stages from documents to buyer receipt, only by the right actors', async () => {
  const log = await opened();
  assert.equal(currentStage(log.state), 1);
  await up(log, 'seller', 'vin_photos', { mime: 'image/jpeg' });
  await up(log, 'seller', 'registration');
  await up(log, 'seller', 'ownership');
  assert.equal(currentStage(log.state), 2);
  await approve(log, 'vin_photos', true); await approve(log, 'registration', true); await approve(log, 'ownership');
  assert.equal(currentStage(log.state), 3);
  assert.equal(log.state.docs.vin_photos.reviews[0]!.at > 0, true, 'review has date and time');
  await ok(log, 'auction_server', { type: 'auction_started', startedAt: 5_000 });
  assert.deepEqual(log.state.warnings, []);
  await ok(log, 'auction_server', { type: 'winner_confirmed', bidderId: 'you', amount: 4_000_000, bidId: 'b9', endedAt: 9_000, bids: 12 });
  assert.equal(currentStage(log.state), 5);
  await up(log, 'seller', 'invoice', { amount: 4_250_000 });
  await approve(log, 'invoice');
  await up(log, 'buyer', 'payment_proof', { mime: 'image/png' });
  assert.equal(currentStage(log.state), 6, 'an uploaded payment order is not a payment');
  await ok(log, 'payment_provider', { type: 'payment_confirmed', amount: 4_250_000, reference: 'PAY-1' });
  await up(log, 'seller', 'transfer_poa'); await approve(log, 'transfer_poa');
  await up(log, 'seller', 'pickup_auth'); await approve(log, 'pickup_auth');
  await ok(log, 'carrier', { type: 'transport', step: 'picked_up' });
  await up(log, 'carrier', 'cmr'); await approve(log, 'cmr');
  await ok(log, 'carrier', { type: 'transport', step: 'in_transit' });
  await ok(log, 'carrier', { type: 'transport', step: 'delivered' });
  assert.equal(currentStage(log.state), 8);
  await up(log, 'carrier', 'delivery_protocol'); await approve(log, 'delivery_protocol');
  await ok(log, 'buyer', { type: 'receipt_confirmed', car: true, originals: true });
  assert.equal(currentStage(log.state), 9);
  assert.equal(checklistDone(log.state), CHECKLIST_TOTAL);
  assert.equal(nextStep(log.state), null);
  assert.deepEqual(await verifyChain(log.events), { ok: true, count: log.events.length });
});

test('authority: AI and user roles can never confirm WINNER, payment or ownership', async () => {
  const log = await opened();
  const winner: DealBody = { type: 'winner_confirmed', bidderId: 'you', amount: 100, bidId: 'b', endedAt: 1, bids: 1 };
  const pay: DealBody = { type: 'payment_confirmed', amount: 100, reference: 'x' };
  for (const a of ['ai', 'buyer', 'seller', 'admin', 'carrier', 'payment_provider'] as Actor[]) assert.equal(refuse(log.state, a, winner)?.code, 'FORBIDDEN', a);
  for (const a of ['ai', 'buyer', 'seller', 'admin', 'carrier', 'auction_server'] as Actor[]) assert.equal(refuse(log.state, a, pay)?.code, 'FORBIDDEN', a);
  // AI may record nothing at all.
  for (const [type, actors] of Object.entries(AUTHORITY)) assert.ok(!actors.includes('ai'), type);
  // Documents: only the defined uploader; only the admin reviews (never the uploader).
  assert.equal(refuse(log.state, 'buyer', { type: 'doc_uploaded', doc: 'ownership', file: file() })?.code, 'WRONG_UPLOADER');
  assert.equal(refuse(log.state, 'admin', { type: 'doc_uploaded', doc: 'ownership', file: file() })?.code, 'FORBIDDEN');
  await up(log, 'seller', 'ownership');
  const f = log.state.docs.ownership.versions[0]!;
  assert.equal(refuse(log.state, 'seller', { type: 'doc_reviewed', doc: 'ownership', fileId: f.fileId, decision: 'approved', note: '' })?.code, 'FORBIDDEN');
  // Receipt needs both the car and the original documents.
  const r = await log.append('buyer', { type: 'receipt_confirmed', car: true, originals: false });
  assert.equal(r.ok, false);
});

test('payment: provider amount must equal the approved invoice; nothing before WINNER', async () => {
  const log = await opened();
  assert.equal(refuse(log.state, 'seller', { type: 'doc_uploaded', doc: 'invoice', file: file({ amount: 100 }) })?.code, 'TOO_EARLY');
  await ok(log, 'auction_server', { type: 'auction_started', startedAt: 1 });
  assert.equal(log.state.warnings.length, 1, 'auction started before documents were approved → warning');
  await ok(log, 'auction_server', { type: 'winner_confirmed', bidderId: 'p2', amount: 500_000, bidId: 'b', endedAt: 2, bids: 3 });
  assert.equal(refuse(log.state, 'seller', { type: 'doc_uploaded', doc: 'invoice', file: file({ amount: 100 }) })?.code, 'BELOW_WIN');
  assert.equal(refuse(log.state, 'seller', { type: 'doc_uploaded', doc: 'invoice', file: file() })?.code, 'NO_AMOUNT');
  assert.equal(refuse(log.state, 'payment_provider', { type: 'payment_confirmed', amount: 500_000, reference: 'r' })?.code, 'NO_INVOICE');
  await up(log, 'seller', 'invoice', { amount: 520_000 });
  assert.equal(refuse(log.state, 'payment_provider', { type: 'payment_confirmed', amount: 520_000, reference: 'r' })?.code, 'NO_INVOICE', 'invoice not yet approved');
  await approve(log, 'invoice');
  assert.equal(refuse(log.state, 'payment_provider', { type: 'payment_confirmed', amount: 500_000, reference: 'r' })?.code, 'AMOUNT_MISMATCH');
  assert.equal(refuse(log.state, 'carrier', { type: 'transport', step: 'picked_up' })?.code, 'NOT_RELEASED');
  assert.equal(refuse(log.state, 'auction_server', { type: 'winner_confirmed', bidderId: 'x', amount: 1, bidId: 'c', endedAt: 3, bids: 1 })?.code, 'ALREADY_DECIDED');
});

test('admin review: VIN match required, rejection needs a reason, approved documents are locked', async () => {
  const log = await opened();
  await up(log, 'seller', 'vin_photos', { mime: 'image/jpeg' });
  const f1 = log.state.docs.vin_photos.versions[0]!;
  assert.equal(refuse(log.state, 'admin', { type: 'doc_reviewed', doc: 'vin_photos', fileId: f1.fileId, decision: 'approved', note: '' })?.code, 'VIN_NOT_CONFIRMED');
  assert.equal(refuse(log.state, 'admin', { type: 'doc_reviewed', doc: 'vin_photos', fileId: f1.fileId, decision: 'rejected', note: '' })?.code, 'NEED_NOTE');
  await ok(log, 'admin', { type: 'doc_reviewed', doc: 'vin_photos', fileId: f1.fileId, decision: 'rejected', note: 'VIN не се чете' });
  assert.equal(docStatus(log.state.docs.vin_photos), 'rejected');
  assert.equal(nextStep(log.state)?.who, 'seller');
  await up(log, 'seller', 'vin_photos', { mime: 'image/jpeg' });
  assert.equal(docStatus(log.state.docs.vin_photos), 'pending');
  assert.equal(refuse(log.state, 'admin', { type: 'doc_reviewed', doc: 'vin_photos', fileId: f1.fileId, decision: 'approved', note: '', vinMatches: true })?.code, 'STALE');
  await approve(log, 'vin_photos', true);
  assert.equal(refuse(log.state, 'seller', { type: 'doc_uploaded', doc: 'vin_photos', file: file() })?.code, 'LOCKED');
  assert.equal(log.state.docs.vin_photos.versions.length, 2, 'both versions stay in the history');
});

test('hash chain: edits, deletions and forged actors are detected', async () => {
  const log = await opened();
  await up(log, 'seller', 'ownership');
  await ok(log, 'auction_server', { type: 'auction_started', startedAt: 1 });
  const good = structuredClone(log.events);
  assert.equal((await verifyChain(good)).ok, true);

  const edited = structuredClone(good);
  (edited[1]!.body as { file: FileMeta }).file.name = 'other.pdf';
  assert.deepEqual([(await verifyChain(edited)).ok, (await verifyChain(edited)).brokenAt], [false, 2]);

  const removed = structuredClone(good); removed.splice(1, 1);
  assert.equal((await verifyChain(removed)).ok, false);

  // A correctly re-hashed event with a forbidden actor (buyer "confirms" the winner) is still refused.
  const forged = structuredClone(good);
  const draft = { seq: 4, at: 9, actor: 'buyer' as Actor, body: { type: 'winner_confirmed', bidderId: 'me', amount: 1, bidId: 'z', endedAt: 9, bids: 1 } as DealBody, prev: good[2]!.hash };
  forged.push({ ...draft, hash: await hashEvent(draft) });
  const c = await verifyChain(forged);
  assert.equal(c.ok, false);
  assert.match(c.reason!, /Недопустимо/);

  const fresh = new DealLog();
  assert.equal((await fresh.load(edited)).ok, false);
  assert.equal(fresh.state.key, null, 'a broken log is never loaded');
});

test('service: deal opened from the auction stream by LOT ID + VIN; WINNER from the server; persisted', async () => {
  const storage = memory();
  const files = memoryFileStore();
  let now = 50_000;
  const svc = new DealService({ now: () => now, demo: true, storage, files, providerDelayMs: 0 });
  const stages: number[] = [];
  svc.stageTaps.push((s) => stages.push(s));
  let a = initialAuctionState();
  const feed = async (e: AuctionEvent) => { a = applyEvent(a, e, 0).state; svc.onAuctionEvent(e, a); await new Promise((r) => setTimeout(r, 10)); };
  await feed({ type: 'snapshot', seq: 1, serverTime: 1_000, lot: CONCEPT_LOT, rules: DEMO_RULES, status: 'active', endsAt: 100_000, bids: [] });
  assert.equal(svc.key, `DEMO-0001|${VIN}`);
  assert.equal(svc.state.auctionStartedAt, 1_000);
  await feed({ type: 'bid', seq: 2, serverTime: 2_000, bid: { bidId: 'b1', bidderId: 'p1', amount: 10_000, serverTime: 2_000 } });
  await feed({ type: 'bid', seq: 3, serverTime: 3_000, bid: { bidId: 'b2', bidderId: 'you', amount: 20_000, serverTime: 3_000 } });
  await feed({ type: 'status', seq: 4, serverTime: 4_000, status: 'ended' });
  assert.deepEqual(svc.state.winner, { bidderId: 'you', amount: 20_000, bidId: 'b2', at: 4_000, bids: 2 });
  await feed({ type: 'snapshot', seq: 5, serverTime: 4_500, lot: CONCEPT_LOT, rules: DEMO_RULES, status: 'ended', endsAt: 4_000, bids: [] });
  assert.equal(svc.log.events.filter((e) => e.body.type === 'winner_confirmed').length, 1, 'winner recorded once');

  // Files: hash verified against storage; the simulated provider confirms only after invoice approval + proof.
  const inv = await svc.upload('seller', 'invoice', PDF(), 25_000);
  assert.ok(inv.ok);
  await svc.upload('buyer', 'payment_proof', PDF());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(svc.state.payment, null, 'no payment before the invoice is approved');
  await svc.review('invoice', 'approved', '');
  await new Promise((r) => setTimeout(r, 30));
  const paid = svc.state.payment as { amount: number; reference: string } | null;
  assert.equal(paid?.amount, 25_000);
  assert.match(paid!.reference, /^DEMO-PAY-/);
  const meta = svc.state.docs.invoice.versions[0]!;
  assert.equal(await verifyStoredFile(files, meta), 'ok');
  const bad = await svc.upload('seller', 'ownership', new Blob(['MZ not a pdf']));
  assert.equal(bad.ok, false);
  assert.ok(stages.includes(4) && stages.includes(6), `stages seen: ${stages}`);

  // Reload on the same device: the same deal comes back from storage (chain verified).
  const again = new DealService({ now: () => now, demo: true, storage, files });
  await again.attachLot(CONCEPT_LOT);
  assert.equal(again.log.events.length, svc.log.events.length);
  assert.equal(again.state.winner?.bidId, 'b2');
  now++;
});

test('service: a real (non-demo) build never simulates the payment provider', async () => {
  const svc = new DealService({ now: () => 1, demo: false, storage: null, files: memoryFileStore(), providerDelayMs: 0 });
  await svc.attachLot(CONCEPT_LOT);
  await svc.log.append('auction_server', { type: 'auction_started', startedAt: 1 });
  await svc.log.append('auction_server', { type: 'winner_confirmed', bidderId: 'you', amount: 100, bidId: 'b', endedAt: 2, bids: 1 });
  await svc.upload('seller', 'invoice', PDF(), 100);
  await svc.review('invoice', 'approved', '');
  await svc.upload('buyer', 'payment_proof', PDF());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(svc.state.payment, null);
  await svc.resetDemo();
  assert.ok(svc.log.events.length > 1, 'reset is DEMO-only');
});

test('service: a lot without a valid VIN cannot open a deal', async () => {
  const svc = new DealService({ now: () => 1, demo: true, storage: null, files: memoryFileStore() });
  await svc.attachLot({ ...CONCEPT_LOT, lotId: 'X-1', details: [{ label: 'VIN', value: 'EADEMO00000000001' }] });
  assert.equal(svc.key, null);
  assert.match(svc.unavailable!, /VIN/);
});
