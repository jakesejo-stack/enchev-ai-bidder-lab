// Revolut Merchant API client for the ENCHEV wallet ("Вход" = deposit hold, "Изход" = release/refund).
// SANDBOX by default. Production is refused unless the owner has explicitly approved real money
// (ENCHEV_REAL_MONEY=approved, set in Vercel by the owner — never by code or a user action).
// Secrets live only in Vercel environment variables; nothing here is sent to the browser.
//   REVOLUT_ENV            sandbox (default) | production
//   REVOLUT_SECRET_KEY     Merchant API secret key (sk_…) for that environment
//   REVOLUT_WEBHOOK_SECRET webhook signing secret (wsk_…)
//   ENCHEV_OPS_TOKEN       operator token for release / forfeit / refund (server-to-server or ops page)
//   ENCHEV_REAL_MONEY      must be "approved" for production
//   DEPOSIT_RATE, DEPOSIT_MIN_CENTS, DEPOSIT_FIXED_CENTS  deposit rule (configurable, not hard-coded)
import { createHmac, timingSafeEqual } from 'node:crypto';

export const API_VERSION = '2024-09-01';
const BASES = { sandbox: 'https://sandbox-merchant.revolut.com', production: 'https://merchant.revolut.com' };

export function config(env = process.env) {
  const mode = env.REVOLUT_ENV === 'production' ? 'production' : 'sandbox';
  const liveApproved = env.ENCHEV_REAL_MONEY === 'approved';
  const rate = Number(env.DEPOSIT_RATE ?? '0.1');
  const min = Number(env.DEPOSIT_MIN_CENTS ?? '30000');
  const fixed = env.DEPOSIT_FIXED_CENTS ? Number(env.DEPOSIT_FIXED_CENTS) : null;
  return {
    mode,
    base: BASES[mode],
    key: env.REVOLUT_SECRET_KEY || '',
    webhookSecret: env.REVOLUT_WEBHOOK_SECRET || '',
    opsToken: env.ENCHEV_OPS_TOKEN || '',
    liveApproved,
    configured: !!env.REVOLUT_SECRET_KEY && (mode === 'sandbox' || liveApproved),
    rules: {
      rate: Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 0.1,
      minCents: Number.isFinite(min) && min >= 1 ? Math.round(min) : 30000,
      fixedCents: fixed !== null && Number.isFinite(fixed) && fixed >= 1 ? Math.round(fixed) : null,
    },
  };
}

/** Why money actions are refused right now (null = allowed). */
export function refusal(cfg) {
  if (cfg.mode === 'production' && !cfg.liveApproved) return { code: 'LIVE_NOT_APPROVED', message: 'Реалните пари не са одобрени от собственика. Работи се само в Revolut Sandbox.' };
  if (!cfg.key) return { code: 'NOT_CONFIGURED', message: 'Revolut ключът не е настроен (REVOLUT_SECRET_KEY във Vercel).' };
  return null;
}

/** Deposit for a maximum bid: fixed amount if set (e.g. 1 cent for the first test), else max(rate × bid, minimum). */
export function depositFor(maxBidCents, rules) {
  if (rules.fixedCents !== null) return rules.fixedCents;
  return Math.max(Math.round(maxBidCents * rules.rate), rules.minCents);
}

export const BIDDER_RE = /^b_[A-Za-z0-9_-]{22}$/;
export const LOT_RE = /^[A-Za-z0-9-]{1,40}$/;
export const ORDER_RE = /^[0-9a-fA-F-]{36}$/;

export async function revolut(cfg, method, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.key}`, 'Revolut-Api-Version': API_VERSION, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error(`Revolut ${method} ${path.split('?')[0]} → ${res.status}`);
    err.status = res.status;
    err.detail = data && typeof data === 'object' ? String(data.message ?? data.code ?? '').slice(0, 200) : '';
    throw err;
  }
  return data;
}

/** Revolut webhook signature: HMAC-SHA256 over "v1.{timestamp}.{raw body}", header "v1=<hex>[,v1=<hex>]", 5-minute tolerance. */
export function verifySignature(rawBody, timestamp, signatureHeader, secret, now = Date.now()) {
  if (!secret || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60_000) return false;
  const expected = Buffer.from(`v1=${createHmac('sha256', secret).update(`v1.${timestamp}.${rawBody}`).digest('hex')}`);
  return String(signatureHeader).split(',').some((s) => {
    const got = Buffer.from(s.trim());
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** What the buyer sees for one provider order. Everything comes from Revolut's own order state. */
export function ledgerEntry(o) {
  const meta = (o && o.metadata) || {};
  const amount = Number(o.amount) || 0;
  const refunded = Number(o.refunded_amount) || 0;
  const state = String(o.state || '').toLowerCase();
  const STATE_BG = {
    pending: 'Чака плащане', processing: 'Обработва се', authorised: 'Задържан (вход)', completed: meta.kind === 'deposit' ? 'Взет като санкция' : 'Платено',
    cancelled: 'Освободен (изход)', failed: 'Неуспешно', declined: 'Отказано',
  };
  return {
    orderId: String(o.id || ''),
    kind: meta.kind === 'deposit' ? 'deposit' : meta.kind === 'payment' ? 'payment' : 'other',
    lot: typeof meta.lot === 'string' ? meta.lot.slice(0, 40) : '',
    amount,
    capturedAmount: state === 'completed' ? amount : 0,
    refunded,
    currency: String(o.currency || 'EUR'),
    state,
    label: refunded > 0 ? (refunded >= amount ? 'Върнат изцяло (изход)' : 'Частично върнат') : (STATE_BG[state] || state),
    createdAt: o.created_at || null,
    updatedAt: o.updated_at || null,
  };
}

export async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('payload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = await readRaw(req);
  try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
}

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
