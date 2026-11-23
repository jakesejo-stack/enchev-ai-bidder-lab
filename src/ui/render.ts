import type { Controller } from '../app/controller.js';
import type { DemoAdapter } from '../adapters/demo-adapter.js';
import { APP_HTML } from './layout.js';
import { mountBubble } from './bubble.js';
import { icon } from './icons.js';
import { priceChartSvg, barChartSvg, priceSeriesSvg } from './chart.js';
import { formatEur, parseEurInput } from '../domain/money.js';
import { VAT_RATE } from '../domain/costs.js';
import { formatCountdown } from '../domain/clock.js';
import { nextValidBid, stepFor } from '../domain/rules.js';
import { CONFIG } from '../config.js';
import type { Caption } from '../voice/david.js';
import { loadReadOnly, lotCountdown, LOT_STATUS_BG, SERVICE_BG, parseEnvelope, toServiceView, type ReadOnlySnapshot, type ServiceView } from '../adapters/enchev-readonly.js';
import type { AnalyticsStore, EventRecorder } from '../analytics/store.js';
import { auctionsCsv, bidsCsv, dayString, rangeFor, summarize, type RangeKind, type Summary } from '../analytics/aggregate.js';
import { availableSources, defaultSource, demoAllowed, type SourceKind } from '../analytics/sources.js';
import { generateDemoHistory } from '../analytics/demo-history.js';
import { similarLots } from '../domain/similar.js';
import { quickBids } from '../domain/advisor.js';
import { DEMO_LOT, SIMILAR_LOTS } from '../adapters/demo-lots.js';
import type { DealBook } from '../deal/book.js';
import { mountOffice } from './office.js';
import { mountWallet } from './wallet.js';

const ROUTES = ['live', 'dashboard', 'ai', 'bids', 'mycars', 'office', 'passport', 'wallet', 'history', 'real', 'settings'] as const;
type Route = (typeof ROUTES)[number];
const timeFmt = new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function setText(el: Element, t: string): void { if (el.textContent !== t) el.textContent = t; }
/** Long countdowns for real lots (days/hours), short ones as mm:ss. */
function formatLong(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m >= 24 * 60) return `${Math.floor(m / 1440)} д ${Math.floor((m % 1440) / 60)} ч`;
  if (m >= 60) return `${Math.floor(m / 60)} ч ${m % 60} мин`;
  return formatCountdown(ms);
}
function setHtml(el: Element, h: string, cache: Map<Element, string>): void {
  if (cache.get(el) === h) return;
  cache.set(el, h);
  el.innerHTML = h;
}

export interface AnalyticsDeps { store: AnalyticsStore; recorder: EventRecorder | null; }

