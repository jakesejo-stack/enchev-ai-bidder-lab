// Vehicle Deal Workspace — one deal per LOT ID + VIN, from the auction to the buyer receiving the car.
// Pure and unit-tested. Every change is an event in an append-only, hash-chained log (see chain.ts);
// the state below is always DERIVED from that log, so nothing is stored twice.
//
// Authority (who may record what) is enforced here, not in the UI:
//   • WINNER and auction facts → only the auction server's published events ('auction_server').
//   • Payment confirmed        → only the payment provider ('payment_provider'), amount = approved invoice.
//   • Document verification    → only an administrator, with date and time, never the uploader.
//   • AI ('ai')                → may record NOTHING. It can only suggest the next step.
// No user button can confirm a payment, ownership or the winner.
import type { Cents } from '../domain/types.js';
import { checkVin } from './vin.js';

export type Role = 'seller' | 'admin' | 'buyer' | 'carrier';
export type SystemActor = 'auction_server' | 'payment_provider';
export type Actor = Role | SystemActor | 'ai';
export const ROLES: Role[] = ['seller', 'admin', 'buyer', 'carrier'];
export const ACTOR_BG: Record<Actor, string> = {
  seller: 'Продавач', admin: 'Администратор', buyer: 'Купувач', carrier: 'Превозвач',
  auction_server: 'Сървър на търга', payment_provider: 'Платежен доставчик', ai: 'AI',
};

export type Phase = 'before' | 'after' | 'release' | 'delivery';
export const PHASE_BG: Record<Phase, string> = { before: 'Преди търга', after: 'След търга', release: 'Освобождаване', delivery: 'Доставка' };

export type DocType = 'vin_photos' | 'registration' | 'ownership' | 'invoice' | 'payment_proof' | 'transfer_poa' | 'pickup_auth' | 'cmr' | 'delivery_protocol';

export interface DocDef {
  type: DocType;
  phase: Phase;
  title: string;
  hint: string;
  uploader: Role;
  /** Offer the phone camera first (photos of the car / VIN plate). */
  camera: boolean;
  /** The administrator must confirm the VIN on the document matches the lot's VIN. */
  vinCheck: boolean;
  /** The upload carries an amount (invoice). */
  amount: boolean;
}

export const DOCS: DocDef[] = [
  { type: 'vin_photos', phase: 'before', title: 'VIN и снимки на автомобила', hint: 'Табелка с VIN и снимки от всички страни.', uploader: 'seller', camera: true, vinCheck: true, amount: false },
  { type: 'registration', phase: 'before', title: 'Регистрационен талон', hint: 'Двете страни на талона.', uploader: 'seller', camera: true, vinCheck: true, amount: false },
  { type: 'ownership', phase: 'before', title: 'Документ за собственост', hint: 'Договор, фактура или друг документ за собственост.', uploader: 'seller', camera: true, vinCheck: false, amount: false },
  { type: 'invoice', phase: 'after', title: 'Фактура и разбивка', hint: 'Официална фактура с крайна сума и валута.', uploader: 'seller', camera: false, vinCheck: false, amount: true },
  { type: 'payment_proof', phase: 'after', title: 'Платежно нареждане', hint: 'Доказателство за превода. Не е потвърждение — плащането потвърждава доставчикът.', uploader: 'buyer', camera: true, vinCheck: false, amount: false },
  { type: 'transfer_poa', phase: 'release', title: 'Прехвърляне / пълномощно', hint: 'Документ за прехвърляне на собствеността или пълномощно.', uploader: 'seller', camera: true, vinCheck: false, amount: false },
  { type: 'pickup_auth', phase: 'release', title: 'Разрешение за вземане', hint: 'Разрешение превозвачът да вземе автомобила.', uploader: 'seller', camera: false, vinCheck: false, amount: false },
  { type: 'cmr', phase: 'delivery', title: 'Товарителница / CMR', hint: 'Подписана при вземане на автомобила.', uploader: 'carrier', camera: true, vinCheck: false, amount: false },
  { type: 'delivery_protocol', phase: 'delivery', title: 'Приемо-предавателен протокол', hint: 'Подписан от купувача при получаване.', uploader: 'carrier', camera: true, vinCheck: false, amount: false },
];
export const DOC_BY_TYPE = Object.fromEntries(DOCS.map((d) => [d.type, d])) as Record<DocType, DocDef>;
/** 9 uploaded documents + the WINNER record published by the auction server = 10 items. */
export const CHECKLIST_TOTAL = DOCS.length + 1;

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export interface FileMeta {
  fileId: string;
  name: string;
  mime: AllowedMime;
  size: number;
  /** SHA-256 of the file bytes (hex): proves later that the stored file is the one reviewed. */
  sha256: string;
  /** Invoice total, integer cents (only for documents with amount: true). */
  amount?: Cents;
}

