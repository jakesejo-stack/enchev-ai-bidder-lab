// "Keep the money for another car": similar lots ranked by how close their estimated retail value is to
// the current car's, with the ones that fit the user's budget first. Pure and deterministic.
import type { Cents, LotInfo } from './types.js';

export interface SimilarLot { lot: LotInfo; retail: Cents | null; withinBudget: boolean | null; }

export function similarLots(current: LotInfo | null, candidates: readonly LotInfo[], budget: Cents | null, max = 5): SimilarLot[] {
  const ref = current?.retailValue ?? null;
  return candidates
    .filter((l) => l.lotId !== current?.lotId)
    .map((lot) => {
      const retail = lot.retailValue ?? null;
      return { lot, retail, withinBudget: budget === null || retail === null ? null : retail <= budget };
    })
    .sort((a, b) => {
      const fit = (x: SimilarLot) => (x.withinBudget === false ? 1 : 0);
      if (fit(a) !== fit(b)) return fit(a) - fit(b);
      const d = (x: SimilarLot) => (ref === null || x.retail === null ? Number.MAX_SAFE_INTEGER : Math.abs(x.retail - ref));
      return d(a) - d(b) || a.lot.lotId.localeCompare(b.lot.lotId);
    })
    .slice(0, max);
}