export function mountApp(root: HTMLElement, ctrl: Controller, demo: DemoAdapter | null, analytics: AnalyticsDeps, book: DealBook | null = null): void {
  root.innerHTML = APP_HTML;
  const ref = <T extends HTMLElement = HTMLElement>(name: string): T => {
    const el = document.querySelector<T>(`[data-ref="${name}"]`);
    if (!el) throw new Error(`missing ref ${name}`);
    return el;
  };
  const html = new Map<Element, string>();
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------ AiBidder bubble
  const aib = ref<HTMLButtonElement>('aib');
  let lastAction = '';
  // DAVID switch rides on top of the AiBidder bubble: one tap = voice + 3D subtitles on/off.
  const davidPill = ref<HTMLButtonElement>('davidPill');
  const bubble = mountBubble(aib, ref('aibPanel'), (open) => { if (open) delete aib.dataset.new; render(); }, { companion: davidPill });
  davidPill.addEventListener('click', () => ctrl.setDavid(!ctrl.david.enabled));
  // DAVID is heard only while you are here: another tab, app or window silences him at once.
  const syncPresence = () => ctrl.david.setPresent(document.visibilityState === 'visible' && document.hasFocus());
  document.addEventListener('visibilitychange', syncPresence);
  addEventListener('blur', syncPresence);
  addEventListener('focus', syncPresence);
  addEventListener('pageshow', syncPresence);
  addEventListener('pagehide', () => ctrl.david.setPresent(false));
  document.addEventListener('pointerdown', syncPresence, true);
  syncPresence();
  const info = mountBubble(ref<HTMLButtonElement>('aii'), ref('aiiPanel'), () => render(), { storeKey: 'enchev-aii-pos-v1', side: 'left' });

  // ------------------------------------------------------------ routing
  let officeUi: ReturnType<typeof mountOffice> | null = null;
  let walletUi: ReturnType<typeof mountWallet> | null = null;
  /** "#/office/<id>" → route "office", param "<id>". */
  function routeParts(): [Route, string] {
    const [head = '', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
    const r = head as Route;
    return ROUTES.includes(r) ? [r, rest.join('/')] : ['live', ''];
  }
  function route(): Route { return routeParts()[0]; }
  function applyRoute(focus: boolean): void {
    const r = route();
    document.documentElement.dataset.route = r;
    document.querySelectorAll<HTMLElement>('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== r; });
    const navR = r === 'office' || r === 'passport' ? 'mycars' : r;
    document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => {
      if (a.dataset.nav === navR) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (focus) document.getElementById('main')?.focus({ preventScroll: false });
    bubble.layout(); // the bid bar shows only on the live view (phones)
    info.layout();
    officeUi?.show(r, routeParts()[1]);
    walletUi?.show(r === 'wallet');
    syncRealPolling();
    if (r === 'real') {
      if (bubble.isOpen) bubble.setOpen(false, false);
      if (info.isOpen) info.setOpen(false, false);
      refreshReal();
      if (!realTimer) realTimer = window.setInterval(refreshReal, 30_000);
    } else if (realTimer) {
      clearInterval(realTimer);
      realTimer = 0;
    }
    render();
  }
  addEventListener('hashchange', () => applyRoute(true));

  // ------------------------------------------------------------ analytics dashboard (Табло)
  const sources = availableSources(CONFIG);
  let anSource: SourceKind = defaultSource(CONFIG);
  let anRange: RangeKind = 'live';
  let anMemo = '';
  let anSummary: Summary | null = null;
  let anReal: ServiceView | null = null;
  let anRealTimer = 0;
  let anRowsLimit = 15;
  const anFrom = ref<HTMLInputElement>('anFrom');
  const anTo = ref<HTMLInputElement>('anTo');
  anTo.value = dayString(Date.now());
  anFrom.value = dayString(Date.now() - 6 * 24 * 3600_000);
  document.querySelectorAll<HTMLButtonElement>('[data-src]').forEach((b) => { if (!sources.includes(b.dataset.src as SourceKind)) b.hidden = true; });
  const setRadio = (sel: string, attr: string, v: string) => document.querySelectorAll<HTMLElement>(sel).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[attr] === v)));
  setRadio('[data-src]', 'src', anSource);
  function refreshRealStatus(): void {
    fetch('/api/enchev?r=health-realtime', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => { anReal = toServiceView('realtime', parseEnvelope(j)); anMemo = ''; render(); });
  }
  function syncRealPolling(): void {
    const want = route() === 'dashboard' && anSource === 'real';
    if (want && !anRealTimer) { refreshRealStatus(); anRealTimer = window.setInterval(refreshRealStatus, 30_000); }
    if (!want && anRealTimer) { clearInterval(anRealTimer); anRealTimer = 0; }
  }
  document.querySelectorAll<HTMLButtonElement>('[data-src]').forEach((b) => b.addEventListener('click', () => {
    anSource = b.dataset.src as SourceKind; setRadio('[data-src]', 'src', anSource); anMemo = ''; anRowsLimit = 15; syncRealPolling(); render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) => b.addEventListener('click', () => {
    anRange = b.dataset.range as RangeKind; setRadio('[data-range]', 'range', anRange); ref('anDates').hidden = anRange !== 'custom'; anMemo = ''; anRowsLimit = 15; render();
  }));
  for (const inp of [anFrom, anTo]) for (const ev of ['input', 'change']) inp.addEventListener(ev, () => { anMemo = ''; anRowsLimit = 15; render(); });
  ref('anRows').addEventListener('click', (e) => {
    if (!(e.target as Element).closest('[data-an-more]')) return;
    anRowsLimit += 30; anMemo = ''; render();
  });
  function download(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const csvName = (what: string) => {
    const r = anSummary!.range;
    return `enchev-${anSource === 'demo' ? 'DEMO-' : ''}${what}-${anRange}-${dayString(r.from)}_${dayString(r.to)}.csv`;
  };
  ref('anCsvAuctions').addEventListener('click', () => { if (anSummary) download(csvName('auctions'), auctionsCsv(anSummary)); });
  ref('anCsvBids').addEventListener('click', () => {
    if (anSummary) download(csvName('bids'), bidsCsv(analytics.store.bySource(anSource), anSummary.range, anSource === 'demo' ? analytics.recorder?.live ?? null : null));
  });
  ref('anGen').addEventListener('click', () => {
    if (!demoAllowed(CONFIG) || !ctrl.auction.lot) return;
    analytics.store.clear(['demo-generated']);
    analytics.store.add(generateDemoHistory(ctrl.serverNow, ctrl.auction.lot));
    toast('ДЕМО: добавена примерна история за 30 дни (генерирани данни, не са реални)');
  });
  ref('anClear').addEventListener('click', () => {
    const keep = analytics.recorder?.live ?? null;
    analytics.store.auctions = analytics.store.auctions.filter((x) => x.source === 'real' || x === keep);
    analytics.store.changed();
    toast('ДЕМО историята е изчистена');
  });
  const mmss = (ms: number) => formatCountdown(Math.max(0, ms));
  const dateTime = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const dateOnly = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const SRC_BADGE = { real: 'реален', 'demo-session': 'ДЕМО', 'demo-generated': 'ДЕМО ген.' } as const;
  function renderAnalytics(): void {
    const now = ctrl.serverNow;
    const live = anSource === 'demo' ? analytics.recorder?.live ?? null : null;
    const key = `${anSource}|${anRange}|${anFrom.value}|${anTo.value}|${analytics.store.version}|${Math.floor(now / 1000)}|${anReal?.status ?? ''}`;
    if (key === anMemo) return;
    anMemo = key;
    const range = rangeFor(anRange, now, { live, from: anFrom.value, to: anTo.value });
    const list = analytics.store.bySource(anSource);
    const s = summarize(list, range, now, live);
    anSummary = s;
    // Notes
    if (anSource === 'demo') {
      const sess = list.filter((x) => x.source === 'demo-session').length;
      const gen = list.filter((x) => x.source === 'demo-generated').length;
      setText(ref('anNote'), `ДЕМО ДАННИ — събития от симулирания сървър, записани на това устройство (пазят се 31 дни). Не са реални търгове. Записани търгове: ${sess} от сесии${gen ? `, ${gen} генерирани` : ''}.`);
    } else {
      setText(ref('anNote'), `РЕАЛНИ ДАННИ — само събития, записани от сървъра на Enchev Auctions. ${list.length ? '' : `Към момента няма записани реални събития: регистърът на офертите на Enchev Auctions още не съществува${anReal ? ` (услуга в реално време: ${anReal.state === 'ready' ? 'готова' : anReal.status})` : ''}.`}`);
    }
    ref('anNote').dataset.src = anSource;
    ref('anDemoTools').hidden = anSource !== 'demo' || !demoAllowed(CONFIG);
    const labelFor = (): string => {
      if (anRange === 'live') return live ? `LIVE · текущ търг от ${timeFmt.format(live.startedAt)}${live.endedAt ? ' · приключи' : ' · обновява се на живо'}` : 'LIVE · няма търг на живо';
      if (anRange === '24h') return 'Последните 24 часа (по час)';
      if (anRange === '7d') return 'Последните 7 дни (по ден)';
      if (anRange === '30d') return 'Последните 30 дни (по ден)';
      return `Период ${dateOnly.format(range.from)} – ${dateOnly.format(range.to)}`;
    };
    setText(ref('anRangeLabel'), labelFor());
    // KPIs
    const dash = anSource === 'real' && !list.length;
    const kpi = (k: string, v: string, sub: string) => `<div class="an-kpi"><span>${esc(k)}</span><b>${esc(v)}</b><small>${esc(sub)}</small></div>`;
    const isLive = anRange === 'live';
    setHtml(ref('anKpis'), [
      kpi('Оферти', dash ? '—' : String(s.bids), dash ? 'няма данни' : `твои: ${s.myBids}`),
      kpi('Уникални участници', dash ? '—' : String(s.uniqueBidders), isLive ? 'в текущия търг' : 'за периода'),
      kpi('Приключили търгове', dash ? '—' : String(s.completed), isLive ? (live?.endedAt ? 'текущият приключи' : 'текущият е на живо') : 'за периода'),
      kpi('Удължавания на таймера', dash ? '—' : String(s.extensions), 'анти-снайпинг'),
      kpi('Продължителност', dash ? '—' : isLive ? (s.live ? mmss(s.live.elapsedMs) : '—') : s.avgDurationMs === null ? '—' : mmss(s.avgDurationMs), isLive ? 'досега' : 'средно на търг'),
      kpi('Ръст на цената', dash ? '—' : isLive ? (s.live ? `+${formatEur(s.live.growth)}` : '—') : s.avgGrowth === null ? '—' : `+${formatEur(s.avgGrowth)}`,
        isLive ? (s.live ? `${formatEur(s.live.perMinute)}/мин` : '') : s.maxFinal === null ? 'средно от старта' : `средно · най-висока ${formatEur(s.maxFinal)}`),
    ].join(''), html);
    // Charts
    setText(ref('anActTitle'), isLive ? 'Активност на живо (оферти на 10 с)' : s.range.bucketMs < 86_400_000 ? 'Оферти по час' : s.range.bucketMs > 86_400_000 ? 'Оферти по седмица' : 'Оферти по ден');
    setHtml(ref('anActivity'), barChartSvg(s.activity.map((b) => ({ label: b.label, v: b.bids })), { liveLast: isLive && !!live && !live.endedAt }), html);
    const daily = !isLive && s.range.bucketMs >= 86_400_000;
    setText(ref('anPriceTitle'), isLive ? 'Цена на живо' : daily ? 'Средна крайна цена по ден' : 'Крайни цени на приключилите търгове');
    setHtml(ref('anPrice'), priceSeriesSvg(s.price, isLive ? { step: true, label: (t) => timeFmt.format(t) } : { label: (t) => (daily ? dateOnly.format(t) : dateTime.format(t)) }), html);
    // Completed auctions (newest first)
    const shown = s.rows.slice(0, anRowsLimit);
    setHtml(ref('anRows'), shown.length ? shown.map((x) => `<tr><td data-label="Край">${dateTime.format(x.endedAt!)}</td><td data-label="Лот"><b>${esc(x.title)}</b><small>${esc(x.lotId)}</small></td><td data-label="Продължителност">${mmss(x.durationMs ?? 0)}</td><td data-label="Оферти">${x.bids}</td><td data-label="Участници">${x.bidders}</td><td data-label="Удължавания">${x.extensions}</td><td data-label="Крайна цена">${x.finalPrice === null ? '—' : formatEur(x.finalPrice)}</td><td data-label="Ръст">${x.growth === null ? '—' : '+' + formatEur(x.growth)}</td><td data-label="Източник"><span class="src-badge" data-src="${x.source}">${SRC_BADGE[x.source]}</span></td></tr>`).join('')
      + (s.rows.length > shown.length ? `<tr class="an-more"><td colspan="9"><button type="button" class="btn ghost sm" data-an-more>Покажи още (${s.rows.length - shown.length})</button> <span class="muted">всички са в CSV</span></td></tr>` : '')
      : `<tr class="an-empty"><td colspan="9">${dash ? 'Няма записани реални търгове.' : 'Няма приключили търгове за избрания период.'}</td></tr>`, html);
    ref<HTMLButtonElement>('anCsvAuctions').disabled = !s.rows.length;
    ref<HTMLButtonElement>('anCsvBids').disabled = !s.bids;
  }

  // ------------------------------------------------------------ real data (read-only bridge)
  let real: ReadOnlySnapshot | null = null;
  let realLoading = false;
  let realTimer = 0;
  let lastRealSummary = '';
  function refreshReal(): void {
    if (realLoading) return;
    realLoading = true;
    loadReadOnly().then((snap) => {
      real = snap;
      const rt = snap.services.find((x) => x.key === 'realtime');
      const c = snap.catalog;
      const cat = c.state === 'ok' ? `${c.lots.length} реални ${c.lots.length === 1 ? 'лот' : 'лота'} в каталога` : c.state === 'empty' ? 'няма публикувани реални лотове' : 'каталогът не е наличен';
      const summary = `Реални данни, само четене: ${cat}. ${rt?.state === 'ready' ? 'Услугата в реално време отговаря.' : 'Услугата за оферти в реално време още не е готова.'}`;
      if (summary !== lastRealSummary && route() === 'real') { lastRealSummary = summary; ctrl.david.say(summary, 'system', 'real'); }
    }).finally(() => { realLoading = false; render(); });
  }

  // ------------------------------------------------------------ viewer (lazy)
  const viewerHost = ref('viewer');
  // A missing poster must never show a broken-image icon: hide it and keep the gradient backdrop.
  const poster = viewerHost.querySelector<HTMLImageElement>('.viewer-poster');
  if (poster) {
    const hide = () => { poster.hidden = true; };
    poster.addEventListener('error', hide);
    if (poster.complete && poster.naturalWidth === 0) hide();
  }
  // The 3D viewer follows the lot: a lot change with another model remounts it.
  let viewerUrl = '';
  let viewerHandle: { destroy(): void } | null = null;
  function startViewer(lot: { modelUrl?: string; modelScan?: boolean; modelLength?: number }): void {
    const url = lot.modelUrl ?? '';
    if (url === viewerUrl) return;
    viewerUrl = url;
    viewerHandle?.destroy();
    viewerHandle = null;
    if (!url) return;
    import('../viewer/viewer.js').then(({ mountViewer }) => {
      if (viewerUrl !== url) return;
      viewerHandle = mountViewer(viewerHost, { modelUrl: url, scan: !!lot.modelScan, length: lot.modelLength, reducedMotion: reduceMotion, maxDpr: matchMedia('(pointer: coarse)').matches ? 1.5 : 1.75 });
    }).catch(() => { viewerHost.dataset.viewer = 'fallback'; });
  }

  // ------------------------------------------------------------ inputs
  const rate = ref<HTMLSelectElement>('rate');
  rate.value = String(ctrl.settings.rate);
  rate.addEventListener('change', () => ctrl.setSetting('rate', Number(rate.value)));
  ref('voiceToggle').addEventListener('click', () => ctrl.setDavid(!ctrl.david.enabled));
  ref('pause').addEventListener('click', () => { if (ctrl.david.paused) ctrl.david.resume(); else ctrl.david.pause(); });
  ref('mic').addEventListener('click', () => ctrl.mic.toggle());
  ref('realRefresh').addEventListener('click', () => refreshReal());
  ref('cta').addEventListener('click', () => ctrl.openConfirm());
  ref('cta2').addEventListener('click', () => ctrl.openConfirm());
  const speakAdvice = ref<HTMLInputElement>('speakAdvice');
  speakAdvice.checked = ctrl.settings.speakAdvice;
  speakAdvice.addEventListener('change', () => ctrl.setSetting('speakAdvice', speakAdvice.checked));
  // Budget (AiBidder → Бюджет): the user's own amount for this car; can always be raised.
  const budgetInput = ref<HTMLInputElement>('budgetInput');
  ref('budgetForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = parseEurInput(budgetInput.value);
    if (c === null || c <= 0 || c > 100_000_000) { toast('Въведи бюджет в евро (до 1 000 000 €).', 'bad'); return; }
    ctrl.setCap(c);
    budgetInput.blur();
    toast(`Бюджет: ${formatEur(c)}`, 'ok');
  });
  ref('aibPanel').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLButtonElement>('[data-budget]');
    if (b) {
      const retailV = ctrl.auction.lot?.retailValue ?? null;
      if (b.dataset.budget === 'clear') { ctrl.setCap(null); budgetInput.value = ''; toast('Бюджетът е изчистен'); return; }
      if (b.dataset.budget === 'erv' && retailV) budgetInput.value = String(Math.round(retailV / 100));
      if (b.dataset.budget === '+5000') budgetInput.value = String(Math.round(((parseEurInput(budgetInput.value) ?? ctrl.cap ?? 0) + 500_000) / 100));
      budgetInput.focus();
      return;
    }
    const qb = t.closest<HTMLButtonElement>('[data-quick]');
    if (qb && !qb.disabled) {
      bubble.setOpen(false, false);
      ctrl.openConfirmAt(Number(qb.dataset.quick));
      return;
    }
    const sw = t.closest<HTMLButtonElement>('[data-switch]');
    if (sw && demo) {
      const target = [DEMO_LOT, ...SIMILAR_LOTS].find((l) => l.lotId === sw.dataset.switch);
      if (!target) return;
      bubble.setOpen(false, false);
      demo.server.switchLot(target);
      if (location.hash !== '#/live') location.hash = '#/live';
      toast(`ДЕМО: нов търг за ${target.title}`, 'info');
    }
  });
  const hc = ref<HTMLInputElement>('hc');
  hc.checked = ctrl.settings.highContrast;
  hc.addEventListener('change', () => ctrl.setSetting('highContrast', hc.checked));
  const probWhy = ref('probWhy');
  probWhy.addEventListener('click', () => {
    const t = ref('probWhyText');
    t.hidden = !t.hidden;
    probWhy.setAttribute('aria-expanded', String(!t.hidden));
  });
  // Collapsible chart sections start closed on phones.
  if (matchMedia('(max-width: 1023px)').matches) ref<HTMLDetailsElement>('chartDetails').open = false;

  // Demo controls (event delegation: there are two copies of the buttons).
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-demo]');
    if (!b || !demo) return;
    switch (b.dataset.demo) {
      case 'burst': demo.server.burst(5); toast('ДЕМО: 5 бързи оферти от други участници'); break;
      case 'outage': demo.simulateOutage(5000); toast('ДЕМО: връзката е прекъсната за 5 секунди'); break;
      case 'unstable':
        demo.unstable = !demo.unstable;
        document.querySelectorAll('[data-demo="unstable"]').forEach((x) => x.setAttribute('aria-pressed', String(demo.unstable)));
        toast(demo.unstable ? 'ДЕМО: нестабилна мрежа — загубени, разбъркани и повторени събития' : 'ДЕМО: стабилна мрежа');
        break;
      case 'end': demo.server.endIn(15_000); toast('ДЕМО: търгът ще приключи след 15 секунди'); break;
      case 'reset': demo.server.reset(); ctrl.attempts.length = 0; toast('ДЕМО: нов търг'); break;
    }
  });

  // ------------------------------------------------------------ dialog
  const dialog = ref<HTMLDialogElement>('dialog');
  const consent = ref<HTMLInputElement>('consent');
  consent.addEventListener('change', () => ctrl.setConsent(consent.checked));
  ref('cfSubmit').addEventListener('click', () => { void ctrl.submitBid(); });
  ref('cfCancel').addEventListener('click', () => ctrl.closeConfirm());
  dialog.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-raise]');
    if (!b || !ctrl.confirm.open) return;
    const step = ctrl.confirmStep ?? 0;
    const v = b.dataset.raise!;
    const amount = ctrl.confirm.amount;
    if (v === 'min') ctrl.setConfirmAmount(ctrl.nextValid ?? amount);
    else if (v === 'down') ctrl.setConfirmAmount(amount - step);
    else if (v === 'up') ctrl.setConfirmAmount(amount + step);
    else ctrl.setConfirmAmount(amount + Number(v));
  });
  // Free amount: type any sum; it is rounded UP to the step grid and capped at the lot's maximum (server rule).
  const cfFree = ref<HTMLInputElement>('cfFree');
  ref('cfFreeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!ctrl.confirm.open) return;
    const c = parseEurInput(cfFree.value);
    if (c === null) { toast('Напиши сума в евро, напр. 55 000', 'bad'); cfFree.focus(); return; }
    const max = ctrl.auction.rules?.maxBid ?? null;
    ctrl.setConfirmAmount(c);
    if (max !== null && c > max) toast(`Максимумът за лота е ${formatEur(max)} — сумата е намалена до него.`, 'info');
    else if (ctrl.nextValid !== null && c < ctrl.nextValid) toast(`Най-малката валидна оферта е ${formatEur(ctrl.nextValid)}.`, 'info');
    cfFree.value = '';
  });
  ref('cfX').addEventListener('click', () => ctrl.closeConfirm());
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); ctrl.closeConfirm(); });
  let lastFocus: HTMLElement | null = null;

  // ------------------------------------------------------------ toasts & live regions
  const toasts = ref('toasts');
  function toast(text: string, tone: 'ok' | 'bad' | 'info' = 'info'): void {
    const t = document.createElement('div');
    t.className = `toast ${tone}`;
    t.textContent = text;
    toasts.appendChild(t);
    setTimeout(() => t.classList.add('out'), 3800);
    setTimeout(() => t.remove(), 4400);
  }
  let lastCaptionId = 0;
  let lastAttemptState = new Map<string, string>();
  /** Announce all captions that arrived since the last render (not just the newest one). */
  function announce(batch: Caption[]): void {
    const polite = batch.filter((c) => c.kind !== 'alert').map((c) => c.text);
    const alerts = batch.filter((c) => c.kind === 'alert').map((c) => c.text);
    if (polite.length) ref('livePolite').textContent = polite.join(' ');
    if (alerts.length) ref('liveAssert').textContent = alerts.join(' ');
  }

  // ------------------------------------------------------------ render
  const iconState: { paused: boolean | null; enabled: boolean | null } = { paused: null, enabled: null };
  const svgEl = (markup: string): Element => {
    const t = document.createElement('template');
    t.innerHTML = markup;
    return t.content.firstElementChild!;
  };
  function render(): void {
    const a = ctrl.auction;
    const lot = a.lot;
    const rules = a.rules;
    const adv = ctrl.advice;
    const top = ctrl.top;
    const next = ctrl.nextValid;
    const rem = ctrl.remainingMs;
    const ended = ctrl.ended;
    const conn = ctrl.effectiveConnection;
    document.documentElement.classList.toggle('hc', ctrl.settings.highContrast);
    document.documentElement.dataset.conn = conn;
    document.documentElement.dataset.ended = String(ended);

    if (lot) {
      startViewer(lot);
      viewerHost.dataset.model = lot.modelUrl ? (lot.modelScan ? 'scan' : 'yes') : 'none';
      setText(ref('viewerTag'), lot.modelScan ? 'ДЕМО · реален 3D скан' : lot.modelUrl ? 'ДЕМО · 3D концепт, не е реален автомобил' : '');
    }

    // Top bar
    setText(ref('timer'), lot ? formatCountdown(rem) : '--:--');
    ref('timer').classList.toggle('urgent', !!lot && !ended && rem < 30_000);
    ref('ext').hidden = !(ctrl.extendedAt !== null && Date.now() - ctrl.extendedAt < 8000 && !ended);
    setText(ref('liveText'), ended ? 'ПРИКЛЮЧИЛ' : 'НА ЖИВО');
    ref('livePill').classList.toggle('off', ended);
    const connText = { online: 'Свързан (ДЕМО)', connecting: 'Свързване…', reconnecting: 'Повторно свързване…', offline: 'Няма връзка' }[conn];
    setText(ref('connText'), a.needsResync && conn === 'online' ? 'Синхронизиране…' : connText);
    ref('conn').dataset.state = conn;
    setText(ref('lotMini'), lot ? `Активен лот: ${lot.title}` : '—');

    // Lot
    if (lot) {
      setText(ref('lotNo'), `ЛОТ #${lot.lotId}${lot.demo ? ' · ДЕМО' : ''}`);
      setText(ref('lotTitle'), lot.title);
      setText(ref('lotSub'), lot.subtitle);
      const retail = ref('lotRetail');
      retail.hidden = !lot.retailValue;
      if (lot.retailValue) setHtml(retail, `Estimated retail value: <b>${formatEur(lot.retailValue)}</b> <span>· ${esc(lot.retailSource ?? 'обявена в лота')}</span>`, html);
      setHtml(ref('specs'), lot.specs.map((s, i) => `<li>${icon(['calendar', 'engine', 'bolt', 'road'][i] ?? 'info')}<span><span class="sr-only">${esc(s.label)}: </span>${esc(s.value)}</span></li>`).join('') + '<li class="spec-note">примерни данни</li>', html);
    }
    const step = lot && rules ? stepFor(top ? top.amount : lot.startPrice, rules) : null;
    setText(ref('current'), top ? formatEur(top.amount) : lot ? formatEur(lot.startPrice) : '—');
    setText(ref('currentBy'), top ? (top.bidderId === ctrl.adapter.bidderId ? 'Твоя оферта' : top.bidderId) : lot ? `Няма оферти · старт от ${formatEur(lot.startPrice)}` : '');
    setText(ref('next'), next !== null ? formatEur(next) : '—');
    // Auctioneer subtitle in 3D: your bid green/white, someone else's red/yellow.
    const sub = ctrl.subtitle;
    if (!ctrl.david.enabled) { const el = ref('sub3d'); if (el.classList.contains('on')) { clearTimeout(subTimer); el.classList.remove('show', 'on'); } }
    else if (sub && sub.id !== lastSubtitle) {
      lastSubtitle = sub.id;
      const el = ref('sub3d');
      el.dataset.tone = sub.tone;
      setText(ref('sub3dMain'), sub.main);
      setText(ref('sub3dSub'), sub.sub);
      el.classList.remove('show', 'on');
      void el.offsetWidth; // restart the animation for every call
      el.classList.add('show', 'on');
      clearTimeout(subTimer);
      subTimer = setTimeout(() => el.classList.remove('show', 'on'), 2600);
    }
    setText(ref('stepLine'), step !== null ? `Стъпка ${formatEur(step)}` : '');
    const statusText = ended ? 'ДЕМО · Търгът приключи' : conn !== 'online' ? 'ДЕМО · Няма връзка — наддаването е спряно' : 'ДЕМО · Активен търг · Наддаване в реално време';
    setText(ref('statusText'), statusText);
    ref('statusChip').dataset.state = ended ? 'ended' : conn;

    // Timeline (last 6 bids)
    const last6 = a.bids.slice(-6);
    setHtml(ref('timeline'), !last6.length && lot ? `<li class="tl-empty">Още няма оферти. Търгът започва от ${formatEur(lot.startPrice)}${next !== null ? ` — първата валидна оферта е ${formatEur(next)}` : ''}.</li>` : last6.map((b, i) => {
      const mine = b.bidderId === ctrl.adapter.bidderId;
      const isLast = i === last6.length - 1;
      return `<li class="${isLast ? 'last' : ''}${mine ? ' mine' : ''}"><span class="tl-dot" aria-hidden="true"></span><span class="tl-amt">${formatEur(b.amount)}</span><span class="tl-time">${timeFmt.format(b.serverTime)}</span><span class="tl-who">${mine ? 'Ти' : esc(b.bidderId)}</span></li>`;
    }).join(''), html);

    // Chart, gauge, signals
    setHtml(ref('chart'), priceChartSvg(a.bids, null, ctrl.adapter.bidderId), html);
    const sigHtml = adv.signals.map((s) => `<li class="sig ${s.tone}"><span class="sig-l">${esc(s.label)}</span><span class="sig-v">${esc(s.value)}</span></li>`).join('');
    setHtml(ref('signals'), sigHtml, html);
    setHtml(ref('aiSignals'), sigHtml, html);
    setText(ref('prob'), adv.probabilityText);
    setText(ref('probWhyText'), adv.probabilityWhy);

    // DAVID
    const d = ctrl.david;
    const vs = d.status;
    setText(ref('vstate'), { off: 'ГЛАС ИЗКЛ.', idle: 'АКТИВЕН', speaking: 'ГОВОРИ', paused: 'ГЛАС НА ПАУЗА', unavailable: 'САМО НАДПИСИ' }[vs]);
    ref('vstate').dataset.state = vs;
    ref('wave').classList.toggle('on', vs === 'speaking' && !reduceMotion);
    setText(ref('quote'), d.latest ? `„${d.latest.text}“` : '…');
    const note = d.unavailableReason;
    ref('voiceNote').hidden = !(note && d.enabled);
    setText(ref('voiceNote'), note ?? '');
    setText(ref('voiceToggleLabel'), d.enabled ? 'Изключи гласа' : 'Включи гласа');
    ref('voiceToggle').setAttribute('aria-pressed', String(d.enabled));
    davidPill.setAttribute('aria-pressed', String(d.enabled));
    davidPill.dataset.state = vs;
    davidPill.classList.toggle('talking', vs === 'speaking' && !reduceMotion);
    setText(ref('davidPillState'), d.enabled ? 'включен' : 'изключен');
    setText(ref('pauseLabel'), d.paused ? 'Продължи' : 'Пауза');
    ref('pause').setAttribute('aria-pressed', String(d.paused));
    if (iconState.paused !== d.paused) {
      iconState.paused = d.paused;
      ref('pause').querySelector('svg')?.replaceWith(svgEl(icon(d.paused ? 'play' : 'pause')));
    }
    if (iconState.enabled !== d.enabled) {
      iconState.enabled = d.enabled;
      ref('voiceToggle').querySelector('svg')?.replaceWith(svgEl(icon(d.enabled ? 'volumeOff' : 'volume')));
    }
    const mic = ref('mic');
    mic.dataset.state = ctrl.mic.state;
    mic.setAttribute('aria-pressed', String(ctrl.mic.state === 'listening'));
    mic.title = { unsupported: 'Гласовите команди не се поддържат от този браузър', idle: 'Натисни и кажи команда', listening: 'Слушам…', denied: 'Достъпът до микрофона е отказан', error: 'Грешка при разпознаване на реч' }[ctrl.mic.state];
    (mic as HTMLButtonElement).disabled = ctrl.mic.state === 'unsupported';
    const risk = ref('risk');
    setText(risk, adv.risk.toUpperCase());
    risk.dataset.level = adv.risk;
    // AI Info: the car (all characteristics + declared retail value), live statistics, auction rules
    if (info.isOpen && lot && rules) {
      setText(ref('aiiRetail'), lot.retailValue ? formatEur(lot.retailValue) : 'не е обявена');
      setText(ref('aiiRetailSrc'), lot.retailSource ?? '');
      const row = (k: string, v: string, cls = '') => `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
      setHtml(ref('aiiSpecs'), (lot.details ?? lot.specs).map((s) => row(s.label, s.value)).join(''), html);
      const bids = a.bids;
      const me = ctrl.adapter.bidderId;
      const price = top ? top.amount : 0;
      const sNow = ctrl.serverNow;
      const lastMin = bids.filter((b) => sNow - b.serverTime <= 60_000).length;
      const sorted = [...bids].sort((x, y) => x.amount - y.amount);
      const raises = sorted.slice(1).map((b, i) => b.amount - sorted[i]!.amount);
      const avgRaise = raises.length ? Math.round(raises.reduce((x, y) => x + y, 0) / raises.length) : null;
      const lastBid = bids.length ? bids.reduce((x, y) => (y.serverTime > x.serverTime ? y : x)) : null;
      const st = a.stats;
      setHtml(ref('aiiStats'), [
        row('Текуща оферта', formatEur(price), 'hl'),
        row('Ръст от старта', formatEur(Math.max(0, price - lot.startPrice))),
        ...(lot.retailValue ? [
          row('Цена / estimated retail value', `${Math.round((price / lot.retailValue) * 100)} %`),
          row(price <= lot.retailValue ? 'До estimated retail value' : 'Над estimated retail value', formatEur(Math.abs(lot.retailValue - price))),
        ] : []),
        row('Оферти общо', String(bids.length)),
        row('Участници', String(new Set(bids.map((b) => b.bidderId)).size)),
        row('Твои приети оферти', String(bids.filter((b) => b.bidderId === me).length)),
        row('Оферти за последната минута', String(lastMin)),
        row('Средно повишение', avgRaise === null ? '—' : formatEur(avgRaise)),
        row('Последна оферта преди', lastBid ? `${Math.max(0, Math.round((sNow - lastBid.serverTime) / 1000))} с` : '—'),
        row('Удължавания', String(ctrl.extensions)),
        row('Оставащо време', ended ? 'приключил' : formatCountdown(rem)),
        row('Връзка', `${conn === 'online' ? 'онлайн' : conn === 'offline' ? 'няма връзка' : 'свързване'} · пресинхронизации ${st.resyncs}`),
      ].join(''), html);
      const bands = rules.increments.map((b) => `${b.below === null ? 'над' : 'до'} ${formatEur(b.below ?? rules.increments[rules.increments.length - 2]?.below ?? 0)} → ${formatEur(b.step)}`).join('; ');
      setHtml(ref('aiiRules'), [
        row('Режим', 'ДЕМО — симулиран търг', 'hl'),
        row('Начална цена', formatEur(lot.startPrice)),
        row('Първа валидна оферта', formatEur(nextValidBid(lot, rules, []))),
        row('Стъпки на наддаване', bands),
        row('Удължаване', `оферта в последните ${Math.round(rules.antiSnipingWindowMs / 1000)} с удължава до ${Math.round(rules.extensionMs / 1000)} с след нея`),
        row('Изпращане на реални оферти', 'изключено'),
      ].join(''), html);
    }

    // Advice
    setText(ref('advHead'), adv.headline);
    setText(ref('aiHead'), adv.headline);
    const reasons = adv.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
    setHtml(ref('advReasons'), reasons, html);
    setHtml(ref('aiReasons'), reasons, html);
    ref('aibPanel').dataset.action = adv.action;
    aib.dataset.level = adv.risk;
    if (adv.action !== lastAction) {
      if (lastAction !== '' && !bubble.isOpen) aib.dataset.new = 'true';
      lastAction = adv.action;
    }
    aib.setAttribute('aria-label', `AiBidder — съвети. Риск: ${adv.risk}.${aib.dataset.new ? ' Нов съвет.' : ''}`);
    const retailV = lot?.retailValue ?? null;
    const blocked = !!ctrl.blockReason && ctrl.blockReason !== 'НАД БЮДЖЕТА';
    setHtml(ref('aibQuick'), quickBids(ctrl.auction, ctrl.cap).map((q) => `<button type="button" class="qb" data-quick="${q.amount}" data-min="${q.min}" ${blocked || q.overBudget ? 'disabled' : ''}><span class="qb-plus">${q.min ? 'Минимум' : `+${formatEur(q.plus)}`}</span><b>${formatEur(q.amount)}</b>${q.overBudget ? '<small>над бюджета</small>' : ''}</button>`).join(''), html);
    setHtml(ref('aibTips'), adv.tips.map((t) => `<li>${esc(t)}</li>`).join(''), html);
    ref('aibSimilarBtn').hidden = !adv.suggestSimilar;
    setText(ref('aibBudgetBtn'), ctrl.cap === null ? 'Задай бюджет' : `Бюджет: ${formatEur(ctrl.cap)}`);
    setText(ref('aibErv'), retailV ? formatEur(retailV) : 'не е посочена');
    // VAT in one sentence under the car.
    setText(ref('lotVat'), `ДДС: ${Math.round(VAT_RATE * 100)} % — начислява се върху таксите на търга, не върху колата; колата е в ЕС, затова няма мито.`);
    setText(ref('budgetNow'), ctrl.cap === null ? 'Няма зададен бюджет.' : `Текущ бюджет: ${formatEur(ctrl.cap)}${adv.walkAway !== null ? ` · препоръчан праг: ${formatEur(adv.walkAway)}` : ''}`);
    if (document.activeElement !== budgetInput && budgetInput.dataset.cap !== String(ctrl.cap)) {
      budgetInput.dataset.cap = String(ctrl.cap);
      budgetInput.value = ctrl.cap === null ? '' : String(Math.round(ctrl.cap / 100));
    }
    if (bubble.isOpen) {
      const list = similarLots(lot ?? null, [DEMO_LOT, ...SIMILAR_LOTS], ctrl.cap);
      setText(ref('similarNote'), adv.suggestSimilar
        ? (ctrl.cap !== null ? `Ако спреш сега, запазваш ${formatEur(ctrl.cap)} за друга кола. Подобни коли в сайта:` : 'Подобни коли в сайта — може да вземеш по-добра цена:')
        : 'Подобни коли в сайта, ако искаш алтернатива (ДЕМО лотове, примерни данни):');
      setHtml(ref('similar'), list.map((x) => {
        const sp = (k: string) => x.lot.specs.find((q) => q.label === k)?.value ?? '';
        const fit = x.withinBudget === null ? '' : `<span class="sim-fit" data-fit="${x.withinBudget}">${x.withinBudget ? 'в бюджета' : 'над бюджета'}</span>`;
        return `<li class="sim"><div class="sim-top"><b>${esc(x.lot.title)}</b>${fit}</div><span class="sim-sub">${esc([sp('Година'), sp('Мощност'), sp('Пробег')].filter(Boolean).join(' · '))}</span><span class="sim-erv">Estimated retail value: <b>${x.retail !== null ? formatEur(x.retail) : 'не е посочена'}</b></span>${demo ? `<button type="button" class="btn sm sim-go" data-switch="${esc(x.lot.lotId)}">Наддавай за тази</button>` : ''}</li>`;
      }).join(''), html);
    }

    // CTA
    const block = ctrl.blockReason;
    for (const r of ['cta', 'cta2']) {
      const b = ref<HTMLButtonElement>(r);
      b.disabled = !!block;
      b.dataset.state = block ? 'blocked' : 'ready';
      setText(ref(`${r}Label`), block ?? 'НАДДАЙ');
      setText(ref(`${r}Amount`), next !== null && (!block || block === 'НАД БЮДЖЕТА') ? `(${formatEur(next)})` : '');
      b.setAttribute('aria-label', block ? `Наддаването не е възможно: ${block}` : `Наддай ${next !== null ? formatEur(next) : ''} — отваря потвърждение`);
    }

    // Confirm dialog
    const c = ctrl.confirm;
    if (c.open && !dialog.open) { lastFocus = document.activeElement as HTMLElement; dialog.showModal(); consent.focus(); }
    if (!c.open && dialog.open) { dialog.close(); lastFocus?.focus(); }
    if (c.open && lot) {
      setText(ref('cfLot'), `#${lot.lotId} · ${lot.title}`);
      setText(ref('cfAmount'), formatEur(c.amount));
      setText(ref('cfAmount2'), formatEur(c.amount));
      setText(ref('cfCurrent'), top ? formatEur(top.amount) : '—');
      setText(ref('cfStep'), step !== null ? formatEur(step) : '—');
      ref('cfMoved').hidden = !c.priceMoved;
      setText(ref('cfMoved'), `Цената се промени. Новата следваща валидна оферта е ${formatEur(c.amount)} — потвърди отново.`);
      consent.checked = c.consent;
      const err = ref('cfError');
      err.hidden = !c.error;
      setText(err, c.error ?? '');
      const atMin = next !== null && c.amount <= next;
      dialog.querySelectorAll<HTMLButtonElement>('[data-raise]').forEach((b) => {
        b.disabled = c.pending || ((b.dataset.raise === 'down' || b.dataset.raise === 'min') && atMin);
      });
      const submit = ref<HTMLButtonElement>('cfSubmit');
      submit.disabled = !c.consent || c.pending || !!ctrl.blockReason;
      setText(submit, c.pending ? 'Изпращане…' : 'Потвърди наддаване');
      ref<HTMLButtonElement>('cfCancel').disabled = c.pending;
    }

    // Views
    const r = route();
    if (r === 'dashboard') {
      renderAnalytics();
      setText(ref('dLot'), lot ? lot.title : '—');
      setText(ref('dPrice'), top ? `Текуща оферта ${formatEur(top.amount)}` : 'Няма оферти');
      setText(ref('dTime'), lot ? (ended ? 'Търгът приключи' : `Остават ${formatCountdown(rem)}`) : '—');
      setText(ref('dPos'), ctrl.leading ? 'Водиш' : top ? 'Не водиш' : '—');
      setText(ref('dMine'), `Приети демо оферти: ${ctrl.attempts.filter((x) => x.status === 'accepted').length}`);
      setText(ref('dVoice'), { off: 'Гласът е изключен', idle: 'Гласът е включен', speaking: 'Говори', paused: 'Гласът е на пауза', unavailable: 'Само надписи' }[vs]);
      setText(ref('dReal'), 'РЕАЛНИ ДАННИ — само четене. Реалното наддаване е изключено.');
    }
    if (r === 'bids') {
      setHtml(ref('bidsBody'), ctrl.attempts.length ? ctrl.attempts.map((x) => `<tr class="${x.status}"><td>${timeFmt.format(x.at)}</td><td>${formatEur(x.amount)}</td><td>${{ pending: 'Изпраща се', accepted: 'Приета (ДЕМО)', rejected: 'Отказана' }[x.status]}</td><td>${esc(x.message)}</td></tr>`).join('') : '<tr><td colspan="4">Още нямаш оферти.</td></tr>', html);
    }
    if (r === 'history') {
      setHtml(ref('log'), ctrl.log.slice(-200).reverse().map((l) => `<li class="${l.kind}"><time>${timeFmt.format(l.at)}</time> ${esc(l.text)}</li>`).join(''), html);
      setHtml(ref('transcript'), d.captions.slice(-200).reverse().map((c2) => `<li class="${c2.kind}"><time>${timeFmt.format(c2.at)}</time> ${esc(c2.text)}</li>`).join(''), html);
    }
    if (r === 'real') {
      const now = Date.now();
      if (!real) {
        setText(ref('realChecked'), realLoading ? 'Проверка…' : '—');
      } else {
        setHtml(ref('realServices'), real.services.map((x) => `<li class="svc-item" data-state="${x.state}"><span class="svc-dot" aria-hidden="true"></span><span class="svc-name">${esc(SERVICE_BG[x.key])}</span><span class="svc-st">${x.state === 'ready' ? 'Работи' : x.state === 'not_ready' ? 'Не е готова' : 'Няма връзка'}<small>${esc(x.status)}</small></span></li>`).join(''), html);
        setText(ref('realChecked'), `Проверено в ${timeFmt.format(real.at)} · обновява се на 30 с${realLoading ? ' · проверка…' : ''}`);
        const c = real.catalog;
        setText(ref('realCatalogState'), c.reason);
        ref('realCatalogState').dataset.state = c.state;
        setHtml(ref('realLots'), c.lots.map((l) => {
          const cd = lotCountdown(l, now);
          return `<li class="rlot" data-status="${l.status}"><div class="rlot-top"><span class="rlot-no">${esc(l.lotNumber)}</span><span class="rlot-st">${LOT_STATUS_BG[l.status]}</span></div><b class="rlot-title">${esc(l.title)}</b>${l.subtitle ? `<span class="rlot-sub">${esc(l.subtitle)}</span>` : ''}<div class="rlot-meta"><span>Начална цена: <b>${l.startingPrice === null ? 'не е обявена' : formatEur(l.startingPrice)}</b></span><span>${cd.label}${cd.ms !== null && cd.ms > 0 ? `: <b class="rlot-cd">${formatLong(cd.ms)}</b>` : ''}</span></div></li>`;
        }).join(''), html);
        const rt = real.services.find((x) => x.key === 'realtime')!;
        setText(ref('realBidsText'), rt.state === 'ready'
          ? 'Услугата в реално време на Enchev Auctions отговаря като готова, но лабораторията още не е свързана с нея: нужни са описание на данните в събитията за оферти и достъп само за четене.'
          : rt.state === 'not_ready'
            ? `Няма реални оферти за показване: услугата на Enchev Auctions за оферти и събития в реално време още не е готова (статус: ${rt.status}).`
            : 'Няма връзка с услугата в реално време на Enchev Auctions, затова няма реални оферти за показване.');
      }
    }
    if (r === 'settings') setText(ref('audioInfo'), d.audioInfo);
    if (r === 'settings') setText(ref('realReason'), CONFIG.realMode.enabled ? 'конфигуриран' : `не е свързан. ${CONFIG.realMode.reason}`);

    // Announce new captions; toast bid results.
    const fresh = d.captions.filter((cap) => cap.id > lastCaptionId);
    if (fresh.length) { lastCaptionId = fresh[fresh.length - 1]!.id; announce(fresh); }
    const now = new Map(ctrl.attempts.map((x) => [x.key, x.status] as const));
    for (const x of ctrl.attempts) {
      const before = lastAttemptState.get(x.key);
      if (before === 'pending' && x.status === 'accepted') toast(`Офертата ти ${formatEur(x.amount)} е приета (ДЕМО)`, 'ok');
      if (before === 'pending' && x.status === 'rejected') toast(`Офертата не е приета: ${x.message}`, 'bad');
    }
    lastAttemptState = now;
  }

  let lastSubtitle = 0;
  let subTimer: ReturnType<typeof setTimeout> | undefined;
  ctrl.subscribe(render);
  if (book) officeUi = mountOffice({ book, ctrl, toast, ref });
  else ref('wonCta').hidden = true;
  walletUi = mountWallet({ ctrl, toast, ref });
  applyRoute(false);
}
