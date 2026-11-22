// Floating bubbles (AiBidder, AI Info): a small button that opens a compact, NON-modal panel with
// three pages. Several bubbles share one behaviour; only one panel is open at a time.
// Designed not to get in the way on a phone:
// • draggable; snaps to the left or right edge; position is remembered on this device
// • stays between the top bar and the bid bar / bottom navigation (never covers НАДДАЙ)
// • panel opens above or below the bubble, capped in height; tap outside, ✕ or Escape closes it
// • pages switch by tabs or by swiping; inactive pages are inert (no hidden focus stops)

export interface BubbleApi {
  readonly isOpen: boolean;
  setOpen(open: boolean, returnFocus?: boolean): void;
  selectTab(i: number): void;
  layout(): void;
}
interface Pos { side: 'left' | 'right'; t: number; }
export interface BubbleOptions { storeKey?: string; side?: 'left' | 'right'; t?: number; }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** All mounted bubbles: one open panel at a time, and bubbles never rest on top of each other. */
const registry: { el: HTMLElement; side: () => 'left' | 'right'; api: BubbleApi }[] = [];

export function mountBubble(bubble: HTMLButtonElement, panel: HTMLElement, onOpenChange: (open: boolean) => void, options: BubbleOptions = {}): BubbleApi {
  const STORE_KEY = options.storeKey ?? 'enchev-aib-pos-v1';
  const pages = panel.querySelector<HTMLElement>('.aib-pages')!;
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const pageEls = [...panel.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  const desktop = matchMedia('(min-width: 1024px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pos: Pos = { side: options.side ?? 'right', t: options.t ?? 1 };
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Pos> | null;
    if (v && (v.side === 'left' || v.side === 'right') && typeof v.t === 'number' && Number.isFinite(v.t)) pos = { side: v.side, t: clamp(v.t, 0, 1) };
  } catch { /* storage unavailable */ }
  let open = false;
  let tab = 0;

  /** Free area for the bubble: below the top bar, above the bid bar / bottom nav (phone) or inside main (desktop). */
  function bounds(): { left: number; right: number; top: number; bottom: number } {
    const vv = window.visualViewport;
    const viewBottom = vv ? vv.offsetTop + vv.height : innerHeight;
    if (desktop.matches) {
      const m = document.querySelector('.main')?.getBoundingClientRect();
      if (m) return { left: m.left + 16, right: m.right - 16, top: m.top + 16, bottom: Math.min(m.bottom, viewBottom) - 16 };
    }
    const top = (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 8;
    let bottom = viewBottom;
    for (const sel of ['.bidbar .cta', '.bottomnav']) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r && r.height > 0) bottom = Math.min(bottom, r.top);
    }
    return { left: 10, right: innerWidth - 10, top, bottom: bottom - 10 };
  }

  function place(): void {
    const b = bounds();
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    const x = pos.side === 'left' ? b.left : b.right - w;
    const y = b.top + pos.t * Math.max(0, b.bottom - b.top - h);
    bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    bubble.dataset.side = pos.side;
    if (open) placePanel();
  }

  function placePanel(): void {
    const vv = window.visualViewport;
    const vh = vv ? vv.height : innerHeight;
    const vTop = vv ? vv.offsetTop : 0;
    const r = bubble.getBoundingClientRect();
    const b = bounds();
    const w = Math.min(desktop.matches ? 380 : 400, innerWidth - 24);
    const left = clamp(pos.side === 'right' ? r.right - w : r.left, 12, innerWidth - w - 12);
    const cap = desktop.matches ? 460 : 400;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.width = `${Math.round(w)}px`;
    if (innerHeight - vh > 120) {
      // On-screen keyboard is open (editing the limit): use the visible area above it.
      panel.style.top = `${Math.round(vTop + 8)}px`; panel.style.bottom = 'auto';
      panel.style.setProperty('--aib-max', `${Math.round(Math.min(cap, vh - 16))}px`);
      fit();
      return;
    }
    const above = r.top - 10 - b.top;
    const below = b.bottom - r.bottom - 10;
    if (above >= below) {
      panel.style.top = 'auto'; panel.style.bottom = `${Math.round(innerHeight - r.top + 10)}px`;
      panel.style.setProperty('--aib-max', `${Math.round(Math.min(cap, Math.max(220, above)))}px`);
    } else {
      panel.style.bottom = 'auto'; panel.style.top = `${Math.round(r.bottom + 10)}px`;
      panel.style.setProperty('--aib-max', `${Math.round(Math.min(cap, Math.max(220, below)))}px`);
    }
    fit();
    origin();
  }

  /** Bubble-style opening: the panel grows as a circle out of the bubble's centre. */
  function origin(): void {
    const r = bubble.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const ox = r.left + r.width / 2 - p.left, oy = r.top + r.height / 2 - p.top;
    const far = Math.max(...[[0, 0], [p.width, 0], [0, p.height], [p.width, p.height]].map(([x, y]) => Math.hypot(x! - ox, y! - oy)));
    panel.style.setProperty('--ox', `${Math.round(ox)}px`);
    panel.style.setProperty('--oy', `${Math.round(oy)}px`);
    panel.style.setProperty('--or', `${Math.ceil(far + 4)}px`);
  }

  /** The panel is only as tall as the active page (capped); longer pages scroll inside. */
  function fit(): void {
    if (!open) return;
    const max = parseFloat(panel.style.getPropertyValue('--aib-max')) || 400;
    const avail = Math.max(120, max - pages.offsetTop);
    for (const p of pageEls) p.style.maxHeight = `${avail}px`;
    pages.style.height = `${Math.min(pageEls[tab]!.scrollHeight, avail)}px`;
  }

  function selectTab(i: number, smooth = true): void {
    tab = clamp(i, 0, tabs.length - 1);
    tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === tab)); t.tabIndex = k === tab ? 0 : -1; });
    pageEls.forEach((p, k) => { p.inert = k !== tab; });
    const left = tab * pages.clientWidth;
    if (Math.abs(pages.scrollLeft - left) > 2) pages.scrollTo({ left, behavior: smooth && !reduced ? 'smooth' : 'auto' });
    fit();
  }

  function setOpen(v: boolean, returnFocus = true): void {
    if (open === v) return;
    open = v;
    panel.hidden = !v;
    bubble.setAttribute('aria-expanded', String(v));
    if (v) {
      for (const o of registry) if (o.el !== bubble && o.api.isOpen) o.api.setOpen(false, false);
      placePanel();
      selectTab(tab, false);
      origin();
      panel.classList.remove('pop');
      void panel.offsetWidth; // restart the opening animation
      panel.classList.add('pop');
      tabs[tab]!.focus({ preventScroll: true });
    } else {
      panel.classList.remove('pop');
      if (returnFocus) bubble.focus({ preventScroll: true });
    }
    onOpenChange(v);
  }

  // ---- tabs: click, arrow keys, swipe
  tabs.forEach((t, k) => t.addEventListener('click', () => selectTab(k)));
  panel.querySelector('[role="tablist"]')!.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    const n = ke.key === 'ArrowRight' ? tab + 1 : ke.key === 'ArrowLeft' ? tab - 1 : ke.key === 'Home' ? 0 : ke.key === 'End' ? tabs.length - 1 : null;
    if (n === null) return;
    ke.preventDefault();
    selectTab((n + tabs.length) % tabs.length);
    tabs[tab]!.focus();
  });
  panel.addEventListener('click', (e) => {
    const g = (e.target as Element).closest<HTMLElement>('[data-goto]');
    if (g) selectTab(Number(g.dataset.goto));
  });
  let swipeTimer = 0;
  pages.addEventListener('scroll', () => {
    clearTimeout(swipeTimer);
    swipeTimer = window.setTimeout(() => {
      const i = Math.round(pages.scrollLeft / Math.max(1, pages.clientWidth));
      if (i !== tab) selectTab(i, false);
    }, 90);
  }, { passive: true });

  // ---- open/close
  let suppressClick = false;
  bubble.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    setOpen(!open);
  });
  panel.querySelector('.aib-x')!.addEventListener('click', () => setOpen(false));
  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    const t = e.target as Node;
    if (panel.contains(t) || bubble.contains(t)) return;
    setOpen(false, false); // light dismiss: the tap still reaches what it was aimed at
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && !document.querySelector('dialog[open]')) { e.preventDefault(); setOpen(false); }
  });

  // ---- drag (mouse, pen, touch) with edge snapping
  let drag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  bubble.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = bubble.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    // Capture at once: a quick flick can leave the (rounded) bubble before the drag threshold is reached.
    try { bubble.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      bubble.classList.add('dragging');
      if (open) setOpen(false, false);
    }
    const b = bounds();
    const x = clamp(drag.ox + dx, b.left, b.right - bubble.offsetWidth);
    const y = clamp(drag.oy + dy, b.top, b.bottom - bubble.offsetHeight);
    bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    bubble.classList.remove('dragging');
    const r = bubble.getBoundingClientRect();
    const b = bounds();
    pos = {
      side: r.left + r.width / 2 < (b.left + b.right) / 2 ? 'left' : 'right',
      t: clamp((r.top - b.top) / Math.max(1, b.bottom - b.top - r.height), 0, 1),
    };
    // Never rest on another bubble on the same edge: move just above it (or below if no room).
    for (const o of registry) {
      if (o.el === bubble || o.side() !== pos.side) continue;
      const other = o.el.getBoundingClientRect();
      const y = b.top + pos.t * Math.max(0, b.bottom - b.top - r.height);
      if (y < other.bottom + 8 && y + r.height > other.top - 8) {
        let ny = other.top - 8 - r.height;
        if (ny < b.top) ny = other.bottom + 8;
        pos.t = clamp((ny - b.top) / Math.max(1, b.bottom - b.top - r.height), 0, 1);
      }
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
    place();
  };
  bubble.addEventListener('pointerup', endDrag);
  bubble.addEventListener('pointercancel', endDrag);

  // ---- keep in place
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => fit());
    for (const p of pageEls) for (const c of p.children) ro.observe(c);
  }
  addEventListener('resize', place);
  window.visualViewport?.addEventListener('resize', () => { if (open) placePanel(); });
  desktop.addEventListener('change', place);
  place();
  selectTab(0, false);
  requestAnimationFrame(() => bubble.classList.add('ready'));

  const api: BubbleApi = {
    get isOpen() { return open; },
    setOpen,
    selectTab: (i: number) => selectTab(i),
    layout: place,
  };
  registry.push({ el: bubble, side: () => pos.side, api });
  return api;
}
