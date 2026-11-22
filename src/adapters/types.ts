import type { AuctionEvent, BidRequest, BidResult, ConnectionState } from '../domain/types.js';
import type { ClockSample } from '../domain/clock.js';

export type AdapterMode = 'demo' | 'real';

export interface AuctionAdapterHandlers {
  onEvent(e: AuctionEvent): void;
  onConnection(state: ConnectionState, detail?: string): void;
  onClockSample(sample: ClockSample): void;
  /** Periodic server heartbeat with its latest stream seq: lets the client detect a lost final event. */
  onHeartbeat(serverSeq: number): void;
}

/**
 * Transport between the UI and an auction backend.
 * Real implementations MUST: authenticate the user server-side, validate every bid on the server
 * (lot, status, minimum, step, house max, currency), deduplicate by idempotency key, rate-limit,
 * and write an audit record. The client never decides whether a bid is valid.
 */
export interface AuctionAdapter {
  readonly mode: AdapterMode;
  /** Pseudonymous id the server uses for this user's bids in the public stream. */
  readonly bidderId: string;
  readonly authenticated: boolean;
  connect(handlers: AuctionAdapterHandlers): void;
  disconnect(): void;
  /** Ask the server for a full snapshot (after a gap, reconnect, or on demand). */
  requestSnapshot(): void;
  placeBid(req: BidRequest): Promise<BidResult>;
}
