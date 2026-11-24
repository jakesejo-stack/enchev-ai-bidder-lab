// Bid arithmetic and validation. The SAME rules run in the client (to explain and pre-check)
// and in the server (demo server here; the real backend must enforce its own copy).
// The client check is advisory only — the server is authoritative.
import type { AuctionStatus, BidRecord, BidRejectCode, BidRules, Cents, LotInfo } from './types.js';
import { formatEur } from './money.js';

export function stepFor(current: Cents, rules: BidRules): Cents {
  for (const band of rules.increments) {
    if (band.below === null || current < band.below) return band.step;
  }
  const last = rules.increments[rules.increments.length - 1];
  if (!last) throw new Error('No increment bands configured');
  return last.step;
}

export function highestBid(bids: readonly BidRecord[]): BidRecord | null {
  let top: BidRecord | null = null;
  for (const b of bids) if (!top || b.amount > top.amount) top = b;
  return top;
}

/**
 * Next valid bid: the start price if there are no bids (a 0 € start opens at the first increment,
 * because a 0 € bid is not a bid), otherwise current + increment for that band.
 */
export function nextValidBid(lot: LotInfo, rules: BidRules, bids: readonly BidRecord[]): Cents {
  const top = highestBid(bids);
  if (!top) return lot.startPrice > 0 ? lot.startPrice : stepFor(0, rules);
  return top.amount + stepFor(top.amount, rules);
}

/** Step that valid bids must follow right now (the band of the current price, or of the start). */
export function currentStep(lot: LotInfo, rules: BidRules, bids: readonly BidRecord[]): Cents {
  const top = highestBid(bids);
  return stepFor(top ? top.amount : lot.startPrice, rules);
}

/** Rounds a wished amount UP to the nearest valid bid (≥ next valid, on the step grid). */
export function alignBid(amount: Cents, nextValid: Cents, step: Cents): Cents {
  if (!(amount > nextValid)) return nextValid;
  return nextValid + Math.ceil((amount - nextValid) / step) * step;
}

export interface BidCheckContext {
  lot: LotInfo;
  rules: BidRules;
  status: AuctionStatus;
  bids: readonly BidRecord[];
  endsAt: number;
  serverNow: number;
  bidderId: string;
  authenticated: boolean;
  lotId: string;
}

export interface BidCheck {
  ok: boolean;
  code?: BidRejectCode;
  message?: string;
  nextValid: Cents;
}

export function checkBid(amount: Cents, ctx: BidCheckContext): BidCheck {
  const nextValid = nextValidBid(ctx.lot, ctx.rules, ctx.bids);
  const fail = (code: BidRejectCode, message: string): BidCheck => ({ ok: false, code, message, nextValid });
  if (!ctx.authenticated) return fail('UNAUTHENTICATED', 'Нужен е вход в профила, за да наддаваш.');
  if (ctx.lotId !== ctx.lot.lotId) return fail('WRONG_LOT', 'Офертата е за друг лот.');
  if (ctx.status === 'ended' || ctx.serverNow >= ctx.endsAt) return fail('ENDED', 'Търгът е приключил.');
  if (ctx.status !== 'active') return fail('NOT_ACTIVE', 'Търгът не е активен в момента.');
  if (!Number.isInteger(amount) || amount <= 0) return fail('BELOW_MINIMUM', 'Невалидна сума.');
  const top = highestBid(ctx.bids);
  if (top && top.bidderId === ctx.bidderId) return fail('ALREADY_HIGHEST', 'Ти вече си с най-високата оферта.');
  if (amount < nextValid) return fail('BELOW_MINIMUM', `Минималната валидна оферта е ${formatEur(nextValid)}.`);
  const step = top ? stepFor(top.amount, ctx.rules) : stepFor(ctx.lot.startPrice, ctx.rules);
  if ((amount - nextValid) % step !== 0) return fail('NOT_ON_STEP', `Сумата трябва да е кратна на стъпката от ${formatEur(step)}.`);
  if (ctx.rules.maxBid !== null && amount > ctx.rules.maxBid) return fail('ABOVE_HOUSE_MAX', `Максималната оферта за лота е ${formatEur(ctx.rules.maxBid)}.`);
  return { ok: true, nextValid };
}

/** Anti-sniping: returns the new end time if a bid accepted at `acceptedAt` extends the auction. */
export function extendedEnd(endsAt: number, acceptedAt: number, rules: BidRules): number | null {
  if (endsAt - acceptedAt <= rules.antiSnipingWindowMs) return Math.max(endsAt, acceptedAt + rules.extensionMs);
  return null;
}
