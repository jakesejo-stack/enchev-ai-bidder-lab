// "Моите коли" → "Офис" → "Дигитален паспорт": everything after the auction, for the winner.
// The UI only records the buyer's own decisions; every other step arrives from the (simulated) party
// that owns it — see src/deal/book.ts.
import type { Controller } from '../app/controller.js';
import type { DealBook, Deal, SecondChanceOffer } from '../deal/book.js';
import { ACTOR_BG, PHASE_BG, STEPS, activeDeadline, invoiceOf, originCity, quoteFor, type DealBody, type DealEvent, type DealState, type DocKind } from '../deal/office.js';
import { DOC_TITLE, availableDocs, buildDoc, docHash, fmtDate, passportUrl, renderDoc } from '../deal/docs.js';
import { CARRIAGE_BG, CITIES, DEMO_TARIFF, type Carriage } from '../deal/transport.js';
import { qrSvg } from '../deal/qr.js';
import { formatEur, formatEurExact } from '../domain/money.js';
import { icon } from './icons.js';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function left(ms: number): string {
  if (ms <= 0) return 'изтече';
  const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
  if (m >= 60) return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
  return `${m}:${String(s).padStart(2, '0')} мин`;
}

function describe(b: DealBody): string {
  switch (b.type) {
    case 'won': return `Спечелена за ${formatEur(b.amount)}${b.viaSecondChance ? ' (втори шанс)' : ''}`;
    case 'deposit_held': return `Задържан депозит ${formatEur(b.amount)} по картата`;
    case 'think': return '„Ще помисля“';
    case 'consult_requested': return 'Поискана консултация';
    case 'consult_extended': return 'Консултантът удължи срока с 24 ч';
    case 'approved': return '„Одобрявам“';
    case 'delivery_chosen': return b.mode === 'pickup' ? 'Избрано: вземане от площадката' : `Избрано: доставка до ${CITIES.find((c) => c.id === b.cityId)?.name ?? b.cityId}`;
    case 'signed': return 'Договорът е подписан с КЕП';
    case 'paid': return `Плащане ${formatEur(b.amount)} потвърдено (${b.ref})`;
    case 'docs_issued': return `Издадени документи: ${b.docs.length}`;
    case 'declined': return b.reason === 'buyer' ? '„Отказвам“' : 'Срокът изтече — отказ';
    case 'penalty_captured': return `Санкция ${formatEur(b.amount)} взета от депозита`;
    case 'passed_on': return b.amount ? `Предложена на ${b.to} за ${formatEur(b.amount)}` : 'Няма следващ наддавач';
    case 'resold': return `${b.to} прие — колата е продадена`;
    case 'relisted': return 'Никой не прие — нов търг';
    case 'picked_up': return 'Превозвачът взе колата';
    case 'gps': return `GPS: ${Math.round(b.progress * 100)} % от пътя`;
    case 'delivered': return 'Доставена';
    case 'received': return 'Протоколът е подписан';
  }
}

export interface OfficeDeps { book: DealBook; ctrl: Controller; toast: (t: string, tone?: 'ok' | 'bad' | 'info') => void; ref: (name: string) => HTMLElement; }

