// REAL deal / document endpoint placeholder. It ALWAYS refuses: this lab has no sign-in and no
// protected storage, so it must not accept real documents, payments or ownership data.
// The DEMO workspace keeps its deal log and files on the user's own device only.
//
// Contract for the real implementation (server-side, behind Enchev Auctions sign-in):
//   GET  /api/deals/:lotId                → deal log for LOT ID + VIN (only parties of the deal + admins)
//   POST /api/deals/:lotId/documents      → multipart upload; role from the session (never from the client);
//                                           size/type checked by magic bytes, malware scan, private bucket,
//                                           SHA-256 recorded in the append-only log; Idempotency-Key required
//   POST /api/deals/:lotId/reviews        → administrators only; decision + note + VIN match; server time
//   POST /api/payments/webhook            → payment provider only (signature verified); amount must equal
//                                           the approved invoice; never callable from the browser
//   Auction result (WINNER)               → written only from the auction server's own "ended" event
// Every write: authenticate, authorise by role and deal, validate with the same rules as
// src/deal/model.ts (refuse), append to the hash-chained log, audit (who, what, when, IP policy).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.status(501).json({
    error: 'REAL_DEALS_NOT_CONNECTED',
    message: 'Реалните сделки и документи не са свързани в тази лаборатория: няма вход и защитено хранилище. ДЕМО сделката се пази само на устройството.',
  });
}