export type DealBody =
  | { type: 'deal_opened'; lotId: string; vin: string; title: string; demo: boolean }
  | { type: 'auction_started'; startedAt: number }
  | { type: 'winner_confirmed'; bidderId: string; amount: Cents; bidId: string; endedAt: number; bids: number }
  | { type: 'auction_ended_no_winner'; endedAt: number }
  | { type: 'doc_uploaded'; doc: DocType; file: FileMeta }
  | { type: 'doc_reviewed'; doc: DocType; fileId: string; decision: 'approved' | 'rejected'; note: string; vinMatches?: boolean }
  | { type: 'payment_confirmed'; amount: Cents; reference: string }
  | { type: 'transport'; step: 'picked_up' | 'in_transit' | 'delivered' }
  | { type: 'receipt_confirmed'; car: boolean; originals: boolean };
export type DealEventType = DealBody['type'];

/** Who may record each kind of event. Anything not listed is refused. */
export const AUTHORITY: Record<DealEventType, readonly Actor[]> = {
  deal_opened: ['auction_server'],
  auction_started: ['auction_server'],
  winner_confirmed: ['auction_server'],
  auction_ended_no_winner: ['auction_server'],
  doc_uploaded: ['seller', 'buyer', 'carrier'],
  doc_reviewed: ['admin'],
  payment_confirmed: ['payment_provider'],
  transport: ['carrier'],
  receipt_confirmed: ['buyer'],
};

export interface DealEvent {
  seq: number;
  /** Server time (ms) when the event was recorded. */
  at: number;
  actor: Actor;
  body: DealBody;
  /** Hash of the previous event ('' for the first): any edit or removal breaks the chain. */
  prev: string;
  hash: string;
}

export interface FileVersion extends FileMeta { at: number; by: Actor; }
export interface Review { fileId: string; decision: 'approved' | 'rejected'; note: string; at: number; vinMatches?: boolean; }
export interface DocState { versions: FileVersion[]; reviews: Review[]; }

export interface DealState {
  key: { lotId: string; vin: string; title: string; demo: boolean } | null;
  docs: Record<DocType, DocState>;
  auctionStartedAt: number | null;
  auctionEndedAt: number | null;
  winner: { bidderId: string; amount: Cents; bidId: string; at: number; bids: number } | null;
  noWinner: boolean;
  payment: { amount: Cents; reference: string; at: number } | null;
  transport: { picked_up: number | null; in_transit: number | null; delivered: number | null };
  receipt: { at: number } | null;
  warnings: string[];
  lastSeq: number;
  lastHash: string;
}

export function emptyDeal(): DealState {
  return {
    key: null,
    docs: Object.fromEntries(DOCS.map((d) => [d.type, { versions: [], reviews: [] }])) as unknown as Record<DocType, DocState>,
    auctionStartedAt: null, auctionEndedAt: null, winner: null, noWinner: false, payment: null,
    transport: { picked_up: null, in_transit: null, delivered: null }, receipt: null, warnings: [], lastSeq: 0, lastHash: '',
  };
}

