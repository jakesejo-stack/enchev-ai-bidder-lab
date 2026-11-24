// REAL MODE adapter — intentionally NOT active in this lab.
// It is only constructed when an authorised Enchev Auctions endpoint is configured
// (see src/config.ts). Until then the UI shows real mode as "не е свързан" and no request
// is ever sent. When enabled, the browser never holds API keys: it uses the user's session
// cookie (credentials: 'include'), and the server performs authentication, validation,
// idempotency, rate limiting and audit logging.
import type { AuctionEvent, BidRequest, BidResult, BidRejectCode } from '../domain/types.js';
import type { AuctionAdapter, AuctionAdapterHandlers } from './types.js';

export interface RealAdapterConfig {
  /** wss://… stream of AuctionEvent JSON messages for one lot. */
  streamUrl: string;
  /** https://… base for POST /bids and GET /time, same site as the session cookie. */
  apiBase: string;
  bidderId: string;
  authenticated: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Runtime validation of untrusted stream messages. Returns null for anything malformed. */
export function parseAuctionEvent(raw: unknown): AuctionEvent | null {
  if (!isObj(raw) || !isInt(raw.seq) || raw.seq < 0 || !isInt(raw.serverTime)) return null;
  switch (raw.type) {
    case 'bid': {
      const b = raw.bid;
      if (!isObj(b) || typeof b.bidId !== 'string' || typeof b.bidderId !== 'string' || !isInt(b.amount) || b.amount <= 0 || !isInt(b.serverTime)) return null;
      return raw as unknown as AuctionEvent;
    }
    case 'status':
      return ['scheduled', 'active', 'ended', 'suspended'].includes(raw.status as string) ? (raw as unknown as AuctionEvent) : null;
    case 'extension':
      return isInt(raw.endsAt) && isInt(raw.byMs) ? (raw as unknown as AuctionEvent) : null;
    case 'snapshot':
    case 'lot_change':
      return isObj(raw.lot) && isObj(raw.rules) && Array.isArray(raw.bids) && isInt(raw.endsAt) ? (raw as unknown as AuctionEvent) : null;
    default:
      return null;
  }
}

const KNOWN_CODES: BidRejectCode[] = ['UNAUTHENTICATED', 'NOT_ACTIVE', 'ENDED', 'BELOW_MINIMUM', 'NOT_ON_STEP', 'ABOVE_HOUSE_MAX', 'ALREADY_HIGHEST', 'RATE_LIMITED', 'WRONG_LOT', 'WRONG_CURRENCY'];

export class RealAdapter implements AuctionAdapter {
  readonly mode = 'real' as const;
  private ws: WebSocket | null = null;
  private handlers: AuctionAdapterHandlers | null = null;
  private retry = 0;
  private closedByUser = false;
  constructor(private cfg: RealAdapterConfig) {}
  get bidderId(): string { return this.cfg.bidderId; }
  get authenticated(): boolean { return this.cfg.authenticated; }

  connect(handlers: AuctionAdapterHandlers): void {
    this.handlers = handlers;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const h = this.handlers;
    if (!h) return;
    h.onConnection(this.retry ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.cfg.streamUrl);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; h.onConnection('online'); this.requestSnapshot(); void this.syncClock(); };
    ws.onmessage = (m) => {
      let data: unknown;
      try { data = JSON.parse(String(m.data)); } catch { return; }
      if (isObj(data) && data.type === 'heartbeat' && isInt(data.seq)) { h.onHeartbeat(data.seq); return; }
      const e = parseAuctionEvent(data);
      if (e) h.onEvent(e);
    };
    ws.onclose = () => {
      if (this.closedByUser) return;
      h.onConnection('offline');
      const wait = Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), wait);
    };
  }

  private async syncClock(): Promise<void> {
    const sentAt = Date.now();
    const r = await fetch(`${this.cfg.apiBase}/time`, { credentials: 'include', cache: 'no-store' });
    const body: unknown = await r.json();
    if (isObj(body) && isInt(body.serverTime)) this.handlers?.onClockSample({ sentAt, serverTime: body.serverTime, receivedAt: Date.now() });
  }

  requestSnapshot(): void {
    this.ws?.send(JSON.stringify({ type: 'snapshot_request' }));
  }

  disconnect(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }

  async placeBid(req: BidRequest): Promise<BidResult> {
    try {
      const r = await fetch(`${this.cfg.apiBase}/bids`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': req.idempotencyKey },
        body: JSON.stringify({ lotId: req.lotId, amount: req.amount, currency: req.currency }),
      });
      const body: unknown = await r.json().catch(() => null);
      if (r.ok && isObj(body) && isObj(body.bid)) return { status: 'accepted', bid: body.bid as never, duplicate: r.status === 200 && body.duplicate === true };
      const code = isObj(body) && KNOWN_CODES.includes(body.code as BidRejectCode) ? (body.code as BidRejectCode) : r.status === 401 ? 'UNAUTHENTICATED' : r.status === 429 ? 'RATE_LIMITED' : 'NETWORK';
      const message = isObj(body) && typeof body.message === 'string' ? body.message : 'Сървърът отказа офертата.';
      return { status: 'rejected', code, message };
    } catch {
      return { status: 'rejected', code: 'NETWORK', message: 'Мрежова грешка — офертата НЕ е потвърдена. Провери историята преди нов опит.' };
    }
  }
}