export function mountOffice({ book, ctrl, toast, ref }: OfficeDeps) {
  let route = '';
  let param = '';
  let declining: string | null = null;
  const waiting = new Map<string, 'sign' | 'pay'>();
  const drafts = new Map<string, { mode: 'pickup' | 'delivery'; cityId: string; carriage: Carriage }>();
  const docHashes = new Map<string, Map<DocKind, string>>();
  const overlay = ref('docOverlay');
  const html = new Map<Element, string>();
  /** Open/closed state of the DEMO panels survives re-renders. */
  let demoOpen = false;
  document.addEventListener('toggle', (e) => { const t = e.target as HTMLElement; if (t.classList?.contains('of-demo')) demoOpen = (t as HTMLDetailsElement).open; }, true);
  const put = (el: Element, h: string) => { if (html.get(el) !== h) { html.set(el, h); el.innerHTML = h; } };

  // ------------------------------------------------------------ Моите коли
  function offerCard(o: SecondChanceOffer): string {
    return `<article class="card mc-offer" data-offer="${esc(o.offerId)}">
      <p class="mc-kicker">${icon('spark')} Втори шанс</p>
      <h2>${esc(o.title)}</h2>
      <p>Победителят се отказа. Колата е твоя за последната ти оферта <b>${formatEur(o.amount)}</b>, ако я искаш.</p>
      <p class="muted">Офертата важи още <b data-cd="${o.until}">${left(o.until - book.now())}</b>. Не дължиш нищо, ако откажеш.</p>
      <div class="of-actions"><button type="button" class="btn primary" data-of="offer-accept" data-id="${esc(o.offerId)}">Искам я</button><button type="button" class="btn ghost" data-of="offer-decline" data-id="${esc(o.offerId)}">Не, благодаря</button></div>
    </article>`;
  }

  function dealCard(d: Deal): string {
    const s = d.state, deal = s.deal;
    if (!deal) return `<article class="card mc-card broken"><h2>Повредена сделка</h2><p>${esc(d.check?.reason ?? 'Дневникът не може да бъде проверен.')}</p></article>`;
    const dl = activeDeadline(s);
    return `<article class="card mc-card" data-phase="${s.phase}">
      <div class="mc-top"><span class="mc-emblem" aria-hidden="true">E&amp;A</span><div><h2>${esc(deal.title)}</h2><p class="muted">ЛОТ ${esc(deal.lotId)} · VIN ${esc(deal.vin)}</p></div></div>
      <dl class="mc-facts"><div><dt>Спечелена</dt><dd>${formatEur(deal.amount)}</dd></div><div><dt>Статус</dt><dd class="ph">${esc(PHASE_BG[s.phase])}</dd></div>${dl ? `<div><dt>${esc(dl.label)}</dt><dd data-cd="${dl.at}">${left(dl.at - book.now())}</dd></div>` : ''}</dl>
      <a class="btn primary" href="#/office/${esc(d.id)}">${icon('chip')} Влез в Офиса</a>
    </article>`;
  }

  function renderMyCars(): void {
    const deals = book.list();
    const offers = book.offers.filter((o) => o.status === 'open');
    put(ref('mycars'), `
      <div class="of-head"><h1 id="mc-h">${icon('car')} Моите коли</h1><span class="demo-badge">ДЕМО</span></div>
      <p class="muted">Тук са само колите, които си спечелил. Всяка има свой Офис: решение, документи, плащане и транспорт.</p>
      ${offers.map(offerCard).join('')}
      ${deals.length ? `<div class="mc-grid">${deals.map(dealCard).join('')}</div>` : `<div class="card mc-empty"><p>Още нямаш спечелени коли.</p><p class="muted">Спечели демо търг и колата ще се появи тук автоматично — записва я сървърът на търга, не бутон.</p><a class="btn" href="#/live">${icon('gavel')} Към търга</a></div>`}
      <details class="card of-demo"${demoOpen ? ' open' : ''}><summary>ДЕМО контроли</summary>
        <p class="muted">Симулират страните, които в реалната система са отделни: сървъра на търга и другите купувачи.</p>
        <div class="of-actions">
          <button type="button" class="btn ghost sm" data-of="winner-declined" ${book.youWereRunnerUp ? '' : 'disabled'}>Победителят на последния търг се отказа</button>
          <button type="button" class="btn ghost sm" data-of="clear">Изчисти Моите коли</button>
        </div>
        <p class="muted small">„Победителят се отказа“ е активно, когато последният търг е спечелен от друг, а ти си вторият най-висок наддавач.</p>
      </details>`);
  }

  // ------------------------------------------------------------ Офис
  function stepper(s: DealState): string {
    const cur = STEPS.findIndex((x) => !x.done(s));
    return `<ol class="of-steps" aria-label="Етапи на сделката">${STEPS.map((x, i) => `<li class="${x.done(s) ? 'done' : i === cur && s.phase !== 'declined' ? 'now' : ''}"><span class="of-dot" aria-hidden="true">${x.done(s) ? icon('check') : i + 1}</span><span>${esc(x.label)}</span></li>`).join('')}</ol>`;
  }

  function invoiceTable(s: DealState): string {
    const inv = invoiceOf(s);
    if (!inv) return '';
    return `<table class="tbl of-inv"><thead><tr><th scope="col">Позиция</th><th scope="col">Как е сметнато</th><th scope="col" class="num">Сума</th></tr></thead><tbody>
      ${inv.lines.map((l) => `<tr${l.negative ? ' class="neg"' : ''}><td>${esc(l.label)}</td><td class="muted">${esc(l.formula)}</td><td class="num">${l.negative ? '−' : ''}${formatEurExact(Math.abs(l.amount))}</td></tr>`).join('')}
      </tbody><tfoot><tr><th scope="row" colspan="2">За плащане</th><td class="num" data-ref-due>${formatEurExact(inv.due)}</td></tr></tfoot></table>
      <p class="muted small">ДДС 20 % само върху таксите (кола от ЕС, без мито). Таксите са по тарифата на Copart Испания 2026 като ориентир — ДЕМО.</p>`;
  }

  function deliveryForm(d: Deal): string {
    const s = d.state, deal = s.deal!;
    const from = originCity(deal);
    const dr = drafts.get(d.id) ?? { mode: s.delivery?.mode ?? 'delivery', cityId: s.delivery?.cityId ?? 'plovdiv', carriage: (s.delivery?.quote?.carriage ?? 'truck') as Carriage };
    drafts.set(d.id, dr);
    const q = dr.mode === 'delivery' ? quoteFor(deal, dr.cityId, dr.carriage) : null;
    const saved = s.delivery ? (s.delivery.mode === 'pickup' ? `Запазено: вземане от ${from.name}` : `Запазено: доставка до ${s.delivery.quote?.to} — ${formatEurExact(s.delivery.quote?.total ?? 0)}`) : 'Още не е избрано.';
    return `<section class="card of-delivery" aria-labelledby="dl-h">
      <h2 id="dl-h">${icon('road')} 1. Вземане или доставка</h2>
      <div class="seg" role="radiogroup" aria-label="Начин">
        <button type="button" role="radio" aria-checked="${dr.mode === 'pickup'}" data-df="mode" data-v="pickup">Вземам сам от ${esc(from.name)}</button>
        <button type="button" role="radio" aria-checked="${dr.mode === 'delivery'}" data-df="mode" data-v="delivery">Доставка с превозвач</button>
      </div>
      ${dr.mode === 'delivery' ? `<div class="of-form">
        <label>Град<select data-df="city">${CITIES.filter((c) => c.id !== from.id).map((c) => `<option value="${c.id}"${c.id === dr.cityId ? ' selected' : ''}>${esc(c.name)} (${c.country})</option>`).join('')}</select></label>
        <label>Превоз<select data-df="carriage">${(Object.keys(CARRIAGE_BG) as Carriage[]).map((k) => `<option value="${k}"${k === dr.carriage ? ' selected' : ''}>${esc(CARRIAGE_BG[k])}</option>`).join('')}</select></label>
      </div>
      ${q ? `<table class="tbl of-quote"><tbody>${q.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="muted">${esc(l.formula)}</td><td class="num">${formatEurExact(l.amount)}</td></tr>`).join('')}<tr><td>ДДС 20 %</td><td class="muted">върху транспорта</td><td class="num">${formatEurExact(q.vat)}</td></tr></tbody><tfoot><tr><th scope="row" colspan="2">Транспорт ${esc(q.from)} → ${esc(q.to)}</th><td class="num">${formatEurExact(q.total)}</td></tr></tfoot></table>
      <p class="muted small">Разстоянието е приблизително (по права × 1,25). ${esc(DEMO_TARIFF.source)}.</p>` : ''}` : `<p class="muted">Получаваш Gate Pass с QR. Показваш го на площадката в ${esc(from.name)}.</p>`}
      <div class="of-actions"><button type="button" class="btn" data-of="delivery-save" data-id="${d.id}">Запази избора</button><span class="muted small" data-saved>${esc(saved)}</span></div>
    </section>`;
  }

  function gpsMap(s: DealState): string {
    const deal = s.deal!, from = originCity(deal), to = CITIES.find((c) => c.id === s.delivery?.cityId) ?? from;
    const lats = [from.lat, to.lat], lngs = [from.lng, to.lng];
    const pad = 0.6, x0 = Math.min(...lngs) - pad, x1 = Math.max(...lngs) + pad, y0 = Math.min(...lats) - pad, y1 = Math.max(...lats) + pad;
    const W = 320, H = 170;
    const k = Math.min(W / (x1 - x0), H / (y1 - y0));
    const X = (lng: number) => 10 + (lng - x0) * k, Y = (lat: number) => 10 + (y1 - lat) * k;
    const cur = s.track.lat !== null && s.track.lng !== null ? { lat: s.track.lat, lng: s.track.lng } : { lat: from.lat, lng: from.lng };
    const w = Math.round((x1 - x0) * k + 20), h = Math.round((y1 - y0) * k + 20);
    const eta = s.track.deliveredAt ? 'Доставена' : `${Math.round(s.track.progress * 100)} % от ${s.delivery?.quote?.km ?? 0} км`;
    return `<figure class="of-map"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="GPS: ${esc(from.name)} → ${esc(to.name)}, ${esc(eta)}">
      <line x1="${X(from.lng)}" y1="${Y(from.lat)}" x2="${X(to.lng)}" y2="${Y(to.lat)}" class="route"/>
      <line x1="${X(from.lng)}" y1="${Y(from.lat)}" x2="${X(cur.lng)}" y2="${Y(cur.lat)}" class="done"/>
      <circle cx="${X(from.lng)}" cy="${Y(from.lat)}" r="5" class="city"/><circle cx="${X(to.lng)}" cy="${Y(to.lat)}" r="5" class="city"/>
      <circle cx="${X(cur.lng)}" cy="${Y(cur.lat)}" r="8" class="truck"/>
      <text x="${X(from.lng)}" y="${Y(from.lat) - 10}" text-anchor="middle">${esc(from.name)}</text><text x="${X(to.lng)}" y="${Y(to.lat) + 20}" text-anchor="middle">${esc(to.name)}</text>
    </svg><figcaption><span class="of-bar"><i style="width:${Math.round(s.track.progress * 100)}%"></i></span>${esc(eta)} · ДЕМО проследяване (права линия, не реални GPS данни)</figcaption></figure>`;
  }

  function mainPanel(d: Deal): string {
    const s = d.state, deal = s.deal!, dl = activeDeadline(s);
    const wait = waiting.get(d.id);
    const deposit = s.deposit.status === 'held' ? `Депозит <b>${formatEur(s.deposit.amount)}</b> е задържан по картата (ДЕМО).` : s.deposit.status === 'none' ? 'Задържаме депозита по картата…' : '';
    const declineBox = declining === d.id ? `<div class="of-decline" role="alertdialog" aria-labelledby="dc-h">
        <h3 id="dc-h">${icon('warn')} Сигурен ли си?</h3>
        <p>Ако откажеш, губиш <b>${formatEur(s.penalty)}</b> от депозита (10 % от цената, мин. 300 €). Колата отива при следващия наддавач.</p>
        <label class="check"><input type="checkbox" data-df="decline-consent"> Разбирам, че губя ${formatEur(s.penalty)}.</label>
        <div class="of-actions"><button type="button" class="btn danger" data-of="decline-confirm" data-id="${d.id}" disabled>Да, отказвам</button><button type="button" class="btn ghost" data-of="decline-cancel">Назад</button></div>
      </div>` : '';
    switch (s.phase) {
      case 'decision':
        return `<section class="card of-main" aria-labelledby="om-h">
          <h2 id="om-h">Твоето решение</h2>
          ${dl ? `<p class="of-deadline">${esc(dl.label)}: <b data-cd="${dl.at}">${left(dl.at - book.now())}</b> <span class="muted">(до ${esc(fmtDate(dl.at))})</span></p>` : ''}
          <p class="muted">${deposit} Офертата ти е обвързваща. Бутоните са начин да продължиш или да прекратиш по правилата.</p>
          <div class="of-choices">
            <button type="button" class="of-choice go" data-of="approve" data-id="${d.id}" ${s.deposit.status === 'held' ? '' : 'disabled'}>${icon('check')}<b>Одобрявам</b><small>Продължи към подпис и плащане</small></button>
            <button type="button" class="of-choice" data-of="think" data-id="${d.id}" ${s.thinking ? 'disabled' : ''}>${icon('clock')}<b>Ще помисля</b><small>${s.thinking ? 'Ползвано — напомняме ти преди срока' : 'Веднъж, в рамките на срока'}</small></button>
            <button type="button" class="of-choice" data-of="consult" data-id="${d.id}" ${s.consult !== 'none' ? 'disabled' : ''}>${icon('mic')}<b>Консултация</b><small>${s.consult === 'none' ? 'Обаждане от наш консултант' : s.consult === 'requested' ? 'Консултантът ще ти се обади' : 'Срокът е удължен с 24 ч'}</small></button>
            <button type="button" class="of-choice stop" data-of="decline-ask" data-id="${d.id}">${icon('close')}<b>Отказвам</b><small>Губиш ${formatEur(s.penalty)} от депозита</small></button>
          </div>
          ${declineBox}
          ${s.consult !== 'none' ? `<p class="of-note">${icon('info')} Можеш да пратиш линк само за четене на човек, с когото да се посъветваш: <button type="button" class="linkish" data-of="share" data-id="${d.id}">Копирай линка към паспорта</button></p>` : ''}
        </section>`;
      case 'approved':
        return `${deliveryForm(d)}
          <section class="card of-main" aria-labelledby="sg-h"><h2 id="sg-h">${icon('check')} 2. Подпис на договора</h2>
            <p class="muted">Подписваш с квалифициран електронен подпис в приложението на Евротръст. Срок за плащане: <b data-cd="${s.payBy}">${left(s.payBy - book.now())}</b>.</p>
            <div class="of-actions"><button type="button" class="btn primary" data-of="sign" data-id="${d.id}" ${s.delivery && !wait ? '' : 'disabled'}>${wait === 'sign' ? 'Чака подпис в Евротръст…' : 'Подпиши с КЕП (Евротръст · ДЕМО)'}</button>
            <button type="button" class="btn ghost" data-of="decline-ask" data-id="${d.id}">Отказвам</button></div>
            ${s.delivery ? '' : '<p class="muted small">Първо запази вземане или доставка.</p>'}
            ${declineBox}
          </section>`;
      case 'signed':
        return `<section class="card of-main" aria-labelledby="py-h"><h2 id="py-h">${icon('tag')} 3. Плащане</h2>
          <p>Срок: <b data-cd="${s.payBy}">${left(s.payBy - book.now())}</b> <span class="muted">(до ${esc(fmtDate(s.payBy))})</span></p>
          ${invoiceTable(s)}
          <div class="of-actions"><button type="button" class="btn primary" data-of="pay" data-id="${d.id}" ${wait === 'pay' ? 'disabled' : ''}>${wait === 'pay' ? 'Чака потвърждение от банката…' : `Плати ${formatEurExact(invoiceOf(s)?.due ?? 0)} (ДЕМО · Revolut)`}</button>
          <button type="button" class="btn ghost" data-of="decline-ask" data-id="${d.id}">Отказвам</button></div>
          <p class="muted small">„Платено“ се появява само когато банката потвърди сумата от фактурата. За колата препоръчваме SEPA превод; картата е за депозита и таксите.</p>
          ${declineBox}
        </section>`;
      case 'paid':
        return `<section class="card of-main"><h2>${icon('check')} Плащането е потвърдено</h2><p class="muted">Издаваме документите и паспорта…</p></section>`;
      case 'docs':
        return s.delivery?.mode === 'pickup'
          ? `<section class="card of-main"><h2>${icon('road')} 4. Вземане</h2><p>Покажи Gate Pass на площадката в ${esc(originCity(deal).name)}. Провери колата и документите, после подпиши протокола.</p>${protocolBox(d)}</section>`
          : `<section class="card of-main"><h2>${icon('road')} 4. Транспорт</h2><p class="muted">Превозвачът идва за колата. Щом сканира Gate Pass, започва GPS проследяването.</p></section>`;
      case 'transport':
        return `<section class="card of-main"><h2>${icon('road')} 4. В транспорт</h2>${gpsMap(s)}</section>`;
      case 'delivered':
        return `<section class="card of-main"><h2>${icon('check')} 5. Доставена</h2>${gpsMap(s)}${protocolBox(d)}</section>`;
      case 'completed':
        return `<section class="card of-main of-done"><h2>${icon('check')} Колата е твоя</h2><p>Протоколът е подписан на ${esc(fmtDate(s.receivedAt!))}. Всичко за колата е в дигиталния ѝ паспорт.</p><a class="btn primary" href="#/passport/${encodeURIComponent(deal.vin)}">Отвори паспорта</a></section>`;
      case 'declined': {
        const sc = s.secondChance;
        return `<section class="card of-main of-declined"><h2>${icon('close')} ${s.declined?.reason === 'expired' ? 'Срокът изтече — сделката е прекратена' : 'Отказа се'}</h2>
          <p>Санкция: <b>${formatEur(s.penalty)}</b> — ${s.deposit.status === 'captured' ? 'взета от депозита' : 'взима се от депозита…'}.</p>
          <p>${!sc ? 'Предлагаме колата на следващия наддавач…' : sc.amount === 0 ? 'Нямаше следващ наддавач.' : `Предложена на ${esc(sc.to)} за ${formatEur(sc.amount)} — ${sc.result === 'pending' ? 'чакаме отговор (24 ч)' : sc.result === 'resold' ? 'прие, колата е продадена' : 'отказа'}.`}${sc?.result === 'relisted' ? ' Колата отива в нов търг.' : ''}</p>
          <p class="muted small">В реалната система вторият шанс минава до 3 кръга, преди нов търг.</p></section>`;
      }
      default: return '';
    }
  }

  function protocolBox(d: Deal): string {
    return `<div class="of-protocol"><label class="check"><input type="checkbox" data-df="car-ok"> Колата отговаря на описанието и доклада</label>
      <label class="check"><input type="checkbox" data-df="docs-ok"> Получих оригиналните документи</label>
      <button type="button" class="btn primary" data-of="received" data-id="${d.id}" disabled>Подпиши протокола</button></div>`;
  }

  function sidePanel(d: Deal): string {
    const s = d.state, deal = s.deal!;
    const docs = availableDocs(s);
    const issued = new Map(s.docs.map((x) => [x.kind, x.hash] as const));
    return `<section class="card of-docs" aria-labelledby="od-h"><h2 id="od-h">${icon('layers')} Документи</h2>
        <ul class="of-doclist">${docs.map((k) => `<li><button type="button" class="linkish" data-of="doc" data-id="${d.id}" data-kind="${k}">${esc(DOC_TITLE[k])}</button>${issued.has(k) ? '<span class="ok-badge">издаден</span>' : ''}</li>`).join('')}</ul>
      </section>
      <section class="card of-pass" aria-labelledby="op-h"><h2 id="op-h">Дигитален паспорт</h2>
        <a class="of-qr" href="#/passport/${encodeURIComponent(deal.vin)}">${qrSvg(passportUrl(deal.vin), `QR код към паспорта на ${deal.vin}`)}</a>
        <p class="muted small">VIN ${esc(deal.vin)}. QR кодът отваря историята на колата: публична част за всеки и пълна сметка само за теб.</p>
      </section>
      <section class="card of-log" aria-labelledby="ol-h"><h2 id="ol-h">${icon('clock')} Дневник</h2>
        <ol class="of-events">${d.events.slice().reverse().map((e: DealEvent) => `<li><time>${esc(fmtDate(e.at))}</time><span>${esc(describe(e.body))}</span><small>${esc(ACTOR_BG[e.actor])} · #${e.seq} · ${e.hash.slice(0, 10)}</small></li>`).join('')}</ol>
        <div class="of-actions"><button type="button" class="btn ghost sm" data-of="verify" data-id="${d.id}">Провери веригата и документите</button></div>
        <p class="muted small" data-verify-out>${d.check ? (d.check.ok ? `Веригата е цяла: ${d.check.count} събития.` : `Повредена при #${d.check.brokenAt}: ${esc(d.check.reason ?? '')}`) : ''}</p>
      </section>`;
  }

  function renderOfficeView(): void {
    const d = book.get(param);
    const host = ref('office');
    if (!d || !d.state.deal) {
      put(host, `<div class="card mc-empty"><h1 id="of-h">Офис</h1><p>Тази сделка не е намерена на това устройство.</p><a class="btn" href="#/mycars">${icon('car')} Моите коли</a></div>`);
      return;
    }
    const s = d.state, deal = s.deal!;
    const dl = activeDeadline(s);
    put(host, `
      <a class="back" href="#/mycars">← Моите коли</a>
      <div class="of-head"><div><p class="mc-kicker">Офис · ЛОТ ${esc(deal.lotId)}</p><h1 id="of-h">${esc(deal.title)}</h1><p class="muted">VIN ${esc(deal.vin)} · спечелена за <b>${formatEur(deal.amount)}</b> на ${esc(fmtDate(deal.wonAt))}${deal.viaSecondChance ? ' · втори шанс' : ''}</p></div><span class="of-phase" data-phase="${s.phase}">${esc(PHASE_BG[s.phase])}</span></div>
      ${stepper(s)}
      <div class="of-grid"><div class="of-col">${mainPanel(d)}</div><div class="of-col">${sidePanel(d)}</div></div>
      <details class="card of-demo"${demoOpen ? ' open' : ''}><summary>ДЕМО контроли</summary>
        <p class="muted">Платежният доставчик, Евротръст, консултантът и превозвачът са симулирани в браузъра. В реалната система техните събития идват от тях.</p>
        <div class="of-actions"><button type="button" class="btn ghost sm" data-of="expire" data-id="${d.id}" ${dl ? '' : 'disabled'}>Превърти до края на срока</button></div>
      </details>`);
  }

  // ------------------------------------------------------------ Паспорт
  function renderPassport(): void {
    const vin = decodeURIComponent(param);
    const d = book.byVin(vin);
    const host = ref('passport');
    if (!d || !d.state.deal) {
      put(host, `<div class="card mc-empty"><h1 id="pp-h">Дигитален паспорт</h1><p>Няма паспорт за VIN ${esc(vin)} на това устройство.</p><p class="muted">В ДЕМО паспортите се пазят в браузъра, в който е спечелена колата.</p></div>`);
      return;
    }
    const s = d.state, deal = s.deal!;
    const specs = deal.specs.filter((x) => x.label !== 'VIN');
    put(host, `
      <div class="of-head"><div><p class="mc-kicker">Дигитален паспорт · ДЕМО</p><h1 id="pp-h">${esc(deal.title)}</h1><p class="muted">VIN <b>${esc(deal.vin)}</b></p></div></div>
      <div class="of-grid"><div class="of-col">
        <section class="card"><h2>Публична част</h2>
          <dl class="pp-specs">${specs.map((x) => `<div><dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd></div>`).join('')}</dl>
          <p>Продадена на онлайн търг ENCHEV (ДЕМО) на ${esc(fmtDate(deal.wonAt))}.</p>
          <p class="muted small">${d.check?.ok === false ? 'Дневникът е повреден.' : `Историята е записана във верига от ${d.events.length} събития с SHA-256.`}</p>
        </section>
        <section class="card"><h2>Само за купувача</h2>
          <p>Статус: <b>${esc(PHASE_BG[s.phase])}</b></p>
          ${s.paid ? `<p>Платено: <b>${formatEurExact(s.paid.amount)}</b> на ${esc(fmtDate(s.paid.at))} (${esc(s.paid.ref)}).</p>` : ''}
          ${s.delivery?.quote ? `<p>Транспорт: ${esc(s.delivery.quote.from)} → ${esc(s.delivery.quote.to)}, ${s.delivery.quote.km} км.</p>` : ''}
          ${s.phase === 'transport' || s.phase === 'delivered' ? gpsMap(s) : ''}
          <ul class="of-doclist">${s.docs.map((x) => `<li>${esc(DOC_TITLE[x.kind])} <small class="doc-hash">SHA-256 ${x.hash.slice(0, 16)}…</small></li>`).join('')}</ul>
          <a class="btn" href="#/office/${d.id}">${icon('chip')} Към Офиса</a>
        </section>
      </div><div class="of-col">
        <section class="card pp-qr">${qrSvg(passportUrl(deal.vin), `QR код към паспорта на ${deal.vin}`)}<p class="muted small">Сканирай, за да отвориш този паспорт. В реалната система линкът носи подпис от сървъра.</p></section>
      </div></div>`);
  }

  // ------------------------------------------------------------ documents overlay
  async function openDoc(id: string, kind: DocKind): Promise<void> {
    const d = book.get(id);
    if (!d?.state.deal) return;
    const doc = buildDoc(kind, d.state);
    const hash = await docHash(doc);
    const issued = d.state.docs.find((x) => x.kind === kind)?.hash;
    ref('docBody').innerHTML = renderDoc(doc, hash, d.state.deal.vin) + (issued ? `<p class="doc-check ${issued === hash ? 'ok' : 'bad'}">${issued === hash ? 'Съвпада с отпечатъка в дневника.' : 'НЕ съвпада с отпечатъка в дневника!'}</p>` : '');
    overlay.hidden = false;
    document.documentElement.classList.add('doc-open');
    overlay.querySelector<HTMLButtonElement>('[data-doc-close]')?.focus();
  }
  function closeDoc(): void { overlay.hidden = true; document.documentElement.classList.remove('doc-open'); }
  overlay.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t === overlay || t.closest('[data-doc-close]')) closeDoc();
    if (t.closest('[data-doc-print]')) window.print();
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeDoc(); });

  // ------------------------------------------------------------ actions
  const done = (r: string | null, ok?: string) => { if (r) toast(r, 'bad'); else if (ok) toast(ok, 'ok'); };
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-of]');
    if (!b || (b as HTMLButtonElement).disabled) return;
    const id = b.dataset.id ?? '';
    switch (b.dataset.of) {
      case 'approve': void book.approve(id).then((r) => done(r, 'Одобрено. Избери вземане или доставка и подпиши договора.')); break;
      case 'think': void book.think(id).then((r) => done(r, 'Добре. Ще ти напомним преди срока.')); break;
      case 'consult': void book.consult(id).then((r) => done(r, 'Консултантът ще ти се обади (ДЕМО).')); break;
      case 'decline-ask': declining = id; render(); break;
      case 'decline-cancel': declining = null; render(); break;
      case 'decline-confirm': declining = null; void book.decline(id).then((r) => done(r, 'Отказа се. Колата отива при следващия наддавач.')); break;
      case 'delivery-save': {
        const dr = drafts.get(id);
        if (!dr) break;
        void (dr.mode === 'pickup' ? book.choosePickup(id) : book.chooseDelivery(id, dr.cityId, dr.carriage)).then((r) => done(r, 'Изборът е запазен.'));
        break;
      }
      case 'sign': void book.requestSignature(id).then((r) => { if (r) toast(r, 'bad'); else { waiting.set(id, 'sign'); toast('Отвори приложението Евротръст и подпиши (ДЕМО — подписва се само).', 'info'); render(); } }); break;
      case 'pay': {
        const due = invoiceOf(book.get(id)!.state)?.due ?? 0;
        const r = book.requestPayment(id, due);
        if (r) toast(r, 'bad'); else { waiting.set(id, 'pay'); toast('ДЕМО плащане изпратено. Чакаме потвърждение от банката.', 'info'); render(); }
        break;
      }
      case 'received': void book.confirmReceived(id).then((r) => done(r, 'Протоколът е подписан. Колата е твоя.')); break;
      case 'verify': void (async () => {
        const c = await book.verify(id);
        const d = book.get(id);
        let docsOk = true;
        for (const x of d?.state.docs ?? []) if ((await docHash(buildDoc(x.kind, d!.state))) !== x.hash) docsOk = false;
        toast(c?.ok ? `Веригата е цяла (${c.count} събития). Документите ${docsOk ? 'съвпадат' : 'НЕ съвпадат'} с отпечатъците.` : `Веригата е повредена: ${c?.reason ?? ''}`, c?.ok && docsOk ? 'ok' : 'bad');
      })(); break;
      case 'doc': void openDoc(id, b.dataset.kind as DocKind); break;
      case 'expire': book.demoExpire(id); toast('ДЕМО: часовникът на Офиса е преместен след срока.', 'info'); break;
      case 'share': {
        const deal = book.get(id)?.state.deal;
        if (deal) void navigator.clipboard?.writeText(passportUrl(deal.vin)).then(() => toast('Линкът е копиран.', 'ok'), () => toast(passportUrl(deal.vin), 'info'));
        break;
      }
      case 'offer-accept': void book.answerOffer(id, true).then((d) => { if (d) { toast('Колата е твоя чрез втори шанс. Влез в Офиса.', 'ok'); location.hash = `#/office/${d.id}`; } }); break;
      case 'offer-decline': void book.answerOffer(id, false).then(() => toast('Отказа офертата. Не дължиш нищо.', 'info')); break;
      case 'winner-declined': if (!book.demoWinnerDeclined()) toast('Няма търг, в който си вторият наддавач.', 'bad'); break;
      case 'clear': book.clear(); toast('ДЕМО: Моите коли са изчистени.'); break;
    }
  });
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-df="mode"]');
    if (!b) return;
    const id = param, dr = drafts.get(id);
    if (dr) { dr.mode = b.dataset.v === 'pickup' ? 'pickup' : 'delivery'; render(); }
  });
  document.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const kind = t.dataset?.df;
    if (!kind) return;
    const dr = drafts.get(param);
    if (kind === 'city' && dr) { dr.cityId = t.value; render(); }
    if (kind === 'carriage' && dr) { dr.carriage = t.value as Carriage; render(); }
    if (kind === 'decline-consent') { const btn = t.closest('.of-decline')?.querySelector<HTMLButtonElement>('[data-of="decline-confirm"]'); if (btn) btn.disabled = !(t as HTMLInputElement).checked; }
    if (kind === 'car-ok' || kind === 'docs-ok') {
      const box = t.closest('.of-protocol');
      const all = [...(box?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? [])].every((x) => x.checked);
      const btn = box?.querySelector<HTMLButtonElement>('[data-of="received"]');
      if (btn) btn.disabled = !all;
    }
  });

  // ------------------------------------------------------------ render + countdowns
  function render(): void {
    for (const [id, w] of waiting) {
      const p = book.get(id)?.state.phase;
      if ((w === 'sign' && p !== 'approved') || (w === 'pay' && p !== 'signed')) waiting.delete(id);
    }
    if (route === 'mycars') renderMyCars();
    else if (route === 'office') renderOfficeView();
    else if (route === 'passport') renderPassport();
    renderWon();
  }
  function tick(): void {
    document.querySelectorAll<HTMLElement>('[data-cd]').forEach((el) => {
      const t = left(Number(el.dataset.cd) - book.now());
      if (el.textContent !== t) el.textContent = t;
    });
  }
  /** On the live view: after a win, the way into the Office. */
  function renderWon(): void {
    const cta = ref('wonCta') as HTMLAnchorElement;
    const latest = book.list()[0];
    const show = ctrl.ended && ctrl.leading && !!latest?.state.deal && latest.state.deal.lotId === ctrl.auction.lot?.lotId;
    cta.hidden = !show;
    if (show) cta.href = `#/office/${latest!.id}`;
  }
  book.subscribe(render);
  ctrl.subscribe(renderWon);
  setInterval(tick, 1000);

  return {
    show(r: string, p: string): void {
      if (r !== route || p !== param) { declining = null; html.clear(); }
      route = r;
      param = p;
      render();
    },
  };
}
