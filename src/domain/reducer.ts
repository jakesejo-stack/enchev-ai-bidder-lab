// Applies the auction event stream to client state.
// Ordering rules (server is the source of truth):
//   • seq ≤ lastSeq          → duplicate or stale: ignored.
//   • seq = lastSeq + 1      → applied, then any buffered successors are drained in order.
//   • seq > lastSeq + 1      → buffered (out-of-order delivery). If the gap is not filled within
//                              GAP_TIMEOUT_MS the state is flagged `needsResync` and the adapter
//                              requests a fresh snapshot. Snapshots always win.
import type { AuctionEvent, AuctionStatus, BidRecord, BidRules, LotInfo } from './types.js';

export const GAP_TIMEOUT_MS = 1500;
const MAX_BUFFER = 64;

export interface AuctionState {
  lot: LotInfo | null;
  rules: BidRules | null;
  status: AuctionStatus;
  endsAt: number;
  bids: BidRecord[]; // ascending by amount
  lastSeq: number;
  buffer: AuctionEvent[]; // out-of-order events waiting for a gap to fill
  gapSince: number | null; // local time the current gap was first seen
  needsResync: boolean;
  /** Counters for diagnostics and tests. */
  stats: { applied: number; duplicates: number; buffered: number; resyncs: number };
}

export function initialAuctionState(): AuctionState {
  return {
    lot: null, rules: null, status: 'scheduled', endsAt: 0, bids: [], lastSeq: 0,
    buffer: [], gapSince: null, needsResync: false,
    stats: { applied: 0, duplicates: 0, buffered: 0, resyncs: 0 },
  };
}

function insertBid(bids: BidRecord[], bid: BidRecord): BidRecord[] {
  if (bids.some((b) => b.bidId === bid.bidId)) return bids;
  const next = [...bids, bid];
  next.sort((a, b) => a.amount - b.amount || a.serverTime - b.serverTime);
  return next;
}

function applyOne(s: AuctionState, e: AuctionEvent): AuctionState {
  switch (e.type) {
    case 'snapshot':
    case 'lot_change':
      return {
        ...s, lot: e.lot, rules: e.rules, status: e.status, endsAt: e.endsAt,
        bids: [...e.bids].sort((a, b) => a.amount - b.amount), lastSeq: e.seq,
      };
    case 'bid':
      return { ...s, bids: insertBid(s.bids, e.bid), lastSeq: e.seq };
    case 'status':
      return { ...s, status: e.status, lastSeq: e.seq };
    case 'extension':
      return { ...s, endsAt: Math.max(s.endsAt, e.endsAt), lastSeq: e.seq };
  }
}

/** Returns the new state plus the events actually applied (in order), for narration/UI. */
export function applyEvent(state: AuctionState, e: AuctionEvent, localNow: number): { state: AuctionState; applied: AuctionEvent[] } {
  let s = state;
  const applied: AuctionEvent[] = [];
  const stats = { ...s.stats };

  if (e.type === 'snapshot' || e.type === 'lot_change') {
    // A snapshot replaces everything; keep only buffered events newer than it.
    s = applyOne(s, e);
    const keep = s.buffer.filter((b) => b.seq > e.seq);
    s = { ...s, buffer: keep, needsResync: false, gapSince: null };
    stats.applied++;
    applied.push(e);
  } else if (e.seq <= s.lastSeq || s.buffer.some((b) => b.seq === e.seq)) {
    stats.duplicates++;
    return { state: { ...s, stats }, applied };
  } else if (e.seq === s.lastSeq + 1) {
    s = applyOne(s, e);
    stats.applied++;
    applied.push(e);
  } else {
    const buffer = [...s.buffer, e].sort((a, b) => a.seq - b.seq).slice(-MAX_BUFFER);
    stats.buffered++;
    return { state: { ...s, buffer, gapSince: s.gapSince ?? localNow, stats }, applied };
  }

  // Drain buffered successors.
  let buffer = [...s.buffer];
  while (buffer.length && buffer[0]!.seq <= s.lastSeq + 1) {
    const next = buffer.shift()!;
    if (next.seq === s.lastSeq + 1) {
      s = applyOne(s, next);
      stats.applied++;
      applied.push(next);
    } else {
      stats.duplicates++;
    }
  }
  s = { ...s, buffer, gapSince: buffer.length ? (s.gapSince ?? localNow) : null, stats };
  return { state: s, applied };
}

/** Call periodically: flags a resync when a gap has not been filled in time. */
export function checkGap(state: AuctionState, localNow: number): AuctionState {
  if (state.gapSince !== null && !state.needsResync && localNow - state.gapSince > GAP_TIMEOUT_MS) {
    return { ...state, needsResync: true, stats: { ...state.stats, resyncs: state.stats.resyncs + 1 } };
  }
  return state;
}
