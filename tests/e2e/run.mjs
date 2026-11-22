#!/usr/bin/env node
// End-to-end tests in a real browser (Playwright + Chrome) against the production build in dist/.
// Serves dist/ with the SAME security headers as vercel.json, so CSP regressions fail here too.
//   npm run build && node tests/e2e/run.mjs [--chrome /path/to/chrome] [--out results.json] [--shots dir]
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
let pw;
try { pw = require('playwright'); } catch { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); }
const outFile = arg('--out', join(root, 'test-results/e2e.json'));
const shots = arg('--shots', join(root, 'test-results/screenshots'));
mkdirSync(shots, { recursive: true });

// ---------------------------------------------------------------- server with vercel.json headers
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const globalHeaders = Object.fromEntries(vercel.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value]));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.map': 'application/json', '.txt': 'text/plain' };
const requests = [];
const srv = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(url.pathname);
  if (url.pathname === '/api/bids') { res.writeHead(501, { 'Content-Type': 'application/json' }); return res.end('{"error":"REAL_BIDDING_NOT_CONNECTED"}'); }
  let file = join(root, 'dist', decodeURIComponent(url.pathname));
  if (url.pathname === '/' || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'dist/index.html');
  res.writeHead(200, { ...globalHeaders, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await pw.chromium.launch({
  executablePath: arg('--chrome', process.env.CHROME_PATH),
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const browserVersion = browser.version();
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = (w = 390, h = 844) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

// Fake Bulgarian speech synthesis (headless Chrome has no voices); records what was spoken.
const FAKE_TTS = () => {
  const spoken = []; let speaking = null; const listeners = {};
  const voice = { lang: 'bg-BG', name: 'Тест глас', default: true, localService: true, voiceURI: 'test-bg' };
  const synth = {
    getVoices: () => [voice],
    speak(u) { spoken.push(u.text); speaking = u; setTimeout(() => { if (speaking === u) { speaking = null; u.onend && u.onend(); } }, 300); },
    cancel() { const u = speaking; speaking = null; if (u && u.onerror) u.onerror(new Event('error')); window.__ttsCancels = (window.__ttsCancels || 0) + 1; },
    pause() {}, resume() {},
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    get speaking() { return !!speaking; },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  window.__spoken = spoken;
};

const results = [];
const grep = arg('--grep', null);
async function run(name, opts, fn) {
  if (grep && !name.includes(grep)) return;
  const t0 = Date.now();
  const ctx = await browser.newContext(opts.ctx ?? DESKTOP);
  if (opts.tts) await ctx.addInitScript(FAKE_TTS);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let status = 'pass', detail = '';
  try {
    await page.goto(`${base}/${opts.query ?? '?seed=3'}`);
    await page.waitForFunction(() => window.__bidder?.ctrl.auction.lot && window.__bidder.ctrl.connection === 'online', null, { timeout: 15000 });
    detail = (await fn(page, ctx)) ?? '';
    const unexpected = errors.filter((e) => !(opts.allowErrors && opts.allowErrors.test(e)));
    if (unexpected.length) throw new Error('console/page errors: ' + unexpected.slice(0, 3).join(' | '));
  } catch (e) {
    status = 'fail';
    detail = String(e && e.message ? e.message : e).split('\n')[0];
    try { await page.screenshot({ path: join(shots, `FAIL-${name.replace(/[^a-z0-9]+/gi, '_')}.png`) }); } catch {}
  }
  results.push({ name, status, ms: Date.now() - t0, detail });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  await ctx.close();
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const text = (page, ref) => page.locator(`[data-ref="${ref}"]`).first().innerText();
const state = (page) => page.evaluate(() => {
  const { ctrl, demo } = window.__bidder;
  const top = ctrl.top;
  return { top: top && top.amount, topBy: top && top.bidderId, next: ctrl.nextValid, block: ctrl.blockReason, mine: ctrl.auction.bids.filter((b) => b.bidderId === ctrl.adapter.bidderId).length,
    serverTop: (() => { const s = demo.server.snapshot(); return Math.max(...s.bids.map((b) => b.amount)); })(), ended: ctrl.ended, endsAt: ctrl.auction.endsAt, serverEnds: demo.server.snapshot().endsAt,
    remaining: ctrl.remainingMs, serverRemaining: demo.server.snapshot().endsAt - demo.server.now(), stats: ctrl.auction.stats, accepted: demo.server.audit.filter((a) => a.result === 'accepted').length };
});

// ---------------------------------------------------------------- tests
await run('desktop: values are consistent (next valid = current + step), countdown runs', { query: '?seed=3&competitors=0' }, async (p) => {
  const s = await state(p);
  expect(s.next === s.top + 50_000, `next ${s.next} != top ${s.top} + 500 €`);
  expect((await text(p, 'current')).replace(/\s/g, '') === '42500€', 'current tile shows 42 500 €');
  expect((await text(p, 'next')).replace(/\s/g, '') === '43000€', 'next tile shows 43 000 €');
  const t1 = await text(p, 'timer'); await p.waitForTimeout(2200); const t2 = await text(p, 'timer');
  expect(t1 !== t2, 'countdown moves');
  expect((await text(p, 'connText')).includes('Свързан'), 'connected label');
  expect((await p.innerText('body')).includes('ДЕМО ДАННИ'), 'demo label visible');
  await p.screenshot({ path: join(shots, 'desktop-1440.png') });
  return `timer ${t1} → ${t2}`;
});

await run('no fabricated success probability anywhere', { query: '?seed=3' }, async (p) => {
  const body = await p.innerText('body');
  expect(body.includes('Няма достатъчно данни'), 'shows "Няма достатъчно данни"');
  expect(!/вероятност[^\n]{0,40}\d+\s*%/i.test(body), 'no "вероятност … NN%"');
  expect(!/справедлива|пазарна стойност е|висока вероятност/i.test(body), 'no market-value or high-probability claims');
});

await run('bid flow: CTA → confirmation (consent required) → accepted; you lead', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.click('[data-ref="cta"]');
  await p.waitForSelector('dialog[open]');
  expect(await p.locator('[data-ref="cfSubmit"]').isDisabled(), 'submit disabled before consent');
  expect((await text(p, 'cfAmount')).replace(/\s/g, '') === '43000€', 'dialog amount = next valid bid');
  await p.check('[data-ref="consent"]');
  await p.click('[data-ref="cfSubmit"]');
  await p.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 5000 });
  await p.waitForFunction(() => window.__bidder.ctrl.leading, null, { timeout: 5000 });
  const s = await state(p);
  expect(s.top === 4_300_000 && s.mine === 1, 'my 43 000 € bid is highest');
  expect((await text(p, 'ctaLabel')) === 'ВОДИШ', 'CTA shows ВОДИШ');
  expect(await p.locator('[data-ref="cta"]').isDisabled(), 'cannot bid against yourself');
  await p.goto(`${base}/#/bids`);
  return 'accepted';
});

await run('repeated clicks: one idempotent bid only', { query: '?seed=3&competitors=0&latency=400' }, async (p) => {
  await p.click('[data-ref="cta"]');
  await p.check('[data-ref="consent"]');
  // Five rapid activations: synthetic clicks in one task plus direct calls, as a double-tap or impatient user would.
  await p.evaluate(() => {
    const b = document.querySelector('[data-ref="cfSubmit"]');
    for (let i = 0; i < 3; i++) b.click();
    window.__bidder.ctrl.submitBid(); window.__bidder.ctrl.submitBid();
  });
  await p.waitForFunction(() => window.__bidder.ctrl.leading, null, { timeout: 8000 });
  await p.waitForTimeout(1200);
  const s = await state(p);
  expect(s.accepted === 1 && s.mine === 1, `exactly one accepted bid (accepted=${s.accepted}, mine=${s.mine})`);
  return `accepted=${s.accepted}`;
});

await run('price moves while confirming → amount updates and consent is required again', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.click('[data-ref="cta"]');
  await p.check('[data-ref="consent"]');
  await p.evaluate(() => window.__bidder.demo.server.burst(1));
  await p.waitForFunction(() => window.__bidder.ctrl.confirm.priceMoved, null, { timeout: 5000 });
  expect(!(await p.isChecked('[data-ref="consent"]')), 'consent cleared');
  expect(await p.locator('[data-ref="cfSubmit"]').isDisabled(), 'submit disabled again');
  expect((await text(p, 'cfAmount')).replace(/\s/g, '') === '43500€', 'amount updated to new next valid bid');
  expect(await p.locator('[data-ref="cfMoved"]').isVisible(), 'price-moved notice visible');
});

await run('user limit: over-limit blocks bidding; invalid input is flagged', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.fill('[data-ref="cap"]', '42 800');
  await p.press('[data-ref="cap"]', 'Enter');
  await p.waitForFunction(() => window.__bidder.ctrl.blockReason === 'НАД ЛИМИТА ТИ');
  await p.waitForFunction(() => document.querySelector('[data-ref="cta"]').disabled && document.querySelector('[data-ref="risk"]').textContent === 'НАД ЛИМИТА', null, { timeout: 5000 });
  expect((await text(p, 'advHead')).startsWith('Спри'), 'advice says stop');
  await p.fill('[data-ref="cap"]', 'много');
  await p.press('[data-ref="cap"]', 'Enter');
  expect((await p.getAttribute('[data-ref="cap"]', 'aria-invalid')) === 'true', 'aria-invalid on bad input');
  await p.fill('[data-ref="cap"]', '50000');
  await p.press('[data-ref="cap"]', 'Enter');
  await p.waitForFunction(() => window.__bidder.ctrl.blockReason === null);
});

await run('rapid incoming bids: UI stays consistent with the server', { query: '?seed=3&competitors=0&latency=20' }, async (p) => {
  await p.evaluate(() => { const s = window.__bidder.demo.server; s.burst(5); setTimeout(() => s.burst(5), 300); });
  // Eventual consistency: after the burst the client must converge on the server's highest bid.
  await p.waitForFunction(() => { const { ctrl, demo } = window.__bidder; const s = demo.server.snapshot(); return s.bids.length >= 16 && ctrl.top && ctrl.top.amount === Math.max(...s.bids.map((b) => b.amount)); }, null, { timeout: 20000 });
  await p.waitForTimeout(400);
  const s = await state(p);
  expect(s.top === s.serverTop, `client top ${s.top} == server top ${s.serverTop}`);
  const last = await p.locator('.timeline li.last .tl-amt').innerText();
  expect(last.replace(/\s/g, '') === `${(s.top / 100).toLocaleString('bg-BG').replace(/\s/g, '')}€`, 'timeline ends with the highest bid');
  return `top ${s.top / 100} €`;
});

await run('unstable network (drops, reorder, duplicates) → gap detection + resync converge', { query: '?seed=5&competitors=0&unstable=1' }, async (p) => {
  await p.evaluate(() => { const s = window.__bidder.demo.server; s.burst(5); setTimeout(() => s.burst(5), 2600); });
  await p.waitForFunction(() => { const { ctrl, demo } = window.__bidder; const s = demo.server.snapshot(); return s.bids.length >= 16 && ctrl.top && ctrl.top.amount === Math.max(...s.bids.map((b) => b.amount)); }, null, { timeout: 25000 });
  const s = await state(p);
  expect(s.top === s.serverTop, `converged: client ${s.top} vs server ${s.serverTop}`);
  return `dup=${s.stats.duplicates} buffered=${s.stats.buffered} resyncs=${s.stats.resyncs}`;
});

await run('lost final event (no later events) is detected via heartbeat and resynced', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.evaluate(() => {
    const { demo } = window.__bidder;
    const realDeliver = demo.deliver.bind(demo);
    demo.deliver = (e) => { if (e.type === 'bid' && !window.__dropped) { window.__dropped = e.seq; return; } realDeliver(e); };
    demo.server.burst(1);
  });
  await p.waitForFunction(() => window.__dropped, null, { timeout: 8000 });
  await p.waitForFunction(() => { const { ctrl, demo } = window.__bidder; const s = demo.server.snapshot(); return ctrl.top.amount === Math.max(...s.bids.map((b) => b.amount)); }, null, { timeout: 20000 });
  const s = await state(p);
  expect(s.stats.resyncs >= 1, 'resync happened');
  return `resyncs=${s.stats.resyncs}`;
});

