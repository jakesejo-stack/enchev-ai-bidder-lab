// "Къде отиват парите": the buyer's payment split by destination. Pure and to the cent.
// The money lands in ONE place first — the company's Revolut Business (merchant) account, "the pool" —
// and waits there. Nothing is forwarded automatically: each payout below needs its own condition and an
// approval. VAT is not forwarded per sale: it is declared and paid with the company's VAT return.
import type { Cents } from '../domain/types.js';
import { buyerFee, liveFee, RETRIEVAL_FEE, VAT_RATE } from '../domain/costs.js';
import { euros } from '../domain/money.js';
import type { DealState } from './office.js';
import { invoiceOf } from './office.js';

/** Card fee of the payment provider — a PLACEHOLDER from Mitko's email (≈1 % + 0,20 €); the real one is in the merchant contract. */
export const PROVIDER_FEE = { rate: 0.01, fixed: euros(0.2), note: 'приблизително 1 % + 0,20 € (по имейла на Митко — да се провери в договора с Revolut)' };

export type Destination = 'seller' | 'company' | 'vat' | 'carrier' | 'provider';
export interface SplitLine { to: Destination; label: string; amount: Cents; when: string; how: string; }
export interface Settlement { paidByBuyer: Cents; intoPool: Cents; lines: SplitLine[]; companyNet: Cents; check: boolean; }

export const DEST_BG: Record<Destination, string> = {
  seller: 'Продавач (Енчев / собственикът на колата)', company: 'Компанията (ENCHEV)', vat: 'ДДС → НАП', carrier: 'Превозвач', provider: 'Revolut (такса)',
};

export function providerFee(amount: Cents): Cents {
  return amount > 0 ? Math.round(amount * PROVIDER_FEE.rate) + PROVIDER_FEE.fixed : 0;
}

export function settlementOf(s: DealState): Settlement | null {
  const inv = invoiceOf(s);
  if (!s.deal || !inv) return null;
  const bid = s.deal.amount;
  const fees = buyerFee(bid) + liveFee(bid) + RETRIEVAL_FEE;
  const vat = Math.round(fees * VAT_RATE);
  const transport = s.delivery?.quote?.total ?? 0;
  const paid = inv.gross; // deposit + the rest = everything the buyer pays
  const fee = providerFee(paid);
  const lines: SplitLine[] = [
    { to: 'seller', label: 'Цената на колата', amount: bid, when: 'след подписан протокол за предаване', how: 'превод от Revolut Business към проверената сметка на продавача (KYB + договор)' },
    { to: 'company', label: 'Такси на купувача (без ДДС)', amount: fees, when: 'остават в сметката', how: 'приход на компанията' },
    { to: 'vat', label: 'ДДС 20 % върху таксите', amount: vat, when: 'с ДДС декларацията за месеца', how: 'отделя се в сметката и се плаща на НАП' },
  ];
  if (transport) lines.push({ to: 'carrier', label: `Транспорт до ${s.delivery!.quote!.to}`, amount: transport, when: 'след доставка', how: 'по фактура на превозвача' });
  lines.push({ to: 'provider', label: 'Такса за картово плащане', amount: -fee, when: 'удържа се при плащането', how: PROVIDER_FEE.note });
  const intoPool = paid - fee;
  const companyNet = fees - fee;
  const sum = bid + fees + vat + transport;
  return { paidByBuyer: paid, intoPool, lines, companyNet, check: sum === paid };
}
