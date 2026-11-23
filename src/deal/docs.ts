// The buyer's documents, built from the deal log only. Each document is plain data first (so it can be
// hashed and the hash written into the log), then rendered as a printable page. Every amount is shown
// with its formula; every page carries a QR code to the vehicle's passport and its own SHA-256.
import { formatEurExact } from '../domain/money.js';
import { canonical, sha256Hex } from './chain.js';
import { invoiceOf, originCity, type DealState, type DocKind } from './office.js';
import { CARRIAGE_BG } from './transport.js';
import { qrSvg } from './qr.js';

export interface DocData {
  kind: DocKind; title: string; number: string; date: number;
  parties: [string, string][];
  vehicle: [string, string][];
  lines: { label: string; formula: string; amount: string; negative?: boolean }[];
  total: [string, string] | null;
  terms: string[];
}

export const DOC_TITLE: Record<DocKind, string> = {
  confirmation: 'Потвърждение за спечелен търг', proforma: 'Проформа фактура', contract: 'Договор за покупко-продажба',
  invoice: 'Фактура', gatepass: 'Разрешение за вземане (Gate Pass)', protocol: 'Приемо-предавателен протокол',
};
const CODE: Record<DocKind, string> = { confirmation: 'WIN', proforma: 'PRF', contract: 'CTR', invoice: 'INV', gatepass: 'GTP', protocol: 'PRT' };

const dt = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (t: number): string => dt.format(t);

/** Which documents exist at this point of the deal. */
export function availableDocs(s: DealState): DocKind[] {
  const out: DocKind[] = [];
  if (!s.deal) return out;
  out.push('confirmation');
  if (['approved', 'signed', 'paid', 'docs', 'transport', 'delivered', 'completed'].includes(s.phase)) out.push('proforma', 'contract');
  if (s.paid) out.push('invoice');
  if (s.docs.length) out.push('gatepass');
  if (s.receivedAt) out.push('protocol');
  return out;
}

export function buildDoc(kind: DocKind, s: DealState): DocData {
  const d = s.deal!;
  const inv = invoiceOf(s)!;
  const date = kind === 'confirmation' ? d.wonAt : kind === 'invoice' ? (s.paid?.at ?? d.wonAt) : kind === 'protocol' ? (s.receivedAt ?? d.wonAt) : d.wonAt;
  const vehicle: [string, string][] = [['ЛОТ', d.lotId], ['VIN', d.vin], ['Автомобил', d.title], ['Местоположение', d.location], ...d.specs.filter((x) => ['Година', 'Пробег', 'Двигател', 'Цвят'].includes(x.label)).map((x) => [x.label, x.value] as [string, string])];
  const parties: [string, string][] = [['Продавач / търговец', 'ENCHEV Auctions (ДЕМО данни)'], ['Купувач', 'Профил „Ти (демо)“ — данните от регистрацията'], ['Начин на продажба', d.viaSecondChance ? 'Втори шанс след отказ на победителя' : 'Онлайн търг на живо']];
  const money = inv.lines.map((l) => ({ label: l.label, formula: l.formula, amount: formatEurExact(Math.abs(l.amount)), ...(l.negative ? { negative: true } : {}) }));
  const base = { kind, title: DOC_TITLE[kind], number: `${CODE[kind]}-${d.dealId.slice(0, 8).toUpperCase()}`, date, parties, vehicle };
  switch (kind) {
    case 'confirmation':
      return { ...base, lines: [{ label: 'Спечелена оферта', formula: `сървърно време ${fmtDate(d.wonAt)}`, amount: formatEurExact(d.amount) }, { label: 'Депозит (задържан по картата)', formula: '10 % от цената, мин. 300 €', amount: formatEurExact(s.penalty) }],
        total: null, terms: [`Решение в Офиса до ${fmtDate(s.decideBy)}: Одобрявам, Ще помисля, Консултация или Отказвам.`, `Плащане до ${fmtDate(s.payBy)} (3 работни дни, включително деня на търга).`, `При отказ или неплащане депозитът от ${formatEurExact(s.penalty)} се задържа като санкция, а колата се предлага на следващия наддавач.`] };
    case 'proforma':
      return { ...base, lines: money, total: ['Дължимо', formatEurExact(inv.due)], terms: ['ДДС 20 % се начислява върху таксите, не върху цената на колата (кола от ЕС, без мито).', `Плащане по банков път до ${fmtDate(s.payBy)}. Таксите са по тарифата на Copart Испания 2026 като ориентир — ДЕМО.`] };
    case 'contract':
      return { ...base, lines: money, total: ['Цена с такси, без депозита', formatEurExact(inv.due)], terms: [
        'Продавачът прехвърля собствеността след пълно плащане, потвърдено от банката.',
        'Автомобилът се продава във вида, описан в лота и в доклада за състоянието.',
        s.delivery?.mode === 'delivery' && s.delivery.quote ? `Доставка до ${s.delivery.quote.to} с превозвач (${CARRIAGE_BG[s.delivery.quote.carriage]}), проследяване по GPS.` : `Купувачът взима колата от ${originCity(d).name} с Gate Pass.`,
        'Договорът се подписва с квалифициран електронен подпис (Евротръст). ДЕМО — нищо не е подписано реално.'] };
    case 'invoice':
      return { ...base, lines: money, total: ['Платено', formatEurExact(s.paid?.amount ?? 0)], terms: [`Плащане потвърдено от платежния доставчик: ${s.paid?.ref ?? '—'}.`, 'ДЕМО — не е данъчен документ.'] };
    case 'gatepass':
      return { ...base, lines: [], total: null, terms: ['Превозвачът или купувачът показва този документ на площадката. Сканирането на QR кода стартира GPS проследяването.', 'Важи само за посочения VIN.'] };
    case 'protocol':
      return { ...base, lines: [], total: null, terms: ['Купувачът потвърждава, че е получил автомобила във вида от доклада и оригиналните документи.', s.track.deliveredAt ? `Доставен на ${fmtDate(s.track.deliveredAt)}.` : 'Взет от площадката.'] };
  }
}

