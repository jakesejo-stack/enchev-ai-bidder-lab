import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartWindow, changeText } from '../../src/ui/live-chart.js';
import { euros } from '../../src/domain/money.js';
import type { BidRecord } from '../../src/domain/types.js';

const bids: BidRecord[] = [10, 11, 12, 13, 14].map((k, i) => ({ bidId: `b${i}`, bidderId: i % 2 ? 'me' : 'B-7', amount: euros(k * 1000), serverTime: 1_000 * i }));

test('"ВСИЧКИ" compares against the lot start price', () => {
  const w = chartWindow(bids, euros(9_000), null);
  assert.equal(w.shown.length, 5);
  assert.equal(w.base, euros(9_000));
  assert.equal(w.baseLabel, 'от старта');
});

test('a range of N bids compares against the price just before it', () => {
  const w = chartWindow(bids, euros(9_000), 2);
  assert.deepEqual(w.shown.map((b) => b.bidId), ['b3', 'b4']);
  assert.equal(w.base, euros(12_000));
  assert.equal(w.baseLabel, 'последни 2 оферти');
});

test('change vs base: sign, percent and direction', () => {
  const c = changeText(euros(14_000), euros(12_000));
  assert.equal(c.dir, 'up');
  assert.ok(c.abs.startsWith('+'));
  assert.equal(c.pct, '16,67%');
  assert.equal(changeText(euros(9_000), euros(9_000)).dir, 'flat');
});
