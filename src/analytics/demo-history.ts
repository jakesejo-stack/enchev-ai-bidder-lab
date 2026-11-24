// DEMO ONLY: sample auction history for previewing the 24H / 7D / 30D views in the lab.
// Created only when the user presses the DEMO control, stored with source 'demo-generated', labelled
// everywhere, and removable. Never available in a real-mode build (see sources.ts).
import type { LotInfo } from '../domain/types.js';
import { mulberry32 } from '../adapters/demo-server.js';
import type { RecAuction, RecBid } from './store.js';

const H = 3600_000, D = 24 * H;

export function generateDemoHistory(now: number, lot: LotInfo, days = 30, seed = 20261122): RecAuction[] {
  const rand = mulberry32(seed);
  const retail = lot.retailValue ?? 6_000_000;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const out: RecAuction[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const day = today.getTime() - d * D;
    const count = 3 + Math.floor(rand() * 7);
    for (let i = 0; i < count; i++) {
      const start = day + 9 * H + Math.floor(rand() * 13 * H);
      const nExt = rand() < 0.45 ? 1 + Math.floor(rand() * 3) : 0;
      const duration = 180_000 + nExt * 20_000;
      const end = start + duration;
      if (end > now - 60_000) continue;
      const people = Array.from({ length: 3 + Math.floor(rand() * 6) }, () => `Участник ${1 + Math.floor(rand() * 24)}`);
      const withMe = rand() < 0.2;
      const nBids = 12 + Math.floor(rand() * 34);
      const final = Math.round((retail * (0.55 + rand() * 0.35)) / 50_000) * 50_000;
      const bids: RecBid[] = [];
      let prev = 0;
      for (let k = 0; k < nBids; k++) {
        const f = (k + 1) / nBids;
        const t = start + Math.round(duration * 0.98 * Math.pow(f, 0.8));
        const amount = k === nBids - 1 ? Math.max(final, prev + 10_000) : Math.max(prev + 10_000, Math.round((final * Math.pow(f, 0.6)) / 10_000) * 10_000);
        prev = amount;
        const mine = withMe && k >= nBids - 4 && rand() < 0.5;
        bids.push({ id: `g${start}-${k}`, t, amount, bidder: mine ? 'Ти (демо)' : people[Math.floor(rand() * people.length)]!, mine });
      }
      const ext = Array.from({ length: nExt }, (_, j) => end - (nExt - j) * 20_000 + 1_000);
      out.push({ id: `G-${lot.lotId}-${start}`, lotId: lot.lotId, title: lot.title, source: 'demo-generated', startedAt: start, endedAt: end, startPrice: lot.startPrice, retailValue: lot.retailValue ?? null, bids, ext });
    }
  }
  return out;
}
