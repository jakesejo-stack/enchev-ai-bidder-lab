// Application controller: owns the adapter, auction state, server clock, DAVID and the bid flow.
// The UI only reads `ctrl` and calls its actions; it re-renders on `subscribe` notifications.
import type { AuctionAdapter } from '../adapters/types.js';
import type { AuctionEvent, BidRecord, Cents, ConnectionState } from '../domain/types.js';
import { applyEvent, checkGap, initialAuctionState, type AuctionState } from '../domain/reducer.js';
import { ServerClock } from '../domain/clock.js';
import { advise, type Advice } from '../domain/advisor.js';
import { alignBid, checkBid, currentStep, highestBid, nextValidBid } from '../domain/rules.js';
import { formatEur, speakEur } from '../domain/money.js';
import { David } from '../voice/david.js';
import { Microphone, parseCommand } from '../voice/commands.js';

export interface BidAttempt {
  key: string;
  amount: Cents;
  at: number;
  status: 'pending' | 'accepted' | 'rejected';
  message: string;
}

export interface LogEntry { at: number; text: string; kind: 'bid' | 'mine' | 'status' | 'system' | 'error'; }

export interface ConfirmState {
  open: boolean;
  amount: Cents;
  key: string;
  consent: boolean;
  pending: boolean;
  error: string | null;
  priceMoved: boolean;
}

export interface Settings { speakAdvice: boolean; highContrast: boolean; rate: number; }

const STORE_KEY = 'enchev-ai-bidder-lab:v1';
const THRESHOLDS = [60_000, 30_000, 10_000];

