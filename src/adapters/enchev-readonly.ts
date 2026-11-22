// Client for the lab's READ-ONLY bridge to public Enchev Auctions data (/api/enchev?r=…).
// Shows only what Enchev Auctions actually publishes: service readiness and verified real lots.
// Bids, bidder events and bid submission are NOT available through this bridge.
import type { Cents } from '../domain/types.js';

export type ServiceKey = 'web' | 'api' | 'realtime' | 'worker';
export const SERVICES: ServiceKey[] = ['web', 'api', 'realtime', 'worker'];
export type LotStatus = 'draft' | 'scheduled' | 'live' | 'ended' | 'cancelled' | 'unknown';

export interface UpstreamEnvelope {
  resource: string;
  reachable: boolean;
  upstreamStatus: number;
  fetchedAt: string;
  error?: string;
  body: Record<string, unknown> | null;
}
export interface RealLot {
  id: string; lotNumber: string; title: string; subtitle: string; status: LotStatus;
  startingPrice: Cents | null; startsAt: number | null; endsAt: number | null;
}
export interface CatalogView {
  state: 'ok' | 'empty' | 'unavailable' | 'unreachable';
  reason: string; lots: RealLot[]; realMoneyEnabled: boolean; upstreamStatus: number;
}
export interface ServiceView { key: ServiceKey; state: 'ready' | 'not_ready' | 'unreachable'; status: string; upstreamStatus: number; }
export interface ReadOnlySnapshot { catalog: CatalogView; services: ServiceView[]; at: number; }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const time = (v: unknown): number | null => { const s = str(v); const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

export function parseEnvelope(x: unknown): UpstreamEnvelope | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.resource !== 'string' || typeof o.reachable !== 'boolean' || typeof o.upstreamStatus !== 'number') return null;
  const body = o.body && typeof o.body === 'object' && !Array.isArray(o.body) ? (o.body as Record<string, unknown>) : null;
  return { resource: o.resource, reachable: o.reachable, upstreamStatus: o.upstreamStatus, fetchedAt: String(o.fetchedAt ?? ''), ...(typeof o.error === 'string' ? { error: o.error } : {}), body };
}

export function toLot(raw: Record<string, unknown>): RealLot | null {
  const lotNumber = str(raw.lot_number);
  const title = str(raw.title);
  if (!lotNumber || !title) return null;
  const price = typeof raw.starting_price === 'number' || typeof raw.starting_price === 'string' ? Number(raw.starting_price) : NaN;
  const status = str(raw.status);
  const sub = [raw.model_year, str(raw.make), str(raw.model), str(raw.country_code)].filter((v) => v !== null && v !== undefined && v !== '').join(' · ');
  return {
    id: str(raw.id) ?? lotNumber,
    lotNumber, title, subtitle: sub,
    status: status && ['draft', 'scheduled', 'live', 'ended', 'cancelled'].includes(status) ? (status as LotStatus) : 'unknown',
    startingPrice: Number.isFinite(price) && price >= 0 && (raw.price_currency ?? 'EUR') === 'EUR' ? Math.round(price * 100) : null,
    startsAt: time(raw.auction_starts_at),
    endsAt: time(raw.auction_ends_at),
  };
}

export function toCatalogView(env: UpstreamEnvelope | null): CatalogView {
  const empty = { lots: [], realMoneyEnabled: false, upstreamStatus: env?.upstreamStatus ?? 0 };
  if (!env || !env.reachable) return { ...empty, state: 'unreachable', reason: 'Няма връзка с Enchev Auctions (недостъпни или бавни услуги).' };
  const b = env.body;
  if (!b || b.ok !== true || b.available === false) {
    const why = str(b?.error);
    return { ...empty, state: 'unavailable', reason: `Каталогът на Enchev Auctions не е наличен (HTTP ${env.upstreamStatus})${why ? `: „${why}“` : '.'}` };
  }
  const lots = (Array.isArray(b.lots) ? b.lots : []).map((l) => (l && typeof l === 'object' ? toLot(l as Record<string, unknown>) : null)).filter((l): l is RealLot => l !== null);
  return {
    state: lots.length ? 'ok' : 'empty',
    reason: lots.length ? `${lots.length} реални ${lots.length === 1 ? 'лот' : 'лота'} от Enchev Auctions.` : 'Enchev Auctions все още няма публикувани и одобрени реални лотове.',
    lots, realMoneyEnabled: b.realMoneyEnabled === true, upstreamStatus: env.upstreamStatus,
  };
}

export function toServiceView(key: ServiceKey, env: UpstreamEnvelope | null): ServiceView {
  if (!env || !env.reachable) return { key, state: 'unreachable', status: 'няма връзка', upstreamStatus: env?.upstreamStatus ?? 0 };
  const ready = env.body?.ready === true && env.upstreamStatus === 200;
  return { key, state: ready ? 'ready' : 'not_ready', status: str(env.body?.status) ?? `HTTP ${env.upstreamStatus}`, upstreamStatus: env.upstreamStatus };
}

export const LOT_STATUS_BG: Record<LotStatus, string> = { draft: 'Чернова', scheduled: 'Предстои', live: 'На живо', ended: 'Приключил', cancelled: 'Отменен', unknown: 'Неизвестен' };
export const SERVICE_BG: Record<ServiceKey, string> = { web: 'Сайт', api: 'API', realtime: 'Реално време (оферти и събития)', worker: 'Фонови задачи' };

/** Countdown for a real lot, from its own published start/end times. */
export function lotCountdown(lot: RealLot, now: number): { label: string; ms: number | null } {
  if (lot.status === 'cancelled') return { label: 'Отменен', ms: null };
  if (lot.startsAt !== null && now < lot.startsAt) return { label: 'Започва след', ms: lot.startsAt - now };
  if (lot.endsAt !== null && now < lot.endsAt) return { label: 'Остават', ms: lot.endsAt - now };
  if (lot.endsAt !== null) return { label: 'Приключил', ms: 0 };
  return { label: 'Без обявен край', ms: null };
}

async function getEnvelope(resource: string, fetchImpl: typeof fetch): Promise<UpstreamEnvelope | null> {
  try {
    const r = await fetchImpl(`/api/enchev?r=${encodeURIComponent(resource)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    return r.ok ? parseEnvelope(await r.json()) : null;
  } catch {
    return null;
  }
}

export async function loadReadOnly(fetchImpl: typeof fetch = fetch): Promise<ReadOnlySnapshot> {
  const [catalog, ...health] = await Promise.all([
    getEnvelope('catalog', fetchImpl),
    ...SERVICES.map((k) => getEnvelope(`health-${k}`, fetchImpl)),
  ]);
  return { catalog: toCatalogView(catalog ?? null), services: SERVICES.map((k, i) => toServiceView(k, health[i] ?? null)), at: Date.now() };
}
