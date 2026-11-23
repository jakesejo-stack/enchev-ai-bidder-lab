import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerFee, liveFee, costOf, maxBidWithin, RETRIEVAL_FEE } from '../../src/domain/costs.js';
import { euros } from '../../src/domain/money.js';

test('fee tiers (Copart ES 2026 benchmark)', () => {
  assert.equal(buyerFee(euros(15_499)), 53_072, 'below 15 500 €: 530,72 € upper bound');
  assert.equal(buyerFee(euros(15_500)), 55_800, '15 500 € × 3,6 % = 558 €');
  assert.equal(buyerFee(euros(50_000)), euros(1_800), '50 000 € × 3,6 % = 1 800 €');
  assert.equal(liveFee(euros(6_749)), 1_057);
  assert.equal(liveFee(euros(6_750)), 1_796);
  assert.equal(liveFee(euros(13_500)), 2_536);
});

test('EU car: bid + fees + 20 % VAT on fees, no duty', () => {
  const c = costOf(euros(50_000));
  const fees = euros(1_800) + 2_536 + RETRIEVAL_FEE;
  assert.equal(c.total, euros(50_000) + fees + Math.round(fees * 0.2));
  assert.ok(!c.lines.some((l) => l.key === 'duty'));
});

test('non-EU car: 10 % duty on CIF, then 20 % import VAT on CIF + duty', () => {
  const c = costOf(euros(20_000), 'NON_EU', euros(2_800));
  const v = Object.fromEntries(c.lines.map((l) => [l.key, l.amount]));
  const cif = v.bid! + v.buyer! + v.live! + v.retrieval! + v.transport! + v.insurance!;
  assert.equal(v.insurance, Math.round(euros(20_000) * 0.015));
  assert.equal(v.duty, Math.round(cif * 0.1));
  assert.equal(v.importVat, Math.round((cif + v.duty!) * 0.2));
  assert.equal(c.total, c.lines.reduce((s, l) => s + l.amount, 0));
  assert.ok(c.lines.every((l) => Number.isInteger(l.amount)), 'integer cents');
});

test('max bid within a budget is exact on the 100 € grid', () => {
  for (const origin of ['EU', 'NON_EU'] as const) {
    for (const b of [5_000, 18_000, 60_000, 250_000]) {
      const budget = euros(b);
      const bid = maxBidWithin(budget, origin);
      assert.equal(bid % euros(100), 0);
      assert.ok(costOf(bid, origin).total <= budget, `${origin} ${b}: fits`);
      assert.ok(costOf(bid + euros(100), origin).total > budget, `${origin} ${b}: next step does not fit`);
    }
  }
  assert.equal(maxBidWithin(euros(100)), 0, 'fees alone exceed a tiny budget');
});
