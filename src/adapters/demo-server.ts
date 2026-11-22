// In-browser SIMULATED auction server for DEMO MODE. Nothing here touches a network or a real auction.
// It behaves like an authoritative server: its own clock (deliberately skewed from the device
// clock to exercise drift correction), its own validation, idempotency, rate limiting and
// anti-sniping, and simulated competing bidders with private limits.
import type { AuctionEvent, AuctionStatus, BidRecord, BidRequest, BidResult, BidRules, LotInfo } from '../domain/types.js';
import { checkBid, extendedEnd, highestBid, nextValidBid } from '../domain/rules.js';
import { euros } from '../domain/money.js';

export interface DemoServerOptions {
  seed?: number;
  durationMs?: number;
  /** Server clock = device clock + skew. */
  clockSkewMs?: number;
  /** Multiplies competitor activity (tests use higher values). */
  activity?: number;
  now?: () => number;
  /** Disable the automatic competitor simulation (for deterministic tests). */
  competitors?: boolean;
}

export const DEMO_LOT: LotInfo = {
  lotId: 'DEMO-0001',
  title: 'E&A концептуално купе',
  subtitle: 'Демонстрационен 3D модел — не е реален автомобил',
  specs: [
    { label: 'Година', value: '2024' },
    { label: 'Двигател', value: '3.0 L' },
    { label: 'Мощност', value: '380 к.с.' },
    { label: 'Пробег', value: '12 400 км' },
  ],
  currency: 'EUR',
  startPrice: euros(40_000),
  demo: true,
  modelUrl: '/models/ea-demo-concept-coupe.glb',
};

export const DEMO_RULES: BidRules = {
  increments: [
    { below: euros(10_000), step: euros(100) },
    { below: euros(50_000), step: euros(500) },
    { below: null, step: euros(1_000) },
  ],
  antiSnipingWindowMs: 20_000,
  extensionMs: 20_000,
  maxBid: euros(250_000),
};

