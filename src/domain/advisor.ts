// AiBidder's guidance: transparent signals computed ONLY from the observed event stream, the user's
// own limit if one is set, and otherwise the retail value DECLARED in the lot (listing data, never our
// estimate). No market predictions, no hidden bidders, no success percentages — there is no validated
// model behind such numbers, so the UI states "Няма достатъчно данни" instead.
import type { BidRecord, Cents, ConnectionState } from './types.js';
import type { AuctionState } from './reducer.js';
import { highestBid, nextValidBid, stepFor } from './rules.js';
import { formatEur } from './money.js';

export type RiskLevel = 'нисък' | 'умерен' | 'висок' | 'над лимита' | 'над retail' | 'няма данни';
export type AdviceAction = 'wait_leading' | 'can_bid' | 'stop_over_limit' | 'offline' | 'ended' | 'not_ready' | 'set_limit';
export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export interface Signal { id: string; label: string; value: string; tone: Tone; }

export interface Advice {
  action: AdviceAction;
  risk: RiskLevel;
  headline: string;
  reasons: string[];
  signals: Signal[];
  nextValid: Cents | null;
  /** Next valid bid as a fraction of the reference (the user's limit, else the declared retail value). */
  limitUse: number | null;
  /** What limitUse is measured against. */
  reference: 'limit' | 'retail' | null;
  probabilityText: string;
  probabilityWhy: string;
}

export const NO_PROBABILITY = 'Няма достатъчно данни';
const NO_PROBABILITY_WHY = 'Няма валидиран модел, който да оценява шанса за печалба, затова не показваме процент.';

export interface AdviceInput {
  auction: AuctionState;
  cap: Cents | null;
  myBidderId: string;
  serverNow: number;
  connection: ConnectionState;
}

export function bidsInWindow(bids: readonly BidRecord[], serverNow: number, windowMs: number): BidRecord[] {
  return bids.filter((b) => serverNow - b.serverTime <= windowMs && b.serverTime <= serverNow + 5000);
}

