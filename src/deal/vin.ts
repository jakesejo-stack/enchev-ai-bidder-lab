// VIN checks (ISO 3779): 17 characters, digits and capital letters except I, O and Q.
// The check digit (position 9) is mandatory only for North-American vehicles, so a mismatch is a
// warning, never a reason to reject a European VIN.

const ALLOWED = /^[A-HJ-NPR-Z0-9]{17}$/;
const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function normalizeVin(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export interface VinCheck { ok: boolean; vin: string; reason?: string; checkDigitOk: boolean | null; }

export function checkVin(raw: string): VinCheck {
  const vin = normalizeVin(raw);
  if (vin.length !== 17) return { ok: false, vin, reason: `VIN трябва да е 17 знака (има ${vin.length}).`, checkDigitOk: null };
  if (/[IOQ]/.test(vin)) return { ok: false, vin, reason: 'VIN не може да съдържа буквите I, O и Q.', checkDigitOk: null };
  if (!ALLOWED.test(vin)) return { ok: false, vin, reason: 'VIN съдържа непозволен знак.', checkDigitOk: null };
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i]!;
    const v = c >= '0' && c <= '9' ? Number(c) : TRANSLIT[c]!;
    sum += v * WEIGHTS[i]!;
  }
  const r = sum % 11;
  const expected = r === 10 ? 'X' : String(r);
  return { ok: true, vin, checkDigitOk: vin[8] === expected };
}
