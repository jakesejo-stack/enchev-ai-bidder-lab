// Pure aggregation over recorded auction events: periods (LIVE / 24H / 7D / 30D / custom dates),
// time buckets, metrics and CSV. No I/O, no randomness — easy to test and to reuse server-side.
import type { Cents } from '../domain/types.js';
import type { RecAuction, RecBid } from './store.js';

export type RangeKind = 'live' | '24h' | '7d' | '30d' | 'custom';
export interface Range { kind: RangeKind; from: number; to: number; bucketMs: number; }

const H = 3600_000, D = 24 * H;
const pad2 = (n: number) => String(n).padStart(2, '0');
function startOfLocalDay(t: number): number { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
/** Parses yyyy-mm-dd as a LOCAL calendar day. */
export function parseDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) && d.getDate() === Number(m[3]) ? d.getTime() : null;
}
export function dayString(t: number): string { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/** Period → [from, to] and bucket size. LIVE follows the auction currently being recorded. */
export function rangeFor(kind: RangeKind, now: number, opts: { live?: RecAuction | null; from?: string; to?: string } = {}): Range {
  switch (kind) {
    case 'live': {
      const a = opts.live;
      const from = a ? a.startedAt : now - 5 * 60_000;
      // Show at least a 3-minute window so the live bars keep a steady width as the auction runs.
      return { kind, from, to: Math.max(now, a?.endedAt ?? now, from + 3 * 60_000), bucketMs: 10_000 };
    }
    case '24h': return { kind, from: Math.floor((now - 24 * H) / H) * H + H, to: now, bucketMs: H };
    case '7d': return { kind, from: startOfLocalDay(now) - 6 * D, to: now, bucketMs: D };
    case '30d': return { kind, from: startOfLocalDay(now) - 29 * D, to: now, bucketMs: D };
    case 'custom': {
      let a = parseDay(opts.from ?? '') ?? startOfLocalDay(now) - 6 * D;
      let b = parseDay(opts.to ?? '') ?? startOfLocalDay(now);
      if (b < a) [a, b] = [b, a];
      const to = b + D - 1;
      return { kind, from: a, to, bucketMs: to - a > 62 * D ? 7 * D : D };
    }
  }
}

export interface Bucket { t: number; label: string; bids: number; }
export interface AuctionRow {
  id: string; lotId: string; title: string; source: RecAuction['source'];
  startedAt: number; endedAt: number | null; durationMs: number | null;
  bids: number; bidders: number; extensions: number;
  startPrice: Cents; finalPrice: Cents | null; growth: Cents | null; wonByMe: boolean | null;
}
export interface Summary {
  range: Range;
  bids: number; myBids: number; uniqueBidders: number; extensions: number;
  completed: number; avgDurationMs: number | null; avgGrowth: Cents | null; maxFinal: Cents | null;
  /** LIVE only: growth so far, € per minute so far, elapsed. */
  live: { growth: Cents; perMinute: Cents; elapsedMs: number; price: Cents; ended: boolean } | null;
  activity: Bucket[];
  price: { t: number; v: Cents }[];
  rows: AuctionRow[];
}

const top = (bids: RecBid[]): Cents | null => (bids.length ? Math.max(...bids.map((b) => b.amount)) : null);

export function rowFor(a: RecAuction): AuctionRow {
  const final = a.endedAt !== null ? top(a.bids) : null;
  const winner = a.endedAt !== null && a.bids.length ? a.bids.reduce((m, b) => (b.amount > m.amount ? b : m)) : null;
  return {
    id: a.id, lotId: a.lotId, title: a.title, source: a.source, startedAt: a.startedAt, endedAt: a.endedAt,
    durationMs: a.endedAt !== null ? a.endedAt - a.startedAt : null,
    bids: a.bids.length, bidders: new Set(a.bids.map((b) => b.bidder)).size, extensions: a.ext.length,
    startPrice: a.startPrice, finalPrice: final, growth: final === null ? null : Math.max(0, final - a.startPrice),
    wonByMe: winner ? winner.mine : null,
  };
}

function bucketLabel(t: number, r: Range): string {
  const d = new Date(t);
  if (r.bucketMs < H) return `${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (r.bucketMs < D) return `${pad2(d.getHours())}:00`;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
}

export function summarize(auctions: RecAuction[], r: Range, now: number, live: RecAuction | null = null): Summary {
  const scope = r.kind === 'live' ? (live ? [live] : []) : auctions;
  const inRange = (t: number) => t >= r.from && t <= r.to;
  const bids = scope.flatMap((a) => a.bids.filter((b) => inRange(b.t)));
  const completed = scope.filter((a) => a.endedAt !== null && inRange(a.endedAt));
  const rows = completed.map(rowFor);
  const durations = rows.map((x) => x.durationMs!).filter((x) => x > 0);
  const growths = rows.map((x) => x.growth).filter((x): x is Cents => x !== null);

  // Buckets: aligned to the range start (which is hour/day aligned for 24H/7D/30D/custom).
  const n = Math.max(1, Math.min(400, Math.ceil((r.to - r.from + 1) / r.bucketMs)));
  const activity: Bucket[] = Array.from({ length: n }, (_, i) => ({ t: r.from + i * r.bucketMs, label: bucketLabel(r.from + i * r.bucketMs, r), bids: 0 }));
  for (const b of bids) {
    const i = Math.floor((b.t - r.from) / r.bucketMs);
    if (i >= 0 && i < n) activity[i]!.bids++;
  }

  let liveInfo: Summary['live'] = null;
  let price: { t: number; v: Cents }[];
  if (r.kind === 'live' && live) {
    const p = top(live.bids) ?? live.startPrice;
    const elapsed = Math.max(0, (live.endedAt ?? now) - live.startedAt);
    liveInfo = { growth: p - live.startPrice, perMinute: elapsed > 0 ? Math.round(((p - live.startPrice) / elapsed) * 60_000) : 0, elapsedMs: elapsed, price: p, ended: live.endedAt !== null };
    let runningTop = live.startPrice;
    price = [{ t: live.startedAt, v: live.startPrice }, ...live.bids.map((b) => ({ t: b.t, v: (runningTop = Math.max(runningTop, b.amount)) }))];
  } else {
    const finals = rows.filter((x) => x.finalPrice !== null).sort((x, y) => x.endedAt! - y.endedAt!);
    if (r.bucketMs >= D) {
      // Day (or week) buckets: average final price per bucket that has completed auctions.
      const acc = new Map<number, { sum: number; n: number }>();
      for (const x of finals) {
        const i = Math.floor((x.endedAt! - r.from) / r.bucketMs);
        const e = acc.get(i) ?? { sum: 0, n: 0 };
        e.sum += x.finalPrice!; e.n++; acc.set(i, e);
      }
      price = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([i, e]) => ({ t: r.from + i * r.bucketMs + r.bucketMs / 2, v: Math.round(e.sum / e.n) }));
    } else {
      price = finals.map((x) => ({ t: x.endedAt!, v: x.finalPrice! }));
    }
  }

  return {
    range: r,
    bids: bids.length,
    myBids: bids.filter((b) => b.mine).length,
    uniqueBidders: new Set(bids.map((b) => b.bidder)).size,
    extensions: scope.reduce((s, a) => s + a.ext.filter(inRange).length, 0),
    completed: completed.length,
    avgDurationMs: durations.length ? Math.round(durations.reduce((x, y) => x + y, 0) / durations.length) : null,
    avgGrowth: growths.length ? Math.round(growths.reduce((x, y) => x + y, 0) / growths.length) : null,
    maxFinal: rows.reduce<Cents | null>((m, x) => (x.finalPrice !== null && (m === null || x.finalPrice > m) ? x.finalPrice : m), null),
    live: liveInfo,
    activity,
    price,
    rows: rows.sort((x, y) => y.endedAt! - x.endedAt!),
  };
}

// ------------------------------------------------------------------ CSV (RFC 4180, UTF-8 with BOM)
export function csvCell(v: string | number | boolean | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\r\n;]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header: string[], rows: (string | number | boolean | null)[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const eur = (c: Cents | null) => (c === null ? null : c / 100);
const SOURCE_BG: Record<RecAuction['source'], string> = { real: 'реален', 'demo-session': 'ДЕМО (сесия)', 'demo-generated': 'ДЕМО (генериран)' };

export function auctionsCsv(s: Summary): string {
  return toCsv(
    ['id', 'източник', 'лот', 'заглавие', 'начало_utc', 'край_utc', 'продължителност_сек', 'оферти', 'участници', 'удължавания', 'начална_цена_eur', 'крайна_цена_eur', 'ръст_eur', 'спечелен_от_теб'],
    s.rows.map((x) => [x.id, SOURCE_BG[x.source], x.lotId, x.title, iso(x.startedAt), iso(x.endedAt), x.durationMs === null ? null : Math.round(x.durationMs / 1000),
      x.bids, x.bidders, x.extensions, eur(x.startPrice), eur(x.finalPrice), eur(x.growth), x.wonByMe === null ? null : x.wonByMe ? 'да' : 'не']),
  );
}

export function bidsCsv(auctions: RecAuction[], r: Range, live: RecAuction | null = null): string {
  const scope = r.kind === 'live' ? (live ? [live] : []) : auctions;
  const rows = scope.flatMap((a) => a.bids.filter((b) => b.t >= r.from && b.t <= r.to).map((b) => [a.id, SOURCE_BG[a.source], a.lotId, iso(b.t), eur(b.amount), b.bidder, b.mine ? 'да' : 'не'] as (string | number | null)[]));
  rows.sort((x, y) => String(x[3]).localeCompare(String(y[3])));
  return toCsv(['търг_id', 'източник', 'лот', 'време_utc', 'сума_eur', 'участник', 'твоя'], rows);
}
