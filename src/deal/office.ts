// The buyer's "Офис" after a won auction: one deal per won lot, kept as a hash-chained event log.
// Who may record what is fixed here (authority rules), so no button, AI or broker can confirm a winner,
// a payment or a delivery on its own:
//   server   — the auction server: the winner, deadlines, second chance, documents
//   buyer    — the winner's own decisions (approve, think, consult, decline, delivery, final protocol)
//   provider — the payment provider: deposit hold, penalty capture, payment (simulated in DEMO)
//   esign    — the qualified e-signature provider (Evrotrust; simulated in DEMO)
//   broker   — our consultant: may extend the decision time once, nothing else
//   carrier  — the transport company: pickup, GPS, delivery
import type { Cents, LotSpec } from '../domain/types.js';
import { euros } from '../domain/money.js';
import { costOf, type CostLine } from '../domain/costs.js';
import type { ChainEvent, ChainRules } from './chain.js';
import { CITIES, cityByName, quoteTransport, type Carriage, type TransportQuote } from './transport.js';

export type Actor = 'server' | 'buyer' | 'provider' | 'esign' | 'carrier' | 'broker';
export const ACTOR_BG: Record<Actor, string> = {
  server: 'Сървър на търга', buyer: 'Купувач', provider: 'Платежен доставчик', esign: 'Евротръст (КЕП)', carrier: 'Превозвач', broker: 'Консултант',
};

// ---------------------------------------------------------------- policy (proposal, see the spec doc)
export const PENALTY_RATE = 0.1;
export const PENALTY_MIN: Cents = euros(300);
export const DECIDE_MS = 24 * 3600_000;
export const CONSULT_EXTENSION_MS = 24 * 3600_000;
export const PAY_BUSINESS_DAYS = 3;

/** Penalty for a declined or unpaid win: 10 % of the winning price, at least 300 €. Also the deposit held. */
export function penaltyFor(amount: Cents): Cents {
  return Math.max(Math.round(amount * PENALTY_RATE), PENALTY_MIN);
}

/** End (23:59:59.999 local) of the n-th business day, counting the day of sale if it is a weekday. */
export function payDeadline(wonAt: number, days = PAY_BUSINESS_DAYS): number {
  const d = new Date(wonAt);
  let left = days;
  for (;;) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) { left--; if (left === 0) break; }
    d.setDate(d.getDate() + 1);
  }
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// ---------------------------------------------------------------- events
export interface WonInfo {
  dealId: string; lotId: string; title: string; vin: string; amount: Cents; origin: 'EU' | 'NON_EU';
  location: string; wonAt: number; specs: LotSpec[]; viaSecondChance: boolean;
  /** Other bidders' best bids, highest first (for the second chance). */
  runnerUps: { bidderId: string; amount: Cents }[];
}

export type DealBody =
  | ({ type: 'won' } & WonInfo)
  | { type: 'deposit_held'; amount: Cents; captureBy: number }
  | { type: 'think' }
  | { type: 'consult_requested' }
  | { type: 'consult_extended' }
  | { type: 'approved' }
  | { type: 'delivery_chosen'; mode: 'pickup' } | { type: 'delivery_chosen'; mode: 'delivery'; cityId: string; carriage: Carriage }
  | { type: 'signed'; contractHash: string }
  | { type: 'paid'; amount: Cents; ref: string }
  | { type: 'docs_issued'; docs: { kind: DocKind; hash: string }[] }
  | { type: 'declined'; penalty: Cents; reason: 'buyer' | 'expired' }
  | { type: 'penalty_captured'; amount: Cents }
  | { type: 'passed_on'; to: string; amount: Cents }
  | { type: 'resold'; to: string; amount: Cents }
  | { type: 'relisted' }
  | { type: 'picked_up' }
  | { type: 'gps'; progress: number; lat: number; lng: number }
  | { type: 'delivered' }
  | { type: 'received'; carOk: true; docsOk: true };

export type DealEvent = ChainEvent<Actor, DealBody>;
export type DocKind = 'confirmation' | 'proforma' | 'contract' | 'invoice' | 'gatepass' | 'protocol';

