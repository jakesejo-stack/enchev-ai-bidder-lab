// Price progression chart (SVG). Pure function of observed bids — nothing extrapolated.
import type { BidRecord, Cents } from '../domain/types.js';
import { formatEur } from '../domain/money.js';

const time = new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit' });

export function priceChartSvg(bids: readonly BidRecord[], cap: Cents | null, mineId: string, w = 560, h = 210): string {
  const pts = bids.slice(-14);
  if (pts.length < 2) return `<p class="chart-empty">Още няма достатъчно оферти за графика.</p>`;
  const pad = { l: 64, r: 14, t: 14, b: 28 };
  const t0 = pts[0]!.serverTime, t1 = pts[pts.length - 1]!.serverTime;
  let lo = Math.min(...pts.map((p) => p.amount));
  let hi = Math.max(...pts.map((p) => p.amount));
  const showCap = cap !== null && cap >= lo && cap <= hi + (hi - lo) * 0.6 + 100_000;
  if (showCap) hi = Math.max(hi, cap!);
  const span = Math.max(hi - lo, 100_000);
  lo -= span * 0.12; hi += span * 0.12;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.serverTime).toFixed(1)},${y(p.amount).toFixed(1)}`).join('');
  const area = `${line}L${x(t1).toFixed(1)},${h - pad.b}L${x(t0).toFixed(1)},${h - pad.b}Z`;
  const ticks = 4;
  const grid: string[] = [];
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    const yy = y(v).toFixed(1);
    grid.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" class="grid"/><text x="${pad.l - 8}" y="${yy}" class="ylab" text-anchor="end" dominant-baseline="middle">${formatEur(Math.round(v / 10_000) * 10_000)}</text>`);
  }
  const xl = [pts[0]!, pts[Math.floor(pts.length / 2)]!, pts[pts.length - 1]!]
    .map((p, i) => `<text x="${x(p.serverTime).toFixed(1)}" y="${h - 8}" class="xlab" text-anchor="${['start', 'middle', 'end'][i]}">${time.format(p.serverTime)}</text>`).join('');
  const dots = pts.map((p, i) => {
    const last = i === pts.length - 1;
    const mine = p.bidderId === mineId;
    return `<circle cx="${x(p.serverTime).toFixed(1)}" cy="${y(p.amount).toFixed(1)}" r="${last ? 5.5 : 3.6}" class="pt${last ? ' last' : ''}${mine ? ' mine' : ''}"/>`;
  }).join('');
  const capLine = showCap ? `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(cap!).toFixed(1)}" y2="${y(cap!).toFixed(1)}" class="cap"/><text x="${w - pad.r}" y="${(y(cap!) - 6).toFixed(1)}" class="caplab" text-anchor="end">Твоят лимит ${formatEur(cap!)}</text>` : '';
  const first = pts[0]!, lastP = pts[pts.length - 1]!;
  const label = `Динамика на наддаването: от ${formatEur(first.amount)} до ${formatEur(lastP.amount)} за последните ${pts.length} оферти.`;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}" preserveAspectRatio="none">
<defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e53745" stop-opacity=".5"/><stop offset="1" stop-color="#e53745" stop-opacity="0"/></linearGradient></defs>
${grid.join('')}${capLine}<path d="${area}" fill="url(#area)"/><path d="${line}" class="line"/>${dots}${xl}</svg>`;
}

/** Semi-circle gauge: how much of the user's limit the next valid bid would use. */
export function limitGaugeSvg(use: number | null): string {
  const r = 70, cx = 90, cy = 88;
  const frac = use === null ? 0 : Math.max(0, Math.min(1, use));
  const a = Math.PI * (1 - frac);
  const ex = cx + r * Math.cos(a), ey = cy - r * Math.sin(a);
  const over = use !== null && use > 1;
  const arc = frac > 0 ? `<path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${ex.toFixed(1)},${ey.toFixed(1)}" class="g-val${over ? ' over' : ''}"/>` : '';
  return `<svg class="gauge" viewBox="0 0 180 100" aria-hidden="true"><path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}" class="g-bg"/>${arc}</svg>`;
}