// ------------------------------------------------------------------ derived document status
export type DocStatus = 'missing' | 'pending' | 'approved' | 'rejected';
export function latest(d: DocState): FileVersion | null { return d.versions[d.versions.length - 1] ?? null; }
export function reviewOf(d: DocState): Review | null {
  const f = latest(d);
  return f ? d.reviews.find((r) => r.fileId === f.fileId) ?? null : null;
}
export function docStatus(d: DocState): DocStatus {
  if (!latest(d)) return 'missing';
  const r = reviewOf(d);
  return r ? r.decision : 'pending';
}
export const approved = (s: DealState, t: DocType): boolean => docStatus(s.docs[t]) === 'approved';
/** Amount of the approved invoice (cents), or null. */
export function invoiceAmount(s: DealState): Cents | null {
  return approved(s, 'invoice') ? latest(s.docs.invoice)!.amount ?? null : null;
}
export function checklistDone(s: DealState): number {
  // The payment order counts as done once the provider confirmed the payment (it needs no separate review).
  return DOCS.filter((d) => approved(s, d.type) || (d.type === 'payment_proof' && s.payment !== null)).length + (s.winner ? 1 : 0);
}

// ------------------------------------------------------------------ stages (derived)
export type StageKey = 'docs' | 'review' | 'live' | 'winner' | 'invoice' | 'payment' | 'transport' | 'received';
export const STAGES: { key: StageKey; title: string }[] = [
  { key: 'docs', title: 'Документи преди търга' },
  { key: 'review', title: 'Проверка от администратор' },
  { key: 'live', title: 'Търг на живо' },
  { key: 'winner', title: 'Потвърден WINNER' },
  { key: 'invoice', title: 'Фактура' },
  { key: 'payment', title: 'Плащане' },
  { key: 'transport', title: 'Освобождаване и транспорт' },
  { key: 'received', title: 'Получено от купувача' },
];
const BEFORE = DOCS.filter((d) => d.phase === 'before').map((d) => d.type);

export function stageDone(s: DealState, k: StageKey): boolean {
  switch (k) {
    case 'docs': return BEFORE.every((t) => latest(s.docs[t]) !== null);
    case 'review': return BEFORE.every((t) => approved(s, t));
    case 'live': return s.auctionStartedAt !== null;
    case 'winner': return s.winner !== null;
    case 'invoice': return approved(s, 'invoice');
    case 'payment': return s.payment !== null;
    case 'transport': return s.transport.delivered !== null && approved(s, 'transfer_poa') && approved(s, 'pickup_auth') && approved(s, 'cmr');
    case 'received': return s.receipt !== null;
  }
}
/** 1-based number of the first stage not done; 9 = the deal is complete. */
export function currentStage(s: DealState): number {
  const i = STAGES.findIndex((st) => !stageDone(s, st.key));
  return i < 0 ? STAGES.length + 1 : i + 1;
}

// ------------------------------------------------------------------ validation
export interface Refusal { code: string; message: string; }
const no = (code: string, message: string): Refusal => ({ code, message });

function checkFile(f: FileMeta, def: DocDef): Refusal | null {
  if (!f.fileId || typeof f.fileId !== 'string') return no('BAD_FILE', 'Липсва идентификатор на файла.');
  if (!(ALLOWED_MIME as readonly string[]).includes(f.mime)) return no('BAD_TYPE', 'Позволени са само JPG, PNG, WEBP, HEIC и PDF.');
  if (!Number.isInteger(f.size) || f.size <= 0) return no('EMPTY_FILE', 'Файлът е празен.');
  if (f.size > MAX_FILE_BYTES) return no('TOO_LARGE', 'Файлът е над 15 MB.');
  if (!/^[0-9a-f]{64}$/.test(f.sha256)) return no('BAD_HASH', 'Липсва SHA-256 на файла.');
  if (def.amount && !(Number.isInteger(f.amount) && (f.amount ?? 0) > 0)) return no('NO_AMOUNT', 'Въведи сумата от фактурата.');
  return null;
}