const WHO: Record<DealBody['type'], Actor> = {
  won: 'server', deposit_held: 'provider', think: 'buyer', consult_requested: 'buyer', consult_extended: 'broker', approved: 'buyer',
  delivery_chosen: 'buyer', signed: 'esign', paid: 'provider', docs_issued: 'server', declined: 'buyer', penalty_captured: 'provider',
  passed_on: 'server', resold: 'server', relisted: 'server', picked_up: 'carrier', gps: 'carrier', delivered: 'carrier', received: 'buyer',
};

// ---------------------------------------------------------------- state
export type Phase = 'none' | 'decision' | 'approved' | 'signed' | 'paid' | 'docs' | 'transport' | 'delivered' | 'completed' | 'declined';
export const PHASE_BG: Record<Phase, string> = {
  none: '—', decision: 'Спечелена — чака решение', approved: 'Одобрена — чака подпис и плащане', signed: 'Подписана — чака плащане',
  paid: 'Платена — издават се документите', docs: 'Документите са готови', transport: 'В транспорт', delivered: 'Доставена — чака протокол',
  completed: 'Получена', declined: 'Отказана',
};

export interface Delivery { mode: 'pickup' | 'delivery'; cityId?: string; quote: TransportQuote | null; }

export interface DealState {
  lastHash: string; lastSeq: number;
  deal: WonInfo | null;
  phase: Phase;
  thinking: boolean;
  consult: 'none' | 'requested' | 'extended';
  decideBy: number; payBy: number;
  penalty: Cents;
  deposit: { amount: Cents; status: 'none' | 'held' | 'captured' | 'applied'; captureBy: number };
  delivery: Delivery | null;
  contractHash: string | null;
  paid: { amount: Cents; ref: string; at: number } | null;
  docs: { kind: DocKind; hash: string }[];
  declined: { reason: 'buyer' | 'expired'; at: number } | null;
  secondChance: { to: string; amount: Cents; result: 'pending' | 'resold' | 'relisted' } | null;
  track: { pickedUpAt: number | null; progress: number; lat: number | null; lng: number | null; deliveredAt: number | null };
  receivedAt: number | null;
}

export function emptyDeal(): DealState {
  return {
    lastHash: '', lastSeq: 0, deal: null, phase: 'none', thinking: false, consult: 'none', decideBy: 0, payBy: 0, penalty: 0,
    deposit: { amount: 0, status: 'none', captureBy: 0 }, delivery: null, contractHash: null, paid: null, docs: [], declined: null,
    secondChance: null, track: { pickedUpAt: null, progress: 0, lat: null, lng: null, deliveredAt: null }, receivedAt: null,
  };
}

export function originCity(deal: WonInfo) {
  return cityByName(deal.location) ?? CITIES[0]!;
}

/** The transport quote for a delivery choice (recomputed from the tariff, never taken from the client). */
export function quoteFor(deal: WonInfo, cityId: string, carriage: Carriage): TransportQuote | null {
  const to = CITIES.find((c) => c.id === cityId);
  return to ? quoteTransport(originCity(deal), to, carriage, true, deal.amount) : null;
}

export interface InvoiceLine extends CostLine { negative?: boolean; }
export interface Invoice { lines: InvoiceLine[]; gross: Cents; deposit: Cents; due: Cents; }

/** What the buyer pays: price + fees + VAT on fees (+ transport) − the deposit already held. */
export function invoiceOf(s: DealState): Invoice | null {
  if (!s.deal) return null;
  const c = costOf(s.deal.amount, s.deal.origin);
  const lines: InvoiceLine[] = c.lines.slice();
  if (s.delivery?.quote) lines.push({ key: 'transport', label: `Транспорт до ${s.delivery.quote.to} (с ДДС)`, amount: s.delivery.quote.total, formula: `${s.delivery.quote.km} км, ДЕМО тарифа` });
  const gross = lines.reduce((t, l) => t + l.amount, 0);
  const deposit = s.deposit.status === 'held' || s.deposit.status === 'applied' ? s.deposit.amount : 0;
  if (deposit) lines.push({ key: 'deposit', label: 'Депозит (вече задържан, приспада се)', amount: -deposit, formula: 'задържан при спечелването', negative: true });
  return { lines, gross, deposit, due: gross - deposit };
}

const OPEN: Phase[] = ['decision', 'approved', 'signed'];