export function advise({ auction, cap, myBidderId, serverNow, connection }: AdviceInput): Advice {
  const base = { probabilityText: NO_PROBABILITY, probabilityWhy: NO_PROBABILITY_WHY };
  const { lot, rules } = auction;
  if (!lot || !rules) {
    return { ...base, action: 'not_ready', risk: 'няма данни', headline: 'Изчакваме данни за търга…', reasons: [], signals: [], nextValid: null, limitUse: null, reference: null };
  }
  const next = nextValidBid(lot, rules, auction.bids);
  const top = highestBid(auction.bids);
  const leading = !!top && top.bidderId === myBidderId;
  const remaining = Math.max(0, auction.endsAt - serverNow);
  const lastMinute = bidsInWindow(auction.bids, serverNow, 60_000);
  const recentBidders = new Set(bidsInWindow(auction.bids, serverNow, 5 * 60_000).map((b) => b.bidderId));
  recentBidders.delete(myBidderId);
  const headroom = cap === null ? null : cap - next;
  const retail = lot.retailValue ?? null;
  const reference: Advice['reference'] = cap !== null ? 'limit' : retail ? 'retail' : null;
  const limitUse = cap !== null ? (cap <= 0 ? null : next / cap) : retail ? next / retail : null;
  const step = top ? stepFor(top.amount, rules) : stepFor(lot.startPrice, rules);
  const pct = (x: number) => `${Math.round(x * 100)} %`;

  const signals: Signal[] = [
    { id: 'position', label: 'Твоята позиция', value: leading ? 'Водиш' : top ? 'Не водиш' : 'Няма оферти', tone: leading ? 'ok' : 'info' },
    cap !== null ? {
      id: 'limit', label: 'Спрямо лимита',
      value: headroom! >= 0 ? `Остават ${formatEur(headroom!)}` : `Над лимита с ${formatEur(-headroom!)}`,
      tone: headroom! < 0 ? 'bad' : headroom! < step * 3 ? 'warn' : 'ok',
    } : {
      id: 'retail', label: 'Спрямо обявената retail стойност',
      value: retail ? pct(next / retail) : 'не е обявена',
      tone: !retail ? 'info' : next > retail ? 'bad' : next > retail * 0.9 ? 'warn' : 'ok',
    },
    { id: 'pace', label: 'Темп (последна минута)', value: `${lastMinute.length} ${lastMinute.length === 1 ? 'оферта' : 'оферти'}`, tone: lastMinute.length >= 4 ? 'warn' : 'info' },
    { id: 'bidders', label: 'Други участници (5 мин)', value: String(recentBidders.size), tone: 'info' },
  ];

  const reasons: string[] = [];
  const out = (action: AdviceAction, risk: RiskLevel, headline: string): Advice =>
    ({ ...base, action, risk, headline, reasons, signals, nextValid: next, limitUse, reference });

  if (auction.status === 'ended' || remaining === 0) {
    reasons.push(top ? `Последната оферта е ${formatEur(top.amount)}.` : 'Няма подадени оферти.');
    return out('ended', 'няма данни', leading ? 'Търгът приключи — твоята оферта е най-високата.' : 'Търгът приключи.');
  }
  if (connection !== 'online') {
    reasons.push('Без връзка не виждаме актуалната цена, затова наддаването е спряно.');
    return out('offline', 'няма данни', 'Няма връзка — изчакай повторно свързване.');
  }
  const fastFinish = lastMinute.length >= 4 && remaining < 60_000;
  if (cap === null) {
    // No personal limit: bids may go up to the auction maximum. The declared retail value of the lot
    // (listing data) is the only reference; it is not a prediction of what the car will sell for.
    let risk: RiskLevel = 'нисък';
    if (retail) {
      const use = next / retail;
      risk = use > 1 ? 'над retail' : use > 0.9 || fastFinish ? 'висок' : use > 0.7 || lastMinute.length >= 2 ? 'умерен' : 'нисък';
    } else if (fastFinish) risk = 'висок';
    else if (lastMinute.length >= 2) risk = 'умерен';
    if (leading) {
      reasons.push(`Най-високата оферта е твоята: ${formatEur(top!.amount)}.`);
      reasons.push('Повторно наддаване срещу себе си не е позволено и само би вдигнало цената.');
      return out('wait_leading', risk === 'над retail' ? 'висок' : risk, 'Водиш. Не е нужно да наддаваш сега.');
    }
    reasons.push(top
      ? `Следващата валидна оферта е ${formatEur(next)} (текуща ${formatEur(top.amount)} + стъпка ${formatEur(step)}).`
      : `Още няма оферти. Търгът започва от ${formatEur(lot.startPrice)}, първата валидна оферта е ${formatEur(next)}.`);
    if (retail) reasons.push(`Това е ${pct(next / retail)} от обявената в лота retail стойност ${formatEur(retail)} (данни на лота, не наша оценка).`);
    if (lastMinute.length >= 2) reasons.push(`Има ${lastMinute.length} оферти през последната минута — цената се движи бързо.`);
    if (remaining < 30_000) reasons.push('Оферта в последните секунди може да удължи търга.');
    const headline = !retail ? `Следващата валидна оферта е ${formatEur(next)}.`
      : next > retail ? `Внимание: ${formatEur(next)} е над обявената retail стойност (${formatEur(retail)}).`
      : `Следващата валидна оферта е ${formatEur(next)} — ${pct(next / retail)} от обявената retail стойност.`;
    return out('can_bid', risk, headline);
  }

  // Risk: purely a function of headroom against the user's own limit, observed pace and time.
  let risk: RiskLevel;
  if (headroom! < 0) risk = 'над лимита';
  else if (headroom! < step * 2 || fastFinish) risk = 'висок';
  else if (limitUse! > 0.85 || lastMinute.length >= 2) risk = 'умерен';
  else risk = 'нисък';

  if (leading) {
    reasons.push(`Най-високата оферта е твоята: ${formatEur(top!.amount)}.`);
    reasons.push('Повторно наддаване срещу себе си не е позволено и само би вдигнало цената.');
    if (risk === 'над лимита') risk = 'висок';
    return out('wait_leading', risk, 'Водиш. Не е нужно да наддаваш сега.');
  }
  if (headroom! < 0) {
    reasons.push(`Следващата валидна оферта ${formatEur(next)} надвишава лимита ти ${formatEur(cap)}.`);
    reasons.push('Ако искаш да продължиш, първо промени лимита съзнателно.');
    return out('stop_over_limit', 'над лимита', 'Спри — следващата оферта е над лимита ти.');
  }
  reasons.push(`Следващата валидна оферта е ${formatEur(next)} (текуща ${top ? formatEur(top.amount) : 'няма'} + стъпка ${formatEur(step)}).`);
  reasons.push(`След нея до лимита ти остават ${formatEur(headroom!)}.`);
  if (lastMinute.length >= 2) reasons.push(`Има ${lastMinute.length} оферти през последната минута — цената се движи бързо.`);
  if (remaining < 30_000) reasons.push('Оферта в последните секунди може да удължи търга.');
  return out('can_bid', risk, `Оферта от ${formatEur(next)} е в рамките на лимита ти.`);
}