/** Why `actor` may not record `body` now (null = allowed). The same check must run on a real server. */
export function refuse(s: DealState, actor: Actor, body: DealBody): Refusal | null {
  if (!AUTHORITY[body.type].includes(actor)) {
    return no('FORBIDDEN', `${ACTOR_BG[actor]} няма право да записва „${body.type}“.`);
  }
  if (body.type !== 'deal_opened' && !s.key) return no('NO_DEAL', 'Сделката още не е отворена.');
  switch (body.type) {
    case 'deal_opened': {
      if (s.key) return no('ALREADY_OPEN', 'Сделката вече е отворена.');
      if (!body.lotId.trim()) return no('NO_LOT', 'Липсва LOT ID.');
      const v = checkVin(body.vin);
      if (!v.ok) return no('BAD_VIN', v.reason ?? 'Невалиден VIN.');
      return null;
    }
    case 'auction_started':
      return s.auctionStartedAt !== null ? no('ALREADY_STARTED', 'Търгът вече е записан като започнал.') : null;
    case 'winner_confirmed':
      if (s.winner || s.noWinner) return no('ALREADY_DECIDED', 'Резултатът от търга вече е записан.');
      if (!Number.isInteger(body.amount) || body.amount <= 0) return no('BAD_AMOUNT', 'Невалидна печеливша сума.');
      if (!body.bidId || !body.bidderId) return no('BAD_WINNER', 'Липсва печелившата оферта.');
      return null;
    case 'auction_ended_no_winner':
      return s.winner || s.noWinner ? no('ALREADY_DECIDED', 'Резултатът от търга вече е записан.') : null;
    case 'doc_uploaded': {
      const def = DOC_BY_TYPE[body.doc];
      if (!def) return no('UNKNOWN_DOC', 'Непознат документ.');
      if (actor !== def.uploader) return no('WRONG_UPLOADER', `Този документ се качва от: ${ACTOR_BG[def.uploader]}.`);
      if (approved(s, body.doc)) return no('LOCKED', 'Документът е одобрен и е заключен.');
      if (s.docs[body.doc].versions.some((v) => v.fileId === body.file.fileId)) return no('DUPLICATE', 'Този файл вече е качен.');
      if (def.phase === 'after' && !s.winner) return no('TOO_EARLY', 'Документът се качва след потвърден WINNER.');
      if (def.phase === 'release' && !s.payment) return no('TOO_EARLY', 'Документът се качва след потвърдено плащане.');
      if (body.doc === 'cmr' && s.transport.picked_up === null) return no('TOO_EARLY', 'CMR се качва при вземане на автомобила.');
      if (body.doc === 'delivery_protocol' && s.transport.delivered === null) return no('TOO_EARLY', 'Протоколът се качва при доставка.');
      const bad = checkFile(body.file, def);
      if (bad) return bad;
      if (body.doc === 'invoice' && s.winner && (body.file.amount ?? 0) < s.winner.amount) return no('BELOW_WIN', 'Сумата във фактурата е под печелившата оферта.');
      return null;
    }
    case 'doc_reviewed': {
      const def = DOC_BY_TYPE[body.doc];
      if (!def) return no('UNKNOWN_DOC', 'Непознат документ.');
      const f = latest(s.docs[body.doc]);
      if (!f) return no('NOTHING_TO_REVIEW', 'Няма качен файл.');
      if (f.fileId !== body.fileId) return no('STALE', 'Има по-нова версия на документа.');
      if (s.docs[body.doc].reviews.some((r) => r.fileId === body.fileId)) return no('ALREADY_REVIEWED', 'Тази версия вече е проверена.');
      if (body.decision === 'rejected' && body.note.trim().length < 3) return no('NEED_NOTE', 'Напиши причина за отказа.');
      if (body.decision === 'approved' && def.vinCheck && body.vinMatches !== true) return no('VIN_NOT_CONFIRMED', `Потвърди, че VIN съвпада с ${s.key!.vin}.`);
      return null;
    }
    case 'payment_confirmed': {
      if (s.payment) return no('ALREADY_PAID', 'Плащането вече е потвърдено.');
      if (!s.winner) return no('NO_WINNER', 'Няма потвърден WINNER.');
      const inv = invoiceAmount(s);
      if (inv === null) return no('NO_INVOICE', 'Няма одобрена фактура.');
      if (body.amount !== inv) return no('AMOUNT_MISMATCH', 'Сумата на плащането не съвпада с фактурата.');
      if (!body.reference.trim()) return no('NO_REFERENCE', 'Липсва референция от доставчика.');
      return null;
    }
    case 'transport': {
      const t = s.transport;
      if (t[body.step] !== null) return no('ALREADY_DONE', 'Тази стъпка вече е записана.');
      if (body.step === 'picked_up' && !(s.payment && approved(s, 'transfer_poa') && approved(s, 'pickup_auth'))) {
        return no('NOT_RELEASED', 'Автомобилът се взема след потвърдено плащане и одобрени прехвърляне и разрешение.');
      }
      if (body.step === 'in_transit' && t.picked_up === null) return no('ORDER', 'Първо „Взет“.');
      if (body.step === 'delivered' && t.in_transit === null) return no('ORDER', 'Първо „В движение“.');
      return null;
    }
    case 'receipt_confirmed':
      if (s.receipt) return no('ALREADY_DONE', 'Получаването вече е потвърдено.');
      if (s.transport.delivered === null) return no('NOT_DELIVERED', 'Автомобилът още не е доставен.');
      if (!approved(s, 'delivery_protocol')) return no('NO_PROTOCOL', 'Протоколът за доставка още не е одобрен.');
      if (!body.car || !body.originals) return no('BOTH_REQUIRED', 'Потвърди и автомобила, и оригиналните документи.');
      return null;
  }
}

