// Static markup for the app shell (one DOM for desktop and mobile; CSS rearranges it).
// No dynamic data is interpolated here — values are written later with textContent.
import { icon } from './icons.js';

const navItems: [string, string, string][] = [
  ['dashboard', 'home', 'Табло'],
  ['live', 'gavel', 'Търгове на живо'],
  ['ai', 'chip', 'AI наддаване'],
  ['bids', 'layers', 'Моите оферти'],
  ['history', 'clock', 'История'],
  ['real', 'wifi', 'Реални данни'],
  ['settings', 'gear', 'Настройки'],
];
const mobileNav: [string, string, string][] = [
  ['dashboard', 'home', 'Начало'],
  ['live', 'gavel', 'На живо'],
  ['ai', 'chip', 'AI'],
  ['bids', 'layers', 'Оферти'],
  ['real', 'wifi', 'Реални'],
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
          <p class="lot-retail" data-ref="lotRetail" hidden></p>
        </div>
      </div>
      <div class="viewer blk-viewer" data-ref="viewer">
        <div class="viewer-stage" aria-hidden="true"><i class="rig"></i><i class="ls w1"></i><i class="ls w2"></i><i class="ls r1"></i><i class="ls r2"></i><i class="ls r3"></i></div>
        <img class="viewer-poster" src="/media/demo-car-poster.webp" alt="E&amp;A концептуално купе — демонстрационен модел" width="1200" height="640" decoding="async">
        <span class="viewer-hint" aria-hidden="true">Плъзни, за да завъртиш</span>
        <span class="viewer-tag">ДЕМО КОНЦЕПТ · не е реален автомобил</span>
        <span class="viewer-none">Няма снимки и 3D модел за този ДЕМО лот</span>
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
      <details class="card chart-card blk-charts" open data-ref="chartDetails">
        <summary><h2>${icon('trend')} Динамика на наддаването</h2></summary>
        <div class="chart-wrap" data-ref="chart"></div>
      </details>
    </section>

    <section class="view" data-view="dashboard" aria-labelledby="dash-h" hidden>
      <div class="an-head">
        <h1 id="dash-h">Табло · Аналитика</h1>
        <div class="seg an-src" role="radiogroup" aria-label="Източник на данните">
          <button type="button" role="radio" aria-checked="true" data-src="demo">ДЕМО</button>
          <button type="button" role="radio" aria-checked="false" data-src="real">РЕАЛНИ</button>
        </div>
      </div>
      <p class="an-note" data-ref="anNote" role="note">—</p>
      <div class="an-filters">
        <div class="seg an-range" role="radiogroup" aria-label="Период">
          <button type="button" role="radio" aria-checked="true" data-range="live"><span class="an-live-dot" aria-hidden="true"></span>LIVE</button>
          <button type="button" role="radio" aria-checked="false" data-range="24h">24Ч</button>
          <button type="button" role="radio" aria-checked="false" data-range="7d">7Д</button>
          <button type="button" role="radio" aria-checked="false" data-range="30d">30Д</button>
          <button type="button" role="radio" aria-checked="false" data-range="custom">Период</button>
        </div>
        <div class="an-dates" data-ref="anDates" hidden>
          <label>От <input type="date" data-ref="anFrom"></label>
          <label>До <input type="date" data-ref="anTo"></label>
        </div>
        <div class="an-actions">
          <button type="button" class="btn ghost sm" data-ref="anCsvAuctions">${icon('layers')}<span>CSV търгове</span></button>
          <button type="button" class="btn ghost sm" data-ref="anCsvBids">${icon('trend')}<span>CSV оферти</span></button>
        </div>
      </div>
      <p class="an-range-label" data-ref="anRangeLabel" aria-live="polite">—</p>
      <div class="an-kpis" data-ref="anKpis"></div>
      <div class="an-charts">
        <section class="card"><h2>${icon('gavel')} <span data-ref="anActTitle">Активност на наддаването</span></h2><div class="chart-wrap" data-ref="anActivity"></div></section>
        <section class="card"><h2>${icon('trend')} <span data-ref="anPriceTitle">Ръст на цената</span></h2><div class="chart-wrap" data-ref="anPrice"></div></section>
      </div>
      <section class="card an-table-card" aria-labelledby="an-t-h">
        <h2 id="an-t-h">${icon('clock')} Приключили търгове</h2>
        <div class="an-table-wrap">
          <table class="tbl an-table">
            <thead><tr><th scope="col">Край</th><th scope="col">Лот</th><th scope="col">Продължителност</th><th scope="col">Оферти</th><th scope="col">Участници</th><th scope="col">Удължавания</th><th scope="col">Крайна цена</th><th scope="col">Ръст</th><th scope="col">Източник</th></tr></thead>
            <tbody data-ref="anRows"></tbody>
          </table>
        </div>
      </section>
      <div class="an-demo-tools" data-ref="anDemoTools">
        <button type="button" class="btn ghost sm" data-ref="anGen">Попълни примерна ДЕМО история (30 дни)</button>
        <button type="button" class="btn ghost sm" data-ref="anClear">Изчисти ДЕМО историята</button>
      </div>
      <h2 class="an-sub">Текущо състояние</h2>
      <div class="dash-grid">
        <a class="card dash-card" href="#/live"><h2>Активен демо лот</h2><p class="dash-big" data-ref="dLot">—</p><p data-ref="dPrice">—</p><p data-ref="dTime">—</p><span class="btn sm">Към търга →</span></a>
        <div class="card dash-card"><h2>Твоята позиция</h2><p class="dash-big" data-ref="dPos">—</p><p data-ref="dMine">—</p></div>
        <div class="card dash-card"><h2>DAVID</h2><p class="dash-big" data-ref="dVoice">—</p><p>Надписите са винаги включени.</p></div>
        <a class="card dash-card" href="#/real"><h2>Режим</h2><p class="dash-big">ДЕМО — активен</p><p data-ref="dReal">РЕАЛНИ ДАННИ — само четене</p><span class="btn sm">Реални данни →</span></a>
      </div>
    </section>

    <section class="view" data-view="real" aria-labelledby="real-h" hidden>
      <h1 id="real-h">Реални данни · Enchev Auctions</h1>
      <p class="real-note" role="note"><b>САМО ЧЕТЕНЕ.</b> Данните идват от публичните услуги на Enchev Auctions. Реалното наддаване е изключено, докато не бъде изрично одобрено.</p>
      <div class="real-grid">
        <section class="card" aria-labelledby="rs-h">
          <div class="real-head"><h2 id="rs-h">Състояние на системата</h2><button type="button" class="btn ghost sm" data-ref="realRefresh">Обнови</button></div>
          <ul class="svc" data-ref="realServices"></ul>
          <p class="muted real-checked" data-ref="realChecked">Проверка…</p>
        </section>
        <section class="card" aria-labelledby="rl-h">
          <h2 id="rl-h">Реални лотове</h2>
          <p class="real-state" data-ref="realCatalogState" role="status">Зареждане…</p>
          <ul class="real-lots" data-ref="realLots"></ul>
        </section>
        <section class="card real-bids" aria-labelledby="rb-h">
          <h2 id="rb-h">Потвърдени оферти и събития</h2>
          <p data-ref="realBidsText">Проверка…</p>
          <p class="muted">DAVID и AiBidder ще работят с реалните оферти, когато Enchev Auctions пусне услугата в реално време и даде достъп само за четене. Изпращането на реални оферти остава изключено.</p>
        </section>
      </div>
    </section>

    <section class="view" data-view="ai" aria-labelledby="ai-h" hidden>
      <h1 id="ai-h">AI наддаване — AiBidder и DAVID</h1>
      <div class="card prose">
        <h2>AiBidder — съвети</h2>
        <p>AiBidder (балончето в ъгъла) използва <b>само</b> данните, които се виждат в търга: подадените оферти, стъпката, оставащото време <b>estimated retail value от обявата</b> (данни на лота, не наша оценка) и <b>твоя бюджет</b>. Казва ти до каква сума да наддаваш, кога да спреш и предлага подобни коли, за които да запазиш парите. Не оценява сама пазарна стойност, не измисля участници и не показва „вероятност за успех“ — за това няма валидиран модел.</p>
        <h2>DAVID — гласът на търга</h2>
        <p>DAVID съобщава събитията: нови оферти, удължаване, оставащо време и край. Може да пуска собствени аудио записи; без тях използва български синтезиран глас или само надписи.</p>
        <p>Нито AiBidder, нито DAVID <b>наддават вместо теб</b>. Бутонът „Наддай“ и гласовата команда „наддай“ само отварят потвърждение, в което проверяваш сумата и потвърждаваш ръчно.</p>
        <h2>Текуща оценка</h2>
        <p class="adv-headline" data-ref="aiHead">—</p>
        <ul class="adv-reasons" data-ref="aiReasons"></ul>
        <h2>Наблюдавани сигнали</h2>
        <ul class="signals wide" data-ref="aiSignals"></ul>
        <h2>Гласови команди (където браузърът поддържа)</h2>
        <ul class="cmds"><li>„цена“ — казва текущата и следващата валидна оферта</li><li>„наддай“ — отваря потвърждението (не изпраща оферта)</li><li>„пауза“ / „продължи“ — гласът на DAVID</li></ul>
        <p class="muted">Разпознаването на реч се извършва от услугата на браузъра (напр. в Chrome гласът се обработва от Google). Микрофонът се включва само когато натиснеш бутона.</p>
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
        <h2>DAVID — аудио</h2>
        <p data-ref="audioInfo">—</p>
        <p class="muted">Собствените записи се добавят в <code>public/audio/david/</code> и се вписват в <code>manifest.json</code> (виж docs/DAVID_AUDIO.md). Сумите винаги се показват в надписите.</p>
        <h2>Режим на свързване</h2>
        <p><b>ДЕМО</b> — активен. Симулиран сървър в браузъра; нищо не се изпраща по мрежата.</p>
        <p><b>РЕАЛЕН</b> — <span data-ref="realReason">не е свързан</span></p>
        <h2>ДЕМО контроли</h2>
        <p class="muted">За тестване на поведението при натоварване, прекъсване и край на търга.</p>
        ${demoControls}
      </div>
    </section>
  </main>

  <aside class="aside" aria-label="DAVID и наддаване">
    <section class="card david blk-david" aria-labelledby="david-h">
      <div class="david-head">
        <button type="button" class="mic" data-ref="mic" aria-pressed="false" aria-label="Гласови команди">${icon('mic')}</button>
        <div class="david-title"><h2 id="david-h">DAVID</h2><p>Гласът на търга</p></div>
        <div class="wave" data-ref="wave" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
        <span class="vstate" data-ref="vstate">ГЛАС ИЗКЛ.</span>
      </div>
      <blockquote class="quote" data-ref="quote">…</blockquote>
      <p class="voice-note" data-ref="voiceNote" hidden></p>
      <div class="voice-ctrls">
        <button type="button" class="btn ghost sm" data-ref="voiceToggle">${icon('volume')}<span data-ref="voiceToggleLabel">Включи гласа</span></button>
        <button type="button" class="btn ghost sm" data-ref="pause">${icon('pause')}<span data-ref="pauseLabel">Пауза</span></button>
        <label class="rate"><span class="sr-only">Скорост на гласа</span><select data-ref="rate"><option value="0.85">0.85×</option><option value="1">1×</option><option value="1.15">1.15×</option><option value="1.3">1.3×</option></select></label>
      </div>
    </section>
    <section class="card timeline-card blk-timeline" aria-labelledby="tl-h">
      <h2 id="tl-h">История на наддаването</h2>
      <ol class="timeline" data-ref="timeline"></ol>
    </section>
    <div class="cta-block blk-cta">
      <button type="button" class="cta" data-ref="cta">${ctaInner('cta')}</button>
    </div>
    <div class="aside-foot blk-foot">
      <p class="footnote">${icon('info')}<span>AiBidder съветва само по видимите данни от търга. Нито AiBidder, нито DAVID наддават вместо теб — всяка оферта изисква твое потвърждение. Паузата спира само гласа, не търга.</span></p>
      <details class="demo-ctrls"><summary>ДЕМО контроли</summary>${demoControls}</details>
    </div>
  </aside>

  <div class="bidbar">
    <button type="button" class="cta" data-ref="cta2">${ctaInner('cta2')}</button>
  </div>
  <div class="sub3d" data-ref="sub3d" aria-hidden="true"><b class="sub3d-main" data-ref="sub3dMain"></b><span class="sub3d-sub" data-ref="sub3dSub"></span></div>
  <nav class="bottomnav" aria-label="Навигация">
    ${mobileNav.map(([r, i, l]) => `<a href="#/${r}" data-nav="${r}">${icon(i)}<span>${l}</span></a>`).join('')}
  </nav>
</div>

<button type="button" class="aib" data-ref="aib" aria-expanded="false" aria-controls="aib-panel" aria-label="AiBidder — съвети">
  <span class="aib-ic" aria-hidden="true">${icon('spark')}</span><span class="aib-name">AiBidder</span><span class="aib-dot" aria-hidden="true"></span>
</button>
<section class="aib-panel" id="aib-panel" data-ref="aibPanel" role="dialog" aria-modal="false" aria-labelledby="aib-h" hidden>
  <header class="aib-head">
    <span class="aib-ic sm" aria-hidden="true">${icon('spark')}</span>
    <h2 id="aib-h">AiBidder</h2>
    <span class="aib-demo">ДЕМО</span>
    <button type="button" class="aib-x" data-ref="aibClose" aria-label="Затвори AiBidder">${icon('close')}</button>
  </header>
  <div class="aib-tabs" role="tablist" aria-label="AiBidder">
    <button type="button" role="tab" id="aib-t0" aria-controls="aib-p0" aria-selected="true" data-tab="0">Съвет</button>
    <button type="button" role="tab" id="aib-t1" aria-controls="aib-p1" aria-selected="false" tabindex="-1" data-tab="1">Защо</button>
    <button type="button" role="tab" id="aib-t2" aria-controls="aib-p2" aria-selected="false" tabindex="-1" data-tab="2">Бюджет</button>
    <button type="button" role="tab" id="aib-t3" aria-controls="aib-p3" aria-selected="false" tabindex="-1" data-tab="3">Подобни</button>
  </div>
  <div class="aib-pages" data-ref="aibPages">
    <div class="aib-page" role="tabpanel" id="aib-p0" aria-labelledby="aib-t0">
      <div class="aib-row"><span class="risk" data-ref="risk">—</span><span class="prob-pill">ВЕРОЯТНОСТ: НЯМА ДАННИ</span></div>
      <p class="adv-headline" data-ref="advHead">—</p>
      <div class="aib-quick" role="group" aria-label="Колко да заложиш" data-ref="aibQuick"></div>
      <p class="aib-psy">Скок с по-голяма сума показва увереност и често обезкуражава другите — психология, не гаранция. Всяка сума се потвърждава от теб.</p>
      <ul class="aib-tips" data-ref="aibTips"></ul>
      <div class="aib-acts">
        <button type="button" class="btn ghost sm" data-goto="3" data-ref="aibSimilarBtn" hidden>Виж подобни коли</button>
        <button type="button" class="btn ghost sm" data-goto="2" data-ref="aibBudgetBtn">Задай бюджет</button>
      </div>
      <label class="check aib-speak"><input type="checkbox" data-ref="speakAdvice"> Изговаряй съветите (с гласа на DAVID)</label>
    </div>
    <div class="aib-page" role="tabpanel" id="aib-p1" aria-labelledby="aib-t1">
      <div class="aib-erv"><span>Estimated retail value</span><b data-ref="aibErv">—</b><small>по данни от обявата · не е наша оценка</small></div>
      <ul class="adv-reasons" data-ref="advReasons"></ul>
      <h3>Наблюдавани сигнали</h3>
      <ul class="signals" data-ref="signals"></ul>
      <p class="prob"><span>Вероятност за успех:</span> <strong data-ref="prob">Няма достатъчно данни</strong>
        <button type="button" class="linkish" data-ref="probWhy" aria-expanded="false" aria-controls="prob-why">Защо?</button></p>
      <p class="prob-why" id="prob-why" data-ref="probWhyText" hidden></p>
    </div>
    <div class="aib-page" role="tabpanel" id="aib-p2" aria-labelledby="aib-t2">
      <form class="aib-budget" data-ref="budgetForm" novalidate>
        <label for="budget-in">Колко пари искаш да дадеш за колата?</label>
        <div class="aib-budget-row"><input id="budget-in" data-ref="budgetInput" inputmode="numeric" autocomplete="off" placeholder="напр. 60 000"><span>€</span></div>
        <div class="aib-budget-quick">
          <button type="button" class="btn ghost sm" data-budget="erv">= Estimated retail value</button>
          <button type="button" class="btn ghost sm" data-budget="+5000">+5 000 €</button>
          <button type="button" class="btn ghost sm" data-budget="clear">Изчисти</button>
        </div>
        <button type="submit" class="btn sm aib-budget-save">Запази бюджета</button>
        <p class="aib-budget-now" data-ref="budgetNow" role="status">—</p>
        <p class="aib-sub">Бюджетът е твой ориентир и се пази само на това устройство. Можеш винаги да го увеличиш. AiBidder ще ти каже кога да спреш и ще предложи подобна кола.</p>
      </form>
    </div>
    <div class="aib-page" role="tabpanel" id="aib-p3" aria-labelledby="aib-t3">
      <p class="aib-sub" data-ref="similarNote">—</p>
      <ul class="aib-similar" data-ref="similar"></ul>
    </div>
  </div>
</section>

<button type="button" class="aib aii" data-ref="aii" aria-expanded="false" aria-controls="aii-panel" aria-label="AI Info — колата и статистика">
  <span class="aib-ic info" aria-hidden="true">${icon('gauge')}</span><span class="aib-name">AI Info</span>
</button>
<section class="aib-panel" id="aii-panel" data-ref="aiiPanel" role="dialog" aria-modal="false" aria-labelledby="aii-h" hidden>
  <header class="aib-head">
    <span class="aib-ic sm info" aria-hidden="true">${icon('gauge')}</span>
    <h2 id="aii-h">AI Info</h2>
    <span class="aib-demo">ДЕМО</span>
    <button type="button" class="aib-x" aria-label="Затвори AI Info">${icon('close')}</button>
  </header>
  <div class="aib-tabs" role="tablist" aria-label="AI Info">
    <button type="button" role="tab" id="aii-t0" aria-controls="aii-p0" aria-selected="true" data-tab="0">Кола</button>
    <button type="button" role="tab" id="aii-t1" aria-controls="aii-p1" aria-selected="false" tabindex="-1" data-tab="1">Статистика</button>
    <button type="button" role="tab" id="aii-t2" aria-controls="aii-p2" aria-selected="false" tabindex="-1" data-tab="2">Търг</button>
  </div>
  <div class="aib-pages">
    <div class="aib-page" role="tabpanel" id="aii-p0" aria-labelledby="aii-t0">
      <div class="aii-retail"><span>Estimated retail value</span><b data-ref="aiiRetail">—</b><small data-ref="aiiRetailSrc"></small></div>
      <dl class="aii-list" data-ref="aiiSpecs"></dl>
    </div>
    <div class="aib-page" role="tabpanel" id="aii-p1" aria-labelledby="aii-t1">
      <dl class="aii-list" data-ref="aiiStats"></dl>
    </div>
    <div class="aib-page" role="tabpanel" id="aii-p2" aria-labelledby="aii-t2">
      <dl class="aii-list" data-ref="aiiRules"></dl>
    </div>
  </div>
</section>

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
      <div><dt>Такси</dt><dd>Няма данни в демо режим. В реален търг таксите се показват тук преди потвърждение.</dd></div>
    </dl>
    <div class="cf-adjust" role="group" aria-label="Промени сумата на офертата">
      <button type="button" class="btn ghost sm" data-raise="down" aria-label="Една стъпка надолу">− стъпка</button>
      <button type="button" class="btn ghost sm" data-raise="up" aria-label="Една стъпка нагоре">+ стъпка</button>
      <button type="button" class="btn ghost sm" data-raise="100000">+1 000 €</button>
      <button type="button" class="btn ghost sm" data-raise="1000000">+10 000 €</button>
      <button type="button" class="btn ghost sm" data-raise="min">Мин.</button>
    </div>
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
