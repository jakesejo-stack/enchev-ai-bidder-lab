// Append-only, hash-chained log. Each event's hash covers its content and the previous hash, so a later
// edit, reordering or deletion is detected by verify(). A real backend keeps the same log server-side
// (with signed actors); this browser copy is then only a mirror.

/** JSON with sorted object keys, so the same content always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ChainEvent<A, B> { seq: number; at: number; actor: A; body: B; prev: string; hash: string; }

export async function hashEvent<A, B>(e: Omit<ChainEvent<A, B>, 'hash'>): Promise<string> {
  return sha256Hex(canonical({ seq: e.seq, at: e.at, actor: e.actor, body: e.body, prev: e.prev }));
}

export interface ChainCheck { ok: boolean; count: number; brokenAt?: number; reason?: string; }

export interface ChainRules<A, B, S> {
  empty(): S;
  /** Why this actor may not append this body now (null = allowed). */
  refuse(s: S, actor: A, body: B, at: number): string | null;
  apply(s: S, e: ChainEvent<A, B>): S;
}

/** Re-hashes every event and re-checks every rule from the start. */
export async function verifyChain<A, B, S>(events: ChainEvent<A, B>[], rules: ChainRules<A, B, S>): Promise<ChainCheck> {
  let s = rules.empty();
  let prev = '';
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i + 1) return { ok: false, count: events.length, brokenAt: i + 1, reason: 'Липсва или е разместено събитие.' };
    if (e.prev !== prev) return { ok: false, count: events.length, brokenAt: e.seq, reason: 'Връзката с предишното събитие е нарушена.' };
    if ((await hashEvent(e)) !== e.hash) return { ok: false, count: events.length, brokenAt: e.seq, reason: 'Съдържанието на събитието е променено.' };
    const r = rules.refuse(s, e.actor, e.body, e.at);
    if (r) return { ok: false, count: events.length, brokenAt: e.seq, reason: `Недопустимо събитие: ${r}` };
    s = rules.apply(s, e);
    prev = e.hash;
  }
  return { ok: true, count: events.length };
}

export type AppendResult<A, B> = { ok: true; event: ChainEvent<A, B> } | { ok: false; reason: string };

/** In-memory log + derived state. Appends are serialised (hashing is async). */
export class ChainLog<A, B, S extends { lastHash: string; lastSeq: number }> {
  events: ChainEvent<A, B>[] = [];
  state: S;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private rules: ChainRules<A, B, S>, private clock: () => number) { this.state = rules.empty(); }

  /** Loads a stored log; refuses it (and stays empty) if the chain does not verify. */
  async load(events: ChainEvent<A, B>[]): Promise<ChainCheck> {
    const check = await verifyChain(events, this.rules);
    if (!check.ok) return check;
    this.events = events.slice();
    this.state = events.reduce((s, e) => this.rules.apply(s, e), this.rules.empty());
    return check;
  }

  verify(): Promise<ChainCheck> { return verifyChain(this.events, this.rules); }

  /** Checks authority + rules against the latest state, then hashes and appends. */
  append(actor: A, body: B): Promise<AppendResult<A, B>> {
    const run = async (): Promise<AppendResult<A, B>> => {
      const at = this.clock();
      const r = this.rules.refuse(this.state, actor, body, at);
      if (r) return { ok: false, reason: r };
      const draft = { seq: this.state.lastSeq + 1, at, actor, body, prev: this.state.lastHash };
      const event: ChainEvent<A, B> = { ...draft, hash: await hashEvent(draft) };
      this.events.push(event);
      this.state = this.rules.apply(this.state, event);
      return { ok: true, event };
    };
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }
}
