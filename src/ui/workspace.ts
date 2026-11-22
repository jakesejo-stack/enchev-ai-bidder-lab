// Vehicle Deal Workspace view (#/workspace): one deal per LOT ID + VIN, linked to the live auction,
// AiBidder (hint only) and DAVID. Roles can be switched in DEMO only; in a real system the role comes
// from the signed-in account. Re-renders only when the deal, role, tab or drafts change, so typed
// notes survive the auction's 4×/s ticks; live auction numbers are patched separately.
import type { Controller } from '../app/controller.js';
import type { DealService } from '../deal/service.js';
import { ACTOR_BG, CHECKLIST_TOTAL, DOCS, DOC_BY_TYPE, PHASE_BG, ROLES, STAGES, checklistDone, currentStage, describe, docStatus, invoiceAmount, latest, nextStep, refuse, reviewOf, stageDone, type DocDef, type DocType, type Phase, type Role } from '../deal/model.js';
import { checkVin } from '../deal/vin.js';
import { verifyStoredFile } from '../deal/files.js';
import { formatEur, parseEurInput } from '../domain/money.js';
import { formatCountdown } from '../domain/clock.js';
import { highestBid } from '../domain/rules.js';
import { loadReadOnly, LOT_STATUS_BG, type ReadOnlySnapshot } from '../adapters/enchev-readonly.js';
import { icon } from './icons.js';

