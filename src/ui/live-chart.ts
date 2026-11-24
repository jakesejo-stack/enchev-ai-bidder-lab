// Live lot price chart in a "stock ticker" style: big price, change since start, glowing step line,
// baseline, min/max, range tabs and touch/mouse scrubbing.
// Pure view of OBSERVED bids — the line only holds the last accepted price until "now";
// nothing is extrapolated, predicted or invented.
import type { BidRecord, Cents } from '../domain/types.js';
import { formatEur } from '../domain/money.js';

export interface LiveChartData {
  bids: readonly BidRecord[];
  /** Starting price of the lot — the baseline for "Всички". */
  startPrice: Cents;
  mineId: string;
  /** True while the auction is running: the line then extends to the current moment. */
  live: boolean;
  now?: number;
}

export interface LiveChartHandle {
  update(d: LiveChartData): void;
  destroy(): void;
}

type RangeKey = '10' | '25' | 'all';
const RANGES: { key: RangeKey; label: string; n: number | null }[] = [
  { key: '10', label: '10', n: 10 },
  { key: '25', label: '25', n: 25 },
  { key: 'all', label: 'ВСИЧКИ', n: null },
];

const H = 230;
const PAD = { l: 6, r: 6, t: 26, b: 26 };
const clock = new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hm = new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit' });
const pct = new Intl.NumberFormat('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** What the chart shows for one range: the visible bids and the price they are compared against. */
export function chartWindow(bids: readonly BidRecord[], startPrice: Cents, n: number | null): { shown: BidRecord[]; base: Cents; baseLabel: string } {
  if (n === null || bids.length <= n) return { shown: bids.slice(), base: startPrice, baseLabel: 'от старта' };
  const shown = bids.slice(-n);
  return { shown, base: bids[bids.length - n - 1]!.amount, baseLabel: `последни ${n} оферти` };
}

/** "+2 400 €" and "2,71%" against the base. */
export function changeText(price: Cents, base: Cents): { abs: string; pct: string; dir: 'up' | 'down' | 'flat' } {
  const d = price - base;
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const p = base > 0 ? (Math.abs(d) / base) * 100 : 0;
  return { abs: `${d >= 0 ? '+' : '−'}${formatEur(Math.abs(d))}`, pct: `${pct.format(p)}%`, dir };
}

export function mountLiveChart(host: HTMLElement, opts: { reducedMotion?: boolean } = {}): LiveChartHandle {
  host.innerHTML = `<div class="lc${opts.reducedMotion ? ' still' : ''}">
  <div class="lc-head">
    <div class="lc-price" data-lc="price">—</div>
    <div class="lc-chg" data-lc="chg"></div>
    <div class="lc-meta" data-lc="meta"></div>
  </div>
  <div class="lc-plot" data-lc="plot"></div>
  <div class="lc-tabs" role="radiogroup" aria-label="Период на графиката">
    ${RANGES.map((r) => `<button type="button" role="radio" data-range="${r.key}" aria-checked="${r.key === 'all'}">${r.label}</button>`).join('')}
  </div>
</div>`;
  const q = (k: string) => host.querySelector<HTMLElement>(`[data-lc="${k}"]`)!;
  const priceEl = q('price'), chgEl = q('chg'), metaEl = q('meta'), plot = q('plot');

  let range: RangeKey = 'all';
  let data: LiveChartData | null = null;
  let scrubIdx: number | null = null;
  let width = 0;
  // Geometry of the last drawing, reused for scrubbing.
  let geo: { x: (t: number) => number; y: (v: number) => number; shown: BidRecord[]; base: Cents; baseLabel: string } | null = null;

  host.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.range as RangeKey;
    host.querySelectorAll('[data-range]').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
    scrubIdx = null;
    draw();
  }));

  function header(): void {
    if (!data || !geo) return;
    const { shown, base, baseLabel } = geo;
    const last = data.bids[data.bids.length - 1];
    const pick = scrubIdx !== null ? shown[scrubIdx] : undefined;
    const price = pick ? pick.amount : last ? last.amount : data.startPrice;
    const c = changeText(price, base);
    priceEl.textContent = formatEur(price);
    chgEl.dataset.dir = c.dir;
    chgEl.innerHTML = `<span class="lc-abs">${c.abs}</span> <span class="lc-pct">${c.dir === 'down' ? '▼' : '▲'} ${c.pct}</span> <span class="lc-per">· ${esc(baseLabel)}</span>`;
    if (pick) {
      const who = pick.bidderId === data.mineId ? 'Ти' : esc(pick.bidderId);
      metaEl.innerHTML = `<span class="lc-when">${clock.format(pick.serverTime)}</span> · ${who}`;
    } else if (!last) {
      metaEl.textContent = `Няма оферти · старт от ${formatEur(data.startPrice)}`;
    } else {
      metaEl.innerHTML = `${data.live ? '<span class="lc-live">НА ЖИВО</span>' : 'ПРИКЛЮЧИЛ'} · ${data.bids.length} ${data.bids.length === 1 ? 'оферта' : 'оферти'}`;
    }
  }

  function draw(): void {
    if (!data) return;
    width = Math.round(plot.clientWidth) || width || 560;
    const w = width;
    const { shown, base, baseLabel } = chartWindow(data.bids, data.startPrice, RANGES.find((r) => r.key === range)!.n);
    if (shown.length < 1) {
      geo = { x: () => 0, y: () => 0, shown, base, baseLabel };
      plot.innerHTML = `<p class="chart-empty">Още няма оферти — графиката тръгва с първата.</p>`;
      header();
      return;
    }
    const now = data.now ?? Date.now();
    const t0 = shown[0]!.serverTime;
    const tEnd = data.live ? Math.max(now, shown[shown.length - 1]!.serverTime) : shown[shown.length - 1]!.serverTime;
    const t1 = Math.max(tEnd, t0 + 1000);
    const vals = shown.map((b) => b.amount);
    let lo = Math.min(base, ...vals), hi = Math.max(base, ...vals);
    const span = Math.max(hi - lo, 20_000);
    lo -= span * 0.14; hi += span * 0.14;
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    geo = { x, y, shown, base, baseLabel };
    const f = (n: number) => n.toFixed(1);

    // Step line: a price holds until the next accepted bid, then jumps.
    let d = `M${f(x(t0))},${f(y(shown[0]!.amount))}`;
    for (let i = 1; i < shown.length; i++) d += `H${f(x(shown[i]!.serverTime))}V${f(y(shown[i]!.amount))}`;
    d += `H${f(x(tEnd))}`;
    const area = `${d}V${H - PAD.b}H${f(x(t0))}Z`;

    const grid = [0.25, 0.5, 0.75].map((k) => `<line class="lc-grid" x1="0" x2="${w}" y1="${f(PAD.t + k * (H - PAD.t - PAD.b))}" y2="${f(PAD.t + k * (H - PAD.t - PAD.b))}"/>`).join('')
      + [0.2, 0.4, 0.6, 0.8].map((k) => `<line class="lc-grid" y1="${PAD.t}" y2="${H - PAD.b}" x1="${f(w * k)}" x2="${f(w * k)}"/>`).join('');

    // Baseline (dotted) with a pill on the left, like the opening price on a stock chart.
    const by = y(base);
    const baseTxt = formatEur(base);
    const baseline = `<line class="lc-base" x1="0" x2="${w}" y1="${f(by)}" y2="${f(by)}"/>`
      + pill(PAD.l, by + 16 > H - PAD.b ? by - 16 : by + 14, baseTxt, 'start', 'lc-pill');

    // Max / min of the visible bids on the right edge.
    const maxV = Math.max(...vals), minV = Math.min(...vals);
    const mm = (maxV !== minV ? pill(w - PAD.r, Math.max(14, y(maxV) - 12), formatEur(maxV), 'end', 'lc-pill hi') : '')
      + (minV !== maxV && minV !== base ? pill(w - PAD.r, Math.min(H - PAD.b - 2, y(minV) + 16), formatEur(minV), 'end', 'lc-pill') : '');

    // My bids: a dashed tick from the top with a "Т" marker (the "E" earnings marker in stock apps).
    const mine = shown.filter((b) => b.bidderId === data!.mineId).slice(-6).map((b) => {
      const xx = f(x(b.serverTime));
      return `<line class="lc-mine-l" x1="${xx}" x2="${xx}" y1="14" y2="${f(y(b.amount))}"/><circle class="lc-mine" cx="${xx}" cy="11" r="8"/><text class="lc-mine-t" x="${xx}" y="11">Т</text>`;
    }).join('');

    // Hours on the x-axis.
    const xl = `<text class="lc-x" x="${PAD.l}" y="${H - 7}">${hm.format(t0)}</text><text class="lc-x" x="${w - PAD.r}" y="${H - 7}" text-anchor="end">${data.live ? 'сега' : hm.format(t1)}</text>`;

    const lastB = shown[shown.length - 1]!;
    const endX = f(x(tEnd)), endY = f(y(lastB.amount));
    const endDot = `${data.live ? `<circle class="lc-pulse" cx="${endX}" cy="${endY}" r="5"/>` : ''}<circle class="lc-end" cx="${endX}" cy="${endY}" r="5"/>`;

    const label = `Цена на лота: ${formatEur(shown[0]!.amount)} до ${formatEur(lastB.amount)}, ${shown.length} оферти.`;
    plot.innerHTML = `<svg class="lc-svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="${esc(label)}">
<defs>
  <linearGradient id="lcArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e53745" stop-opacity=".42"/><stop offset=".7" stop-color="#e53745" stop-opacity=".06"/><stop offset="1" stop-color="#e53745" stop-opacity="0"/></linearGradient>
  <filter id="lcGlow" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
${grid}<path d="${area}" fill="url(#lcArea)"/>${baseline}${mine}<path d="${d}" class="lc-line" filter="url(#lcGlow)"/>${endDot}${mm}${xl}
<g class="lc-cross" data-lc="cross" visibility="hidden"><line class="lc-cross-l" y1="${PAD.t - 8}" y2="${H - PAD.b}"/><circle class="lc-cross-d" r="6"/></g>
</svg>`;
    paintCross();
    header();
  }

  function pill(px: number, py: number, text: string, anchor: 'start' | 'end', cls: string): string {
    const tw = text.length * 7 + 14;
    const rx = anchor === 'start' ? px : px - tw;
    return `<g class="${cls}"><rect x="${rx.toFixed(1)}" y="${(py - 12).toFixed(1)}" width="${tw}" height="20" rx="6"/><text x="${(rx + tw / 2).toFixed(1)}" y="${(py - 2).toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text></g>`;
  }

  function paintCross(): void {
    const g = plot.querySelector<SVGGElement>('[data-lc="cross"]');
    if (!g || !geo) return;
    const b = scrubIdx !== null ? geo.shown[scrubIdx] : undefined;
    if (!b) { g.setAttribute('visibility', 'hidden'); return; }
    const xx = geo.x(b.serverTime).toFixed(1), yy = geo.y(b.amount).toFixed(1);
    const l = g.querySelector('line')!, c = g.querySelector('circle')!;
    l.setAttribute('x1', xx); l.setAttribute('x2', xx);
    c.setAttribute('cx', xx); c.setAttribute('cy', yy);
    g.setAttribute('visibility', 'visible');
  }

  function nearest(clientX: number): number | null {
    if (!geo || !geo.shown.length) return null;
    const r = plot.getBoundingClientRect();
    const px = clientX - r.left;
    let best = 0, bd = Infinity;
    geo.shown.forEach((b, i) => { const dd = Math.abs(geo!.x(b.serverTime) - px); if (dd < bd) { bd = dd; best = i; } });
    return best;
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && !(e.buttons & 1) && e.type === 'pointermove') return;
    const i = nearest(e.clientX);
    if (i === scrubIdx) return;
    scrubIdx = i;
    paintCross(); header();
  };
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const onEnd = () => { clearTimeout(holdTimer); if (scrubIdx === null) return; scrubIdx = null; paintCross(); header(); };
  plot.addEventListener('pointerdown', (e) => { clearTimeout(holdTimer); onMove(e); });
  plot.addEventListener('pointermove', onMove);
  // On a phone the finger lifts after a tap: keep the picked bid readable for a moment.
  plot.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') { clearTimeout(holdTimer); holdTimer = setTimeout(onEnd, 1800); } });
  plot.addEventListener('pointercancel', onEnd);
  plot.addEventListener('pointerleave', onEnd);

  // Redraw on resize so text and dots never get stretched.
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (Math.round(plot.clientWidth) !== width) draw(); }) : null;
  ro?.observe(plot);

  let lastKey = '';
  return {
    update(d) {
      data = d;
      const last = d.bids[d.bids.length - 1];
      // While live the "now" end moves, so redraw at most once per second; otherwise only on new data.
      const key = `${d.bids.length}|${last?.bidId ?? ''}|${d.live}|${d.startPrice}|${d.live ? Math.floor((d.now ?? Date.now()) / 1000) : ''}`;
      if (key === lastKey) return;
      lastKey = key;
      if (scrubIdx !== null && geo && scrubIdx >= geo.shown.length) scrubIdx = null;
      draw();
    },
    destroy() { clearTimeout(holdTimer); ro?.disconnect(); host.innerHTML = ''; },
  };
}
