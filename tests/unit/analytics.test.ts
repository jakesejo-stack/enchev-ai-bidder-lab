import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsStore, EventRecorder, MAX_AUCTIONS, RETENTION_MS, type RecAuction } from '../../src/analytics/store.js';
import { auctionsCsv, bidsCsv, csvCell, parseDay, rangeFor, summarize } from '../../src/analytics/aggregate.js';
import { availableSources, defaultSource, demoAllowed } from '../../src/analytics/sources.js';
import { generateDemoHistory } from '../../src/analytics/demo-history.js';
import { DEMO_LOT, DEMO_RULES } from '../../src/adapters/demo-server.js';
import { euros } from '../../src/domain/money.js';
import type { AuctionEvent, BidRecord } from '../../src/domain/types.js';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
const bid = (id: string, who: string, eur: number, t: number): BidRecord => ({ bidId: id, bidderId: who, amount: euros(eur), serverTime: t });
const H = 3600_000, D = 24 * H;

test('recorder: server events → one auction record (resync merged, duplicates ignored, extensions, end)', () => {
  const store = new AnalyticsStore(null, () => 10_000);
  const rec = new EventRecorder(store, 'me', 'demo-session');
  const base = { lot: DEMO_LOT, rules: DEMO_RULES, status: 'active' as const, endsAt: 200_000 };
  rec.record({ type: 'snapshot', seq: 1, serverTime: 1_000, ...base, bids: [] });
  rec.record({ type: 'bid', seq: 2, serverTime: 2_000, bid: bid('b1', 'p1', 100, 2_000) });
  rec.record({ type: 'bid', seq: 3, serverTime: 3_000, bid: bid('b2', 'me', 5_000, 3_000) });
  rec.record({ type: 'snapshot', seq: 3, serverTime: 3_500, ...base, bids: [bid('b1', 'p1', 100, 2_000), bid('b2', 'me', 5_000, 3_000)] });
  rec.record({ type: 'extension', seq: 4, serverTime: 4_000, endsAt: 220_000, byMs: 20_000 });
  rec.record({ type: 'extension', seq: 5, serverTime: 4_100, endsAt: 4_200, byMs: 0 }); // demo "end soon": not an extension
  rec.record({ type: 'status', seq: 6, serverTime: 9_000, status: 'ended' });
  assert.equal(store.auctions.length, 1);
  const a = store.auctions[0]!;
  assert.equal(a.bids.length, 2, 'resync did not double-count');
  assert.deepEqual(a.ext, [4_000]);
  assert.equal(a.endedAt, 9_000);
  assert.equal(a.bids[1]!.mine, true);
  rec.record({ type: 'lot_change', seq: 7, serverTime: 10_000, ...base, bids: [] });
  assert.equal(store.auctions.length, 2, 'lot_change starts a new auction run');
});

test('ranges: 24H by hour, 7D/30D by local day, custom dates inclusive, LIVE at least 3 minutes', () => {
  const now = new Date(2026, 10, 22, 21, 37, 12).getTime();
  const r24 = rangeFor('24h', now);
  assert.equal(r24.bucketMs, H);
  assert.equal(new Date(r24.from).getMinutes(), 0);
  const r7 = rangeFor('7d', now);
  assert.equal(new Date(r7.from).getHours(), 0);
  assert.equal(Math.round((now - r7.from) / D), 7);
  const rc = rangeFor('custom', now, { from: '2026-11-20', to: '2026-11-18' });
  assert.equal(rc.from, new Date(2026, 10, 18).getTime(), 'swapped dates are reordered');
  assert.equal(rc.to, new Date(2026, 10, 21).getTime() - 1, 'the end day is included');
  assert.equal(parseDay('2026-02-30'), null);
  const live = rangeFor('live', now, { live: { startedAt: now - 20_000 } as RecAuction });
  assert.ok(live.to - live.from >= 180_000 && live.bucketMs === 10_000);
});

