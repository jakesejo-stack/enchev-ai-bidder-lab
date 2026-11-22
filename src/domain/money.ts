import type { Cents } from './types.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const plain = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 0 });

export const euros = (n: number): Cents => Math.round(n * 100);
export const toEuros = (c: Cents): number => c / 100;

/** "42 500 €" — Bulgarian formatting. */
export function formatEur(c: Cents): string {
  return eur.format(Math.round(c / 100)).replace(/ /g, ' ');
}

/** For speech: "42 500 евро". */
export function speakEur(c: Cents): string {
  return `${plain.format(Math.round(c / 100)).replace(/ /g, ' ')} евро`;
}

/** Parse user input such as "48 000", "48000", "48 000 €", "48.000". Returns null if invalid. */
export function parseEurInput(text: string): Cents | null {
  const digits = text.replace(/[\s .€]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0 || value > 100_000_000) return null;
  return euros(value);
}
