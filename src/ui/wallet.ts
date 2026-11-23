// "Портфейл": Вход (deposit hold through Revolut) and Изход (release / penalty / refund), with a read-only
// ledger read from Revolut. Sandbox until the owner approves real money.
import type { Controller } from '../app/controller.js';
import { bidderId, depositFor, wallet, type LedgerEntry, type WalletStatus } from '../wallet/client.js';
import { formatEurExact, parseEurInput } from '../domain/money.js';
import { icon } from './icons.js';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const dt = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export interface WalletDeps { ctrl: Controller; toast: (t: string, tone?: 'ok' | 'bad' | 'info') => void; ref: (name: string) => HTMLElement; }

export function mountWallet({ ctrl, toast, ref }: WalletDeps) {
  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const session = (() => { try { return window.sessionStorage; } catch { return null; } })();
  const me = bidderId(storage);
  let status: WalletStatus | null = null;
  let statusErr = false;
  let entries: LedgerEntry[] = [];
  let ledgerNote = '';
  let maxBid = 0;
  let busy = false;
  let active = false;

  function envChip(): string {
    if (statusErr || !status) return `<span class="wl-env off">Сървърът на портфейла не отговаря</span>`;
    if (!status.connected) return `<span class="wl-env off">Не е свързан · ${esc(status.reason ?? '')}</span>`;
    return status.realMoney ? `<span class="wl-env live">РЕАЛНИ ПАРИ · Revolut</span>` : `<span class="wl-env sandbox">REVOLUT SANDBOX · тестови пари</span>`;
  }

  function render(): void {
    const lot = ctrl.auction.lot;
    const rules = status?.rules;
    const dep = rules && maxBid > 0 ? depositFor(maxBid, rules) : 0;
    const can = !!status?.connected && !busy && dep > 0 && !!lot;
    const ruleText = rules ? (rules.fixedCents !== null ? `фиксиран тестов депозит ${formatEurExact(rules.fixedCents)}` : `${Math.round(rules.rate * 100)} % от максималната ти оферта, минимум ${formatEurExact(rules.minCents)}`) : '—';
    const opsToken = session?.getItem('enchev-ops-token') ?? '';
    ref('wallet').innerHTML = `
      <div class="of-head"><div><p class="mc-kicker">Портфейл</p><h1 id="wl-h">${icon('wallet')} Вход и изход на парите</h1></div>${envChip()}</div>
      <p class="muted">ENCHEV не пази паричен баланс. Депозитът е <b>задържане по твоята карта</b> в Revolut. Всяко движение по-долу е прочетено от Revolut.</p>
      <div class="of-grid"><div class="of-col">
        <section class="card wl-in" aria-labelledby="wi-h"><h2 id="wi-h">${icon('check')} Вход · депозит за наддаване</h2>
          <p class="muted">Правило: ${esc(ruleText)}. Сумата се изчислява на сървъра.</p>
          <div class="of-form">
            <label>Лот<input type="text" value="${esc(lot?.lotId ?? '—')}" readonly></label>
            <label>Максимална оферта (€)<input type="text" inputmode="decimal" data-wl="max" value="${maxBid ? String(maxBid / 100) : ''}" placeholder="напр. 25 000"></label>
          </div>
          <p class="wl-dep">Депозит: <b>${dep ? formatEurExact(dep) : '—'}</b></p>
          <div class="of-actions"><button type="button" class="btn primary" data-wl="deposit" ${can ? '' : 'disabled'}>${busy ? 'Отваряме Revolut…' : 'Внеси депозит през Revolut'}</button></div>
          <p class="muted small">Отваря се защитената страница на Revolut. Номерът на картата не минава през ENCHEV.</p>
        </section>
        <section class="card wl-out" aria-labelledby="wo-h"><h2 id="wo-h">${icon('road')} Изход · какво става с парите</h2>
          <ul class="wl-rules">
            <li><b>Не спечели или търгът е отменен</b> — задържането се освобождава и парите остават при теб.</li>
            <li><b>Спечели и плати</b> — депозитът се приспада от сметката.</li>
            <li><b>Спечели и се откажа или не плати</b> — от депозита се взима санкцията по правилата.</li>
            <li><b>Плащане към продавача</b> — още не е включено. ${esc(status?.payout.reason ?? '')}</li>
          </ul>
          <p class="muted small">Решенията взима сървърът на търга, не бутон в браузъра. „Върнат“ се показва само след потвърждение от Revolut.</p>
        </section>
      </div><div class="of-col">
        <section class="card wl-ledger" aria-labelledby="wlg-h"><h2 id="wlg-h">${icon('layers')} Движения (от Revolut)</h2>
          ${entries.length ? `<table class="tbl"><thead><tr><th scope="col">Дата</th><th scope="col">Лот</th><th scope="col">Състояние</th><th scope="col" class="num">Сума</th></tr></thead><tbody>${entries.map((e) => `<tr data-state="${esc(e.state)}"><td>${e.createdAt ? esc(dt.format(new Date(e.createdAt))) : '—'}</td><td>${esc(e.lot || '—')}</td><td>${esc(e.label)}</td><td class="num">${formatEurExact(e.amount)}${e.refunded ? `<small> · върнати ${formatEurExact(e.refunded)}</small>` : ''}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${esc(ledgerNote || 'Още няма движения.')}</p>`}
          <div class="of-actions"><button type="button" class="btn ghost sm" data-wl="refresh">Обнови от Revolut</button></div>
          <p class="muted small">Профил: ${esc(me.slice(0, 8))}… (в ENCHEV — твоят акаунт).</p>
        </section>
        <section class="card wl-note"><p>${icon('info')} ДЕМО търговете в тази лаборатория не използват портфейла и нямат пари. Реален търг с депозит е възможен само на сървъра на ENCHEV.</p></section>
        <details class="card of-demo wl-ops"><summary>Оператор (Sandbox тест)</summary>
          <p class="muted">За теста с два профила: освобождаване на депозита на загубилия, санкция или връщане. Изисква операторски ключ.</p>
          <label class="wl-token">Операторски ключ<input type="password" data-wl="token" autocomplete="off" value="${esc(opsToken)}"></label>
          ${entries.filter((e) => e.kind === 'deposit').map((e) => `<div class="wl-op"><span>${esc(e.lot || '—')} · ${formatEurExact(e.amount)} · ${esc(e.label)}</span>
            <button type="button" class="btn ghost sm" data-wl="release" data-id="${esc(e.orderId)}" ${e.state === 'authorised' || e.state === 'pending' ? '' : 'disabled'}>Освободи</button>
            <button type="button" class="btn ghost sm" data-wl="forfeit" data-id="${esc(e.orderId)}" ${e.state === 'authorised' ? '' : 'disabled'}>Санкция</button>
            <button type="button" class="btn ghost sm" data-wl="refund" data-id="${esc(e.orderId)}" ${e.state === 'completed' && e.refunded < e.amount ? '' : 'disabled'}>Върни</button></div>`).join('') || '<p class="muted small">Няма депозити.</p>'}
        </details>
      </div></div>`;
  }

  async function refresh(): Promise<void> {
    const s = await wallet.status();
    statusErr = !s.ok || !s.data;
    status = s.data;
    if (status?.connected) {
      const l = await wallet.ledger(me);
      entries = l.data?.entries ?? [];
      ledgerNote = l.ok ? '' : (l.data?.message ?? 'Revolut не отговори.');
    } else {
      entries = [];
      ledgerNote = 'Портфейлът не е свързан с Revolut.';
    }
    if (active) render();
  }

  document.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset?.wl === 'max') {
      maxBid = parseEurInput(t.value) ?? 0;
      const dep = status?.rules && maxBid ? depositFor(maxBid, status.rules) : 0;
      const out = ref('wallet').querySelector('.wl-dep b');
      if (out) out.textContent = dep ? formatEurExact(dep) : '—';
      const btn = ref('wallet').querySelector<HTMLButtonElement>('[data-wl="deposit"]');
      if (btn) btn.disabled = !(status?.connected && dep > 0 && ctrl.auction.lot && !busy);
    }
    if (t.dataset?.wl === 'token') { try { session?.setItem('enchev-ops-token', t.value); } catch { /* ignore */ } }
  });
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-wl]');
    if (!b || b.disabled || b.tagName !== 'BUTTON') return;
    const act = b.dataset.wl;
    if (act === 'refresh') { void refresh().then(() => toast('Обновено от Revolut.', 'info')); return; }
    if (act === 'deposit') {
      const lot = ctrl.auction.lot;
      if (!lot || !maxBid) return;
      busy = true; render();
      void wallet.deposit(me, lot.lotId, maxBid).then((r) => {
        busy = false;
        if (r.ok && r.data?.checkoutUrl) { location.assign(r.data.checkoutUrl); return; }
        render();
        toast(r.data?.message ?? 'Revolut не прие заявката.', 'bad');
      });
      return;
    }
    if (act === 'release' || act === 'forfeit' || act === 'refund') {
      const token = session?.getItem('enchev-ops-token') ?? '';
      if (!token) { toast('Въведи операторски ключ.', 'bad'); return; }
      void wallet.settle(token, b.dataset.id ?? '', act).then((r) => {
        toast(r.ok ? `Изпратено към Revolut: ${act === 'release' ? 'освобождаване' : act === 'forfeit' ? 'санкция' : 'връщане'}.` : (r.data?.message ?? `Отказано (${r.status}).`), r.ok ? 'ok' : 'bad');
        void refresh();
      });
    }
  });

  return {
    show(on: boolean): void {
      active = on;
      if (on) { render(); void refresh(); }
    },
  };
}
