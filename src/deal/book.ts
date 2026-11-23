// "Моите коли": every won deal (one hash-chained log each) plus second-chance offers, kept on this device
// in DEMO. The simulated services below play the parts the real system gives to other parties: the
// payment provider, Evrotrust, the consultant, the carrier and the auction server. In a real build these
// events arrive from those services' webhooks; nothing in the browser may record them.
import type { BidRecord, Cents, LotInfo } from '../domain/types.js';
import { ChainLog, sha256Hex, type ChainCheck } from './chain.js';
import { DEAL_RULES, activeDeadline, originCity, type Actor, type DealBody, type DealEvent, type DealState, type DocKind } from './office.js';
import { buildDoc, docHash } from './docs.js';
import { CITIES, trackPoint, type Carriage } from './transport.js';

export type Deal = ChainLog<Actor, DealBody, DealState> & { id: string; check: ChainCheck | null };

export interface SecondChanceOffer {
  offerId: string; lotId: string; title: string; vin: string; location: string; specs: LotInfo['details'];
  amount: Cents; until: number; status: 'open' | 'accepted' | 'declined';
}

export interface EndedAuction { lot: LotInfo; bids: BidRecord[]; endsAt: number; myId: string; }

interface Stored { deals: Record<string, DealEvent[]>; offers: SecondChanceOffer[]; }
const KEY = 'enchev-office-v1';

const specOf = (lot: LotInfo, label: string): string | undefined => lot.details?.find((d) => d.label === label)?.value;

/** Best bid of every bidder except one, highest first. */
export function runnerUps(bids: BidRecord[], except: string): { bidderId: string; amount: Cents }[] {
  const best = new Map<string, Cents>();
  for (const b of bids) if (b.bidderId !== except) best.set(b.bidderId, Math.max(best.get(b.bidderId) ?? 0, b.amount));
  return [...best].map(([bidderId, amount]) => ({ bidderId, amount })).sort((a, b) => b.amount - a.amount);
}

export class DealBook {
  deals = new Map<string, Deal>();
  offers: SecondChanceOffer[] = [];
  lastEnded: EndedAuction | null = null;
  /** DEMO only: moves this book's clock forward to try deadlines without waiting a day. */
  skewMs = 0;
  private listeners = new Set<() => void>();
  private timers = new Set<number>();
  private sweep = 0;
  readonly ready: Promise<void>;
  /** Simulated service delays (ms); tests may shorten them. */
  delays = { provider: 900, esign: 1400, docs: 700, pickup: 2200, gpsStep: 1200, gpsSteps: 12, broker: 2500, secondChance: 2500 };

  constructor(private storage: Storage | null, private announce: (text: string) => void = () => {}) {
    this.ready = this.load();
    this.sweep = window.setInterval(() => this.checkDeadlines(), 1000);
  }

  now(): number { return Date.now() + this.skewMs; }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(): void { this.save(); for (const l of this.listeners) l(); }

  private newLog(id: string): Deal {
    const log = new ChainLog(DEAL_RULES, () => this.now()) as Deal;
    log.id = id;
    log.check = null;
    return log;
  }

  private async load(): Promise<void> {
    let raw: Stored | null = null;
    try { raw = JSON.parse(this.storage?.getItem(KEY) ?? 'null') as Stored | null; } catch { raw = null; }
    if (!raw) return;
    this.offers = Array.isArray(raw.offers) ? raw.offers : [];
    for (const [id, events] of Object.entries(raw.deals ?? {})) {
      const log = this.newLog(id);
      log.check = await log.load(events);
      if (!log.check.ok) log.events = events; // keep the broken log visible, never act on it
      this.deals.set(id, log);
    }
    for (const l of this.listeners) l();
    for (const d of this.deals.values()) this.drive(d);
  }

  private save(): void {
    try {
      const deals: Record<string, DealEvent[]> = {};
      for (const [id, d] of this.deals) deals[id] = d.events;
      this.storage?.setItem(KEY, JSON.stringify({ deals, offers: this.offers } satisfies Stored));
    } catch { /* storage full or blocked: the session still works */ }
  }