await run('connection loss: bidding disabled, recovers and resyncs', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.evaluate(() => window.__bidder.demo.simulateOutage(3000));
  await p.waitForFunction(() => window.__bidder.ctrl.blockReason === 'НЯМА ВРЪЗКА');
  await p.waitForFunction(() => document.querySelector('[data-ref="cta"]').disabled && document.querySelector('[data-ref="ctaLabel"]').textContent === 'НЯМА ВРЪЗКА');
  await p.evaluate(() => window.__bidder.demo.server.burst(1)); // happens while we are offline
  await p.waitForFunction(() => window.__bidder.ctrl.connection === 'online', null, { timeout: 8000 });
  await p.waitForFunction(() => { const { ctrl, demo } = window.__bidder; const s = demo.server.snapshot(); return ctrl.top.amount === Math.max(...s.bids.map((b) => b.amount)); }, null, { timeout: 10000 });
  const s = await state(p);
  expect(s.top === s.serverTop, 'missed bid recovered via snapshot');
  expect(s.block === null, 'bidding re-enabled');
});

await run('browser offline event disables bidding', { query: '?seed=3&competitors=0', allowErrors: /ERR_INTERNET_DISCONNECTED/ }, async (p, ctx) => {
  await p.waitForFunction(() => document.querySelector('[data-ref="viewer"]').dataset.viewer === 'ready', null, { timeout: 30000 });
  await ctx.setOffline(true);
  await p.waitForFunction(() => window.__bidder.ctrl.blockReason === 'НЯМА ВРЪЗКА', null, { timeout: 5000 });
  await ctx.setOffline(false);
  await p.waitForFunction(() => window.__bidder.ctrl.blockReason === null, null, { timeout: 5000 });
});

