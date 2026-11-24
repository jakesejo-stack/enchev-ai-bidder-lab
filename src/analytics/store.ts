// Analytics history, built ONLY from auction events as published by the auction server (bid accepted,
// extension, end, snapshot). Every auction record carries its source, and sources never mix:
//   • 'real'            — events from the authorised Enchev Auctions backend (none exist yet)
//   • 'demo-session'    — events from the simulated in-browser server, recorded on this device
//   • 'demo-generated'  — sample history created on request with the DEMO control (never automatic)
// Retained for 31 days on this device (localStorage), capped in size.
import type { AuctionEvent, BidRecord, Cents } from '../domain/types.js';

export type AuctionSource = 'real' | 'demo-session' | 'demo-generated';
export interface RecBid { id: string; t: number; amount: Cents; bidder: string; mine: boolean; }
export interface RecAuction {
  id: string;
  lotId: string;
  title: string;
  source: AuctionSource;
  startedAt: number;
  /** Server time of the 'ended' status; null while running or if it never finished here. */
  endedAt: number | null;
  startPrice: Cents;
  retailValue: Cents | null;
  bids: RecBid[];
  /** Server times of anti-sniping extensions. */
  ext: number[];
}

export const RETENTION_MS = 31 * 24 * 3600_000;
export const MAX_AUCTIONS = 1500;
const KEY = 'enchev-analytics-v1';

type Packed = [string, string, string, AuctionSource, number, number | null, number, number | null, string[], [number, number, number, number, string][], number[]];

function pack(a: RecAuction): Packed {
  const people = [...new Set(a.bids.map((b) => b.bidder))];
  return [a.id, a.lotId, a.title, a.source, a.startedAt, a.endedAt, a.startPrice, a.retailValue, people,
    a.bids.map((b) => [b.t - a.startedAt, b.amount, people.indexOf(b.bidder), b.mine ? 1 : 0, b.id]), a.ext];
}
function unpack(p: Packed): RecAuction | null {
  if (!Array.isArray(p) || p.length !== 11) return null;
  const [id, lotId, title, source, startedAt, endedAt, startPrice, retailValue, people, bids, ext] = p;
  if (typeof id !== 'string' || !['real', 'demo-session', 'demo-generated'].includes(source) || !Number.isFinite(startedAt)) return null;
  return {
    id, lotId, title, source, startedAt, endedAt, startPrice, retailValue, ext: Array.isArray(ext) ? ext : [],
    bids: (Array.isArray(bids) ? bids : []).map(([dt, amount, who, mine, bid]) => ({ id: bid, t: startedAt + dt, amount, bidder: people[who] ?? '?', mine: mine === 1 })),
  };
}

export class AnalyticsStore {
  auctions: RecAuction[] = [];
  /** Increments on every change (cheap memo key for the dashboard). */
  version = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, private now: () => number = () => Date.now()) {
    this.load();
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { v?: number; a?: Packed[] };
      if (v.v !== 1 || !Array.isArray(v.a)) return;
      this.auctions = v.a.map(unpack).filter((x): x is RecAuction => x !== null);
      this.prune();
    } catch { /* corrupt or unavailable storage: start empty */ }
  }

  /** Drops records older than the retention window and keeps the newest MAX_AUCTIONS. */
  prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    this.auctions = this.auctions.filter((a) => (a.endedAt ?? a.bids[a.bids.length - 1]?.t ?? a.startedAt) >= cutoff);
    if (this.auctions.length > MAX_AUCTIONS) this.auctions = this.auctions.sort((x, y) => x.startedAt - y.startedAt).slice(-MAX_AUCTIONS);
  }

  changed(): void {
    this.version++;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 800);
  }

  flush(): void {
    this.prune();
    try { this.storage?.setItem(KEY, JSON.stringify({ v: 1, a: this.auctions.map(pack) })); } catch { /* quota: keep in memory */ }
  }

  add(list: RecAuction[]): void { this.auctions.push(...list); this.changed(); }

  clear(sources: AuctionSource[]): void {
    this.auctions = this.auctions.filter((a) => !sources.includes(a.source));
    this.changed();
  }

  bySource(kind: 'demo' | 'real'): RecAuction[] {
    return this.auctions.filter((a) => (kind === 'real' ? a.source === 'real' : a.source !== 'real'));
  }
}

/**
 * Turns the server's auction events (after ordering/de-duplication by the reducer) into auction records.
 * lot_change = a new auction run; snapshot = resync of the same run (merged, never double-counted).
 */
export class EventRecorder {
  private current: RecAuction | null = null;

  constructor(private store: AnalyticsStore, private myBidderId: string, private source: 'real' | 'demo-session') {}

  private toBid(b: BidRecord): RecBid { return { id: b.bidId, t: b.serverTime, amount: b.amount, bidder: b.bidderId, mine: b.bidderId === this.myBidderId }; }

  private addBid(b: BidRecord): void {
    const c = this.current;
    if (!c || c.bids.some((x) => x.id === b.bidId)) return;
    c.bids.push(this.toBid(b));
    c.bids.sort((x, y) => x.t - y.t);
  }

  record(e: AuctionEvent): void {
    switch (e.type) {
      case 'lot_change':
      case 'snapshot': {
        const sameRun = e.type === 'snapshot' && this.current && this.current.lotId === e.lot.lotId && this.current.endedAt === null;
        if (!sameRun) {
          const first = e.bids.reduce((m, b) => Math.min(m, b.serverTime), e.serverTime);
          this.current = {
            id: `${e.lot.lotId}-${e.serverTime}`, lotId: e.lot.lotId, title: e.lot.title, source: this.source,
            startedAt: e.type === 'lot_change' ? e.serverTime : first, endedAt: null,
            startPrice: e.lot.startPrice, retailValue: e.lot.retailValue ?? null, bids: [], ext: [],
          };
          this.store.auctions.push(this.current);
        }
        for (const b of e.bids) this.addBid(b);
        if (e.status === 'ended' && this.current!.endedAt === null) this.current!.endedAt = e.serverTime;
        break;
      }
      case 'bid': this.addBid(e.bid); break;
      case 'extension': if (this.current && e.byMs > 0) this.current.ext.push(e.serverTime); break;
      case 'status': if (this.current && e.status === 'ended' && this.current.endedAt === null) this.current.endedAt = e.serverTime; break;
    }
    this.store.changed();
  }

  /** The auction currently being recorded (for LIVE). */
  get live(): RecAuction | null { return this.current; }
}
