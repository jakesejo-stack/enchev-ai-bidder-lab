# ENCHEV AI Bidder Lab — architecture

## Status: DEMO only

| Area | Today (this lab) | Needed for real auctions |
|---|---|---|
| Auction data | Simulated server **in the browser** (`src/adapters/demo-server.ts`), labelled "ДЕМО ДАННИ" everywhere | Authorised Enchev Auctions WebSocket stream + REST API |
| Bids | Validated by the simulated server; never leave the browser | Server-side: session auth, validation, idempotency, rate limit, audit, then publish |
| `/api/bids` | Always `501 REAL_BIDDING_NOT_CONNECTED` | Proxy to the real backend or removed |
| Real mode | Disabled in `src/config.ts`; UI shows "РЕАЛЕН — не е свързан" | Configure endpoints at build time after review; no API keys in the browser |
| Real data (read-only) | `#/real` via `api/enchev.js`: Enchev service readiness + verified real lots, GET-only allow-list, no credentials | Bids/events need Enchev's realtime service + a read-only grant + payload schema (docs/ENCHEV_REAL_DATA.md) |
| AI | Transparent rules over observed events + your limit. No success %, no market value | Only add predictions backed by a validated, documented model |
| Voice | Browser TTS (Bulgarian voice only) + captions; Web Speech recognition for 4 commands | Same; recognition is processed by the browser vendor (e.g. Google in Chrome) |

## Layers

```
src/domain      pure, unit-tested: types, money (integer cents), bid rules, event reducer, server clock, advisor
src/adapters    AuctionAdapter interface · DemoAdapter + DemoAuctionServer · RealAdapter (disabled skeleton) · enchev-readonly (real lots + service health via /api/enchev)
src/app         Controller: state, narration, bid flow (confirmation, idempotency), heartbeat/gap resync
src/voice       David (TTS queue, captions, pause = voice only), Microphone (commands)
src/ui          markup + render (one DOM; CSS lays it out for desktop ≥1024 px and phones)
src/viewer      lazy three.js viewer (original E&A concept GLB; poster fallback)
```

## Event stream contract (`src/domain/types.ts`)

Every event has `seq` (strictly increasing per lot) and `serverTime`. Types: `snapshot`, `lot_change`,
`bid`, `status`, `extension`, plus a `heartbeat {seq}` message outside the event log.

Client rules (`src/domain/reducer.ts`): `seq ≤ last` → ignored (duplicate/late); `seq = last+1` → applied
and buffered successors drained; `seq > last+1` → buffered; unfilled gap after 1.5 s → request snapshot;
heartbeat ahead of `last` twice with nothing buffered → request snapshot (lost final event). Snapshots win.

## Bid arithmetic (`src/domain/rules.ts`)

`next valid = start price` (no bids) or `current + step(current)`; steps come from increment bands.
Validation: authenticated, same lot, active and not past `endsAt`, not already highest, `≥ next valid`,
on step, `≤ house max`. The same function runs in the demo server; **a real backend must enforce its own copy**.
Anti-sniping: an accepted bid within `antiSnipingWindowMs` of the end moves the end to `acceptedAt + extensionMs`.

## Time

The countdown is `endsAt − (device time + offset)`, offset estimated from round-trip time samples
(`ServerClock`), so a wrong device clock does not change the countdown. The demo server runs 2.3 s ahead
of the device on purpose; tests verify a +60 s skew is corrected.

## Bid safety

1. The CTA only opens a confirmation dialog (lot, amount = next valid bid, current, step, your limit, fees).
2. Consent checkbox is required; if the price moves while open, the amount updates and consent resets.
3. One idempotency key per dialog: repeated clicks/taps cannot create a second bid (tested).
4. Disabled when offline, resyncing, ended, not active, unauthenticated, leading, or over your limit.
5. DAVID never bids. The voice command "наддай" only opens the dialog.

## Connecting a real backend (checklist)

- [ ] Written authorisation from Enchev Auctions; endpoints for stream, `/time`, `/bids`.
- [ ] Session-cookie auth (same site), CSRF protection on `POST /bids`, no keys in the client.
- [ ] Server validation identical to `checkBid` + currency + per-user limits from KYC/deposit rules.
- [ ] `Idempotency-Key` storage with response replay; rate limit per user and per lot.
- [ ] Append-only audit (who, what, when, result, idempotency key, IP/device as policy allows).
- [ ] Fees/buyer's premium shown in the confirmation before consent.
- [ ] Legal review of AI wording; any probability/valuation only from a validated model.
- [ ] Load test of the stream; reconnect/backoff; monitoring.