/** Applies an already validated event (pure). */
export function applyDeal(s: DealState, e: DealEvent): DealState {
  const n: DealState = { ...s, lastSeq: e.seq, lastHash: e.hash };
  const b = e.body;
  const docs = (t: DocType, d: DocState) => ({ ...n.docs, [t]: d });
  switch (b.type) {
    case 'deal_opened': n.key = { lotId: b.lotId, vin: checkVin(b.vin).vin, title: b.title, demo: b.demo }; break;
    case 'auction_started':
      n.auctionStartedAt = b.startedAt;
      if (!BEFORE.every((t) => approved(s, t))) n.warnings = [...s.warnings, 'Търгът започна преди документите преди търга да са одобрени.'];
      break;
    case 'winner_confirmed':
      n.winner = { bidderId: b.bidderId, amount: b.amount, bidId: b.bidId, at: b.endedAt, bids: b.bids };
      n.auctionEndedAt = b.endedAt;
      break;
    case 'auction_ended_no_winner': n.noWinner = true; n.auctionEndedAt = b.endedAt; break;
    case 'doc_uploaded': {
      const d = s.docs[b.doc];
      n.docs = docs(b.doc, { ...d, versions: [...d.versions, { ...b.file, at: e.at, by: e.actor }] });
      break;
    }
    case 'doc_reviewed': {
      const d = s.docs[b.doc];
      const r: Review = { fileId: b.fileId, decision: b.decision, note: b.note.trim(), at: e.at, ...(b.vinMatches !== undefined ? { vinMatches: b.vinMatches } : {}) };
      n.docs = docs(b.doc, { ...d, reviews: [...d.reviews, r] });
      break;
    }
    case 'payment_confirmed': n.payment = { amount: b.amount, reference: b.reference, at: e.at }; break;
    case 'transport': n.transport = { ...s.transport, [b.step]: e.at }; break;
    case 'receipt_confirmed': n.receipt = { at: e.at }; break;
  }
  return n;
}