/** No personal limit is shown in this lab: bids may go from 0 € up to the auction maximum (1 000 000 €). */
export const CAP_MAX: Cents = 100_000_000;
const validCap = (c: unknown): c is Cents => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= CAP_MAX;

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class Controller {
  auction: AuctionState = initialAuctionState();
  connection: ConnectionState = 'connecting';
  browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
  clock = new ServerClock();
  cap: Cents | null = null;
  attempts: BidAttempt[] = [];
  log: LogEntry[] = [];
  /** Local time of the last anti-sniping extension (for the УДЪЛЖЕН badge). */
  extendedAt: number | null = null;
  /** Anti-sniping extensions seen in this auction (for AI Info statistics). */
  extensions = 0;
  confirm: ConfirmState = { open: false, amount: 0, key: '', consent: false, pending: false, error: null, priceMoved: false };
  settings: Settings = { speakAdvice: false, highContrast: false, rate: 1 };
  david: David;
  mic: Microphone;
  advice!: Advice;
  private listeners = new Set<() => void>();
  /** Receives every server event once, in order, after de-duplication (analytics recorder). */
  readonly eventTaps: ((e: AuctionEvent) => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private warned = new Set<number>();
  private lastAdviceAction = '';
  private lastEndsAt = 0;
  private scheduled = false;

  constructor(public adapter: AuctionAdapter) {
    this.david = new David(() => this.notify());
    this.mic = new Microphone((t) => this.onVoiceText(t), () => this.notify());
    this.load();
    this.david.setRate(this.settings.rate);
    this.refreshAdvice();
  }

  // ---------------------------------------------------------------- lifecycle
  start(): void {
    this.adapter.connect({
      onEvent: (e) => this.onEvent(e),
      onConnection: (s, d) => this.onConnection(s, d),
      onClockSample: (s) => { this.clock.sample(s); },
      onHeartbeat: (seq) => this.onHeartbeat(seq),
    });
    this.tickTimer = setInterval(() => this.tick(), 250);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.browserOnline = true; this.refreshAdvice(); this.notify(); });
      window.addEventListener('offline', () => {
        this.browserOnline = false;
        this.david.say('Устройството е без интернет. Наддаването е спряно.', 'alert', undefined, 'offline');
        this.refreshAdvice(); this.notify();
      });
    }
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Batched notifications (rapid event bursts render once per frame). */
  notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => { this.scheduled = false; for (const l of this.listeners) l(); };
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(run); else setTimeout(run, 0);
  }

  // ---------------------------------------------------------------- derived
  get effectiveConnection(): ConnectionState { return this.browserOnline ? this.connection : 'offline'; }
  get serverNow(): number { return this.clock.now(); }
  get remainingMs(): number { return this.auction.lot ? this.clock.remainingMs(this.auction.endsAt) : 0; }
  get top(): BidRecord | null { return highestBid(this.auction.bids); }
  get leading(): boolean { return this.top?.bidderId === this.adapter.bidderId; }
  get nextValid(): Cents | null { const { lot, rules, bids } = this.auction; return lot && rules ? nextValidBid(lot, rules, bids) : null; }
  get ended(): boolean { return this.auction.status === 'ended' || (!!this.auction.lot && this.remainingMs === 0); }

  /** Why bidding is not possible right now (null = possible). Client-side check only; the server decides. */
  get blockReason(): string | null {
    const { lot, rules } = this.auction;
    if (!lot || !rules) return 'Зареждане…';
    if (this.effectiveConnection !== 'online') return 'НЯМА ВРЪЗКА';
    if (this.auction.needsResync) return 'СИНХРОНИЗИРАНЕ…';
    if (this.ended) return 'ТЪРГЪТ ПРИКЛЮЧИ';
    if (this.auction.status !== 'active') return 'ТЪРГЪТ НЕ Е АКТИВЕН';
    if (!this.adapter.authenticated) return 'ВЛЕЗ В ПРОФИЛА';
    if (this.leading) return 'ВОДИШ';
    const next = this.nextValid!;
    if (rules.maxBid !== null && next > rules.maxBid) return 'НАД МАКСИМУМА';
    if (this.cap !== null && next > this.cap) return 'НАД ЛИМИТА ТИ';
    return null;
  }

  private refreshAdvice(): void {
    this.advice = advise({ auction: this.auction, cap: this.cap, myBidderId: this.adapter.bidderId, serverNow: this.serverNow, connection: this.effectiveConnection });
    if (this.advice.action !== this.lastAdviceAction) {
      const first = this.lastAdviceAction === '';
      this.lastAdviceAction = this.advice.action;
      if (!first && this.settings.speakAdvice && this.advice.action !== 'not_ready') this.david.say(this.advice.headline, 'advice', 'advice');
    }
  }

  // ---------------------------------------------------------------- events
  private onEvent(e: AuctionEvent): void {
    const wasLeading = this.leading;
    const hadLot = !!this.auction.lot;
    this.clock.observeServerTime(e.serverTime, Date.now());
    const r = applyEvent(this.auction, e, Date.now());
    this.auction = r.state;
    for (const a of r.applied) {
      this.narrate(a, wasLeading, hadLot);
      for (const tap of this.eventTaps) tap(a);
    }
    if (this.auction.endsAt !== this.lastEndsAt) {
      // Re-arm time warnings that are now in the future again (after an extension).
      const rem = this.remainingMs;
      for (const t of THRESHOLDS) if (rem > t + 1000) this.warned.delete(t);
      this.lastEndsAt = this.auction.endsAt;
    }
    if (this.confirm.open && !this.confirm.pending && this.nextValid !== null && this.auction.lot && this.auction.rules) {
      // Price moved while the dialog was open: if the chosen amount is no longer a valid bid, raise it to
      // the nearest valid one and require fresh consent for the new amount.
      const aligned = alignBid(this.confirm.amount, this.nextValid, currentStep(this.auction.lot, this.auction.rules, this.auction.bids));
      if (aligned !== this.confirm.amount) this.confirm = { ...this.confirm, amount: aligned, consent: false, priceMoved: true, key: uid(), error: null };
    }
    this.refreshAdvice();
    this.notify();
  }

  private narrate(e: AuctionEvent, wasLeading: boolean, hadLot: boolean): void {
    const at = e.serverTime;
    switch (e.type) {
      case 'snapshot':
      case 'lot_change': {
        const top = highestBid(e.bids);
        if (!hadLot || e.type === 'lot_change') {
          this.log.push({ at, text: `Свързан с ${e.lot.demo ? 'ДЕМО ' : ''}лот ${e.lot.lotId}`, kind: 'system' });
          this.david.say(`Свързан съм с ${e.lot.demo ? 'демо ' : ''}търга. Текуща оферта: ${top ? speakEur(top.amount) : 'няма'}.`, 'system', undefined, 'connected');
        } else {
          this.log.push({ at, text: 'Синхронизиране с актуалното състояние', kind: 'system' });
        }
        break;
      }
      case 'bid': {
        const mine = e.bid.bidderId === this.adapter.bidderId;
        this.log.push({ at, text: `${mine ? 'Ти' : e.bid.bidderId}: ${formatEur(e.bid.amount)}`, kind: mine ? 'mine' : 'bid' });
        if (mine) this.david.say(`Твоята оферта от ${speakEur(e.bid.amount)} е най-високата.`, 'event', 'price', 'you_lead');
        else if (wasLeading) this.david.say(`Някой те надмина: ${speakEur(e.bid.amount)}.`, 'alert', 'price', 'outbid');
        else this.david.say(`Има нова оферта: ${speakEur(e.bid.amount)}.`, 'event', 'price', 'new_bid');
        break;
      }
      case 'extension':
        if (e.byMs > 0) {
          const s = Math.round(e.byMs / 1000);
          this.extendedAt = Date.now();
          this.extensions++;
          this.log.push({ at, text: `Търгът е удължен с ${s} с (оферта в последните секунди)`, kind: 'status' });
          this.david.say(`Търгът е удължен с ${s} секунди.`, 'alert', 'ext', 'extended');
        } else {
          this.log.push({ at, text: 'Краят на търга е променен', kind: 'status' });
        }
        break;
      case 'status':
        this.log.push({ at, text: e.status === 'ended' ? 'Търгът приключи' : `Статус: ${e.status}`, kind: 'status' });
        if (e.status === 'ended') {
          const top = highestBid(this.auction.bids);
          const mine = top?.bidderId === this.adapter.bidderId;
          this.david.say(mine ? `Търгът приключи. Твоята оферта от ${speakEur(top!.amount)} е най-високата.` : `Търгът приключи${top ? ` при ${speakEur(top.amount)}` : ''}.`, 'alert', undefined, mine ? 'ended_won' : 'ended');
        }
        break;
    }
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  }

  private heartbeatBehind = 0;
  /** The server is ahead of us and nothing is buffered to fill the gap: a tail event was lost. */
  private onHeartbeat(serverSeq: number): void {
    const a = this.auction;
    if (serverSeq > a.lastSeq && !a.buffer.length) {
      // Allow one heartbeat interval for in-flight events before resyncing.
      if (++this.heartbeatBehind >= 2) {
        this.heartbeatBehind = 0;
        this.auction = { ...a, stats: { ...a.stats, resyncs: a.stats.resyncs + 1 } };
        this.log.push({ at: this.serverNow, text: 'Пропуснато последно събитие — изисквам пълно състояние', kind: 'system' });
        this.adapter.requestSnapshot();
      }
    } else {
      this.heartbeatBehind = 0;
    }
  }

  private onConnection(s: ConnectionState, detail?: string): void {
    const prev = this.connection;
    this.connection = s;
    if (s === 'offline' && prev === 'online') {
      this.log.push({ at: this.serverNow, text: `Връзката е прекъсната${detail ? ` (${detail})` : ''}`, kind: 'error' });
      this.david.say('Връзката е прекъсната. Наддаването е спряно, докато се свържем отново.', 'alert', undefined, 'connection_lost');
    }
    if (s === 'online' && (prev === 'offline' || prev === 'reconnecting')) {
      this.log.push({ at: this.serverNow, text: 'Връзката е възстановена — синхронизиране', kind: 'system' });
      this.david.say('Връзката е възстановена.', 'system', undefined, 'connection_back');
    }
    this.refreshAdvice();
    this.notify();
  }

  private tick(): void {
    const gapped = checkGap(this.auction, Date.now());
    if (gapped !== this.auction) {
      this.auction = gapped;
      if (gapped.needsResync) {
        this.log.push({ at: this.serverNow, text: 'Липсващи събития — изисквам пълно състояние', kind: 'system' });
        this.adapter.requestSnapshot();
      }
    }
    if (this.auction.lot && !this.ended && this.auction.status === 'active') {
      const rem = this.remainingMs;
      for (const t of THRESHOLDS) {
        if (rem <= t && rem > t - 2000 && !this.warned.has(t)) {
          this.warned.add(t);
          const text = t === 60_000 ? 'Остава една минута.' : `Остават ${t / 1000} секунди.`;
          this.david.say(text, 'alert', 'time', t === 60_000 ? 'time_60' : t === 30_000 ? 'time_30' : t === 10_000 ? 'time_10' : undefined);
        } else if (rem <= t - 2000) {
          this.warned.add(t); // passed silently (e.g. joined late)
        }
      }
    }
    this.refreshAdvice();
    this.notify();
  }

  // ---------------------------------------------------------------- user actions
  setCap(c: Cents | null): void {
    if (c !== null && !validCap(c)) return;
    this.cap = c;
    this.save();
    this.log.push({ at: this.serverNow, text: c === null ? 'Лимитът е изчистен' : `Лимитът е зададен на ${formatEur(c)}`, kind: 'system' });
    this.refreshAdvice();
    this.notify();
  }

  setSetting<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.settings = { ...this.settings, [k]: v };
    if (k === 'rate') this.david.setRate(v as number);
    this.save();
    this.notify();
  }

  openConfirm(): void {
    if (this.blockReason || this.nextValid === null) return;
    this.confirm = { open: true, amount: this.nextValid, key: uid(), consent: false, pending: false, error: null, priceMoved: false };
    this.notify();
  }

  closeConfirm(): void {
    if (this.confirm.pending) return;
    this.confirm = { ...this.confirm, open: false };
    this.notify();
  }

  /** Choose the bid amount in the open confirmation (rounded up to a valid bid). Consent must be given again. */
  setConfirmAmount(amount: Cents): void {
    const c = this.confirm;
    const { lot, rules, bids } = this.auction;
    if (!c.open || c.pending || !lot || !rules || this.nextValid === null) return;
    const aligned = alignBid(Math.min(amount, rules.maxBid ?? amount), this.nextValid, currentStep(lot, rules, bids));
    if (aligned === c.amount) return;
    this.confirm = { ...c, amount: aligned, consent: false, priceMoved: false, key: uid(), error: null };
    this.notify();
  }

  get confirmStep(): Cents | null {
    const { lot, rules, bids } = this.auction;
    return lot && rules ? currentStep(lot, rules, bids) : null;
  }

  setConsent(v: boolean): void { this.confirm = { ...this.confirm, consent: v, priceMoved: v ? false : this.confirm.priceMoved }; this.notify(); }

  /** Sends the bid. Repeated clicks reuse the same idempotency key and are ignored while pending. */
  async submitBid(): Promise<void> {
    const c = this.confirm;
    if (!c.open || !c.consent || c.pending) return;
    const { lot, rules } = this.auction;
    if (!lot || !rules) return;
    // Client pre-check (advisory): refuses obviously invalid bids before contacting the server.
    const pre = checkBid(c.amount, {
      lot, rules, status: this.auction.status, bids: this.auction.bids, endsAt: this.auction.endsAt, serverNow: this.serverNow,
      bidderId: this.adapter.bidderId, authenticated: this.adapter.authenticated, lotId: lot.lotId,
    });
    if (!pre.ok) { this.confirm = { ...c, error: pre.message ?? 'Офертата не е валидна.' }; this.notify(); return; }
    if (this.cap !== null && c.amount > this.cap) { this.confirm = { ...c, error: 'Сумата е над лимита ти. Промени лимита съзнателно, ако искаш да продължиш.' }; this.notify(); return; }
    if (this.effectiveConnection !== 'online') { this.confirm = { ...c, error: 'Няма връзка. Офертата не е изпратена.' }; this.notify(); return; }

    let attempt = this.attempts.find((a) => a.key === c.key);
    if (!attempt) {
      attempt = { key: c.key, amount: c.amount, at: this.serverNow, status: 'pending', message: 'Изпращане…' };
      this.attempts.unshift(attempt);
    }
    this.confirm = { ...c, pending: true, error: null };
    this.notify();
    const res = await this.adapter.placeBid({ lotId: lot.lotId, amount: c.amount, currency: lot.currency, idempotencyKey: c.key });
    if (res.status === 'accepted') {
      attempt.status = 'accepted';
      attempt.message = this.adapter.mode === 'demo' ? 'Приета от демо сървъра (не е реална оферта)' : 'Приета от сървъра';
      this.confirm = { ...this.confirm, open: false, pending: false };
    } else {
      attempt.status = 'rejected';
      attempt.message = res.message;
      this.log.push({ at: this.serverNow, text: `Отказана оферта ${formatEur(c.amount)}: ${res.message}`, kind: 'error' });
      this.david.say(`Офертата не е приета. ${res.message}`, 'alert', undefined, 'bid_rejected');
      this.confirm = { ...this.confirm, pending: false, error: res.message };
    }
    this.refreshAdvice();
    this.notify();
  }

  // ---------------------------------------------------------------- voice
  private onVoiceText(text: string): void {
    this.david.say(`„${text}“`, 'user');
    switch (parseCommand(text)) {
      case 'price': {
        const top = this.top;
        this.david.say(top ? `Текущата оферта е ${speakEur(top.amount)}. Следващата валидна е ${speakEur(this.nextValid!)}.` : 'Още няма оферти.', 'event');
        break;
      }
      case 'open_bid':
        if (this.blockReason) this.david.say(`Не може да наддадеш сега: ${this.blockReason.toLowerCase()}.`, 'event');
        else { this.openConfirm(); this.david.say('Отворих потвърждението. Провери сумата и потвърди ръчно.', 'event', undefined, 'confirm_opened'); }
        break;
      case 'pause_voice': this.david.pause(); break;
      case 'resume_voice': this.david.resume(); break;
      case 'limit': this.david.say('В тази версия няма личен лимит: можеш да наддаваш от 0 до 1 000 000 евро.', 'event'); break;
      default: this.david.say('Не разбрах командата. Опитай: „цена“, „наддай“, „пауза“.', 'event');
    }
  }

  // ---------------------------------------------------------------- persistence
  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { cap?: number | null; settings?: Partial<Settings> };
      // The personal limit is no longer shown, so a limit saved by an older version is ignored.
      if (v.settings) this.settings = { ...this.settings, ...v.settings };
    } catch { /* storage unavailable */ }
  }

  private save(): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ cap: this.cap, settings: this.settings })); } catch { /* ignore */ }
  }
}
