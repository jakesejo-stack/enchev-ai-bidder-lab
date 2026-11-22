// Append-only, hash-chained deal log. Each event's hash covers its content and the previous hash,
// so any later edit, reordering or deletion is detected by verifyChain(). A real backend must keep
// the same log server-side (with signed actors); this client copy is then only a mirror.
import { applyDeal, emptyDeal, refuse, type Actor, type DealBody, type DealEvent, type DealState, type Refusal } from './model.js';

/** JSON with sorted object keys, so the same content always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashEvent(e: Omit<DealEvent, 'hash'>): Promise<string> {
  return sha256Hex(canonical({ seq: e.seq, at: e.at, actor: e.actor, body: e.body, prev: e.prev }));
}

export interface ChainCheck { ok: boolean; count: number; brokenAt?: number; reason?: string; }

/** Re-hashes every event and re-validates every authority rule from the start. */
export async function verifyChain(events: DealEvent[]): Promise<ChainCheck> {
  let s = emptyDeal();
  let prev = '';
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i + 1) return { ok: false, count: events.length, brokenAt: i + 1, reason: 'Липсва или е разместено събитие.' };
    if (e.prev !== prev) return { ok: false, count: events.length, brokenAt: e.seq, reason: 'Връзката с предишното събитие е нарушена.' };
    if ((await hashEvent(e)) !== e.hash) return { ok: false, count: events.length, brokenAt: e.seq, reason: 'Съдържанието на събитието е променено.' };
    const r = refuse(s, e.actor, e.body);
    if (r) return { ok: false, count: events.length, brokenAt: e.seq, reason: `Недопустимо събитие: ${r.message}` };
    s = applyDeal(s, e);
    prev = e.hash;
  }
  return { ok: true, count: events.length };
}

export type AppendResult = { ok: true; event: DealEvent } | ({ ok: false } & Refusal);

/** In-memory log + derived state. Appends are serialised (hashing is async). */
export class DealLog {
  events: DealEvent[] = [];
  state: DealState = emptyDeal();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(e: DealEvent | null) => void>();

  constructor(private clock: () => number = () => Date.now()) {}

  subscribe(fn: (e: DealEvent | null) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Loads a stored log; refuses it (and stays empty) if the chain does not verify. */
  async load(events: DealEvent[]): Promise<ChainCheck> {
    const check = await verifyChain(events);
    if (!check.ok) return check;
    this.events = events.slice();
    this.state = events.reduce(applyDeal, emptyDeal());
    for (const l of this.listeners) l(null);
    return check;
  }

  reset(): void {
    this.events = [];
    this.state = emptyDeal();
    for (const l of this.listeners) l(null);
  }

  /** Checks authority + rules against the latest state, then hashes and appends. */
  append(actor: Actor, body: DealBody): Promise<AppendResult> {
    const run = async (): Promise<AppendResult> => {
      const r = refuse(this.state, actor, body);
      if (r) return { ok: false, ...r };
      const draft = { seq: this.state.lastSeq + 1, at: this.clock(), actor, body, prev: this.state.lastHash };
      const event: DealEvent = { ...draft, hash: await hashEvent(draft) };
      this.events.push(event);
      this.state = applyDeal(this.state, event);
      for (const l of this.listeners) l(event);
      return { ok: true, event };
    };
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }
}
