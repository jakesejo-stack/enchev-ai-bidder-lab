// AiBidder's guidance: transparent rules over the observed event stream, the user's own budget (if set)
// and the lot's ESTIMATED RETAIL VALUE as stated in the listing (lot data, not a value we compute).
// The advice is a stop point, not a prediction: "bid up to X; above X we recommend you fold and keep the
// money for a similar car". No success percentages and no hidden bidders — there is no validated model
// behind such numbers, so the UI states "Няма достатъчно данни" instead.
import type { BidRecord, Cents, ConnectionState } from './types.js';
import type { AuctionState } from './reducer.js';
import { highestBid, nextValidBid, stepFor } from './rules.js';
import { formatEur } from './money.js';

export type RiskLevel = 'нисък' | 'умерен' | 'висок' | 'над бюджета' | 'над retail' | 'няма данни';
export type AdviceAction = 'wait_leading' | 'can_bid' | 'stop_over_budget' | 'fold' | 'offline' | 'ended' | 'not_ready';
export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export interface Signal { id: string; label: string; value: string; tone: Tone; }

export interface Advice {
  action: AdviceAction;
  risk: RiskLevel;
  headline: string;
  /** Short, actionable lines for the "Съвет" page (budget, stop point, keep the money for another car). */
  tips: string[];
  /** Detailed explanation for the "Защо" page. */
  reasons: string[];
  signals: Signal[];
  nextValid: Cents | null;
  /** Estimated retail value from the lot listing. */
  retail: Cents | null;
  /** Recommended stop point: the lower of the user's budget and the estimated retail value. */
  walkAway: Cents | null;
  /** Show similar cars (the user should keep the money for another lot). */
  suggestSimilar: boolean;
  probabilityText: string;
  probabilityWhy: string;
}

export const NO_PROBABILITY = 'Няма достатъчно данни';
const NO_PROBABILITY_WHY = 'Няма валидиран модел, който да оценява шанса за печалба, затова не показваме процент.';

export interface AdviceInput {
  auction: AuctionState;
  /** The user's own budget for this car (null = not set). */
  cap: Cents | null;
  myBidderId: string;
  serverNow: number;
  connection: ConnectionState;
}

export function bidsInWindow(bids: readonly BidRecord[], serverNow: number, windowMs: number): BidRecord[] {
  return bids.filter((b) => serverNow - b.serverTime <= windowMs && b.serverTime <= serverNow + 5000);
}

/** Lower of budget and estimated retail value (null when neither is known). */
export function stopPoint(cap: Cents | null, retail: Cents | null): Cents | null {
  if (cap === null) return retail;
  if (retail === null) return cap;
  return Math.min(cap, retail);
}