/** Small deterministic PRNG so demos and tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Competitor { id: string; max: number; eagerness: number; }

type Listener = (e: AuctionEvent) => void;

export class DemoAuctionServer {
  private seq = 0;
  private bids: BidRecord[] = [];
  private status: AuctionStatus = 'active';
  private endsAt = 0;
  private listeners = new Set<Listener>();
  private idempotency = new Map<string, BidResult>();
  private lastBidAt = new Map<string, number>();
  private competitors: Competitor[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private competitorTimer: ReturnType<typeof setTimeout> | null = null;
  private rand: () => number;
  private bidCounter = 0;
  readonly skew: number;
  private readonly localNow: () => number;
  readonly lot = DEMO_LOT;
  readonly rules = DEMO_RULES;
  private activity: number;
  private simulateCompetitors: boolean;
  /** Audit trail, as a real server would keep (demo: in memory only). */
  readonly audit: { at: number; bidderId: string; amount: number; result: string; key: string }[] = [];

  constructor(private opts: DemoServerOptions = {}) {
    this.rand = mulberry32(opts.seed ?? 20261122);
    this.skew = opts.clockSkewMs ?? 2300;
    this.localNow = opts.now ?? (() => Date.now());
    this.activity = opts.activity ?? 1;
    this.simulateCompetitors = opts.competitors ?? true;
    this.reset();
  }

  now(): number { return this.localNow() + this.skew; }
  get currentSeq(): number { return this.seq; }

  reset(): void {
    this.stop();
    this.bids = [];
    this.status = 'active';
    this.idempotency.clear();
    this.lastBidAt.clear();
    const start = this.now();
    this.endsAt = start + (this.opts.durationMs ?? 180_000);
    // Opening history so the screen is meaningful immediately (clearly demo data).
    const opening = [40_000, 40_500, 41_000, 41_500, 42_000, 42_500];
    const ids = ['Участник 7', 'Участник 3', 'Участник 7', 'Участник 12', 'Участник 3', 'Участник 12'];
    opening.forEach((eur, i) => {
      this.bids.push({ bidId: `b${++this.bidCounter}`, bidderId: ids[i]!, amount: euros(eur), serverTime: start - (opening.length - i) * 26_000 });
    });
    this.competitors = [
      { id: 'Участник 3', max: euros(44_000 + Math.round(this.rand() * 6) * 500), eagerness: 0.55 },
      { id: 'Участник 7', max: euros(45_500 + Math.round(this.rand() * 8) * 500), eagerness: 0.4 },
      { id: 'Участник 12', max: euros(43_500 + Math.round(this.rand() * 10) * 500), eagerness: 0.35 },
    ];
    this.emit({ type: 'lot_change', seq: ++this.seq, serverTime: this.now(), lot: this.lot, rules: this.rules, status: this.status, endsAt: this.endsAt, bids: [...this.bids] });
    this.tickTimer = setInterval(() => this.tick(), 250);
    this.scheduleCompetitor(4000);
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.competitorTimer) clearTimeout(this.competitorTimer);
    this.competitorTimer = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  snapshot(): AuctionEvent {
    return { type: 'snapshot', seq: this.seq, serverTime: this.now(), lot: this.lot, rules: this.rules, status: this.status, endsAt: this.endsAt, bids: [...this.bids] };
  }

  private emit(e: AuctionEvent): void { for (const l of this.listeners) l(e); }

  private tick(): void {
    if (this.status === 'active' && this.now() >= this.endsAt) {
      this.status = 'ended';
      this.emit({ type: 'status', seq: ++this.seq, serverTime: this.now(), status: 'ended', reason: 'time' });
      this.stop();
    }
  }

  private scheduleCompetitor(delayMs: number): void {
    if (!this.simulateCompetitors) return;
    // A single competitor "thread": rescheduling replaces the pending move.
    if (this.competitorTimer) clearTimeout(this.competitorTimer);
    this.competitorTimer = setTimeout(() => this.competitorMove(), delayMs);
  }

  private competitorMove(): void {
    if (this.status !== 'active') return;
    const next = nextValidBid(this.lot, this.rules, this.bids);
    const top = highestBid(this.bids);
    const remaining = this.endsAt - this.now();
    const willing = this.competitors.filter((c) => c.max >= next && (!top || top.bidderId !== c.id));
    if (willing.length) {
      // More eager near the end; the user's own bids provoke responses (as in real auctions).
      const urgency = remaining < 30_000 ? 1.6 : 1;
      const pick = willing[Math.floor(this.rand() * willing.length)]!;
      if (this.rand() < Math.min(0.95, pick.eagerness * urgency * this.activity)) this.accept(pick.id, next);
    }
    const base = remaining < 30_000 ? 2500 : 6000;
    this.scheduleCompetitor((base + this.rand() * base) / this.activity);
  }

  /** Force a burst of competitor bids (demo control: "бързи оферти"). */
  burst(count = 5): void {
    for (let i = 0; i < count; i++) {
      const t = setTimeout(() => {
        if (this.status !== 'active') return;
        const top = highestBid(this.bids);
        const pool = this.competitors.filter((c) => !top || c.id !== top.bidderId);
        const who = pool[Math.floor(this.rand() * pool.length)] ?? this.competitors[0]!;
        this.accept(who.id, nextValidBid(this.lot, this.rules, this.bids));
      }, 250 + i * 450);
      this.timers.push(t);
    }
  }

  /** Demo control: bring the end time forward. */
  endIn(ms: number): void {
    if (this.status !== 'active') return;
    this.endsAt = this.now() + ms;
    this.emit({ type: 'extension', seq: ++this.seq, serverTime: this.now(), endsAt: this.endsAt, byMs: 0 });
  }

  private accept(bidderId: string, amount: number): BidRecord {
    const at = this.now();
    const bid: BidRecord = { bidId: `b${++this.bidCounter}`, bidderId, amount, serverTime: at };
    this.bids.push(bid);
    this.emit({ type: 'bid', seq: ++this.seq, serverTime: at, bid });
    const ext = extendedEnd(this.endsAt, at, this.rules);
    if (ext !== null && ext > this.endsAt) {
      const by = ext - this.endsAt;
      this.endsAt = ext;
      this.emit({ type: 'extension', seq: ++this.seq, serverTime: at, endsAt: ext, byMs: by });
    }
    return bid;
  }

  /** Server-side handling of a user bid: authentication, validation, idempotency, rate limit, audit. */
  placeBid(req: BidRequest, auth: { bidderId: string; authenticated: boolean }): BidResult {
    const prior = this.idempotency.get(req.idempotencyKey);
    if (prior) return prior.status === 'accepted' ? { ...prior, duplicate: true } : prior;
    const record = (result: BidResult): BidResult => {
      this.audit.push({ at: this.now(), bidderId: auth.bidderId, amount: req.amount, result: result.status === 'accepted' ? 'accepted' : result.code, key: req.idempotencyKey });
      this.idempotency.set(req.idempotencyKey, result);
      return result;
    };
    if (req.currency !== this.lot.currency) return record({ status: 'rejected', code: 'WRONG_CURRENCY', message: 'Невалидна валута.' });
    const last = this.lastBidAt.get(auth.bidderId) ?? -Infinity;
    if (this.now() - last < 1000) {
      // Not cached under the idempotency key: a later retry of the same intent may succeed.
      return { status: 'rejected', code: 'RATE_LIMITED', message: 'Твърде много оферти за кратко време. Опитай след секунда.' };
    }
    const check = checkBid(req.amount, {
      lot: this.lot, rules: this.rules, status: this.status, bids: this.bids, endsAt: this.endsAt,
      serverNow: this.now(), bidderId: auth.bidderId, authenticated: auth.authenticated, lotId: req.lotId,
    });
    if (!check.ok) return record({ status: 'rejected', code: check.code!, message: check.message!, nextValid: check.nextValid });
    this.lastBidAt.set(auth.bidderId, this.now());
    const bid = this.accept(auth.bidderId, req.amount);
    // Competitors may react to the user's bid.
    this.scheduleCompetitor(1500 + this.rand() * 2500);
    return record({ status: 'accepted', bid, duplicate: false });
  }
}
