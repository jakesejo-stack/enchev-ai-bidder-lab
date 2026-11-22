// Static markup for the app shell (one DOM for desktop and mobile; CSS rearranges it).
// No dynamic data is interpolated here — values are written later with textContent.
import { icon } from './icons.js';

const navItems: [string, string, string][] = [
  ['dashboard', 'home', 'Табло'],
  ['live', 'gavel', 'Търгове на живо'],
  ['ai', 'chip', 'AI наддаване'],
  ['bids', 'layers', 'Моите оферти'],
  ['history', 'clock', 'История'],
  ['settings', 'gear', 'Настройки'],
];
const mobileNav: [string, string, string][] = [
  ['dashboard', 'home', 'Начало'],
  ['live', 'gavel', 'На живо'],
  ['ai', 'chip', 'AI'],
  ['bids', 'layers', 'Оферти'],
];

const demoControls = `
  <div class="demo-buttons">
    <button type="button" class="btn ghost sm" data-demo="burst">Бързи оферти (5)</button>
    <button type="button" class="btn ghost sm" data-demo="outage">Прекъсни връзката (5 с)</button>
    <button type="button" class="btn ghost sm" data-demo="unstable" aria-pressed="false">Нестабилна мрежа</button>
    <button type="button" class="btn ghost sm" data-demo="end">Край след 15 с</button>
    <button type="button" class="btn ghost sm" data-demo="reset">Нов демо търг</button>
  </div>`;

const ctaInner = (ref: string) => `${icon('gavel', 'cta-ic')}<span class="cta-text"><b data-ref="${ref}Label">НАДДАЙ</b><small data-ref="${ref}Amount"></small></span>`;