await run('server clock skew (+60 s) is corrected: countdown follows server time', { query: '?seed=3&competitors=0&skew=60000' }, async (p) => {
  await p.waitForTimeout(1500);
  const s = await state(p);
  expect(Math.abs(s.remaining - s.serverRemaining) < 600, `client remaining ${s.remaining} vs server ${s.serverRemaining}`);
  return `Δ ${Math.round(s.remaining - s.serverRemaining)} ms`;
});

await run('anti-sniping: late bid extends the auction (УДЪЛЖЕН)', { query: '?seed=3&competitors=0&duration=24' }, async (p) => {
  await p.waitForFunction(() => window.__bidder.ctrl.remainingMs < 19_000, null, { timeout: 10000 });
  const before = (await state(p)).endsAt;
  await p.click('[data-ref="cta"]');
  await p.check('[data-ref="consent"]');
  await p.click('[data-ref="cfSubmit"]');
  await p.waitForFunction((b) => window.__bidder.ctrl.auction.endsAt > b, before, { timeout: 5000 });
  expect(await p.locator('[data-ref="ext"]').isVisible(), 'УДЪЛЖЕН badge shown');
});

await run('end of auction: timer 00:00, bidding closed, server rejects late bids', { query: '?seed=3&competitors=0&duration=5' }, async (p) => {
  await p.waitForFunction(() => window.__bidder.ctrl.ended, null, { timeout: 12000 });
  await p.waitForTimeout(600);
  expect((await text(p, 'timer')) === '00:00', 'timer at 00:00');
  expect((await text(p, 'ctaLabel')) === 'ТЪРГЪТ ПРИКЛЮЧИ', 'CTA says ended');
  expect((await text(p, 'liveText')) === 'ПРИКЛЮЧИЛ', 'live pill says ended');
  const r = await p.evaluate(() => window.__bidder.demo.server.placeBid({ lotId: 'DEMO-0001', amount: 4_300_000, currency: 'EUR', idempotencyKey: 'late' }, { bidderId: 'x', authenticated: true }));
  expect(r.status === 'rejected' && r.code === 'ENDED', 'server rejects after end');
});

