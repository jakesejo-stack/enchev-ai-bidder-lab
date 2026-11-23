// Browser side of the wallet. It only ASKS the server: the deposit amount, the provider state and every
// "release / forfeit / refund" are decided server-side and confirmed by Revolut. No balance is kept here.
import type { Cents } from '../domain/types.js';

export interface WalletStatus {
  environment: 'sandbox' | 'production'; connected: boolean; reason: string | null; realMoney: boolean; webhookVerified: boolean;
  rules: { rate: number; minCents: number; fixedCents: number | null };
  payout: { enabled: boolean; reason: string };
}
export interface LedgerEntry {
  orderId: string; kind: 'deposit' | 'payment' | 'other'; lot: string; amount: Cents; capturedAmount: Cents; refunded: Cents;
  currency: string; state: string; label: string; createdAt: string | null; updatedAt: string | null;
}

const KEY = 'enchev-wallet-bidder-v1';

/** A random, unguessable profile id for this device (sandbox). ENCHEV uses the signed-in user instead. */
export function bidderId(storage: Storage | null): string {
  try {
    const have = storage?.getItem(KEY);
    if (have && /^b_[A-Za-z0-9_-]{22}$/.test(have)) return have;
  } catch { /* storage blocked */ }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = `b_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  try { storage?.setItem(KEY, id); } catch { /* session only */ }
  return id;
}

export function depositFor(maxBid: Cents, rules: WalletStatus['rules']): Cents {
  return rules.fixedCents ?? Math.max(Math.round(maxBid * rules.rate), rules.minCents);
}

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const r = await fetch(url, { cache: 'no-store', ...init });
    const data = (await r.json().catch(() => null)) as T | null;
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export const wallet = {
  status: () => call<WalletStatus>('/api/wallet/status'),
  ledger: (bidder: string) => call<{ entries: LedgerEntry[]; message?: string }>(`/api/wallet/ledger?bidder=${encodeURIComponent(bidder)}`),
  deposit: (bidder: string, lotId: string, maxBid: Cents) => call<{ orderId?: string; checkoutUrl?: string | null; amount?: Cents; message?: string }>('/api/wallet/deposit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bidder, lotId, maxBid }),
  }),
  settle: (token: string, orderId: string, action: 'release' | 'forfeit' | 'refund', amount?: Cents) => call<{ ok?: boolean; state?: string; message?: string }>('/api/wallet/settle', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ orderId, action, ...(amount ? { amount } : {}) }),
  }),
};
