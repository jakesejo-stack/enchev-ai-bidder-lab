// The "Къде отиват парите" card (Office and Портфейл).
import { DEST_BG, settlementOf } from '../deal/settlement.js';
import type { DealState } from '../deal/office.js';
import { formatEurExact } from '../domain/money.js';
import { icon } from './icons.js';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function settlementCard(s: DealState, example = false): string {
  const st = settlementOf(s);
  if (!st) return '';
  return `<section class="card st-card" aria-labelledby="st-h">
    <h2 id="st-h">${icon('layers')} Къде отиват парите${example ? ' · пример' : ''}</h2>
    <p class="st-flow"><span>Купувачът плаща <b>${formatEurExact(st.paidByBuyer)}</b></span><span aria-hidden="true">→</span><span>Пул: Revolut Business на компанията <b>${formatEurExact(st.intoPool)}</b></span><span aria-hidden="true">→</span><span>чака одобрение за всяко плащане</span></p>
    <table class="tbl st-tbl"><thead><tr><th scope="col">Към</th><th scope="col">Какво</th><th scope="col">Кога</th><th scope="col" class="num">Сума</th></tr></thead><tbody>
      ${st.lines.map((l) => `<tr data-to="${l.to}"><td>${esc(DEST_BG[l.to])}</td><td>${esc(l.label)}<small>${esc(l.how)}</small></td><td>${esc(l.when)}</td><td class="num">${l.amount < 0 ? '−' : ''}${formatEurExact(Math.abs(l.amount))}</td></tr>`).join('')}
    </tbody><tfoot><tr><th scope="row" colspan="3">Остава за компанията (такси − такса Revolut)</th><td class="num">${formatEurExact(st.companyNet)}</td></tr></tfoot></table>
    <p class="muted small">${st.check ? 'Сумите съвпадат до стотинка с платеното.' : 'ВНИМАНИЕ: сумите не съвпадат.'} Нищо не се превежда автоматично: продавачът получава парите след протокола и проверка (KYB), превозвачът — след доставка, ДДС се плаща с декларацията. ${example ? 'Пример за кола за 25 000 € с доставка до Пловдив.' : ''}</p>
  </section>`;
}
