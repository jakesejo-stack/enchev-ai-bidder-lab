// Connects the deal log to the auction stream, file storage and (DEMO only) a simulated payment provider.
//
// Linking: one deal per LOT ID + VIN. The lot and its VIN come from the auction listing
// (LotInfo.details "VIN"), the WINNER from the auction server's own published events — the same
// de-duplicated, ordered stream the bidder UI and analytics use. Nothing is re-typed by hand.
import type { AuctionEvent, Cents, LotInfo } from '../domain/types.js';
import type { AuctionState } from '../domain/reducer.js';
import { highestBid } from '../domain/rules.js';
import { DealLog, verifyChain, type AppendResult, type ChainCheck } from './chain.js';
import { STAGES, stageDone, invoiceAmount, latest, type DealEvent, type DealState, type DocType, type Role } from './model.js';
import { checkVin } from './vin.js';
import { newId, prepareFile, type FileStore } from './files.js';

export interface DealDeps {
  now: () => number;
  /** DEMO builds simulate the payment provider; real builds never do. */
  demo: boolean;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  files: FileStore;
  /** Delay of the simulated provider confirmation (DEMO). */
  providerDelayMs?: number;
}

const PREFIX = 'enchev-deal-v1:';

export function vinOf(lot: LotInfo): string | null {
  const v = lot.details?.find((d) => d.label.toUpperCase() === 'VIN')?.value ?? null;
  return v && checkVin(v).ok ? checkVin(v).vin : null;
}
export function doneStages(s: DealState): Set<number> {
  return new Set(STAGES.map((st, i) => (stageDone(s, st.key) ? i + 1 : 0)).filter((n) => n > 0));
}
export const dealKeyOf = (lotId: string, vin: string) => `${lotId}|${vin}`;

export class DealService {
  log: DealLog;
  chain: ChainCheck | null = null;
  /** Why no deal could be opened for the current lot (e.g. no valid VIN in the listing). */
  unavailable: string | null = null;
  private lot: LotInfo | null = null;
  private providerTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  /** Stages already done (1-based); a tap fires when a stage becomes done by a new event. */
  private done = new Set<number>();
  readonly stageTaps: ((stage: number, e: DealEvent) => void)[] = [];