export function docHash(doc: DocData): Promise<string> { return sha256Hex(canonical(doc)); }

export function passportUrl(vin: string): string {
  return `${location.origin}/#/passport/${encodeURIComponent(vin)}`;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderDoc(doc: DocData, hash: string, vin: string): string {
  const kv = (rows: [string, string][]) => rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  return `<article class="doc" data-doc="${doc.kind}">
    <header class="doc-head">
      <div class="doc-brand"><span class="doc-mark" aria-hidden="true"><i></i><i></i></span><b>ENCHEV</b><small>AUCTIONS</small></div>
      <div class="doc-id"><h2>${esc(doc.title)}</h2><p>№ ${esc(doc.number)} · ${esc(fmtDate(doc.date))}</p></div>
    </header>
    <p class="doc-demo" role="note">ДЕМО — документ от лабораторията, не е реален.</p>
    <p class="doc-summary"><b>${esc(doc.vehicle[2]?.[1] ?? '')}</b> · VIN ${esc(vin)}${doc.total ? ` · ${esc(doc.total[0])}: <b>${esc(doc.total[1])}</b>` : ''}</p>
    <div class="doc-grid"><section><h3>Страни</h3><dl>${kv(doc.parties)}</dl></section><section><h3>Автомобил</h3><dl>${kv(doc.vehicle)}</dl></section></div>
    ${doc.lines.length ? `<table class="doc-lines"><thead><tr><th scope="col">Позиция</th><th scope="col">Как е сметнато</th><th scope="col" class="num">Сума</th></tr></thead><tbody>${doc.lines.map((l) => `<tr${l.negative ? ' class="neg"' : ''}><td>${esc(l.label)}</td><td>${esc(l.formula)}</td><td class="num">${l.negative ? '−' : ''}${esc(l.amount)}</td></tr>`).join('')}</tbody>${doc.total ? `<tfoot><tr><th scope="row" colspan="2">${esc(doc.total[0])}</th><td class="num">${esc(doc.total[1])}</td></tr></tfoot>` : ''}</table>` : ''}
    <ul class="doc-terms">${doc.terms.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <footer class="doc-foot">${qrSvg(passportUrl(vin), `QR код към дигиталния паспорт на ${vin}`)}<p><b>Дигитален паспорт</b> — сканирай за историята на колата.<br><span class="doc-hash">SHA-256: ${esc(hash)}</span></p></footer>
  </article>`;
}