  list(): Deal[] { return [...this.deals.values()].sort((a, b) => (b.state.deal?.wonAt ?? 0) - (a.state.deal?.wonAt ?? 0)); }
  get(id: string): Deal | undefined { return this.deals.get(id); }
  byVin(vin: string): Deal | undefined { return this.list().find((d) => d.state.deal?.vin === vin); }

  /** Records a win. Called only from the auction server's own "ended" event (or an accepted second chance). */
  async recordWin(lot: LotInfo, amount: Cents, wonAt: number, auctionKey: string, others: { bidderId: string; amount: Cents }[], viaSecondChance = false): Promise<Deal | null> {
    await this.ready;
    const id = (await sha256Hex(`${auctionKey}|${viaSecondChance ? 'sc' : 'win'}`)).slice(0, 16);
    if (this.deals.has(id)) return this.deals.get(id)!;
    const log = this.newLog(id);
    const r = await log.append('server', {
      type: 'won', dealId: id, lotId: lot.lotId, title: lot.title, vin: specOf(lot, 'VIN') ?? '', amount, origin: 'EU',
      location: specOf(lot, 'Местоположение') ?? 'София, BG', wonAt, specs: lot.details ?? lot.specs, viaSecondChance, runnerUps: others.slice(0, 3),
    });
    if (!r.ok) return null;
    log.check = { ok: true, count: 1 };
    this.deals.set(id, log);
    this.changed();
    this.announce(`Колата е в „Моите коли“. Влез в Офиса, за да решиш до утре по това време.`);
    // The payment provider confirms the deposit hold (in a real build: before the first bid).
    this.drive(log);
    return log;
  }

  /** Remember the last ended auction (for the DEMO second chance when you were the runner-up). */
  noteEnded(a: EndedAuction): void { this.lastEnded = a; this.changed(); }

  private later(ms: number, fn: () => unknown): void {
    const t = window.setTimeout(() => { this.timers.delete(t); void fn(); }, ms);
    this.timers.add(t);
  }

  /** Appends one event and notifies; returns the refusal text, if any. */
  async as(id: string, actor: Actor, body: DealBody): Promise<string | null> {
    const d = this.deals.get(id);
    if (!d || d.check?.ok === false) return 'Сделката не е налична.';
    const r = await d.append(actor, body);
    if (!r.ok) return r.reason;
    this.changed();
    this.note(body);
    this.drive(d);
    return null;
  }

  // ------------------------------------------------------------ buyer actions (the only ones the UI calls)
  think(id: string) { return this.as(id, 'buyer', { type: 'think' }); }
  approve(id: string) { return this.as(id, 'buyer', { type: 'approved' }); }
  consult(id: string) { return this.as(id, 'buyer', { type: 'consult_requested' }); }
  decline(id: string) { const d = this.deals.get(id); return this.as(id, 'buyer', { type: 'declined', penalty: d?.state.penalty ?? 0, reason: 'buyer' }); }
  choosePickup(id: string) { return this.as(id, 'buyer', { type: 'delivery_chosen', mode: 'pickup' }); }
  chooseDelivery(id: string, cityId: string, carriage: Carriage) { return this.as(id, 'buyer', { type: 'delivery_chosen', mode: 'delivery', cityId, carriage }); }
  confirmReceived(id: string) { return this.as(id, 'buyer', { type: 'received', carOk: true, docsOk: true }); }

  /** Opens the (simulated) Evrotrust signing; the signature event comes from the e-sign provider. */
  async requestSignature(id: string): Promise<string | null> {
    const d = this.deals.get(id);
    if (!d || d.state.phase !== 'approved' || !d.state.delivery) return 'Първо избери вземане или доставка.';
    const hash = await docHash(buildDoc('contract', d.state));
    this.later(this.delays.esign, () => this.as(id, 'esign', { type: 'signed', contractHash: hash }));
    return null;
  }