  constructor(private deps: DealDeps) {
    this.log = new DealLog(deps.now);
    this.log.subscribe((e) => {
      if (e) this.persist();
      const now = doneStages(this.log.state);
      if (e) for (const n of now) if (!this.done.has(n)) for (const t of this.stageTaps) t(n, e);
      this.done = now;
      this.maybeSimulateProvider();
      this.notify();
    });
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify(): void { for (const l of this.listeners) l(); }
  get state() { return this.log.state; }
  get key(): string | null { const k = this.log.state.key; return k ? dealKeyOf(k.lotId, k.vin) : null; }
  get files(): FileStore { return this.deps.files; }

  // ---------------------------------------------------------------- auction link
  /** Opens (or reloads) the deal for this lot. Called for snapshots/lot changes from the auction stream. */
  async attachLot(lot: LotInfo): Promise<void> {
    if (this.lot && this.lot.lotId === lot.lotId && this.key) return;
    this.lot = lot;
    const vin = vinOf(lot);
    if (!vin) { this.unavailable = 'В обявата на лота няма валиден VIN — сделка не може да се отвори.'; this.log.reset(); this.notify(); return; }
    this.unavailable = null;
    const key = dealKeyOf(lot.lotId, vin);
    let stored: DealEvent[] = [];
    try { stored = JSON.parse(this.deps.storage?.getItem(PREFIX + key) ?? '[]') as DealEvent[]; } catch { stored = []; }
    this.log.reset();
    this.chain = stored.length ? await this.log.load(stored) : { ok: true, count: 0 };
    if (!this.log.state.key) {
      if (stored.length && !this.chain.ok) this.deps.storage?.removeItem(PREFIX + key); // broken copy: start clean, keep the reason
      await this.log.append('auction_server', { type: 'deal_opened', lotId: lot.lotId, vin, title: lot.title, demo: lot.demo });
    }
    this.notify();
  }

  /** Receives every auction event once, in order (controller event tap), after the state was updated. */
  onAuctionEvent(e: AuctionEvent, auction: AuctionState): void {
    if ((e.type === 'snapshot' || e.type === 'lot_change') && e.lot) void this.attachLot(e.lot).then(() => this.fromStatus(auction, e.serverTime));
    else this.fromStatus(auction, e.serverTime);
  }

  private fromStatus(a: AuctionState, at: number): void {
    const s = this.log.state;
    if (!s.key || !a.lot || a.lot.lotId !== s.key.lotId || s.winner || s.noWinner) return;
    if ((a.status === 'active' || a.status === 'ended') && s.auctionStartedAt === null) void this.log.append('auction_server', { type: 'auction_started', startedAt: at });
    if (a.status === 'ended') {
      const top = highestBid(a.bids);
      void this.log.append('auction_server', top
        ? { type: 'winner_confirmed', bidderId: top.bidderId, amount: top.amount, bidId: top.bidId, endedAt: at, bids: a.bids.length }
        : { type: 'auction_ended_no_winner', endedAt: at });
    }
  }

  // ---------------------------------------------------------------- user actions (roles)
  async upload(role: Role, doc: DocType, file: Blob & { name?: string }, amount?: Cents): Promise<AppendResult | { ok: false; code: string; message: string }> {
    const p = await prepareFile(file, amount);
    if (!p.ok) return { ok: false, code: 'BAD_FILE', message: p.message };
    const key = this.key;
    if (!key) return { ok: false, code: 'NO_DEAL', message: 'Няма отворена сделка.' };
    await this.deps.files.put(key, p.meta, p.blob);
    const r = await this.log.append(role, { type: 'doc_uploaded', doc, file: p.meta });
    if (!r.ok) await this.deps.files.remove(p.meta.fileId);
    return r;
  }

  review(doc: DocType, decision: 'approved' | 'rejected', note: string, vinMatches?: boolean): Promise<AppendResult> {
    const f = latest(this.log.state.docs[doc]);
    return this.log.append('admin', { type: 'doc_reviewed', doc, fileId: f?.fileId ?? '', decision, note, ...(vinMatches !== undefined ? { vinMatches } : {}) });
  }

  transport(step: 'picked_up' | 'in_transit' | 'delivered'): Promise<AppendResult> {
    return this.log.append('carrier', { type: 'transport', step });
  }

  confirmReceipt(car: boolean, originals: boolean): Promise<AppendResult> {
    return this.log.append('buyer', { type: 'receipt_confirmed', car, originals });
  }

  /** DEMO: deletes this device's copy of the deal and its files, then reopens it empty. */
  async resetDemo(): Promise<void> {
    if (!this.deps.demo) return;
    const key = this.key;
    if (key) { this.deps.storage?.removeItem(PREFIX + key); await this.deps.files.removeDeal(key); }
    const lot = this.lot;
    this.lot = null;
    if (lot) await this.attachLot(lot);
  }

  async verify(): Promise<ChainCheck> {
    this.chain = await verifyChain(this.log.events);
    this.notify();
    return this.chain;
  }

  // ---------------------------------------------------------------- DEMO payment provider
  /** Simulates the provider's confirmation (in a real system: a signed webhook from the provider). */
  private maybeSimulateProvider(): void {
    if (!this.deps.demo || this.providerTimer) return;
    const s = this.log.state;
    const amount = invoiceAmount(s);
    if (s.payment || amount === null || !latest(s.docs.payment_proof)) return;
    this.providerTimer = setTimeout(() => {
      this.providerTimer = null;
      void this.log.append('payment_provider', { type: 'payment_confirmed', amount, reference: `DEMO-PAY-${newId().slice(0, 8).toUpperCase()}` });
    }, this.deps.providerDelayMs ?? 2500);
  }

  private persist(): void {
    const key = this.key;
    if (!key) return;
    try { this.deps.storage?.setItem(PREFIX + key, JSON.stringify(this.log.events)); } catch { /* quota / private mode: the deal stays in memory */ }
  }
}
