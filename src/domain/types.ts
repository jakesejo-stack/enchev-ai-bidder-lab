// Typed auction event stream shared by the demo adapter and any future real adapter.
// Money is always integer euro CENTS to avoid floating-point rounding in bid arithmetic.

export type Cents = number;
export type Currency = 'EUR';

export type AuctionStatus = 'scheduled' | 'active' | 'ended' | 'suspended';

export interface LotSpec {
  label: string;
  value: string;
}

export interface LotInfo {
  lotId: string;
  title: string;
  subtitle: string;
  specs: LotSpec[];
  currency: Currency;
  startPrice: Cents;
  /** True for simulated lots. Demo lots must never be presented as real auctions. */
  demo: boolean;
  modelUrl?: string;
}

export interface IncrementBand {
  /** Applies while the current price is below this amount; null = no upper bound. */
  below: Cents | null;
  step: Cents;
}

export interface BidRules {
  increments: IncrementBand[];
  /** A bid accepted within this window before the end extends the auction. */
  antiSnipingWindowMs: number;
  /** New end = acceptance time + extensionMs. */
  extensionMs: number;
  /** House maximum for a single bid, if any. */
  maxBid: Cents | null;
}

export interface BidRecord {
  bidId: string;
  /** Pseudonymous bidder handle as published by the server (never a real identity). */
  bidderId: string;
  amount: Cents;
  serverTime: number;
}

interface EventBase {
  /** Strictly increasing per auction stream; used for ordering, de-duplication and gap detection. */
  seq: number;
  /** Server clock (ms since epoch) when the event was produced. */
  serverTime: number;
}

export interface SnapshotEvent extends EventBase {
  type: 'snapshot';
  lot: LotInfo;
  rules: BidRules;
  status: AuctionStatus;
  endsAt: number;
  bids: BidRecord[];
}

export interface BidEvent extends EventBase {
  type: 'bid';
  bid: BidRecord;
}

export interface StatusEvent extends EventBase {
  type: 'status';
  status: AuctionStatus;
  reason?: string;
}

export interface ExtensionEvent extends EventBase {
  type: 'extension';
  endsAt: number;
  byMs: number;
}

export interface LotChangeEvent extends EventBase {
  type: 'lot_change';
  lot: LotInfo;
  rules: BidRules;
  status: AuctionStatus;
  endsAt: number;
  bids: BidRecord[];
}

export type AuctionEvent = SnapshotEvent | BidEvent | StatusEvent | ExtensionEvent | LotChangeEvent;

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface BidRequest {
  lotId: string;
  amount: Cents;
  currency: Currency;
  /** Same key for retries of the same user intent: the server must not create a second bid. */
  idempotencyKey: string;
}

export type BidRejectCode =
  | 'UNAUTHENTICATED'
  | 'NOT_ACTIVE'
  | 'ENDED'
  | 'BELOW_MINIMUM'
  | 'NOT_ON_STEP'
  | 'ABOVE_HOUSE_MAX'
  | 'ALREADY_HIGHEST'
  | 'RATE_LIMITED'
  | 'WRONG_LOT'
  | 'WRONG_CURRENCY'
  | 'NETWORK'
  | 'NOT_CONNECTED';

export type BidResult =
  | { status: 'accepted'; bid: BidRecord; duplicate: boolean }
  | { status: 'rejected'; code: BidRejectCode; message: string; nextValid?: Cents };