export function advise({ auction, cap, myBidderId, serverNow, connection }: AdviceInput): Advice {
  const base = { probabilityText: NO_PROBABILITY, probabilityWhy: NO_PROBABILITY_WHY };
  const { lot, rules } = auction;
  if (!lot || !rules) {
    return { ...base, action: 'not_ready', risk: 'няма данни', headline: 'Изчакваме данни за търга…', tips: [], reasons: [], signals: [], nextValid: null, retail: null, walkAway: null, suggestSimilar: false };
  }
  const next = nextValidBid(lot, rules, auction.bids);
  const top = highestBid(auction.bids);
  const leading = !!top && top.bidderId === myBidderId;
  const remaining = Math.max(0, auction.endsAt - serverNow);
  const lastMinute = bidsInWindow(auction.bids, serverNow, 60_000);
  const recentBidders = new Set(bidsInWindow(auction.bids, serverNow, 5 * 60_000).map((b) => b.bidderId));
  recentBidders.delete(myBidderId);
  const retail = lot.retailValue ?? null;
  const walkAway = stopPoint(cap, retail);
  const step = top ? stepFor(top.amount, rules) : stepFor(lot.startPrice, rules);
  const fastFinish = lastMinute.length >= 4 && remaining < 60_000;

  const signals: Signal[] = [
    { id: 'position', label: 'Твоята позиция', value: leading ? 'Водиш' : top ? 'Не водиш' : 'Няма оферти', tone: leading ? 'ok' : 'info' },
    { id: 'stop', label: 'Препоръчан праг', value: walkAway === null ? 'няма данни' : formatEur(walkAway), tone: walkAway !== null && next > walkAway ? 'bad' : 'info' },
    { id: 'budget', label: 'Бюджет', value: cap === null ? 'не е зададен' : next > cap ? `надвишен с ${formatEur(next - cap)}` : `остават ${formatEur(cap - next)}`, tone: cap === null ? 'info' : next > cap ? 'bad' : cap - next < step * 3 ? 'warn' : 'ok' },
    { id: 'pace', label: 'Темп (последна минута)', value: `${lastMinute.length} ${lastMinute.length === 1 ? 'оферта' : 'оферти'}`, tone: lastMinute.length >= 4 ? 'warn' : 'info' },
    { id: 'bidders', label: 'Други участници (5 мин)', value: String(recentBidders.size), tone: 'info' },
  ];

  const tips: string[] = [];
  const reasons: string[] = [];
  const out = (action: AdviceAction, risk: RiskLevel, headline: string, suggestSimilar = false): Advice =>
    ({ ...base, action, risk, headline, tips, reasons, signals, nextValid: next, retail, walkAway, suggestSimilar });

  if (retail !== null) reasons.push(`Estimated retail value на колата: ${formatEur(retail)} (по данни от обявата, не е наша оценка).`);
  reasons.push(top
    ? `Следващата валидна оферта е ${formatEur(next)} (текуща ${formatEur(top.amount)} + стъпка ${formatEur(step)}).`
    : `Още няма оферти. Първата валидна оферта е ${formatEur(next)}.`);

  if (auction.status === 'ended' || remaining === 0) {
    return out('ended', 'няма данни', leading ? 'Търгът приключи — твоята оферта е най-високата.' : 'Търгът приключи.', !leading);
  }
  if (connection !== 'online') {
    reasons.push('Без връзка не виждаме актуалната цена, затова наддаването е спряно.');
    return out('offline', 'няма данни', 'Няма връзка — изчакай повторно свързване.');
  }
  if (cap !== null) reasons.push(`Твоят бюджет: ${formatEur(cap)}. Можеш да го промениш по всяко време.`);
  if (walkAway !== null) reasons.push(`Препоръчваме да спреш над ${formatEur(walkAway)} — ${cap !== null && (retail === null || cap <= retail) ? 'това е бюджетът ти' : 'над тази сума плащаш повече от estimated retail value'}.`);
  if (lastMinute.length >= 2) reasons.push(`Има ${lastMinute.length} оферти през последната минута — цената се движи бързо.`);
  if (remaining < 30_000) reasons.push('Оферта в последните секунди може да удължи търга.');

  if (leading) {
    tips.push(`Най-високата оферта е твоята: ${formatEur(top!.amount)}.`);
    if (walkAway !== null) tips.push(`Ако те надминат, наддавай най-много до ${formatEur(walkAway)}.`);
    return out('wait_leading', 'нисък', 'Водиш. Не е нужно да наддаваш сега.');
  }
  if (cap !== null && next > cap) {
    tips.push(`Ако спреш сега, запазваш ${formatEur(cap)} за друга кола — виж подобните коли.`);
    tips.push('Ако искаш тази кола, можеш винаги да увеличиш бюджета.');
    return out('stop_over_budget', 'над бюджета', `Следващата оферта (${formatEur(next)}) е над бюджета ти.`, true);
  }
  if (retail !== null && next > retail) {
    tips.push(`Над ${formatEur(retail)} плащаш повече, отколкото струва колата по обявата.`);
    tips.push(cap !== null ? `Запази бюджета си от ${formatEur(cap)} за подобна кола.` : 'Пробвай подобна кола — може да вземеш по-добра цена.');
    return out('fold', 'над retail', `Цената мина estimated retail value (${formatEur(retail)}). Препоръчваме да спреш.`, true);
  }

  // Can bid: how close the next bid is to the stop point, plus observed pace.
  const use = walkAway ? next / walkAway : 0;
  const risk: RiskLevel = walkAway && (use > 0.9 || fastFinish) ? 'висок' : (walkAway && use > 0.7) || lastMinute.length >= 2 ? 'умерен' : 'нисък';
  if (walkAway !== null) tips.push(`До прага остават ${formatEur(walkAway - next)}.`);
  if (cap === null) tips.push('Задай бюджет, за да ти казвам точно кога да спреш.');
  else if (retail !== null && cap < retail) tips.push(`Бюджетът ти е под estimated retail value (${formatEur(retail)}). Ако цената стигне ${formatEur(cap)}, спри — ще ти предложим подобна кола. Можеш винаги да вдигнеш бюджета.`);
  if (retail !== null && (cap === null || cap >= retail)) tips.push(`Над ${formatEur(retail)} (estimated retail value) препоръчваме да спреш.`);
  return out('can_bid', risk, walkAway !== null ? `Можеш да наддаваш до ${formatEur(walkAway)}.` : `Следващата валидна оферта е ${formatEur(next)}.`);
}

/** Jump targets offered by AiBidder (added to the current price, then put on the auction's step grid). */
export const QUICK_JUMPS: Cents[] = [100_000, 250_000, 370_000, 500_000];

export interface QuickBid { amount: Cents; plus: Cents; min: boolean; overBudget: boolean; }

/** The minimum valid bid plus up to three bigger jumps, all valid on the step grid, under the house maximum. */
export function quickBids(auction: AuctionState, cap: Cents | null): QuickBid[] {
  const { lot, rules, bids } = auction;
  if (!lot || !rules) return [];
  const next = nextValidBid(lot, rules, bids);
  const top = highestBid(bids);
  const base = top ? top.amount : lot.startPrice;
  const step = top ? stepFor(top.amount, rules) : stepFor(lot.startPrice, rules);
  const amounts = [next];
  for (const j of QUICK_JUMPS) {
    const want = base + j;
    const a = want <= next ? next : next + Math.ceil((want - next) / step) * step;
    if (!amounts.includes(a) && (rules.maxBid === null || a <= rules.maxBid)) amounts.push(a);
    if (amounts.length === 4) break;
  }
  return amounts.map((amount, i) => ({ amount, plus: amount - base, min: i === 0, overBudget: cap !== null && amount > cap }));
}