type Tab = 'docs' | 'winner' | 'transport' | 'history' | 'official';
const TABS: [Tab, string][] = [['docs', 'Документи'], ['winner', 'WINNER и плащане'], ['transport', 'Транспорт'], ['history', 'История'], ['official', 'Официално']];
const ROLE_LABEL: Record<Role, string> = { seller: 'Продавач', admin: 'Администратор (тест)', buyer: 'Купувач', carrier: 'Превозвач' };
const STATUS_BG = { missing: 'Липсва', pending: 'Чака проверка', approved: 'Одобрен', rejected: 'Отхвърлен' } as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pad = (n: number) => String(n).padStart(2, '0');
/** dd.mm.yyyy, hh:mm:ss (local time) — date AND time on every verification. */
export function stamp(t: number): string {
  const d = new Date(t);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const dur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h} ч ${m} мин` : `${m} мин ${s % 60} с`; };

export interface WorkspaceDeps { ctrl: Controller; deal: DealService; demo: boolean; myBidderId: string; toast: (t: string, tone?: 'ok' | 'bad' | 'info') => void; }

export function mountWorkspace(section: HTMLElement, deps: WorkspaceDeps): { render(): void } {
  const { ctrl, deal } = deps;
  let role: Role = 'seller';
  let tab: Tab = 'docs';
  let src: 'deal' | 'real' = 'deal';
  let busy = false;
  let pendingUpload: { doc: DocType; amount?: number } | null = null;
  let chainMsg = '';
  let filesMsg = '';
  let armedReset = false;
  let real: ReadOnlySnapshot | null = null;
  let realLoading = false;
  const notes: Partial<Record<DocType, string>> = {};
  const vinOk: Partial<Record<DocType, boolean>> = {};
  let amountDraft = '';
  let receipt = { car: false, originals: false };
  let memo = '';

  section.innerHTML = `
    <div class="an-head">
      <h1 id="ws-h">Сделка · Vehicle Deal Workspace</h1>
      <div class="seg" role="radiogroup" aria-label="Източник">
        <button type="button" role="radio" aria-checked="true" data-ws-src="deal">ДЕМО сделка</button>
        <button type="button" role="radio" aria-checked="false" data-ws-src="real">Реални лотове</button>
      </div>
    </div>
    <p class="an-note ws-note" data-ws="note" role="note"></p>
    <div data-ws="body"></div>
    <input type="file" data-ws="file" class="ws-file" tabindex="-1" aria-hidden="true">`;
  const q = <T extends HTMLElement = HTMLElement>(k: string) => section.querySelector<T>(`[data-ws="${k}"]`)!;
  const fileInput = q<HTMLInputElement>('file');

  // ---------------------------------------------------------------- actions
  async function act(fn: () => Promise<{ ok: boolean; message?: string }>, okText: string): Promise<void> {
    if (busy) return;
    busy = true; draw();
    try {
      const r = await fn();
      if (r.ok) deps.toast(okText, 'ok'); else deps.toast(r.message ?? 'Не е позволено.', 'bad');
    } finally { busy = false; draw(); }
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    const p = pendingUpload;
    fileInput.value = '';
    pendingUpload = null;
    if (!f || !p) return;
    void act(() => deal.upload(role, p.doc, f, p.amount), `Качен: ${DOC_BY_TYPE[p.doc].title} (SHA-256 записан)`).then(() => { if (p.doc === 'invoice') amountDraft = ''; draw(); });
  });

  section.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const doc = t.dataset.doc as DocType | undefined;
    if (t.dataset.field === 'note' && doc) notes[doc] = t.value;
    if (t.dataset.field === 'vin' && doc) { vinOk[doc] = t.checked; draw(); }
    if (t.dataset.field === 'amount') amountDraft = t.value;
    if (t.dataset.field === 'car') { receipt = { ...receipt, car: t.checked }; draw(); }
    if (t.dataset.field === 'originals') { receipt = { ...receipt, originals: t.checked }; draw(); }
  });

  section.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button, [data-open]');
    if (!b || (b as HTMLButtonElement).disabled) return;
    const d = b.dataset;
    if (d.wsSrc) { src = d.wsSrc as 'deal' | 'real'; if (src === 'real') loadReal(); draw(); return; }
    if (d.role) { role = d.role as Role; draw(); return; }
    if (d.tab) { tab = d.tab as Tab; draw(); return; }
    const doc = d.doc as DocType | undefined;
    if (d.upload && doc) {
      const def = DOC_BY_TYPE[doc];
      let amount: number | undefined;
      if (def.amount) {
        const c = parseEurInput(amountDraft);
        if (c === null || c <= 0) { deps.toast('Въведи сумата от фактурата в евро.', 'bad'); return; }
        amount = c;
      }
      pendingUpload = { doc, ...(amount !== undefined ? { amount } : {}) };
      fileInput.accept = d.upload === 'camera' ? 'image/*' : 'image/*,application/pdf';
      if (d.upload === 'camera') fileInput.setAttribute('capture', 'environment'); else fileInput.removeAttribute('capture');
      fileInput.click();
      return;
    }
    if (d.review && doc) {
      const decision = d.review as 'approved' | 'rejected';
      const def = DOC_BY_TYPE[doc];
      void act(() => deal.review(doc, decision, notes[doc] ?? '', def.vinCheck ? vinOk[doc] === true : undefined), decision === 'approved' ? `Одобрен: ${def.title}` : `Отхвърлен: ${def.title}`)
        .then(() => { delete notes[doc]; delete vinOk[doc]; draw(); });
      return;
    }
    if (d.open && doc) {
      const f = latest(deal.state.docs[doc]);
      if (f) void deal.files.get(f.fileId).then((blob) => {
        if (!blob) { deps.toast('Файлът не е на това устройство.', 'bad'); return; }
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
      return;
    }
    if (d.transport) { void act(() => deal.transport(d.transport as 'picked_up' | 'in_transit' | 'delivered'), 'Транспортът е обновен'); return; }
    if (d.receipt !== undefined) { void act(() => deal.confirmReceipt(receipt.car, receipt.originals), 'Получаването е потвърдено'); return; }
    if (d.verify === 'chain') {
      void deal.verify().then((c) => { chainMsg = c.ok ? `Веригата е цяла: ${c.count} събития, всеки хеш и всяко право са проверени (${stamp(Date.now())}).` : `ВЕРИГАТА Е НАРУШЕНА при събитие ${c.brokenAt}: ${c.reason}`; draw(); });
      return;
    }
    if (d.verify === 'files') {
      const all = DOCS.flatMap((x) => deal.state.docs[x.type].versions);
      void Promise.all(all.map((m) => verifyStoredFile(deal.files, m))).then((rs) => {
        const okN = rs.filter((r) => r === 'ok').length;
        filesMsg = `${okN} от ${rs.length} файла съвпадат със записания SHA-256${rs.length - okN ? ` · ${rs.filter((r) => r === 'missing').length} липсват на това устройство · ${rs.filter((r) => r === 'changed').length} са променени` : ''}.`;
        draw();
      });
      return;
    }
    if (d.reset !== undefined) {
      if (!armedReset) { armedReset = true; draw(); setTimeout(() => { armedReset = false; draw(); }, 4000); return; }
      armedReset = false;
      void deal.resetDemo().then(() => { chainMsg = ''; filesMsg = ''; deps.toast('Нова ДЕМО сделка', 'info'); draw(); });
    }
  });

  function loadReal(): void {
    if (realLoading || real) return;
    realLoading = true;
    void loadReadOnly().then((s) => { real = s; }).finally(() => { realLoading = false; draw(); });
  }

  // ---------------------------------------------------------------- render pieces
  function uploadReason(def: DocDef): string | null {
    const probe = { fileId: 'probe', name: 'x.pdf', mime: 'application/pdf' as const, size: 1, sha256: '0'.repeat(64), ...(def.amount ? { amount: Number.MAX_SAFE_INTEGER } : {}) };
    return refuse(deal.state, role, { type: 'doc_uploaded', doc: def.type, file: probe })?.message ?? null;
  }

  function docRow(def: DocDef): string {
    const s = deal.state;
    const d = s.docs[def.type];
    const st = docStatus(d);
    const f = latest(d);
    const rv = reviewOf(d);
    let actions = '';
    if (role === def.uploader && st !== 'approved') {
      const why = uploadReason(def);
      if (why) actions = `<p class="ws-why">${esc(why)}</p>`;
      else {
        actions = `${def.amount ? `<label class="ws-amount">Сума по фактурата (€) <input inputmode="decimal" autocomplete="off" data-field="amount" value="${esc(amountDraft)}" placeholder="напр. 42 500"></label>` : ''}
          <div class="ws-btns">${def.camera ? `<button type="button" class="btn sm" data-upload="camera" data-doc="${def.type}">${icon('camera')}<span>Снимай</span></button>` : ''}
          <button type="button" class="btn ghost sm" data-upload="file" data-doc="${def.type}">${icon('upload')}<span>${f ? 'Нова версия' : 'Качи файл'}</span></button></div>`;
      }
    }
    if (role === 'admin' && st === 'pending') {
      const vin = s.key!.vin;
      const needVin = def.vinCheck && vinOk[def.type] !== true;
      actions = `<label class="ws-notel">Бележка <input data-field="note" data-doc="${def.type}" value="${esc(notes[def.type] ?? '')}" placeholder="задължителна при отказ" autocomplete="off"></label>
        ${def.vinCheck ? `<label class="check ws-vin"><input type="checkbox" data-field="vin" data-doc="${def.type}" ${vinOk[def.type] ? 'checked' : ''}> VIN на документа съвпада с <b>${esc(vin)}</b></label>` : ''}
        <div class="ws-btns"><button type="button" class="btn sm ok" data-review="approved" data-doc="${def.type}" ${needVin ? 'disabled' : ''}>${icon('check')}<span>Одобри</span></button>
        <button type="button" class="btn ghost sm" data-review="rejected" data-doc="${def.type}">${icon('close')}<span>Отхвърли</span></button></div>`;
    } else if (role === 'admin' && st === 'missing') {
      actions = `<p class="ws-why">Очаква се: ${esc(ACTOR_BG[def.uploader])}. Администраторът не качва вместо него.</p>`;
    }
    const sub = rv
      ? `${rv.decision === 'approved' ? 'Одобрен' : 'Отхвърлен'} ${stamp(rv.at)} · Администратор${rv.vinMatches ? ' · VIN съвпада' : ''}${rv.note ? ` · „${esc(rv.note)}“` : ''}`
      : f ? `Качен ${stamp(f.at)} · ${esc(ACTOR_BG[f.by])}` : `Качва: ${esc(ACTOR_BG[def.uploader])}`;
    const fileLine = f
      ? `<div class="ws-file-line"><span>${icon('doc')}${esc(f.name)} · ${size(f.size)} · v${d.versions.length}${f.amount ? ` · <b>${formatEur(f.amount)}</b>` : ''}</span><code title="SHA-256 ${f.sha256}">SHA-256 ${f.sha256.slice(0, 12)}…</code><button type="button" class="linkish" data-open="1" data-doc="${def.type}">Отвори</button></div>`
      : '';
    return `<li class="ws-doc" data-doc-row="${def.type}" data-status="${st}"><div class="ws-doc-head"><div><b>${esc(def.title)}</b><small>${esc(def.hint)}</small></div><span class="ws-chip" data-status="${st}">${STATUS_BG[st]}</span></div><p class="ws-sub">${sub}</p>${fileLine}${actions ? `<div class="ws-actions">${actions}</div>` : ''}</li>`;
  }

  function winnerRow(): string {
    const w = deal.state.winner;
    const st = w ? 'approved' : deal.state.noWinner ? 'rejected' : 'missing';
    const label = w ? 'Потвърден' : deal.state.noWinner ? 'Няма WINNER' : 'Очаква края';
    return `<li class="ws-doc" data-doc-row="winner" data-status="${st}"><div class="ws-doc-head"><div><b>Потвърден WINNER</b><small>Записва се само от сървъра на търга — никой бутон не може да го зададе.</small></div><span class="ws-chip" data-status="${st}">${label}</span></div>
      <p class="ws-sub">${w ? `${esc(w.bidderId === deps.myBidderId ? 'Ти (ДЕМО участник)' : w.bidderId)} · ${formatEur(w.amount)} · ${stamp(w.at)}` : 'Източник: сървър на търга'}</p></li>`;
  }

  function docsTab(): string {
    const phases: Phase[] = ['before', 'after', 'release', 'delivery'];
    return phases.map((ph) => `<section class="ws-phase"><h3>${PHASE_BG[ph]}</h3><ul class="ws-docs">${ph === 'after' ? winnerRow() : ''}${DOCS.filter((d) => d.phase === ph).map(docRow).join('')}</ul></section>`).join('');
  }

  function winnerTab(): string {
    const s = deal.state;
    const w = s.winner;
    const inv = invoiceAmount(s);
    const started = s.auctionStartedAt;
    const winBox = w
      ? `<dl class="ws-kv"><div><dt>Победител</dt><dd data-ws="winner">${esc(w.bidderId === deps.myBidderId ? 'Ти (ДЕМО участник)' : w.bidderId)}</dd></div><div><dt>Печеливша оферта</dt><dd><b>${formatEur(w.amount)}</b></dd></div><div><dt>Край на търга</dt><dd>${stamp(w.at)}</dd></div><div><dt>Продължителност</dt><dd>${started !== null ? dur(w.at - started) : '—'}</dd></div><div><dt>Оферти</dt><dd>${w.bids}</dd></div><div><dt>Източник</dt><dd>Сървър на търга${s.key?.demo ? ' (ДЕМО)' : ''} · оферта ${esc(w.bidId)}</dd></div></dl>`
      : `<p>${s.noWinner ? 'Търгът приключи без оферти — няма WINNER.' : 'Очаква се краят на търга. WINNER се записва автоматично от събитието „край“ на сървъра на търга.'}</p><a class="btn ghost sm" href="#/live">${icon('gavel')}<span>Към търга</span></a>`;
    const pay = s.payment
      ? `<p class="ws-paid" data-ws="paid">${icon('check')} Платено: <b>${formatEur(s.payment.amount)}</b> · ${stamp(s.payment.at)} · реф. ${esc(s.payment.reference)} · потвърдено от платежния доставчик${s.key?.demo ? ' (ДЕМО)' : ''}</p>`
      : `<p data-ws="paid">${!w ? 'Очаква WINNER.' : inv === null ? 'Очаква одобрена фактура.' : !latest(s.docs.payment_proof) ? `Очаква плащане от купувача: ${formatEur(inv)} и качено платежно.` : 'Очаква потвърждение от платежния доставчик.'}</p>`;
    return `<div class="ws-grid2">
      <section class="card"><h2>${icon('gavel')} WINNER</h2>${winBox}</section>
      <section class="card"><h2>${icon('doc')} Фактура и плащане</h2>
        <dl class="ws-kv"><div><dt>Фактура</dt><dd>${inv !== null ? `<b>${formatEur(inv)}</b> · одобрена` : STATUS_BG[docStatus(s.docs.invoice)]}</dd></div><div><dt>Платежно (купувач)</dt><dd>${STATUS_BG[docStatus(s.docs.payment_proof)]}</dd></div></dl>
        ${pay}
        <p class="ws-rule">${icon('shield')} Няма бутон „Платено“. Плащането се потвърждава само от платежния доставчик, а сумата трябва да е равна на одобрената фактура.${deps.demo ? ' В ДЕМО доставчикът е симулиран: потвърждава 2–3 с след като фактурата е одобрена и купувачът е качил платежното.' : ''}</p>
      </section>
    </div>
    <p class="muted ws-stats">Статистика на офертите за 30 дни (време, продължителност, ръст на цената) е в <a href="#/dashboard">Табло · Аналитика</a>. Реални оферти се записват там само от потвърдени от сървъра събития.</p>`;
  }

  function transportTab(): string {
    const s = deal.state;
    const steps: ['picked_up' | 'in_transit' | 'delivered', string][] = [['picked_up', 'Взет'], ['in_transit', 'В движение'], ['delivered', 'Доставен']];
    const next = steps.find(([k]) => s.transport[k] === null);
    const why = next && role === 'carrier' ? refuse(s, 'carrier', { type: 'transport', step: next[0] })?.message : null;
    const receiptWhy = refuse(s, 'buyer', { type: 'receipt_confirmed', car: true, originals: true })?.message ?? null;
    return `<div class="ws-grid2">
      <section class="card"><h2>${icon('truck')} Транспорт</h2>
        <ol class="ws-steps">${steps.map(([k, l]) => `<li data-done="${s.transport[k] !== null}"><b>${l}</b><span>${s.transport[k] !== null ? stamp(s.transport[k]!) : '—'}</span></li>`).join('')}</ol>
        ${role === 'carrier' && next ? `<button type="button" class="btn sm" data-transport="${next[0]}" ${why || busy ? 'disabled' : ''}>${icon('truck')}<span>Отбележи „${next[1]}“</span></button>${why ? `<p class="ws-why">${esc(why)}</p>` : ''}` : role !== 'carrier' ? '<p class="muted">Транспортът се отбелязва от превозвача.</p>' : ''}
      </section>
      <section class="card"><h2>${icon('check')} Получаване от купувача</h2>
        ${s.receipt ? `<p class="ws-paid" data-ws="received">${icon('check')} Купувачът потвърди получаването на автомобила и оригиналните документи · ${stamp(s.receipt.at)}</p>` : role === 'buyer' ? `
          <label class="check"><input type="checkbox" data-field="car" ${receipt.car ? 'checked' : ''}> Получих автомобила (VIN ${esc(s.key?.vin ?? '')})</label>
          <label class="check"><input type="checkbox" data-field="originals" ${receipt.originals ? 'checked' : ''}> Получих оригиналните документи</label>
          <button type="button" class="btn sm" data-receipt="1" ${receiptWhy || !receipt.car || !receipt.originals || busy ? 'disabled' : ''}>${icon('check')}<span>Потвърди получаването</span></button>
          ${receiptWhy ? `<p class="ws-why">${esc(receiptWhy)}</p>` : ''}` : '<p class="muted">Потвърждава се от купувача след доставка и одобрен протокол.</p>'}
      </section>
    </div>`;
  }

  function historyTab(): string {
    const ev = deal.log.events.slice().reverse();
    return `<section class="card"><div class="real-head"><h2>${icon('clock')} История · ${deal.log.events.length} събития</h2>
      <div class="ws-btns"><button type="button" class="btn ghost sm" data-verify="chain">${icon('shield')}<span>Провери веригата</span></button><button type="button" class="btn ghost sm" data-verify="files">${icon('doc')}<span>Провери файловете</span></button></div></div>
      ${chainMsg ? `<p class="ws-chain" data-ws="chain" data-ok="${!chainMsg.startsWith('ВЕРИГАТА')}">${esc(chainMsg)}</p>` : ''}${filesMsg ? `<p class="ws-chain" data-ws="files">${esc(filesMsg)}</p>` : ''}
      <ol class="log ws-log">${ev.map((e) => `<li><time>${stamp(e.at)}</time> <b>${esc(ACTOR_BG[e.actor])}</b> · ${esc(describe(e))} <code title="${e.hash}">#${e.seq} ${e.hash.slice(0, 10)}</code></li>`).join('')}</ol>
      <p class="muted">Всяко събитие съдържа хеша на предишното. Промяна, изтриване или събитие от лице без право се откриват при проверка.</p></section>`;
  }

  function officialTab(): string {
    return `<section class="card prose ws-official">
      <h2>${icon('shield')} Кое е реално и кое е ДЕМО</h2>
      <table class="tbl"><thead><tr><th scope="col">Функция</th><th scope="col">Сега</th></tr></thead><tbody>
        <tr><td>Връзка LOT ID + VIN, етапи, права, верига от хешове, SHA-256 на файловете</td><td><b>Работи</b> (логика, тествана)</td></tr>
        <tr><td>WINNER от събитията на сървъра на търга</td><td><b>Работи</b> върху ДЕМО търга; реални оферти от Enchev още няма</td></tr>
        <tr><td>Качване от камера/файл, проверка от администратор с дата и час</td><td>ДЕМО · файловете остават само на това устройство</td></tr>
        <tr><td>Роли (продавач, администратор, купувач, превозвач)</td><td>ДЕМО превключване · реално идват от входа в профила</td></tr>
        <tr><td>Плащане</td><td>ДЕМО симулиран доставчик · реално: подписан webhook от доставчика</td></tr>
        <tr><td>Реални лотове на Enchev Auctions</td><td>Само четене (каталог); VIN не се публикува</td></tr>
        <tr><td>Реално наддаване и реални плащания</td><td><b>Изключени</b></td></tr>
      </tbody></table>
      <h2>Нужно за реална употреба</h2>
      <ul><li>Вход в Enchev Auctions (сесия, роли от сървъра) и проверка на правата при всеки запис.</li><li>Защитено хранилище на сървъра: частен bucket, достъп по сделка, кратки подписани връзки, проверка за вируси.</li><li>Същият дневник от събития на сървъра (append-only), подписан от системата; този екран е само огледало.</li><li>Webhook от платежния доставчик с подпис; сума = одобрената фактура.</li><li>Поток от събития на търга с потвърден край (WINNER) и достъп само за четене.</li></ul>
      <p class="muted">Използвай само примерни документи без лични данни. Тази страница не проверява реална покупка, самоличност или документ.</p>
    </section>`;
  }

  function realBody(): string {
    if (!real) return `<p class="real-state">${realLoading ? 'Зареждане на реалните лотове…' : '—'}</p>`;
    const c = real.catalog;
    return `<section class="card"><h2>${icon('wifi')} Реални лотове · Enchev Auctions (само четене)</h2><p class="real-state" data-state="${c.state}">${esc(c.reason)}</p>
      <ul class="real-lots">${c.lots.map((l) => `<li class="rlot" data-status="${l.status}"><div class="rlot-top"><span class="rlot-no">ЛОТ ${esc(l.lotNumber)}</span><span class="rlot-st">${LOT_STATUS_BG[l.status]}</span></div><b class="rlot-title">${esc(l.title)}</b>${l.subtitle ? `<span class="rlot-sub">${esc(l.subtitle)}</span>` : ''}<div class="rlot-meta"><span>VIN: не е публикуван</span><span>Документи: изисква вход в Enchev Auctions</span></div></li>`).join('')}</ul>
      <p class="muted">Сделка за реален лот се отваря, когато Enchev Auctions даде вход, VIN и защитено хранилище за документи. Дотогава тук нищо не се записва.</p></section>`;
  }

  // ---------------------------------------------------------------- main render
  function draw(): void {
    memo = '';
    render();
  }

  function render(): void {
    if (section.hidden) return;
    patchLive();
    const s = deal.state;
    const sig = `${src}|${role}|${tab}|${busy}|${armedReset}|${s.lastSeq}|${deal.unavailable}|${chainMsg}|${filesMsg}|${real?.at ?? 0}|${realLoading}|${vinOk ? JSON.stringify(vinOk) : ''}|${receipt.car}${receipt.originals}`;
    if (sig === memo) return;
    memo = sig;
    section.querySelectorAll<HTMLElement>('[data-ws-src]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.wsSrc === src)));
    const note = q('note');
    note.dataset.src = src === 'real' ? 'real' : 'demo';
    note.textContent = src === 'real'
      ? 'РЕАЛНИ ДАННИ · само четене от публичния каталог на Enchev Auctions. Тук не се записва нищо.'
      : 'ДЕМО · ЛОКАЛНО ТЕСТОВО СЪСТОЯНИЕ. Търгът, ролите и платежният доставчик са симулирани; файловете остават само на това устройство. Използвай само примерни документи без лични данни.';
    const body = q('body');
    if (src === 'real') { body.innerHTML = realBody(); return; }
    if (!s.key) { body.innerHTML = `<p class="real-state">${esc(deal.unavailable ?? 'Свързване с търга…')}</p>`; return; }
    const stage = currentStage(s);
    const nx = nextStep(s);
    const v = checkVin(s.key.vin);
    const focusRef = (document.activeElement as HTMLElement | null)?.dataset;
    const focusKey = focusRef?.field ? `${focusRef.field}|${focusRef.doc ?? ''}` : null;
    body.innerHTML = `
      <div class="ws-key card">
        <div><span class="ws-k">ЛОТ</span><b data-ws="lot">${esc(s.key.lotId)}</b></div>
        <div><span class="ws-k">VIN</span><b data-ws="vin">${esc(s.key.vin)}</b><small>${v.ok ? (v.checkDigitOk ? 'формат ✓ · контролна цифра ✓' : 'формат ✓ · контролна цифра не е задължителна в ЕС') : 'невалиден'}${s.key.demo ? ' · ДЕМО' : ''}</small></div>
        <div class="ws-key-car"><span class="ws-k">Автомобил</span><b>${esc(s.key.title)}</b></div>
        <div><span class="ws-k">Търг</span><b data-ws="auction">—</b><small data-ws="auctionSub"></small></div>
        <a class="btn ghost sm" href="#/live">${icon('gavel')}<span>Към търга</span></a>
      </div>
      ${s.warnings.map((w) => `<p class="ws-warn" role="note">${icon('warn')} ${esc(w)}</p>`).join('')}
      <div class="ws-ai card" aria-live="polite"><span class="aib-ic sm" aria-hidden="true">${icon('spark')}</span><div><b>AI подсказка</b> <small>(само подсказва — не може да потвърждава нищо)</small><p data-ws="ai">${nx ? `${esc(ACTOR_BG[nx.who])}: ${esc(nx.text)}` : 'Сделката е завършена.'}</p></div></div>
      <ol class="ws-stages" aria-label="Етапи на сделката">${STAGES.map((st, i) => `<li data-done="${stageDone(s, st.key)}" ${stage === i + 1 ? 'aria-current="step"' : ''}><span>${i + 1}</span><b>${esc(st.title)}</b></li>`).join('')}</ol>
      <p class="ws-stage-label" data-ws="stage">${stage > STAGES.length ? 'Всички 8 етапа са завършени' : `Етап ${stage} / ${STAGES.length} · ${esc(STAGES[stage - 1]!.title)}`} · Документи ${checklistDone(s)}/${CHECKLIST_TOTAL}</p>
      <div class="ws-bar">
        <div class="seg ws-roles" role="radiogroup" aria-label="Роля (ДЕМО)">${ROLES.map((r) => `<button type="button" role="radio" aria-checked="${r === role}" data-role="${r}">${ROLE_LABEL[r]}</button>`).join('')}</div>
        <p class="muted ws-role-note">Смяната на роля е само за ДЕМО. В реална система ролята идва от входа в профила.</p>
      </div>
      <div class="seg ws-tabs" role="tablist" aria-label="Сделка">${TABS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === tab}" aria-checked="${k === tab}" data-tab="${k}">${l}${k === 'docs' ? ` (${checklistDone(s)}/${CHECKLIST_TOTAL})` : ''}</button>`).join('')}</div>
      <div class="ws-panel" role="tabpanel">${tab === 'docs' ? docsTab() : tab === 'winner' ? winnerTab() : tab === 'transport' ? transportTab() : tab === 'history' ? historyTab() : officialTab()}</div>
      ${deps.demo ? `<div class="an-demo-tools"><button type="button" class="btn ghost sm" data-reset="1">${armedReset ? 'Натисни пак, за да изчистиш' : 'Нова ДЕМО сделка'}</button></div>` : ''}`;
    if (busy) body.querySelectorAll<HTMLButtonElement>('[data-upload],[data-review]').forEach((b) => { b.disabled = true; });
    if (focusKey) {
      const [field, doc] = focusKey.split('|');
      const el = body.querySelector<HTMLInputElement>(`[data-field="${field}"]${doc ? `[data-doc="${doc}"]` : ''}`);
      if (el) { el.focus(); if (el.type !== 'checkbox') el.setSelectionRange(el.value.length, el.value.length); }
    }
    patchLive();
  }

  /** Live auction numbers (current bid, time) without re-rendering the workspace. */
  function patchLive(): void {
    const a = q('body').querySelector('[data-ws="auction"]');
    const sub = q('body').querySelector('[data-ws="auctionSub"]');
    if (!a || !sub) return;
    const lot = ctrl.auction.lot;
    const top = highestBid(ctrl.auction.bids);
    const t = !lot ? '—' : ctrl.ended ? 'Приключил' : ctrl.auction.status === 'active' ? 'На живо' : 'Предстои';
    const st = `${top ? formatEur(top.amount) : 'няма оферти'}${lot && !ctrl.ended ? ` · остават ${formatCountdown(ctrl.remainingMs)}` : ''}${lot?.demo ? ' · ДЕМО' : ''}`;
    if (a.textContent !== t) a.textContent = t;
    if (sub.textContent !== st) sub.textContent = st;
  }

  deal.subscribe(() => render());
  return { render };
}