export function refuseDeal(s: DealState, actor: Actor, body: DealBody, at: number): string | null {
  const who = WHO[body.type];
  const expiredByServer = body.type === 'declined' && body.reason === 'expired';
  if (expiredByServer ? actor !== 'server' : actor !== who) return `„${body.type}“ може да запише само ${ACTOR_BG[expiredByServer ? 'server' : who]}.`;
  if (!s.deal && body.type !== 'won') return 'Сделката още не е създадена от сървъра на търга.';
  switch (body.type) {
    case 'won':
      if (s.deal) return 'Победителят вече е записан.';
      if (!body.vin || body.amount <= 0) return 'Липсват VIN или цена.';
      return null;
    case 'deposit_held':
      if (s.deposit.status !== 'none') return 'Депозитът вече е задържан.';
      if (body.amount !== s.penalty) return 'Депозитът трябва да е равен на санкцията по правилата.';
      return null;
    case 'think':
      if (s.phase !== 'decision') return 'Решението вече е взето.';
      if (s.thinking) return '„Ще помисля“ се използва само веднъж.';
      return at < s.decideBy ? null : 'Срокът за решение изтече.';
    case 'consult_requested':
      if (s.phase !== 'decision') return 'Решението вече е взето.';
      if (s.consult !== 'none') return 'Консултацията вече е поискана.';
      return at < s.decideBy ? null : 'Срокът за решение изтече.';
    case 'consult_extended':
      if (s.phase !== 'decision') return 'Решението вече е взето.';
      if (s.consult !== 'requested') return 'Консултантът може да удължи срока само веднъж и само след поискана консултация.';
      return at < s.decideBy ? null : 'Срокът за решение изтече.';
    case 'approved':
      if (s.phase !== 'decision') return 'Решението вече е взето.';
      if (s.deposit.status !== 'held') return 'Депозитът още не е задържан.';
      return at < s.decideBy ? null : 'Срокът за решение изтече.';
    case 'delivery_chosen':
      if (s.phase !== 'approved') return 'Доставката се избира след одобрение и преди подписа.';
      if (body.mode === 'delivery' && !quoteFor(s.deal!, body.cityId, body.carriage)) return 'Непознат град за доставка.';
      return null;
    case 'signed':
      if (s.phase !== 'approved') return 'Договорът се подписва след одобрение.';
      if (!s.delivery) return 'Първо избери вземане или доставка.';
      return body.contractHash.length === 64 ? null : 'Липсва отпечатък (SHA-256) на договора.';
    case 'paid': {
      if (s.phase !== 'signed') return 'Плащане се приема само след подписан договор.';
      if (at > s.payBy) return 'Срокът за плащане изтече.';
      const inv = invoiceOf(s);
      return inv && body.amount === inv.due ? null : 'Сумата не съвпада с фактурата.';
    }
    case 'docs_issued':
      return s.phase === 'paid' ? null : 'Документите се издават след потвърдено плащане.';
    case 'declined':
      if (!OPEN.includes(s.phase)) return 'Сделката вече не може да бъде отказана.';
      if (body.penalty !== s.penalty) return 'Санкцията не съвпада с правилата.';
      if (body.reason === 'expired') {
        const deadline = s.phase === 'decision' ? s.decideBy : s.payBy;
        if (at < deadline) return 'Срокът още не е изтекъл.';
      }
      return null;
    case 'penalty_captured':
      if (s.phase !== 'declined') return 'Санкция се взима само при отказ.';
      if (s.deposit.status !== 'held') return 'Няма задържан депозит.';
      return body.amount === s.penalty ? null : 'Сумата не съвпада със санкцията.';
    case 'passed_on':
      if (s.phase !== 'declined') return 'Втори шанс има само след отказ.';
      return s.secondChance ? 'Колата вече е предложена.' : null;
    case 'resold':
    case 'relisted':
      return s.secondChance?.result === 'pending' ? null : 'Няма активна оферта „Втори шанс“.';
    case 'picked_up':
      if (s.phase !== 'docs') return 'Колата се взима след документите.';
      return s.delivery?.mode === 'delivery' ? null : 'Избрано е вземане от купувача, не доставка.';
    case 'gps':
      if (s.phase !== 'transport') return 'GPS се записва само по време на превоза.';
      return body.progress >= s.track.progress && body.progress <= 1 ? null : 'Невалиден GPS напредък.';
    case 'delivered':
      return s.phase === 'transport' ? null : 'Колата не е в транспорт.';
    case 'received':
      if (s.phase === 'delivered' || (s.phase === 'docs' && s.delivery?.mode === 'pickup')) return body.carOk && body.docsOk ? null : 'Потвърди и колата, и документите.';
      return 'Колата още не е предадена.';
  }
}

