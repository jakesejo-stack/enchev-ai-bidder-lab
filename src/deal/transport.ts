// Transport price calculator and the DEMO GPS track. Pure functions; all money in integer cents.
//   T = (B + d · r[вид] · k[състояние] + F + p · V) · (1 + ДДС)
// The coefficients below are DEMO sample values for the admin page "Логистика" — not a carrier's offer.
// d is approximate: great-circle distance × 1.25 (a typical road-to-straight-line factor), rounded to 10 km.
import type { Cents } from '../domain/types.js';
import { euros } from '../domain/money.js';
import { VAT_RATE } from '../domain/costs.js';

export interface City { id: string; name: string; country: string; lat: number; lng: number; }

export const CITIES: readonly City[] = [
  { id: 'sofia', name: 'София', country: 'BG', lat: 42.6977, lng: 23.3219 },
  { id: 'plovdiv', name: 'Пловдив', country: 'BG', lat: 42.1354, lng: 24.7453 },
  { id: 'varna', name: 'Варна', country: 'BG', lat: 43.2141, lng: 27.9147 },
  { id: 'burgas', name: 'Бургас', country: 'BG', lat: 42.5048, lng: 27.4626 },
  { id: 'ruse', name: 'Русе', country: 'BG', lat: 43.8356, lng: 25.9657 },
  { id: 'stara-zagora', name: 'Стара Загора', country: 'BG', lat: 42.4258, lng: 25.6345 },
  { id: 'pleven', name: 'Плевен', country: 'BG', lat: 43.417, lng: 24.6067 },
  { id: 'vidin', name: 'Видин', country: 'BG', lat: 43.9962, lng: 22.8679 },
  { id: 'bucharest', name: 'Букурещ', country: 'RO', lat: 44.4268, lng: 26.1025 },
  { id: 'thessaloniki', name: 'Солун', country: 'GR', lat: 40.6401, lng: 22.9444 },
  { id: 'athens', name: 'Атина', country: 'GR', lat: 37.9838, lng: 23.7275 },
  { id: 'belgrade', name: 'Белград', country: 'RS', lat: 44.7866, lng: 20.4489 },
  { id: 'vienna', name: 'Виена', country: 'AT', lat: 48.2082, lng: 16.3738 },
  { id: 'munich', name: 'Мюнхен', country: 'DE', lat: 48.1351, lng: 11.582 },
  { id: 'berlin', name: 'Берлин', country: 'DE', lat: 52.52, lng: 13.405 },
];

export type Carriage = 'truck' | 'flatbed' | 'enclosed';
export const CARRIAGE_BG: Record<Carriage, string> = { truck: 'Автовоз', flatbed: 'Платформа (единичен превоз)', enclosed: 'Закрит автовоз' };

/** DEMO tariff (edited by logistics in the real admin page). */
export const DEMO_TARIFF = {
  base: euros(80),
  perKm: { truck: 55, flatbed: 95, enclosed: 120 } as Record<Carriage, Cents>, // cents per km
  notRunning: 1.25,
  insuranceRate: 0.003,
  source: 'ДЕМО тарифа — примерни коефициенти, не оферта на превозвач',
};

export function cityByName(text: string): City | null {
  const t = text.toLowerCase();
  return CITIES.find((c) => t.includes(c.name.toLowerCase())) ?? null;
}

export function roadKm(a: City, b: City): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  const straight = 2 * R * Math.asin(Math.sqrt(h));
  return Math.round((straight * 1.25) / 10) * 10;
}

export interface QuoteLine { key: string; label: string; amount: Cents; formula: string; }
export interface TransportQuote {
  from: string; to: string; km: number; carriage: Carriage; running: boolean;
  lines: QuoteLine[]; net: Cents; vat: Cents; total: Cents; source: string;
}

export function quoteTransport(from: City, to: City, carriage: Carriage, running: boolean, carValue: Cents): TransportQuote {
  const km = from.id === to.id ? 0 : roadKm(from, to);
  const k = running ? 1 : DEMO_TARIFF.notRunning;
  const rate = DEMO_TARIFF.perKm[carriage];
  const lines: QuoteLine[] = [
    { key: 'base', label: 'Товарене и документи', amount: DEMO_TARIFF.base, formula: 'фиксирана (B)' },
    { key: 'km', label: `Разстояние ${km} км`, amount: Math.round(km * rate * k), formula: `${km} км × ${(rate / 100).toFixed(2).replace('.', ',')} €/км${running ? '' : ' × 1,25 (неработеща)'}` },
    { key: 'insurance', label: 'Застраховка на товара', amount: Math.round(carValue * DEMO_TARIFF.insuranceRate), formula: '0,3 % от цената на колата' },
  ];
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const vat = Math.round(net * VAT_RATE);
  return { from: from.name, to: to.name, km, carriage, running, lines, net, vat, total: net + vat, source: DEMO_TARIFF.source };
}

/** Point on the straight line between two cities (the DEMO track; a real tracker sends real fixes). */
export function trackPoint(from: City, to: City, progress: number): { lat: number; lng: number } {
  const p = Math.min(1, Math.max(0, progress));
  return { lat: from.lat + (to.lat - from.lat) * p, lng: from.lng + (to.lng - from.lng) * p };
}
