// REAL bid endpoint placeholder for the lab. It ALWAYS refuses: this lab is not connected to the
// authorised Enchev Auctions backend. A real implementation must (server-side): authenticate the
// session, validate lot/status/minimum/step/house max/currency against the authoritative auction
// state, enforce the Idempotency-Key, rate-limit per user, write an audit record, then publish the
// accepted bid on the auction stream. See docs/ARCHITECTURE.md.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(501).json({
    error: 'REAL_BIDDING_NOT_CONNECTED',
    message: 'Реалното наддаване не е свързано в тази лаборатория. Офертите в ДЕМО режим се обработват само в браузъра.',
  });
}