export const APP_HTML = `
<a class="skip" href="#main">Към съдържанието</a>
<div class="app">
  <header class="topbar">
    <a class="logo" href="#/live" aria-label="ENCHEV Auctions — търгове на живо">
      <span class="logo-mark" aria-hidden="true"><i></i><i></i></span>
      <span class="logo-word"><b>ENCHEV</b><small>AUCTIONS</small></span>
    </a>
    <span class="sep" aria-hidden="true"></span>
    <span class="live-pill" data-ref="livePill"><span class="dot" aria-hidden="true"></span><span data-ref="liveText">НА ЖИВО</span></span>
    <a class="ai-pill" href="#/ai">${icon('spark')}<span>AI НАДДАВАНЕ</span></a>
    <span class="demo-badge" title="Симулиран търг — офертите не са реални">ДЕМО ДАННИ</span>
    <div class="timer" role="timer" aria-label="Оставащо време">
      <span class="timer-label">КРАЙ НА ТЪРГА</span>
      <span class="timer-val" data-ref="timer">--:--</span>
      <span class="timer-units">МИН · СЕК</span>
      <span class="ext" data-ref="ext" hidden>УДЪЛЖЕН</span>
    </div>
    <div class="lotmini">
      <span class="conn" data-ref="conn"><span class="cdot" aria-hidden="true"></span><span data-ref="connText">Свързване…</span></span>
      <span class="lotmini-title" data-ref="lotMini">—</span>
    </div>
  </header>
  <div class="demo-strip" role="note">ДЕМО ДАННИ · симулиран търг в браузъра — офертите НЕ се изпращат към реален търг</div>

  <nav class="sidenav" aria-label="Основна навигация">
    ${navItems.map(([r, i, l]) => `<a href="#/${r}" data-nav="${r}">${icon(i)}<span>${l}</span></a>`).join('')}
  </nav>

  <main id="main" class="main" tabindex="-1">
    <section class="view view-live" data-view="live" aria-labelledby="lot-title">
      <div class="lot-head blk-lot">
        <div class="lot-emblem" aria-hidden="true">E&amp;A</div>
        <div class="lot-meta">
          <p class="lot-no" data-ref="lotNo">ЛОТ —</p>
          <h1 id="lot-title" data-ref="lotTitle">Зареждане…</h1>
          <p class="lot-sub" data-ref="lotSub"></p>
          <ul class="specs" data-ref="specs" aria-label="Примерни характеристики"></ul>
        </div>
      </div>
      <div class="viewer blk-viewer" data-ref="viewer">
        <img class="viewer-poster" src="/media/demo-car-poster.webp" alt="E&amp;A концептуално купе — демонстрационен модел" width="1200" height="640" decoding="async">
        <span class="viewer-hint" aria-hidden="true">Плъзни, за да завъртиш</span>
        <span class="viewer-tag">ДЕМО КОНЦЕПТ · не е реален автомобил</span>
      </div>
      <div class="tiles blk-tiles">
        <div class="tile">
          <span class="tile-label">Текуща оферта</span>
          <span class="tile-val big" data-ref="current">—</span>
          <span class="tile-sub" data-ref="currentBy"></span>
        </div>
        <div class="tile">
          <span class="tile-label">Следваща валидна оферта</span>
          <span class="tile-val" data-ref="next">—</span>
          <span class="tile-sub" data-ref="stepLine"></span>
        </div>
        <div class="status-chip" data-ref="statusChip"><span class="dot" aria-hidden="true"></span><span data-ref="statusText">ДЕМО · Активен търг</span></div>
      </div>
      <section class="card timeline-card blk-timeline" aria-labelledby="tl-h">
        <h2 id="tl-h">История на наддаването</h2>
        <ol class="timeline" data-ref="timeline"></ol>
      </section>
      <div class="row2 blk-charts">
        <details class="card chart-card" open data-ref="chartDetails">
          <summary><h2>${icon('trend')} Динамика на наддаването</h2></summary>
          <div class="chart-wrap" data-ref="chart"></div>
        </details>
        <details class="card ind-card" open data-ref="indDetails">
          <summary><h2>${icon('target')} Лимит и индикатори</h2></summary>
          <div class="ind-grid">
            <div class="gauge-wrap">
              <div data-ref="gauge"></div>
              <div class="gauge-text"><strong data-ref="gaugePct">—</strong><span>ОТ ЛИМИТА ТИ</span></div>
              <p class="gauge-sub" data-ref="gaugeSub"></p>
            </div>
            <ul class="signals" data-ref="signals"></ul>
          </div>
          <p class="prob"><span>Вероятност за успех:</span> <strong data-ref="prob">Няма достатъчно данни</strong>
            <button type="button" class="linkish" data-ref="probWhy" aria-expanded="false" aria-controls="prob-why">Защо?</button></p>
          <p class="prob-why" id="prob-why" data-ref="probWhyText" hidden></p>
        </details>
      </div>
    </section>

    <section class="view" data-view="dashboard" aria-labelledby="dash-h" hidden>
      <h1 id="dash-h">Табло</h1>
      <div class="dash-grid">
        <a class="card dash-card" href="#/live"><h2>Активен демо лот</h2><p class="dash-big" data-ref="dLot">—</p><p data-ref="dPrice">—</p><p data-ref="dTime">—</p><span class="btn sm">Към търга →</span></a>
        <div class="card dash-card"><h2>Твоята позиция</h2><p class="dash-big" data-ref="dPos">—</p><p data-ref="dMine">—</p></div>
        <div class="card dash-card"><h2>DAVID</h2><p class="dash-big" data-ref="dVoice">—</p><p>Надписите са винаги включени.</p></div>
        <div class="card dash-card"><h2>Режим</h2><p class="dash-big">ДЕМО — активен</p><p data-ref="dReal">РЕАЛЕН — не е свързан</p></div>
      </div>
    </section>

    <section class="view" data-view="ai" aria-labelledby="ai-h" hidden>
      <h1 id="ai-h">AI наддаване — как работи DAVID</h1>
      <div class="card prose">
        <p>DAVID използва <b>само</b> данните, които се виждат в търга: подадените оферти, стъпката, оставащото време и <b>твоя лимит</b>. Не оценява пазарна стойност, не измисля участници и не показва „вероятност за успех“ — за това няма валидиран модел.</p>
        <p>DAVID <b>никога не наддава вместо теб</b>. Бутонът „Наддай“ и гласовата команда „наддай“ само отварят потвърждение, в което проверяваш сумата и потвърждаваш ръчно.</p>
        <h2>Текуща оценка</h2>
        <p class="adv-headline" data-ref="aiHead">—</p>
        <ul class="adv-reasons" data-ref="aiReasons"></ul>
        <h2>Наблюдавани сигнали</h2>
        <ul class="signals wide" data-ref="aiSignals"></ul>
        <h2>Гласови команди (където браузърът поддържа)</h2>
        <ul class="cmds"><li>„цена“ — казва текущата и следващата валидна оферта</li><li>„наддай“ — отваря потвърждението (не изпраща оферта)</li><li>„пауза“ / „продължи“ — гласът на DAVID</li></ul>
        <p class="muted">Разпознаването на реч се извършва от услугата на браузъра (напр. в Chrome гласът се обработва от Google). Микрофонът се включва само когато натиснеш бутона.</p>
        <label class="check"><input type="checkbox" data-ref="speakAdvice"> DAVID да изговаря и препоръките (не само събитията)</label>
      </div>
    </section>

    <section class="view" data-view="bids" aria-labelledby="bids-h" hidden>
      <h1 id="bids-h">Моите оферти</h1>
      <p class="muted">Офертите в тази лаборатория са ДЕМО и се обработват от симулиран сървър в браузъра.</p>
      <div class="card"><table class="tbl"><thead><tr><th scope="col">Час</th><th scope="col">Сума</th><th scope="col">Статус</th><th scope="col">Детайли</th></tr></thead><tbody data-ref="bidsBody"></tbody></table></div>
    </section>

    <section class="view" data-view="history" aria-labelledby="hist-h" hidden>
      <h1 id="hist-h">История</h1>
      <div class="hist-grid">
        <div class="card"><h2>Събития в търга</h2><ol class="log" data-ref="log"></ol></div>
        <div class="card"><h2>Транскрипт на DAVID</h2><ol class="log" data-ref="transcript"></ol></div>
      </div>
    </section>

    <section class="view" data-view="settings" aria-labelledby="set-h" hidden>
      <h1 id="set-h">Настройки</h1>
      <div class="card prose">
        <h2>Достъпност</h2>
        <label class="check"><input type="checkbox" data-ref="hc"> Висок контраст</label>
        <p class="muted">Намалено движение следва системната настройка на устройството.</p>
        <h2>Режим на свързване</h2>
        <p><b>ДЕМО</b> — активен. Симулиран сървър в браузъра; нищо не се изпраща по мрежата.</p>
        <p><b>РЕАЛЕН</b> — <span data-ref="realReason">не е свързан</span></p>
        <h2>ДЕМО контроли</h2>
        <p class="muted">За тестване на поведението при натоварване, прекъсване и край на търга.</p>
        ${demoControls}
      </div>
    </section>
  </main>

  <aside class="aside" aria-label="DAVID — AI асистент">
    <section class="card david blk-david" aria-labelledby="david-h">
      <div class="david-head">
        <button type="button" class="mic" data-ref="mic" aria-pressed="false" aria-label="Гласови команди">${icon('mic')}</button>
        <div class="david-title"><h2 id="david-h">DAVID · LIVE AI</h2><p>ТВОЯТ AI АСИСТЕНТ ЗА НАДДАВАНЕ</p></div>
        <span class="vstate" data-ref="vstate">ГЛАС ИЗКЛ.</span>
      </div>
      <div class="wave" data-ref="wave" aria-hidden="true">${Array.from({ length: 48 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
      <blockquote class="quote" data-ref="quote">…</blockquote>
      <p class="voice-note" data-ref="voiceNote" hidden></p>
      <div class="voice-ctrls">
        <button type="button" class="btn ghost sm" data-ref="voiceToggle">${icon('volume')}<span data-ref="voiceToggleLabel">Включи гласа</span></button>
        <label class="rate">Скорост <select data-ref="rate"><option value="0.85">0.85×</option><option value="1">1×</option><option value="1.15">1.15×</option><option value="1.3">1.3×</option></select></label>
      </div>
      <dl class="stats">
        <div><dt>${icon('tag')} Текуща цена</dt><dd data-ref="sCurrent">—</dd></div>
        <div><dt>${icon('trend')} Следваща стъпка</dt><dd data-ref="sStep">—</dd></div>
        <div><dt>${icon('target')} <label for="cap">Твоят лимит</label></dt><dd class="cap-dd"><input id="cap" data-ref="cap" inputmode="numeric" autocomplete="off" enterkeyhint="done" aria-describedby="cap-help"><span aria-hidden="true">€</span></dd></div>
        <div><dt>${icon('clock')} Оставащо време</dt><dd data-ref="sTime">—</dd></div>
        <div><dt>${icon('warn')} Ниво на риск</dt><dd><span class="risk" data-ref="risk">—</span></dd></div>
      </dl>
      <p id="cap-help" class="cap-help" data-ref="capHelp">Максималната сума, която си готов да платиш. Enter или излез от полето, за да запазиш.</p>
    </section>
    <section class="card advice blk-advice" aria-labelledby="adv-h">
      <div class="adv-top"><h2 id="adv-h">${icon('spark')} AI препоръка</h2><span class="prob-pill">ВЕРОЯТНОСТ: НЯМА ДАННИ</span></div>
      <p class="adv-headline" data-ref="advHead">—</p>
      <ul class="adv-reasons" data-ref="advReasons"></ul>
    </section>
    <div class="cta-block blk-cta">
      <button type="button" class="cta" data-ref="cta">${ctaInner('cta')}</button>
      <button type="button" class="btn pausebtn" data-ref="pause">${icon('pause')}<span data-ref="pauseLabel">ПАУЗА НА ГЛАСА</span></button>
    </div>
    <div class="aside-foot blk-foot">
      <p class="footnote">${icon('info')}<span>DAVID анализира само видимите данни от търга и не наддава вместо теб — всяка оферта изисква твое потвърждение. Паузата спира само гласа, не търга.</span></p>
      <details class="demo-ctrls"><summary>ДЕМО контроли</summary>${demoControls}</details>
    </div>
  </aside>

  <div class="bidbar">
    <button type="button" class="cta" data-ref="cta2">${ctaInner('cta2')}</button>
  </div>
  <nav class="bottomnav" aria-label="Навигация">
    ${mobileNav.map(([r, i, l]) => `<a href="#/${r}" data-nav="${r}">${icon(i)}<span>${l}</span></a>`).join('')}
  </nav>
</div>

<dialog class="confirm" data-ref="dialog" aria-labelledby="cf-h">
  <div class="cf-inner">
    <button type="button" class="cf-x" data-ref="cfX" aria-label="Затвори">${icon('close')}</button>
    <h2 id="cf-h">Потвърди офертата</h2>
    <p class="cf-demo">ДЕМО — офертата отива към симулиран сървър в браузъра, не към реален търг.</p>
    <dl class="cf-rows">
      <div><dt>Лот</dt><dd data-ref="cfLot">—</dd></div>
      <div class="cf-amount"><dt>Твоята оферта</dt><dd data-ref="cfAmount">—</dd></div>
      <div><dt>Текуща най-висока</dt><dd data-ref="cfCurrent">—</dd></div>
      <div><dt>Стъпка</dt><dd data-ref="cfStep">—</dd></div>
      <div><dt>Твоят лимит</dt><dd data-ref="cfCap">—</dd></div>
      <div><dt>Такси</dt><dd>Няма данни в демо режим. В реален търг таксите се показват тук преди потвърждение.</dd></div>
    </dl>
    <p class="cf-moved" data-ref="cfMoved" role="status" hidden></p>
    <label class="consent"><input type="checkbox" data-ref="consent"> <span>Потвърждавам оферта от <b data-ref="cfAmount2">—</b>. Разбирам, че в реален търг офертата е обвързваща.</span></label>
    <p class="cf-error" data-ref="cfError" role="alert" hidden></p>
    <div class="cf-actions">
      <button type="button" class="btn ghost" data-ref="cfCancel">Откажи</button>
      <button type="button" class="cta small" data-ref="cfSubmit">Потвърди наддаване</button>
    </div>
  </div>
</dialog>
<div class="sr-only" aria-live="polite" aria-atomic="true" data-ref="livePolite"></div>
<div class="sr-only" aria-live="assertive" aria-atomic="true" data-ref="liveAssert"></div>
<div class="toasts" data-ref="toasts"></div>
`;
