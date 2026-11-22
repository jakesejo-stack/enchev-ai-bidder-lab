import type { Controller } from '../app/controller.js';
import type { DemoAdapter } from '../adapters/demo-adapter.js';
import { APP_HTML } from './layout.js';
import { mountBubble } from './bubble.js';
import { icon } from './icons.js';
import { priceChartSvg, limitGaugeSvg } from './chart.js';
import { formatEur, parseEurInput } from '../domain/money.js';
import { formatCountdown } from '../domain/clock.js';
import { stepFor } from '../domain/rules.js';
import { CONFIG } from '../config.js';
import type { Caption } from '../voice/david.js';

const ROUTES = ['live', 'dashboard', 'ai', 'bids', 'history', 'settings'] as const;
type Route = (typeof ROUTES)[number];
const timeFmt = new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function setText(el: Element, t: string): void { if (el.textContent !== t) el.textContent = t; }
function setHtml(el: Element, h: string, cache: Map<Element, string>): void {
  if (cache.get(el) === h) return;
  cache.set(el, h);
  el.innerHTML = h;
}

export function mountApp(root: HTMLElement, ctrl: Controller, demo: DemoAdapter | null): void {
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
  const bubble = mountBubble(aib, ref('aibPanel'), (open) => { if (open) delete aib.dataset.new; render(); });

  // ------------------------------------------------------------ routing
  function route(): Route {
    const r = location.hash.replace(/^#\/?/, '') as Route;
    return ROUTES.includes(r) ? r : 'live';
  }
  function applyRoute(focus: boolean): void {
    const r = route();
    document.documentElement.dataset.route = r;
    document.querySelectorAll<HTMLElement>('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== r; });
    document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => {
      if (a.dataset.nav === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (focus) document.getElementById('main')?.focus({ preventScroll: false });
    bubble.layout(); // the bid bar shows only on the live view (phones)
    render();
  }
  addEventListener('hashchange', () => applyRoute(true));

  // ------------------------------------------------------------ viewer (lazy)
  const viewerHost = ref('viewer');
  // A missing poster must never show a broken-image icon: hide it and keep the gradient backdrop.
  const poster = viewerHost.querySelector<HTMLImageElement>('.viewer-poster');
  if (poster) {
    const hide = () => { poster.hidden = true; };
    poster.addEventListener('error', hide);
    if (poster.complete && poster.naturalWidth === 0) hide();
  }
  let viewerStarted = false;
  function startViewer(url: string): void {
    if (viewerStarted) return;
    viewerStarted = true;
    import('../viewer/viewer.js').then(({ mountViewer }) => {
      mountViewer(viewerHost, { modelUrl: url, reducedMotion: reduceMotion, maxDpr: matchMedia('(pointer: coarse)').matches ? 1.5 : 1.75 });
    }).catch(() => { viewerHost.dataset.viewer = 'fallback'; });
  }

  // ------------------------------------------------------------ inputs
  const capInput = ref<HTMLInputElement>('cap');
  const capHelp = ref('capHelp');
  const commitCap = () => {
    const raw = capInput.value.trim();
    if (!raw) { ctrl.setCap(null); capInput.removeAttribute('aria-invalid'); setText(capHelp, 'Лимитът е изчистен — AiBidder няма да оценява риска.'); return; }
    const v = parseEurInput(raw);
    if (v === null) { capInput.setAttribute('aria-invalid', 'true'); setText(capHelp, 'Въведи сума в евро, напр. 48 000.'); capHelp.classList.add('show'); return; }
    capInput.removeAttribute('aria-invalid');
    ctrl.setCap(v);
    setText(capHelp, `Лимитът е запазен: ${formatEur(v)}.`);
    capHelp.classList.add('show');
    setTimeout(() => capHelp.classList.remove('show'), 4000);
  };
  capInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitCap(); capInput.blur(); } });
  capInput.addEventListener('change', commitCap);
  capInput.value = ctrl.cap === null ? '' : String(ctrl.cap / 100);

  const rate = ref<HTMLSelectElement>('rate');
  rate.value = String(ctrl.settings.rate);
  rate.addEventListener('change', () => ctrl.setSetting('rate', Number(rate.value)));
  ref('voiceToggle').addEventListener('click', () => {
    ctrl.david.enable(!ctrl.david.enabled);
    if (ctrl.david.enabled) ctrl.david.say('Гласът на DAVID е включен.', 'system', undefined, 'voice_on');
  });
  ref('pause').addEventListener('click', () => { if (ctrl.david.paused) ctrl.david.resume(); else ctrl.david.pause(); });
  ref('mic').addEventListener('click', () => ctrl.mic.toggle());
  ref('cta').addEventListener('click', () => ctrl.openConfirm());
  ref('cta2').addEventListener('click', () => ctrl.openConfirm());
  const speakAdvice = ref<HTMLInputElement>('speakAdvice');
  speakAdvice.checked = ctrl.settings.speakAdvice;
  speakAdvice.addEventListener('change', () => ctrl.setSetting('speakAdvice', speakAdvice.checked));
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

    if (lot && !viewerStarted && lot.modelUrl) startViewer(lot.modelUrl);

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
      setHtml(ref('specs'), lot.specs.map((s, i) => `<li>${icon(['calendar', 'engine', 'bolt', 'road'][i] ?? 'info')}<span><span class="sr-only">${esc(s.label)}: </span>${esc(s.value)}</span></li>`).join('') + '<li class="spec-note">примерни данни</li>', html);
    }
    const step = lot && rules ? stepFor(top ? top.amount : lot.startPrice, rules) : null;
    setText(ref('current'), top ? formatEur(top.amount) : '—');
    setText(ref('currentBy'), top ? (top.bidderId === ctrl.adapter.bidderId ? 'Твоя оферта' : top.bidderId) : 'Няма оферти');
    setText(ref('next'), next !== null ? formatEur(next) : '—');
    setText(ref('stepLine'), step !== null ? `Стъпка ${formatEur(step)}` : '');
    const statusText = ended ? 'ДЕМО · Търгът приключи' : conn !== 'online' ? 'ДЕМО · Няма връзка — наддаването е спряно' : 'ДЕМО · Активен търг · Наддаване в реално време';
    setText(ref('statusText'), statusText);
    ref('statusChip').dataset.state = ended ? 'ended' : conn;

    // Timeline (last 6 bids)
    const last6 = a.bids.slice(-6);
    setHtml(ref('timeline'), last6.map((b, i) => {
      const mine = b.bidderId === ctrl.adapter.bidderId;
      const isLast = i === last6.length - 1;
      return `<li class="${isLast ? 'last' : ''}${mine ? ' mine' : ''}"><span class="tl-dot" aria-hidden="true"></span><span class="tl-amt">${formatEur(b.amount)}</span><span class="tl-time">${timeFmt.format(b.serverTime)}</span><span class="tl-who">${mine ? 'Ти' : esc(b.bidderId)}</span></li>`;
    }).join(''), html);

    // Chart, gauge, signals
    setHtml(ref('chart'), priceChartSvg(a.bids, ctrl.cap, ctrl.adapter.bidderId), html);
    setHtml(ref('gauge'), limitGaugeSvg(adv.limitUse), html);
    setText(ref('gaugePct'), adv.limitUse === null ? '—' : `${Math.round(adv.limitUse * 100)}%`);
    setText(ref('gaugeSub'), adv.limitUse === null || next === null || ctrl.cap === null ? 'Задай лимит, за да видиш колко от него ще използва следващата оферта.' : `Следващата оферта ${formatEur(next)} от лимит ${formatEur(ctrl.cap)}`);
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
    if (document.activeElement !== capInput) {
      const v = ctrl.cap === null ? '' : String(ctrl.cap / 100);
      if (capInput.value.replace(/\s/g, '') !== v) capInput.value = v;
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
    setText(ref('aibNext'), next !== null ? formatEur(next) : '—');
    setText(ref('aibCap'), ctrl.cap === null ? 'не е зададен' : formatEur(ctrl.cap));
    const use = adv.limitUse;
    const bar = ref('aibBar');
    bar.style.width = `${use === null ? 0 : Math.min(100, Math.round(use * 100))}%`;
    bar.classList.toggle('over', use !== null && use > 1);
    setText(ref('aibSub'), ctrl.cap === null || next === null
      ? 'Задай лимит, за да оцени AiBidder риска.'
      : next > ctrl.cap ? `Следващата оферта е над лимита ти с ${formatEur(next - ctrl.cap)}.`
      : `След следващата оферта до лимита остават ${formatEur(ctrl.cap - next)}.`);

    // CTA
    const block = ctrl.blockReason;
    for (const r of ['cta', 'cta2']) {
      const b = ref<HTMLButtonElement>(r);
      b.disabled = !!block;
      b.dataset.state = block ? 'blocked' : 'ready';
      setText(ref(`${r}Label`), block ?? 'НАДДАЙ');
      setText(ref(`${r}Amount`), next !== null && (!block || block === 'НАД ЛИМИТА ТИ') ? `(${formatEur(next)})` : '');
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
      setText(ref('cfCap'), ctrl.cap === null ? 'не е зададен' : `${formatEur(ctrl.cap)} (остават ${formatEur(Math.max(0, ctrl.cap - c.amount))} след тази оферта)`);
      ref('cfMoved').hidden = !c.priceMoved;
      setText(ref('cfMoved'), `Цената се промени. Новата следваща валидна оферта е ${formatEur(c.amount)} — потвърди отново.`);
      consent.checked = c.consent;
      const err = ref('cfError');
      err.hidden = !c.error;
      setText(err, c.error ?? '');
      const submit = ref<HTMLButtonElement>('cfSubmit');
      submit.disabled = !c.consent || c.pending || !!ctrl.blockReason;
      setText(submit, c.pending ? 'Изпращане…' : 'Потвърди наддаване');
      ref<HTMLButtonElement>('cfCancel').disabled = c.pending;
    }

    // Views
    const r = route();
    if (r === 'dashboard') {
      setText(ref('dLot'), lot ? lot.title : '—');
      setText(ref('dPrice'), top ? `Текуща оферта ${formatEur(top.amount)}` : 'Няма оферти');
      setText(ref('dTime'), lot ? (ended ? 'Търгът приключи' : `Остават ${formatCountdown(rem)}`) : '—');
      setText(ref('dPos'), ctrl.leading ? 'Водиш' : top ? 'Не водиш' : '—');
      setText(ref('dMine'), `Приети демо оферти: ${ctrl.attempts.filter((x) => x.status === 'accepted').length}`);
      setText(ref('dVoice'), { off: 'Гласът е изключен', idle: 'Гласът е включен', speaking: 'Говори', paused: 'Гласът е на пауза', unavailable: 'Само надписи' }[vs]);
      setText(ref('dReal'), `РЕАЛЕН — не е свързан. ${CONFIG.realMode.enabled ? '' : CONFIG.realMode.reason}`);
    }
    if (r === 'bids') {
      setHtml(ref('bidsBody'), ctrl.attempts.length ? ctrl.attempts.map((x) => `<tr class="${x.status}"><td>${timeFmt.format(x.at)}</td><td>${formatEur(x.amount)}</td><td>${{ pending: 'Изпраща се', accepted: 'Приета (ДЕМО)', rejected: 'Отказана' }[x.status]}</td><td>${esc(x.message)}</td></tr>`).join('') : '<tr><td colspan="4">Още нямаш оферти.</td></tr>', html);
    }
    if (r === 'history') {
      setHtml(ref('log'), ctrl.log.slice(-200).reverse().map((l) => `<li class="${l.kind}"><time>${timeFmt.format(l.at)}</time> ${esc(l.text)}</li>`).join(''), html);
      setHtml(ref('transcript'), d.captions.slice(-200).reverse().map((c2) => `<li class="${c2.kind}"><time>${timeFmt.format(c2.at)}</time> ${esc(c2.text)}</li>`).join(''), html);
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

  ctrl.subscribe(render);
  applyRoute(false);
}