export function applyDeal(s0: DealState, e: DealEvent): DealState {
  const s: DealState = { ...s0, lastHash: e.hash, lastSeq: e.seq };
  const b = e.body;
  switch (b.type) {
    case 'won': {
      const { type: _t, ...deal } = b;
      void _t;
      return { ...s, deal, phase: 'decision', decideBy: deal.wonAt + DECIDE_MS, payBy: payDeadline(deal.wonAt), penalty: penaltyFor(deal.amount) };
    }
    case 'deposit_held': return { ...s, deposit: { amount: b.amount, status: 'held', captureBy: b.captureBy } };
    case 'think': return { ...s, thinking: true };
    case 'consult_requested': return { ...s, consult: 'requested' };
    case 'consult_extended': return { ...s, consult: 'extended', decideBy: s.decideBy + CONSULT_EXTENSION_MS };
    case 'approved': return { ...s, phase: 'approved' };
    case 'delivery_chosen':
      return { ...s, delivery: b.mode === 'pickup' ? { mode: 'pickup', quote: null } : { mode: 'delivery', cityId: b.cityId, quote: quoteFor(s.deal!, b.cityId, b.carriage) } };
    case 'signed': return { ...s, phase: 'signed', contractHash: b.contractHash };
    case 'paid': return { ...s, phase: 'paid', paid: { amount: b.amount, ref: b.ref, at: e.at }, deposit: { ...s.deposit, status: 'applied' } };
    case 'docs_issued': return { ...s, phase: 'docs', docs: b.docs };
    case 'declined': return { ...s, phase: 'declined', declined: { reason: b.reason, at: e.at } };
    case 'penalty_captured': return { ...s, deposit: { ...s.deposit, status: 'captured' } };
    case 'passed_on': return { ...s, secondChance: { to: b.to, amount: b.amount, result: 'pending' } };
    case 'resold': return { ...s, secondChance: { to: b.to, amount: b.amount, result: 'resold' } };
    case 'relisted': return { ...s, secondChance: s.secondChance ? { ...s.secondChance, result: 'relisted' } : null };
    case 'picked_up': return { ...s, phase: 'transport', track: { ...s.track, pickedUpAt: e.at } };
    case 'gps': return { ...s, track: { ...s.track, progress: b.progress, lat: b.lat, lng: b.lng } };
    case 'delivered': return { ...s, phase: 'delivered', track: { ...s.track, progress: 1, deliveredAt: e.at } };
    case 'received': return { ...s, phase: 'completed', receivedAt: e.at };
  }
}

export const DEAL_RULES: ChainRules<Actor, DealBody, DealState> = { empty: emptyDeal, refuse: refuseDeal, apply: applyDeal };

/** The deadline that runs now (decision, then payment), or null when none applies. */
export function activeDeadline(s: DealState): { at: number; label: string } | null {
  if (s.phase === 'decision') return { at: s.decideBy, label: 'Срок за решение' };
  if (s.phase === 'approved' || s.phase === 'signed') return { at: s.payBy, label: 'Срок за плащане' };
  return null;
}

/** The 8 steps shown on the Office stepper, with how far this deal is. */
export const STEPS: { key: string; label: string; done: (s: DealState) => boolean }[] = [
  { key: 'won', label: 'Спечелена', done: (s) => !!s.deal },
  { key: 'decision', label: 'Решение', done: (s) => !['none', 'decision'].includes(s.phase) },
  { key: 'signed', label: 'Подпис', done: (s) => !!s.contractHash },
  { key: 'paid', label: 'Плащане', done: (s) => !!s.paid },
  { key: 'docs', label: 'Документи', done: (s) => s.docs.length > 0 },
  { key: 'transport', label: 'Транспорт', done: (s) => s.track.pickedUpAt !== null || (s.delivery?.mode === 'pickup' && s.phase === 'completed') },
  { key: 'delivered', label: 'Доставка', done: (s) => s.track.deliveredAt !== null || (s.delivery?.mode === 'pickup' && s.phase === 'completed') },
  { key: 'received', label: 'Протокол', done: (s) => s.receivedAt !== null },
];