  /** Starts the (simulated) checkout; "paid" comes only from the payment provider, with the invoice amount. */
  requestPayment(id: string, due: Cents): string | null {
    const d = this.deals.get(id);
    if (!d || d.state.phase !== 'signed') return 'Плащане се прави след подписан договор.';
    this.later(this.delays.provider, () => this.as(id, 'provider', { type: 'paid', amount: due, ref: `DEMO-REV-${id.slice(0, 6).toUpperCase()}` }));
    return null;
  }

  // ------------------------------------------------------------ what the other parties do (simulated)
  private busy = new Set<string>();

  /** Spoken note when a step completes. */
  private note(body: DealBody): void {
    const t: Partial<Record<DealBody['type'], string>> = {
      consult_requested: 'Консултантът ще ти се обади. Може да удължи срока веднъж с 24 часа.',
      declined: 'Отказ: задържаме депозита като санкция. Колата отива при следващия наддавач.',
      paid: 'Плащането е потвърдено от банката. Издаваме документите.',
      picked_up: 'Превозвачът взе колата. Можеш да я следиш по GPS.',
      delivered: 'Колата е доставена. Провери я заедно с документите и подпиши протокола.',
    };
    const text = t[body.type];
    if (text) this.announce(text);
  }

  /**
   * Plays the next step that belongs to another party, from the deal's STATE (so it also resumes after a
   * reload). One pending step per deal at a time; each step is checked again by the deal's rules.
   */
  private drive(d: Deal): void {
    if (this.busy.has(d.id) || d.check?.ok === false) return;
    const s = d.state, id = d.id;
    let ms = 0;
    let step: (() => Promise<unknown>) | null = null;
    if (s.phase === 'decision' && s.deposit.status === 'none') {
      ms = this.delays.provider;
      step = () => this.as(id, 'provider', { type: 'deposit_held', amount: s.penalty, captureBy: s.deal!.wonAt + 29 * 86_400_000 });
    } else if (s.phase === 'decision' && s.consult === 'requested') {
      ms = this.delays.broker;
      step = () => this.as(id, 'broker', { type: 'consult_extended' });
    } else if (s.phase === 'declined' && s.deposit.status === 'held') {
      ms = this.delays.provider;
      step = () => this.as(id, 'provider', { type: 'penalty_captured', amount: s.penalty });
    } else if (s.phase === 'declined' && !s.secondChance) {
      ms = 400;
      const next = s.deal?.runnerUps[0];
      step = () => this.as(id, 'server', next ? { type: 'passed_on', to: next.bidderId, amount: next.amount } : { type: 'passed_on', to: '—', amount: 0 });
    } else if (s.phase === 'declined' && s.secondChance?.result === 'pending') {
      const sc = s.secondChance;
      ms = sc.amount ? this.delays.secondChance : 300;
      // DEMO answer of the simulated runner-up: deterministic per deal.
      step = () => this.as(id, 'server', sc.amount && parseInt(id.slice(-1), 16) % 2 === 0 ? { type: 'resold', to: sc.to, amount: sc.amount } : { type: 'relisted' });
    } else if (s.phase === 'paid') {
      ms = this.delays.docs;
      step = async () => {
        const kinds: DocKind[] = ['confirmation', 'proforma', 'contract', 'invoice', 'gatepass'];
        const docs = await Promise.all(kinds.map(async (kind) => ({ kind, hash: await docHash(buildDoc(kind, d.state)) })));
        return this.as(id, 'server', { type: 'docs_issued', docs });
      };
    } else if (s.phase === 'docs' && s.delivery?.mode === 'delivery') {
      ms = this.delays.pickup;
      step = () => this.as(id, 'carrier', { type: 'picked_up' });
    } else if (s.phase === 'transport') {
      ms = this.delays.gpsStep;
      const n = this.delays.gpsSteps;
      const next = Math.min(1, Math.round((s.track.progress + 1 / n) * 1000) / 1000);
      if (s.track.progress >= 1) step = () => this.as(id, 'carrier', { type: 'delivered' });
      else {
        const from = originCity(s.deal!), to = CITIES.find((c) => c.id === s.delivery?.cityId) ?? from;
        const pt = trackPoint(from, to, next);
        step = () => this.as(id, 'carrier', { type: 'gps', progress: next, lat: Math.round(pt.lat * 1e4) / 1e4, lng: Math.round(pt.lng * 1e4) / 1e4 });
      }
    }
    if (!step) return;
    this.busy.add(id);
    const run = step;
    this.later(ms, async () => { try { await run(); } finally { this.busy.delete(id); this.drive(this.deals.get(id) ?? d); } });
  }

