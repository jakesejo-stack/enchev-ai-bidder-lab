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

const axisEur = (c: number): string => {
  const e = c / 100;
  return e >= 10_000 ? `${Math.round(e / 1000)}k €` : `${Math.round(e).toLocaleString('bg-BG')} €`;
};
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v) ?? v;
}

/** Bars per time bucket (bidding activity). The last bucket is highlighted when it is "now". */
export function barChartSvg(values: { label: string; v: number }[], opts: { liveLast?: boolean; unit?: string } = {}, w = 560, h = 190): string {
  if (!values.length || values.every((x) => x.v === 0)) return '<p class="chart-empty">Няма оферти за избрания период.</p>';
  const pad = { l: 34, r: 8, t: 12, b: 26 };
  const top = niceMax(Math.max(...values.map((x) => x.v)));
  const bw = (w - pad.l - pad.r) / values.length;
  const y = (v: number) => pad.t + (1 - v / top) * (h - pad.t - pad.b);
  const grid = [0, 0.5, 1].map((f) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}"/><text class="ylab" x="${pad.l - 6}" y="${(y(top * f) + 4).toFixed(1)}" text-anchor="end">${Math.round(top * f)}</text>`);
  const every = Math.max(1, Math.ceil(values.length / 8));
  const bars = values.map((x, i) => {
    const bh = Math.max(x.v > 0 ? 2 : 0, (h - pad.t - pad.b) * (x.v / top));
    const cls = `bar${opts.liveLast && i === values.length - 1 ? ' now' : ''}`;
    return `<rect class="${cls}" x="${(pad.l + i * bw + bw * 0.14).toFixed(1)}" y="${(h - pad.b - bh).toFixed(1)}" width="${Math.max(1, bw * 0.72).toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${x.label}: ${x.v}</title></rect>`
      + (i % every === 0 ? `<text class="xlab" x="${(pad.l + i * bw + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${x.label}</text>` : '');
  });
  const total = values.reduce((s, x) => s + x.v, 0);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Активност: общо ${total} ${opts.unit ?? 'оферти'}">${grid.join('')}${bars.join('')}</svg>`;
}

/** Price over time: a step line (LIVE, price holds until the next bid) or a line through final prices. */
export function priceSeriesSvg(points: { t: number; v: number }[], opts: { step?: boolean; label?: (t: number) => string } = {}, w = 560, h = 190): string {
  if (points.length < 2) return `<p class="chart-empty">${opts.step ? 'Още няма оферти в този търг.' : 'Няма приключили търгове за избрания период.'}</p>`;
  const pad = { l: 58, r: 12, t: 12, b: 26 };
  const t0 = points[0]!.t, t1 = Math.max(points[points.length - 1]!.t, t0 + 1);
  const hi = niceMax(Math.max(...points.map((p) => p.v)));
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / hi) * (h - pad.t - pad.b);
  let d = `M${x(points[0]!.t).toFixed(1)},${y(points[0]!.v).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (opts.step) d += ` H${x(p.t).toFixed(1)}`;
    d += ` L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
  }
  const grid = [0, 0.5, 1].map((f) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(hi * f).toFixed(1)}" y2="${y(hi * f).toFixed(1)}"/><text class="ylab" x="${pad.l - 6}" y="${(y(hi * f) + 4).toFixed(1)}" text-anchor="end">${axisEur(hi * f)}</text>`);
  const dots = opts.step || points.length > 40 ? '' : points.map((p) => `<circle class="pt" cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3"/>`).join('');
  const lab = opts.label ?? ((t: number) => new Date(t).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' }));
  const xl = `<text class="xlab" x="${pad.l}" y="${h - 8}">${lab(t0)}</text><text class="xlab" x="${w - pad.r}" y="${h - 8}" text-anchor="end">${lab(t1)}</text>`;
  const last = points[points.length - 1]!;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Цена: последна стойност ${axisEur(last.v)}">${grid.join('')}<path d="${d}" class="line"/>${dots}<circle class="pt last" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/>${xl}</svg>`;
}