test('summary: bids, unique bidders, completed auctions, duration, extensions, price growth', () => {
  const now = new Date(2026, 10, 22, 12).getTime();
  const mk = (id: string, start: number, end: number | null, bids: [string, number, number][], ext: number[] = []): RecAuction => ({
    id, lotId: 'L', title: 'T', source: 'demo-session', startedAt: start, endedAt: end, startPrice: 0, retailValue: euros(100_000),
    bids: bids.map(([who, eur, t], i) => ({ id: `${id}${i}`, t, amount: euros(eur), bidder: who, mine: who === 'me' })), ext,
  });
  const list = [
    mk('a', now - 3 * H, now - 3 * H + 200_000, [['p1', 1_000, now - 3 * H + 10_000], ['p2', 30_000, now - 3 * H + 100_000], ['me', 60_000, now - 3 * H + 190_000]], [now - 3 * H + 195_000]),
    mk('b', now - 2 * D, now - 2 * D + 180_000, [['p1', 50_000, now - 2 * D + 60_000]]),
    mk('c', now - 60_000, null, [['p3', 2_000, now - 30_000]]),
  ];
  const s = summarize(list, rangeFor('24h', now), now);
  assert.equal(s.bids, 4);
  assert.equal(s.uniqueBidders, 4);
  assert.equal(s.myBids, 1);
  assert.equal(s.completed, 1, 'only auctions that ended inside the period');
  assert.equal(s.avgDurationMs, 200_000);
  assert.equal(s.extensions, 1);
  assert.equal(s.avgGrowth, euros(60_000));
  assert.equal(s.activity.reduce((x, b) => x + b.bids, 0), 4);
  const s30 = summarize(list, rangeFor('30d', now), now);
  assert.equal(s30.completed, 2);
  assert.equal(s30.price.length, 2, 'one average final-price point per day with completed auctions');
  const live = summarize(list, rangeFor('live', now, { live: list[2] }), now, list[2]);
  assert.equal(live.bids, 1);
  assert.equal(live.live!.growth, euros(2_000));
});

test('CSV: UTF-8 BOM, header, escaping of commas, quotes and new lines', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('x\ny'), '"x\ny"');
  assert.equal(csvCell(null), '');
  const now = Date.now();
  const a: RecAuction = { id: 'x', lotId: 'L', title: 'Купе, "демо"', source: 'demo-session', startedAt: now - 300_000, endedAt: now - 100_000, startPrice: 0, retailValue: null,
    bids: [{ id: 'b', t: now - 200_000, amount: euros(1_500), bidder: 'p1', mine: false }], ext: [] };
  const r = rangeFor('24h', now);
  const csv = auctionsCsv(summarize([a], r, now));
  assert.ok(csv.startsWith('﻿id,източник,лот,заглавие'));
  assert.ok(csv.includes('"Купе, ""демо"""'));
  assert.equal(csv.trim().split('\r\n').length, 2);
  assert.equal(bidsCsv([a], r).trim().split('\r\n').length, 2);
});

test('store: kept 31 days on the device, capped, survives reload, tolerates corrupt data', () => {
  const mem = memory();
  let now = 100 * D;
  const s1 = new AnalyticsStore(mem, () => now);
  const old: RecAuction = { id: 'old', lotId: 'L', title: 'T', source: 'demo-session', startedAt: now - RETENTION_MS - D, endedAt: now - RETENTION_MS - D + 1000, startPrice: 0, retailValue: null, bids: [], ext: [] };
  const fresh: RecAuction = { ...old, id: 'new', startedAt: now - D, endedAt: now - D + 1000, bids: [{ id: 'b', t: now - D + 500, amount: 100, bidder: 'p', mine: true }] };
  s1.add([old, fresh]);
  s1.flush();
  const s2 = new AnalyticsStore(mem, () => now);
  assert.deepEqual(s2.auctions.map((a) => a.id), ['new']);
  assert.equal(s2.auctions[0]!.bids[0]!.mine, true);
  s2.add(Array.from({ length: MAX_AUCTIONS + 20 }, (_, i) => ({ ...fresh, id: `n${i}`, startedAt: now - D + i })));
  s2.flush();
  assert.equal(new AnalyticsStore(mem, () => now).auctions.length, MAX_AUCTIONS);
  mem.m.set('enchev-analytics-v1', '{broken');
  assert.equal(new AnalyticsStore(mem, () => now).auctions.length, 0);
  now += 0;
});

test('sources: a real-mode (production) build shows only real server data — never demo', () => {
  const real = { realMode: { enabled: true as const, streamUrl: 'wss://x', apiBase: 'https://x' } };
  const lab = { realMode: { enabled: false as const, reason: 'lab' } };
  assert.deepEqual(availableSources(real), ['real']);
  assert.equal(defaultSource(real), 'real');
  assert.equal(demoAllowed(real), false);
  assert.deepEqual(availableSources(lab), ['demo', 'real']);
});

test('generated DEMO history: labelled, finished in the past, within 30 days, increasing bids', () => {
  const now = new Date(2026, 10, 22, 21).getTime();
  const list = generateDemoHistory(now, DEMO_LOT);
  assert.ok(list.length > 60);
  for (const a of list) {
    assert.equal(a.source, 'demo-generated');
    assert.ok(a.endedAt! < now && a.startedAt > now - 31 * D);
    for (let i = 1; i < a.bids.length; i++) assert.ok(a.bids[i]!.amount > a.bids[i - 1]!.amount && a.bids[i]!.t >= a.bids[i - 1]!.t);
  }
});