/** Human-readable line for the history (Bulgarian). */
export function describe(e: DealEvent): string {
  const b = e.body;
  switch (b.type) {
    case 'deal_opened': return `Сделката е отворена: ЛОТ ${b.lotId} · VIN ${b.vin}${b.demo ? ' (ДЕМО)' : ''}`;
    case 'auction_started': return 'Търгът започна';
    case 'winner_confirmed': return `WINNER потвърден от сървъра на търга: ${b.bidderId}, ${(b.amount / 100).toLocaleString('bg-BG')} € (${b.bids} оферти)`;
    case 'auction_ended_no_winner': return 'Търгът приключи без оферти — няма WINNER';
    case 'doc_uploaded': return `Качен: ${DOC_BY_TYPE[b.doc].title} — ${b.file.name} (SHA-256 ${b.file.sha256.slice(0, 12)}…)${b.file.amount ? `, сума ${(b.file.amount / 100).toLocaleString('bg-BG')} €` : ''}`;
    case 'doc_reviewed': return `${b.decision === 'approved' ? 'Одобрен' : 'Отхвърлен'}: ${DOC_BY_TYPE[b.doc].title}${b.vinMatches ? ' · VIN съвпада' : ''}${b.note ? ` — „${b.note}“` : ''}`;
    case 'payment_confirmed': return `Плащането е потвърдено от доставчика: ${(b.amount / 100).toLocaleString('bg-BG')} € · реф. ${b.reference}`;
    case 'transport': return { picked_up: 'Автомобилът е взет от превозвача', in_transit: 'Автомобилът е в движение', delivered: 'Автомобилът е доставен' }[b.step];
    case 'receipt_confirmed': return 'Купувачът потвърди, че е получил автомобила и оригиналните документи';
  }
}

/** The single next action, for the AI hint and DAVID. Suggests only — it never records anything. */
export function nextStep(s: DealState): { who: Actor; text: string } | null {
  if (!s.key) return null;
  const missing = (t: DocType) => docStatus(s.docs[t]) === 'missing' || docStatus(s.docs[t]) === 'rejected';
  const pending = (t: DocType) => docStatus(s.docs[t]) === 'pending';
  for (const t of BEFORE) if (missing(t)) return { who: 'seller', text: `Качи „${DOC_BY_TYPE[t].title}“.` };
  for (const t of BEFORE) if (pending(t)) return { who: 'admin', text: `Провери „${DOC_BY_TYPE[t].title}“ (VIN ${s.key.vin}).` };
  if (s.noWinner) return { who: 'auction_server', text: 'Търгът приключи без оферти. Няма WINNER.' };
  if (!s.auctionStartedAt) return { who: 'auction_server', text: 'Очаква се началото на търга.' };
  if (!s.winner) return { who: 'auction_server', text: 'Очаква се краят на търга и WINNER от сървъра.' };
  if (missing('invoice')) return { who: 'seller', text: 'Качи фактурата със сумата.' };
  if (pending('invoice')) return { who: 'admin', text: 'Провери фактурата.' };
  if (!s.payment) {
    if (missing('payment_proof')) return { who: 'buyer', text: 'Плати по фактурата и качи платежното.' };
    return { who: 'payment_provider', text: 'Очаква се потвърждение от платежния доставчик.' };
  }
  for (const t of ['transfer_poa', 'pickup_auth'] as DocType[]) {
    if (missing(t)) return { who: 'seller', text: `Качи „${DOC_BY_TYPE[t].title}“.` };
    if (pending(t)) return { who: 'admin', text: `Провери „${DOC_BY_TYPE[t].title}“.` };
  }
  if (!s.transport.picked_up) return { who: 'carrier', text: 'Вземи автомобила и отбележи „Взет“.' };
  if (missing('cmr')) return { who: 'carrier', text: 'Качи товарителницата (CMR).' };
  if (pending('cmr')) return { who: 'admin', text: 'Провери CMR.' };
  if (!s.transport.in_transit) return { who: 'carrier', text: 'Отбележи „В движение“.' };
  if (!s.transport.delivered) return { who: 'carrier', text: 'Отбележи „Доставен“.' };
  if (missing('delivery_protocol')) return { who: 'carrier', text: 'Качи подписания приемо-предавателен протокол.' };
  if (pending('delivery_protocol')) return { who: 'admin', text: 'Провери протокола за доставка.' };
  if (!s.receipt) return { who: 'buyer', text: 'Потвърди, че си получил автомобила и оригиналните документи.' };
  return null;
}
