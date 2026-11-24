// DEMO transport: connects the UI to the in-browser simulated server through a simulated network
// (latency; optional instability: drops, reordering, duplicates; manual disconnects).
// It never performs a network request, so demo bids cannot reach any real auction.
import type { AuctionEvent, BidRequest, BidResult } from '../domain/types.js';
import type { AuctionAdapter, AuctionAdapterHandlers } from './types.js';
import { DemoAuctionServer, mulberry32, type DemoServerOptions } from './demo-server.js';

export interface DemoNetworkOptions {
  latencyMs?: [number, number];
  unstable?: boolean;
}

export class DemoAdapter implements AuctionAdapter {
  readonly mode = 'demo' as const;
  readonly bidderId = 'Ти (демо)';
  readonly authenticated = true; // the demo user is "signed in" to the simulated server only
  readonly server: DemoAuctionServer;
  private handlers: AuctionAdapterHandlers | null = null;
  private unsub: (() => void) | null = null;
  private connected = false;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private rand = mulberry32(7);
  private latency: [number, number];
  unstable: boolean;

  constructor(serverOpts: DemoServerOptions = {}, net: DemoNetworkOptions = {}) {
    this.server = new DemoAuctionServer(serverOpts);
    this.latency = net.latencyMs ?? [40, 140];
    this.unstable = net.unstable ?? false;
  }

  private delay(): number {
    const [a, b] = this.latency;
    return a + this.rand() * (b - a);
  }

  connect(handlers: AuctionAdapterHandlers): void {
    this.handlers = handlers;
    handlers.onConnection('connecting');
    setTimeout(() => this.open(), this.delay());
  }

  private open(): void {
    if (!this.handlers) return;
    this.connected = true;
    this.handlers.onConnection('online');
    this.unsub = this.server.subscribe((e) => this.deliver(e));
    this.syncClock();
    this.clockTimer = setInterval(() => this.syncClock(), 5000);
    this.requestSnapshot();
  }

  private syncClock(): void {
    const sentAt = Date.now();
    const up = this.delay() / 2;
    setTimeout(() => {
      const serverTime = this.server.now();
      const seq = this.server.currentSeq;
      setTimeout(() => {
        if (!this.connected) return;
        this.handlers?.onClockSample({ sentAt, serverTime, receivedAt: Date.now() });
        this.handlers?.onHeartbeat(seq);
      }, up);
    }, up);
  }

  private deliver(e: AuctionEvent): void {
    if (!this.connected || !this.handlers) return;
    const h = this.handlers;
    let wait = this.delay();
    if (this.unstable) {
      const r = this.rand();
      if (r < 0.12 && e.type !== 'lot_change') return; // dropped: client must detect the gap and resync
      if (r < 0.3) wait += 300 + this.rand() * 700; // delayed: arrives out of order
      if (r > 0.88) setTimeout(() => this.connected && h.onEvent(e), wait + 120); // duplicate
    }
    setTimeout(() => { if (this.connected) h.onEvent(e); }, wait);
  }

  requestSnapshot(): void {
    if (!this.connected) return;
    const snap = this.server.snapshot();
    setTimeout(() => { if (this.connected) this.handlers?.onEvent(snap); }, this.delay());
  }

  /** Demo control: simulate a dropped connection that recovers after `ms`. */
  simulateOutage(ms = 5000): void {
    if (!this.connected) return;
    this.close();
    this.handlers?.onConnection('offline', 'Симулирано прекъсване');
    setTimeout(() => this.handlers?.onConnection('reconnecting'), Math.min(1500, ms / 2));
    setTimeout(() => this.open(), ms);
  }

  private close(): void {
    this.connected = false;
    this.unsub?.();
    this.unsub = null;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  disconnect(): void {
    this.close();
    this.server.stop();
    this.handlers = null;
  }

  async placeBid(req: BidRequest): Promise<BidResult> {
    if (!this.connected) return { status: 'rejected', code: 'NOT_CONNECTED', message: 'Няма връзка със сървъра.' };
    await new Promise((r) => setTimeout(r, this.delay()));
    const result = this.server.placeBid(req, { bidderId: this.bidderId, authenticated: this.authenticated });
    await new Promise((r) => setTimeout(r, this.delay()));
    return result;
  }
}