await run('DAVID: Bulgarian voice speaks events; pause stops voice only; captions continue', { tts: true, query: '?seed=3&competitors=0' }, async (p) => {
  await p.click('[data-ref="voiceToggle"]');
  await p.evaluate(() => window.__bidder.demo.server.burst(1));
  await p.waitForFunction(() => window.__spoken.some((t) => t.startsWith('Има нова оферта')), null, { timeout: 5000 });
  await p.click('[data-ref="pause"]');
  expect((await text(p, 'vstate')) === 'ГЛАС НА ПАУЗА', 'voice paused');
  const spokenBefore = await p.evaluate(() => window.__spoken.length);
  const endsBefore = (await state(p)).endsAt;
  await p.evaluate(() => window.__bidder.demo.server.burst(1));
  await p.waitForFunction(() => window.__bidder.ctrl.david.latest.text.includes('нова оферта'), null, { timeout: 5000 });
  await p.waitForTimeout(800);
  expect((await p.evaluate(() => window.__spoken.length)) === spokenBefore, 'nothing spoken while paused');
  const s = await state(p);
  expect(s.endsAt >= endsBefore && !s.ended && s.remaining > 0, 'auction keeps running while voice is paused');
  expect((await text(p, 'quote')).includes('нова оферта'), 'caption updated while paused');
  await p.click('[data-ref="pause"]');
  await p.waitForFunction((n) => window.__spoken.length > n, spokenBefore, { timeout: 5000 });
  return 'spoken: ' + (await p.evaluate(() => window.__spoken.slice(-1)[0]));
});

await run('DAVID without a Bulgarian voice: captions-only fallback is explained', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.click('[data-ref="voiceToggle"]');
  await p.waitForTimeout(1700);
  const v = await text(p, 'vstate');
  expect(v === 'САМО НАДПИСИ', `state ${v}`);
  expect(await p.locator('[data-ref="voiceNote"]').isVisible(), 'explanation visible');
});

