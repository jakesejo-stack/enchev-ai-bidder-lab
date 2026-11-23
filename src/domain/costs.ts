// What a winning bid really costs the buyer: auction fees, VAT and (for non-EU cars) EU import taxes.
// Fees follow the Copart Spain 2026 public tariff as a BENCHMARK — it is not an Enchev tariff; the real
// Enchev fee table replaces these numbers once it exists. All money is integer cents.
//   EU car:      bid + buyer fee + live-bid fee + retrieval + 20 % VAT on those fees (+ transport)
//   non-EU car:  customs value (CIF) = bid + fees + transport + 1.5 % insurance
//                duty = 10 % × CIF (EU tariff for passenger cars), import VAT = 20 % × (CIF + duty)
import type { Cents } from './types.js';
import { euros } from './money.js';

export type Origin = 'EU' | 'NON_EU';
export interface CostLine { key: string; label: string; amount: Cents; formula: string; }
export interface CostBreakdown { bid: Cents; lines: CostLine[]; total: Cents; }

export const COST_SOURCE = 'Такси по публичната тарифа на Copart Испания 2026 — ориентир, не тарифа на Enchev';
const BUYER_FEE_PERCENT_FROM = euros(15_500);
const BUYER_FEE_PERCENT = 0.036;
const BUYER_FEE_MAX_BELOW = 53_072; // 530,72 € — the highest published tier below 15 500 € (upper bound)
const LIVE_FEE: readonly [below: Cents, fee: Cents][] = [[euros(6_750), 1_057], [euros(13_500), 1_796], [Infinity, 2_536]];
export const RETRIEVAL_FEE: Cents = 4_500;
export const VAT_RATE = 0.2;
export const EU_DUTY_RATE = 0.1;
export const INSURANCE_RATE = 0.015;

export function buyerFee(bid: Cents): Cents {
  return bid >= BUYER_FEE_PERCENT_FROM ? Math.round(bid * BUYER_FEE_PERCENT) : BUYER_FEE_MAX_BELOW;
}

export function liveFee(bid: Cents): Cents {
  for (const [below, fee] of LIVE_FEE) if (bid < below) return fee;
  return LIVE_FEE[LIVE_FEE.length - 1]![1];
}

export function costOf(bid: Cents, origin: Origin = 'EU', transport: Cents = 0): CostBreakdown {
  const b = buyerFee(bid), l = liveFee(bid), r = RETRIEVAL_FEE;
  const lines: CostLine[] = [
    { key: 'bid', label: 'Оферта', amount: bid, formula: 'печелившата оферта' },
    { key: 'buyer', label: 'Такса купувач', amount: b, formula: bid >= BUYER_FEE_PERCENT_FROM ? '3,6 % от офертата' : 'до 530,72 € (горна граница)' },
    { key: 'live', label: 'Такса онлайн наддаване', amount: l, formula: 'по ценови клас' },
    { key: 'retrieval', label: 'Изваждане на лота', amount: r, formula: 'фиксирана' },
  ];
  if (transport > 0) lines.push({ key: 'transport', label: 'Транспорт', amount: transport, formula: 'оферта на превозвач' });
  if (origin === 'EU') {
    lines.push({ key: 'vat', label: 'ДДС върху таксите', amount: Math.round((b + l + r) * VAT_RATE), formula: '20 % × таксите' });
  } else {
    const insurance = Math.round(bid * INSURANCE_RATE);
    lines.push({ key: 'insurance', label: 'Застраховка транспорт', amount: insurance, formula: '1,5 % от офертата' });
    const cif = bid + b + l + r + transport + insurance;
    const duty = Math.round(cif * EU_DUTY_RATE);
    lines.push({ key: 'duty', label: 'Мито (ЕС)', amount: duty, formula: '10 % × митническа стойност' });
    lines.push({ key: 'importVat', label: 'ДДС при внос', amount: Math.round((cif + duty) * VAT_RATE), formula: '20 % × (стойност + мито)' });
  }
  return { bid, lines, total: lines.reduce((s, x) => s + x.amount, 0) };
}

/** Highest bid on a `grid` (e.g. 100 €) whose total cost fits `budget`. 0 when even the smallest bid does not fit. */
export function maxBidWithin(budget: Cents, origin: Origin = 'EU', transport: Cents = 0, grid: Cents = euros(100)): Cents {
  if (costOf(grid, origin, transport).total > budget) return 0;
  let lo = 1, hi = Math.max(1, Math.ceil(budget / grid));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (costOf(mid * grid, origin, transport).total <= budget) lo = mid; else hi = mid - 1;
  }
  return lo * grid;
}
