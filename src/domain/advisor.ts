// DAVID's guidance: transparent signals computed ONLY from the observed event stream and the
// user's own limit. No market values, no hidden bidders, no success percentages — there is no
// validated model behind such numbers, so the UI states "Няма достатъчно данни" instead.
import type { BidRecord, Cents, ConnectionState } from './types.js';
import type { AuctionState } from './reducer.js';
import { highestBid, nextValidBid, stepFor } from './rules.js';
import { formatEur } from './money.js';

export type RiskLevel = 'нисък' | 'умерен' | 'висок' | 'над лимита' | 'няма данни';
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
  /** Fraction of the user's limit that the next valid bid would use (0..∞), null if no limit. */
  limitUse: number | null;
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
    return { ...base, action: 'not_ready', risk: 'няма данни', headline: 'Изчакваме данни за търга…', reasons: [], signals: [], nextValid: null, limitUse: null };
  }
  const next = nextValidBid(lot, rules, auction.bids);
  const top = highestBid(auction.bids);
  const leading = !!top && top.bidderId === myBidderId;
  const remaining = Math.max(0, auction.endsAt - serverNow);
  const lastMinute = bidsInWindow(auction.bids, serverNow, 60_000);
  const recentBidders = new Set(bidsInWindow(auction.bids, serverNow, 5 * 60_000).map((b) => b.bidderId));
  recentBidders.delete(myBidderId);
  const headroom = cap === null ? null : cap - next;
  const limitUse = cap === null || cap <= 0 ? null : next / cap;
  const step = top ? stepFor(top.amount, rules) : stepFor(lot.startPrice, rules);

  const signals: Signal[] = [
    { id: 'position', label: 'Твоята позиция', value: leading ? 'Водиш' : top ? 'Не водиш' : 'Няма оферти', tone: leading ? 'ok' : 'info' },
    {
      id: 'limit', label: 'Спрямо лимита',
      value: headroom === null ? 'Няма зададен лимит' : headroom >= 0 ? `Остават ${formatEur(headroom)}` : `Над лимита с ${formatEur(-headroom)}`,
      tone: headroom === null ? 'warn' : headroom < 0 ? 'bad' : headroom < step * 3 ? 'warn' : 'ok',
    },
    { id: 'pace', label: 'Темп (последна минута)', value: `${lastMinute.length} ${lastMinute.length === 1 ? 'оферта' : 'оферти'}`, tone: lastMinute.length >= 4 ? 'warn' : 'info' },
    { id: 'bidders', label: 'Други участници (5 мин)', value: String(recentBidders.size), tone: 'info' },
  ];

  const reasons: string[] = [];
  const out = (action: AdviceAction, risk: RiskLevel, headline: string): Advice =>
    ({ ...base, action, risk, headline, reasons, signals, nextValid: next, limitUse });

  if (auction.status === 'ended' || remaining === 0) {
    reasons.push(top ? `Последната оферта е ${formatEur(top.amount)}.` : 'Няма подадени оферти.');
    return out('ended', 'няма данни', leading ? 'Търгът приключи — твоята оферта е най-високата.' : 'Търгът приключи.');
  }
  if (connection !== 'online') {
    reasons.push('Без връзка не виждаме актуалната цена, затова наддаването е спряно.');
    return out('offline', 'няма данни', 'Няма връзка — изчакай повторно свързване.');
  }
  if (cap === null) {
    reasons.push('Задай максимален лимит, за да оценим риска спрямо него.');
    return out('set_limit', 'няма данни', 'Задай своя лимит.');
  }

  // Risk: purely a function of headroom against the user's own limit, observed pace and time.
  let risk: RiskLevel;
  const fastFinish = lastMinute.length >= 4 && remaining < 60_000;
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