await run('screen-reader live regions announce new bids', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.evaluate(() => window.__bidder.demo.server.burst(1));
  await p.waitForFunction(() => document.querySelector('[data-ref="livePolite"]').textContent.includes('нова оферта'), null, { timeout: 15000 });
});

await run('keyboard: Tab to CTA, Enter opens dialog, Escape closes and restores focus', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.focus('[data-ref="cta"]');
  await p.keyboard.press('Enter');
  await p.waitForSelector('dialog[open]');
  expect(await p.evaluate(() => document.activeElement?.dataset.ref === 'consent'), 'focus moved into dialog');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('dialog[open]'));
  expect(await p.evaluate(() => document.activeElement?.dataset.ref === 'cta'), 'focus returned to CTA');
});

await run('reduced motion: no animations', { ctx: { ...DESKTOP, reducedMotion: 'reduce' }, tts: true, query: '?seed=3&competitors=0' }, async (p) => {
  const anim = await p.evaluate(() => getComputedStyle(document.querySelector('.live-pill .dot')).animationName);
  expect(anim === 'none', `animation ${anim}`);
});

for (const [w, h] of [[390, 844], [360, 740]]) {
  await run(`mobile ${w}px: no horizontal overflow; sticky bid bar + bottom nav usable`, { ctx: PHONE(w, h), query: '?seed=3&competitors=0' }, async (p) => {
    await p.waitForTimeout(1500);
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(m.sw <= m.iw, `scrollWidth ${m.sw} > ${m.iw}`);
    const bar = await p.locator('.bidbar .cta').boundingBox();
    const nav = await p.locator('.bottomnav').boundingBox();
    expect(bar && nav && bar.y + bar.height <= nav.y + 1 && nav.y + nav.height <= h + 1, 'bid bar sits above bottom nav inside viewport');
    expect(bar.height >= 44, 'bid button ≥ 44 px');
    const small = await p.evaluate(() => [...document.querySelectorAll('.bottomnav a, .bidbar .cta, [data-ref="pause"], [data-ref="voiceToggle"], [data-ref="mic"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.height < 40 || r.width < 40); }).length);
    expect(small === 0, `${small} tap targets smaller than 40 px`);
    await p.screenshot({ path: join(shots, `mobile-${w}.png`) });
    await p.tap('.bidbar .cta');
    await p.waitForSelector('dialog[open]');
    await p.screenshot({ path: join(shots, `mobile-${w}-confirm.png`) });
    await p.tap('[data-ref="cfCancel"]');
    await p.tap('.bottomnav a[data-nav="bids"]');
    await p.waitForFunction(() => document.documentElement.dataset.route === 'bids');
    expect(!(await p.locator('.bidbar').isVisible()), 'bid bar hidden outside the live view');
    return `${m.sw}/${m.iw}`;
  });
}

await run('3D viewer: model loads (WebGL), drag rotates without errors', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.waitForFunction(() => document.querySelector('[data-ref="viewer"]').dataset.viewer === 'ready', null, { timeout: 30000 });
  const box = await p.locator('.viewer-canvas').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down(); await p.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2, { steps: 8 }); await p.mouse.up();
});

await run('real bid endpoint refuses (501) and no request leaves the origin', { query: '?seed=3&competitors=0', allowErrors: /status of 501/ }, async (p) => {
  const r = await p.evaluate(async () => { const x = await fetch('/api/bids', { method: 'POST' }); return x.status; });
  expect(r === 501, `status ${r}`);
  const external = await p.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((u) => !u.startsWith(location.origin)));
  expect(external.length === 0, 'external requests: ' + external.join(', '));
});

await run('views: dashboard, AI, bids, history, settings render in Bulgarian', { query: '?seed=3&competitors=0' }, async (p) => {
  for (const [route, needle] of [['dashboard', 'Табло'], ['ai', 'как работи DAVID'], ['bids', 'Моите оферти'], ['history', 'Транскрипт на DAVID'], ['settings', 'Висок контраст']]) {
    await p.click(`.sidenav a[data-nav="${route}"]`);
    await p.waitForFunction((r) => document.documentElement.dataset.route === r, route);
    expect((await p.innerText('main')).includes(needle), `${route} contains ${needle}`);
  }
});

await browser.close();
srv.close();
const passed = results.filter((r) => r.status === 'pass').length;
mkdirSync(resolve(outFile, '..'), { recursive: true });
writeFileSync(outFile, JSON.stringify({ browser: `Chrome ${browserVersion} (headless, SwiftShader WebGL)`, passed, total: results.length, results }, null, 2));
console.log(`\nE2E ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
