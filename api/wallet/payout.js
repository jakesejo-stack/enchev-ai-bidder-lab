// POST /api/wallet/payout — payment to the SELLER. Intentionally not connected (Mitko, 23.11.2026):
// only through the Revolut Business API or another permitted provider, after a verified recipient (KYB),
// a contract, confirmed funds, legal review and explicit approval. A merchant payout to our own
// Business account is NOT a seller payout.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(501).json({
    error: 'SELLER_PAYOUT_NOT_ENABLED',
    required: ['проверен получател (KYB)', 'договор с продавача', 'потвърдено плащане от купувача', 'правен и счетоводен преглед', 'изрично одобрение от собственика'],
  });
}