  /** The server closes deals whose deadline passed (no decision, or no payment). */
  private checkDeadlines(): void {
    const now = this.now();
    for (const d of this.deals.values()) {
      const dl = activeDeadline(d.state);
      if (dl && now >= dl.at && d.check?.ok !== false) void this.as(d.id, 'server', { type: 'declined', penalty: d.state.penalty, reason: 'expired' });
    }
    let changed = false;
    for (const o of this.offers) if (o.status === 'open' && now >= o.until) { o.status = 'declined'; changed = true; }
    if (changed) this.changed();
  }

  /** DEMO: jump this book's clock to just after the running deadline of a deal. */
  demoExpire(id: string): void {
    const dl = this.deals.get(id) && activeDeadline(this.deals.get(id)!.state);
    if (!dl) return;
    this.skewMs += Math.max(0, dl.at - this.now() + 1000);
    this.checkDeadlines();
  }

  // ------------------------------------------------------------ second chance when YOU were the runner-up
  /** DEMO: the simulated winner of the last auction declines — the server offers the car to you if you were next. */
  demoWinnerDeclined(): SecondChanceOffer | null {
    const a = this.lastEnded;
    if (!a) return null;
    const top = a.bids.reduce<BidRecord | null>((m, b) => (!m || b.amount > m.amount ? b : m), null);
    if (!top || top.bidderId === a.myId) return null;
    const next = runnerUps(a.bids, top.bidderId)[0];
    if (!next || next.bidderId !== a.myId) return null;
    const offerId = `${a.lot.lotId}-${a.endsAt}`;
    if (this.offers.some((o) => o.offerId === offerId)) return null;
    const o: SecondChanceOffer = {
      offerId, lotId: a.lot.lotId, title: a.lot.title, vin: specOf(a.lot, 'VIN') ?? '', location: specOf(a.lot, 'Местоположение') ?? 'София, BG',
      specs: a.lot.details, amount: next.amount, until: this.now() + 24 * 3600_000, status: 'open',
    };
    this.offers.unshift(o);
    this.changed();
    this.announce(`Победителят се отказа. Колата е твоя за последната ти оферта, ако я искаш до утре.`);
    return o;
  }

  /** Whether the last ended auction makes you the runner-up (for the DEMO control). */
  get youWereRunnerUp(): boolean {
    const a = this.lastEnded;
    if (!a) return false;
    const top = a.bids.reduce<BidRecord | null>((m, b) => (!m || b.amount > m.amount ? b : m), null);
    return !!top && top.bidderId !== a.myId && runnerUps(a.bids, top.bidderId)[0]?.bidderId === a.myId && !this.offers.some((o) => o.offerId === `${a.lot.lotId}-${a.endsAt}`);
  }

  async answerOffer(offerId: string, accept: boolean): Promise<Deal | null> {
    const o = this.offers.find((x) => x.offerId === offerId && x.status === 'open');
    if (!o) return null;
    o.status = accept ? 'accepted' : 'declined';
    this.changed();
    if (!accept) return null;
    const lot: LotInfo = { lotId: o.lotId, title: o.title, subtitle: '', specs: [], details: o.specs ?? [], currency: 'EUR', startPrice: 0, demo: true };
    return this.recordWin(lot, o.amount, this.now(), o.offerId, [], true);
  }

  async verify(id: string): Promise<ChainCheck | null> {
    const d = this.deals.get(id);
    if (!d) return null;
    d.check = await d.verify();
    this.changed();
    return d.check;
  }

  /** DEMO: forget every deal and offer on this device. */
  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.busy.clear();
    this.deals.clear();
    this.offers = [];
    this.skewMs = 0;
    this.changed();
  }

  dispose(): void { clearInterval(this.sweep); for (const t of this.timers) clearTimeout(t); }
}
