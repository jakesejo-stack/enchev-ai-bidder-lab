// GET /api/wallet/status — is the wallet connected, in which environment, with which deposit rule.
import { config, refusal } from '../_lib/revolut.js';

export default function handler(req, res) {
  const cfg = config();
  const r = refusal(cfg);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    environment: cfg.mode,
    connected: !r,
    reason: r?.message ?? null,
    realMoney: cfg.mode === 'production' && cfg.liveApproved && !r,
    webhookVerified: !!cfg.webhookSecret,
    rules: cfg.rules,
    payout: { enabled: false, reason: 'Плащане към продавач само след проверен получател (KYB), договор, проверени средства, правен преглед и одобрение.' },
  });
}
