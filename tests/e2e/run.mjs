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
    if (opts.before) await opts.before(page);
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
await run('desktop: values are consistent (next valid = current + step), countdown runs', { query: '?seed=3&competitors=0&opening=1' }, async (p) => {
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
  await p.click('[data-ref="aib"]');
  await p.click('#aib-t1');
  const body = await p.innerText('body');
  expect(body.includes('Няма достатъчно данни'), 'shows "Няма достатъчно данни"');
  expect(!/вероятност[^\n]{0,40}\d+\s*%/i.test(body), 'no "вероятност … NN%"');
  expect(!/справедлива|пазарна стойност е|висока вероятност/i.test(body), 'no market-value or high-probability claims');
});

await run('bid flow: CTA → confirmation (consent required) → accepted; you lead', { query: '?seed=3&competitors=0&opening=1' }, async (p) => {
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

await run('price moves while confirming → amount updates and consent is required again', { query: '?seed=3&competitors=0&opening=1' }, async (p) => {
  await p.click('[data-ref="cta"]');
  await p.check('[data-ref="consent"]');
  await p.evaluate(() => window.__bidder.demo.server.burst(1));
  await p.waitForFunction(() => window.__bidder.ctrl.confirm.priceMoved, null, { timeout: 5000 });
  expect(!(await p.isChecked('[data-ref="consent"]')), 'consent cleared');
  expect(await p.locator('[data-ref="cfSubmit"]').isDisabled(), 'submit disabled again');
  expect((await text(p, 'cfAmount')).replace(/\s/g, '') === '43500€', 'amount updated to new next valid bid');
  expect(await p.locator('[data-ref="cfMoved"]').isVisible(), 'price-moved notice visible');
});

await run('auction starts from 0 €: first valid bid is the first increment; a 100 € bid is accepted', { query: '?seed=3&competitors=0' }, async (p) => {
  expect((await text(p, 'current')).replace(/\s/g, '') === '0€', 'current price 0 €');
  expect((await text(p, 'next')).replace(/\s/g, '') === '100€', 'first valid bid 100 €');
  expect((await text(p, 'timeline')).includes('Още няма оферти'), 'empty history explained');
  await p.click('[data-ref="cta"]');
  await p.check('[data-ref="consent"]');
  await p.click('[data-ref="cfSubmit"]');
  await p.waitForFunction(() => window.__bidder.ctrl.leading && window.__bidder.ctrl.top.amount === 10_000, null, { timeout: 5000 });
});

await run('competitors raise the price from 0 € with valid bids, not above the declared retail value', { query: '?seed=9&activity=6' }, async (p) => {
  await p.waitForFunction(() => window.__bidder.ctrl.auction.bids.length >= 6, null, { timeout: 25000 });
  const r = await p.evaluate(() => {
    const { ctrl } = window.__bidder;
    const lot = ctrl.auction.lot, rules = ctrl.auction.rules;
    const bids = [...ctrl.auction.bids].sort((a, b) => a.serverTime - b.serverTime);
    const stepFor = (x) => rules.increments.find((b) => b.below === null || x < b.below).step;
    let prev = null, ok = true;
    for (const b of bids) {
      const next = prev === null ? (lot.startPrice > 0 ? lot.startPrice : stepFor(0)) : prev + stepFor(prev);
      const step = stepFor(prev === null ? lot.startPrice : prev);
      if (b.amount < next || (b.amount - next) % step !== 0) ok = false;
      prev = b.amount;
    }
    return { ok, n: bids.length, top: prev, retail: lot.retailValue };
  });
  expect(r.ok, 'every bid is a valid bid for the moment it was placed');
  expect(r.top <= r.retail, `top ${r.top} ≤ declared retail ${r.retail}`);
  return `${r.n} bids, top ${r.top / 100} €`;
});

await run('confirmation: choose a higher amount (+10 000 €) → consent again → accepted at that amount', { query: '?seed=3&competitors=0&opening=1' }, async (p) => {
  await p.click('[data-ref="cta"]');
  await p.check('[data-ref="consent"]');
  await p.click('[data-raise="1000000"]');
  await p.waitForFunction(() => document.querySelector('[data-ref="cfAmount"]').textContent.replace(/\s/g, '') === '53000€', null, { timeout: 3000 });
  expect(!(await p.isChecked('[data-ref="consent"]')), 'consent cleared when the amount changes');
  expect(!(await p.locator('[data-raise="min"]').isDisabled()), 'can go back to the minimum');
  await p.click('[data-raise="down"]');
  await p.waitForFunction(() => document.querySelector('[data-ref="cfAmount"]').textContent.replace(/\s/g, '') === '52500€', null, { timeout: 3000 });
  await p.check('[data-ref="consent"]');
  await p.click('[data-ref="cfSubmit"]');
  await p.waitForFunction(() => window.__bidder.ctrl.leading, null, { timeout: 5000 });
  const s = await state(p);
  expect(s.top === 5_250_000, `accepted at 52 500 € (top ${s.top})`);
});

await run('no personal limit on screen; the 1 000 000 € maximum is enforced only by the server', { query: '?seed=3&competitors=0' }, async (p) => {
  let visible = await p.evaluate(() => document.body.innerText);
  await p.click('[data-ref="aib"]');
  await p.waitForSelector('#aib-panel:not([hidden])');
  visible += await p.locator('#aib-panel').innerText();
  await p.click('[data-ref="aii"]');
  await p.waitForSelector('#aii-panel:not([hidden])');
  visible += await p.locator('#aii-panel').innerText();
  await p.click('[data-ref="cta"]');
  await p.waitForSelector('dialog[open]');
  visible += await p.locator('dialog').innerText();
  expect(!/лимит/i.test(visible), 'the word "лимит" appears nowhere on screen');
  expect(!/1\s?000\s?000/.test(visible), 'the maximum is not shown');
  const r = await p.evaluate(() => window.__bidder.demo.server.placeBid({ lotId: window.__bidder.ctrl.auction.lot.lotId, amount: 100_010_000, currency: 'EUR', idempotencyKey: 'over-max' }, { bidderId: 'x', authenticated: true }));
  expect(r.status === 'rejected' && r.code === 'ABOVE_HOUSE_MAX', 'server refuses bids above 1 000 000 €');
});

await run('rapid incoming bids: UI stays consistent with the server', { query: '?seed=3&competitors=0&latency=20&opening=1' }, async (p) => {
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

await run('unstable network (drops, reorder, duplicates) → gap detection + resync converge', { query: '?seed=5&competitors=0&unstable=1&opening=1' }, async (p) => {
  await p.evaluate(() => { const s = window.__bidder.demo.server; s.burst(5); setTimeout(() => s.burst(5), 2600); });
  await p.waitForFunction(() => { const { ctrl, demo } = window.__bidder; const s = demo.server.snapshot(); return s.bids.length >= 16 && ctrl.top && ctrl.top.amount === Math.max(...s.bids.map((b) => b.amount)); }, null, { timeout: 25000 });
  const s = await state(p);
  expect(s.top === s.serverTop, `converged: client ${s.top} vs server ${s.serverTop}`);
  return `dup=${s.stats.duplicates} buffered=${s.stats.buffered} resyncs=${s.stats.resyncs}`;
});

await run('lost final event (no later events) is detected via heartbeat and resynced', { query: '?seed=3&competitors=0&opening=1' }, async (p) => {
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

await run('connection loss: bidding disabled, recovers and resyncs', { query: '?seed=3&competitors=0&opening=1' }, async (p) => {
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
    const aib = await p.locator('[data-ref="aib"]').boundingBox();
    expect(aib && aib.y + aib.height <= bar.y && aib.x >= 0 && aib.x + aib.width <= w, 'AiBidder bubble stays above the bid bar, on screen');
    const small = await p.evaluate(() => [...document.querySelectorAll('.bottomnav a, .bidbar .cta, [data-ref="pause"], [data-ref="voiceToggle"], [data-ref="mic"], [data-ref="aib"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.height < 40 || r.width < 40); }).length);
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

await run('AiBidder bubble (phone): compact non-modal panel, 2 pages, never covers НАДДАЙ', { ctx: PHONE(390, 844), query: '?seed=3&competitors=0' }, async (p) => {
  expect((await text(p, 'aib')).includes('AiBidder'), 'bubble says AiBidder');
  expect(!(await p.locator('[data-ref="aibPanel"]').isVisible()), 'panel starts closed');
  await p.tap('[data-ref="aib"]');
  await p.waitForSelector('[data-ref="aibPanel"]:not([hidden])');
  await p.waitForTimeout(300);
  const panel = await p.locator('[data-ref="aibPanel"]').boundingBox();
  const bar = await p.locator('.bidbar .cta').boundingBox();
  expect(panel.x >= 0 && panel.x + panel.width <= 390 && panel.y >= 0, 'panel on screen');
  expect(panel.height <= 844 * 0.5, `panel is compact (${Math.round(panel.height)} px)`);
  expect(panel.y + panel.height <= bar.y, 'panel does not cover the bid button');
  expect((await p.getAttribute('[data-ref="aib"]', 'aria-expanded')) === 'true', 'aria-expanded');
  expect((await text(p, 'advHead')).length > 5, 'advice shown on page 1');
  await p.tap('#aib-t1');
  await p.waitForFunction(() => document.querySelector('#aib-t1').getAttribute('aria-selected') === 'true' && document.querySelector('#aib-p0').inert);
  await p.screenshot({ path: join(shots, 'mobile-390-aibidder.png') });
  expect((await p.locator('#aib-panel [role="tab"]').count()) === 2, 'two pages: Съвет · Защо');
  await p.tap('#aib-t0');
  expect((await text(p, 'aibRetail')).replace(/\s/g, '').endsWith('€'), 'declared retail value shown');
  // Non-modal: a tap on НАДДАЙ goes through (and closes the panel).
  await p.tap('.bidbar .cta');
  await p.waitForSelector('dialog[open]');
  expect(!(await p.locator('[data-ref="aibPanel"]').isVisible()), 'panel closed by outside tap');
  await p.tap('[data-ref="cfCancel"]');
  await p.tap('[data-ref="aib"]');
  await p.waitForSelector('[data-ref="aibPanel"]:not([hidden])');
  await p.keyboard.press('Escape');
  await p.waitForSelector('[data-ref="aibPanel"]', { state: 'hidden' });
  expect(await p.evaluate(() => document.activeElement?.dataset.ref === 'aib'), 'focus back on the bubble');
  return `panel ${Math.round(panel.height)} px`;
});

for (const [label, ctx] of [['desktop', DESKTOP], ['phone', PHONE(390, 844)]]) {
  await run(`AI Info bubble (${label}): car details + declared retail value, live statistics, auction rules; never overlaps AiBidder`, { ctx, query: '?seed=3&competitors=0&opening=1' }, async (p) => {
    const a = await p.locator('[data-ref="aib"]').boundingBox();
    const b = await p.locator('[data-ref="aii"]').boundingBox();
    expect(a && b && (a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y), 'bubbles do not overlap');
    await p.click('[data-ref="aib"]');
    await p.waitForSelector('#aib-panel:not([hidden])');
    await p.click('[data-ref="aii"]');
    await p.waitForSelector('#aii-panel:not([hidden])');
    expect(!(await p.locator('#aib-panel').isVisible()), 'only one panel open at a time');
    const page1 = await p.locator('#aii-p0').innerText();
    expect(page1.includes('VIN') && page1.includes('Скоростна кутия') && page1.includes('Retail стойност'), 'all characteristics + retail value');
    expect(page1.includes('примерни ДЕМО данни'), 'retail value is labelled as sample lot data');
    await p.click('#aii-t1');
    await p.waitForFunction(() => document.querySelector('#aii-t1').getAttribute('aria-selected') === 'true');
    const page2 = await p.locator('#aii-p1').innerText();
    expect(page2.includes('Оферти общо') && /Оферти общо\s*6/.test(page2) && page2.includes('Цена / retail стойност'), 'live statistics');
    await p.click('#aii-t2');
    const page3 = await p.locator('#aii-p2').innerText();
    expect(page3.includes('Начална цена') && page3.replace(/\s/g, '').includes('0€') && page3.includes('изключено'), 'rules: start 0 €, real bids off');
    const panel = await p.locator('#aii-panel').boundingBox();
    const vp = p.viewportSize();
    expect(panel.y >= 0 && panel.y + panel.height <= vp.height && panel.x >= 0 && panel.x + panel.width <= vp.width, 'panel fully on screen');
    await p.screenshot({ path: join(shots, `${label}-ai-info.png`) });
  });
}

await run('AiBidder bubble: drag snaps to the other edge, does not open, position is remembered', { query: '?seed=3&competitors=0' }, async (p) => {
  const b0 = await p.locator('[data-ref="aib"]').boundingBox();
  await p.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await p.mouse.down();
  await p.mouse.move(b0.x - 700, b0.y - 250, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const b1 = await p.locator('[data-ref="aib"]').boundingBox();
  const main = await p.locator('.main').boundingBox();
  expect((await p.getAttribute('[data-ref="aib"]', 'data-side')) === 'left' && Math.abs(b1.x - (main.x + 16)) < 3, `snapped left (x=${Math.round(b1.x)})`);
  const other = await p.locator('[data-ref="aii"]').boundingBox();
  expect(b1.y + b1.height <= other.y || other.y + other.height <= b1.y, 'stacked next to AI Info, not on top of it');
  expect((await p.getAttribute('[data-ref="aib"]', 'aria-expanded')) === 'false', 'drag did not open the panel');
  await p.reload();
  await p.waitForFunction(() => window.__bidder?.ctrl.auction.lot);
  await p.waitForTimeout(300);
  expect((await p.getAttribute('[data-ref="aib"]', 'data-side')) === 'left', 'position remembered after reload');
  return `x ${Math.round(b0.x)} → ${Math.round(b1.x)}`;
});

// 0.3 s of silence, 8 kHz 8-bit mono WAV — stands in for a recorded DAVID clip.
const silentWav = (() => {
  const n = 2400, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
})();
await run('DAVID audio slot: your recorded clip plays instead of the synthetic voice', {
  tts: true, query: '?seed=3&competitors=0',
  before: async (page) => {
    await page.route('**/audio/david/manifest.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 1, clips: { new_bid: 'test-new-bid.wav' } }) }));
    await page.route('**/audio/david/test-new-bid.wav', (r) => r.fulfill({ contentType: 'audio/wav', body: silentWav }));
  },
}, async (p) => {
  await p.waitForFunction(() => window.__bidder.ctrl.david.clips.size === 1, null, { timeout: 5000 });
  await p.click('[data-ref="voiceToggle"]');
  await p.evaluate(() => window.__bidder.demo.server.burst(1));
  await p.waitForFunction(() => window.__bidder.ctrl.david.playedClips.includes('new_bid'), null, { timeout: 5000 });
  await p.waitForTimeout(800);
  const spoken = await p.evaluate(() => window.__spoken.slice());
  expect(!spoken.some((t) => t.startsWith('Има нова оферта')), 'clip used, not TTS: ' + spoken.join(' | '));
  expect((await text(p, 'quote')).includes('нова оферта'), 'caption still shows the amount');
  await p.click('.sidenav a[data-nav="settings"]');
  expect((await text(p, 'audioInfo')).includes('1 от 16'), 'settings show 1 of 16 clips');
});

// Read-only bridge responses shaped exactly like /api/enchev (envelope around the sanitized Enchev body).
const enchevFixture = (page, { catalogStatus = 200 } = {}) => page.route('**/api/enchev?r=*', (r) => {
  const res = new URL(r.request().url()).searchParams.get('r');
  const now = Date.now();
  const env = (status, body) => ({ readOnly: true, resource: res, upstream: 'https://upstream.test', reachable: true, upstreamStatus: status, fetchedAt: new Date(now).toISOString(), body });
  const lots = [
    { id: 'l1', lot_number: 'EA-20001', title: 'BMW 320d Touring', make: 'BMW', model: '320d', model_year: 2019, country_code: 'BG', starting_price: 12500, price_currency: 'EUR', status: 'live', auction_starts_at: new Date(now - 60_000).toISOString(), auction_ends_at: new Date(now + 5 * 60_000).toISOString() },
    { id: 'l2', lot_number: 'EA-20002', title: 'Škoda Octavia', make: 'Škoda', model: 'Octavia', model_year: 2021, starting_price: 9800, price_currency: 'EUR', status: 'scheduled', auction_starts_at: new Date(now + 26 * 3600_000).toISOString(), auction_ends_at: new Date(now + 27 * 3600_000).toISOString() },
  ];
  const map = {
    catalog: catalogStatus === 200 ? env(200, { ok: true, available: true, realMoneyEnabled: false, lots }) : env(catalogStatus, { ok: false, available: false, lots: [], error: 'Verified catalogue is temporarily unavailable.' }),
    'health-web': env(200, { ok: true, component: 'web', ready: true, status: 'healthy' }),
    'health-api': env(200, { ok: true, component: 'api', ready: true, status: 'healthy' }),
    'health-realtime': env(503, { ok: false, component: 'realtime', ready: false, status: 'service-pending' }),
    'health-worker': env(503, { ok: false, component: 'worker', ready: false, status: 'service-pending' }),
  };
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify(map[res]) });
});

await run('real data (read-only): Enchev status, real lots with countdowns, no fake bids, bidding stays off', {
  query: '?seed=3&competitors=0', before: (page) => enchevFixture(page),
}, async (p) => {
  const apiCalls = [];
  p.on('request', (q) => { const u = new URL(q.url()); if (u.pathname.startsWith('/api/')) apiCalls.push(`${q.method()} ${u.pathname}`); });
  await p.click('.sidenav a[data-nav="real"]');
  await p.waitForFunction(() => document.querySelectorAll('.rlot').length === 2 && document.querySelectorAll('.svc-item').length === 4, null, { timeout: 8000 });
  const main = await p.innerText('main');
  expect(main.includes('САМО ЧЕТЕНЕ'), 'read-only notice');
  expect(main.replace(/\s/g, '').includes('EA-20001') && main.replace(/\s/g, '').includes('12500€'), 'real lot with its starting price');
  expect(/Остават:\s*0[45]:\d\d/.test(main), 'countdown to the live lot end');
  expect(/Започва след:\s*1 д 1[0-9]? ?ч|Започва след:\s*1 д \d+ ч/.test(main), 'countdown to the scheduled lot start');
  expect(main.includes('service-pending') && main.includes('Не е готова'), 'realtime service shown as not ready');
  expect(main.includes('Няма реални оферти'), 'no fabricated bids');
  expect(!(await p.locator('[data-ref="aib"]').isVisible()), 'demo AiBidder hidden on the real data view');
  await p.waitForFunction(() => window.__bidder.ctrl.david.latest?.text.startsWith('Реални данни'), null, { timeout: 5000 });
  expect(apiCalls.length >= 5 && apiCalls.every((c) => c.startsWith('GET /api/enchev')), 'only GET /api/enchev: ' + apiCalls.join(', '));
  await p.screenshot({ path: join(shots, 'desktop-real-data.png') });
  return `${apiCalls.length} GET`;
});

await run('real data (phone): unavailable catalogue is explained; 5-item nav fits', {
  ctx: PHONE(390, 844), query: '?seed=3&competitors=0', before: (page) => enchevFixture(page, { catalogStatus: 503 }),
}, async (p) => {
  await p.tap('.bottomnav a[data-nav="real"]');
  await p.waitForFunction(() => document.querySelector('[data-ref="realCatalogState"]')?.dataset.state === 'unavailable', null, { timeout: 8000 });
  expect((await text(p, 'realCatalogState')).includes('HTTP 503'), 'reason shows upstream status');
  const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(m.sw <= m.iw, `no horizontal overflow (${m.sw}/${m.iw})`);
  const small = await p.evaluate(() => [...document.querySelectorAll('.bottomnav a')].filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).length);
  expect(small === 0, 'nav targets ≥ 44 px');
  await p.screenshot({ path: join(shots, 'mobile-390-real-data.png'), fullPage: true });
});

// ---------------------------------------------------------------- analytics dashboard (Табло)
const toDashboard = async (p) => { await p.click('.sidenav a[data-nav="dashboard"]'); await p.waitForFunction(() => document.documentElement.dataset.route === 'dashboard'); };
const kpi = (p, i) => p.locator('.an-kpi b').nth(i).innerText();
const localDay = (offsetDays) => `(() => { const d = new Date(); d.setDate(d.getDate() + (${offsetDays})); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`;

await run('analytics LIVE: KPIs and charts update in realtime from server events', { query: '?seed=3&competitors=0' }, async (p) => {
  await toDashboard(p);
  expect((await text(p, 'anNote')).includes('ДЕМО ДАННИ'), 'demo data is labelled');
  expect((await kpi(p, 0)) === '0', 'no bids yet');
  await p.evaluate(() => window.__bidder.demo.server.burst(3));
  await p.waitForFunction(() => document.querySelector('.an-kpi b')?.textContent === '3', null, { timeout: 8000 });
  expect((await p.locator('[data-ref="anActivity"] rect.bar').count()) > 0, 'activity bars');
  expect((await p.locator('[data-ref="anPrice"] path.line').count()) === 1, 'live price line');
  expect((await kpi(p, 5)).startsWith('+'), 'price growth shown');
  await p.screenshot({ path: join(shots, 'desktop-analytics-live.png') });
});

await run('analytics 24H: completed auction from server events; CSV export of auctions and bids', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.evaluate(() => window.__bidder.demo.server.burst(2));
  await p.waitForFunction(() => window.__bidder.ctrl.auction.bids.length === 2, null, { timeout: 8000 });
  await p.evaluate(() => window.__bidder.demo.server.endIn(800));
  await p.waitForFunction(() => window.__bidder.ctrl.ended, null, { timeout: 8000 });
  await toDashboard(p);
  await p.click('[data-range="24h"]');
  await p.waitForFunction(() => document.querySelectorAll('.an-kpi b')[2]?.textContent === '1', null, { timeout: 5000 });
  expect((await p.locator('[data-ref="anRows"] tr').count()) === 1, 'one completed auction row');
  const [d1] = await Promise.all([p.waitForEvent('download'), p.click('[data-ref="anCsvAuctions"]')]);
  const csv1 = readFileSync(await d1.path(), 'utf8');
  expect(d1.suggestedFilename().startsWith('enchev-DEMO-auctions-24h'), d1.suggestedFilename());
  expect(csv1.startsWith('\uFEFFid,източник,лот') && csv1.includes('DEMO-0001') && csv1.includes('ДЕМО (сесия)'), 'auctions CSV content');
  const [d2] = await Promise.all([p.waitForEvent('download'), p.click('[data-ref="anCsvBids"]')]);
  const lines = readFileSync(await d2.path(), 'utf8').trim().split('\r\n');
  expect(lines.length === 3, `bids CSV = header + 2 rows (${lines.length})`);
  return d1.suggestedFilename();
});

await run('analytics history: generated DEMO history is labelled, dates filter, data is kept after reload', { query: '?seed=3&competitors=0' }, async (p) => {
  await toDashboard(p);
  await p.click('[data-ref="anGen"]');
  await p.click('[data-range="30d"]');
  const total = Number(await kpi(p, 2));
  expect(total > 50, `30D completed ${total}`);
  expect((await p.locator('.src-badge[data-src="demo-generated"]').count()) > 0, 'generated rows are labelled');
  const y = await p.evaluate(localDay(-1));
  const expected = await p.evaluate((day) => {
    const [Y, M, D] = day.split('-').map(Number);
    const a = new Date(Y, M - 1, D).getTime(), b = new Date(Y, M - 1, D + 1).getTime() - 1;
    return window.__bidder.analytics.auctions.filter((x) => x.source !== 'real' && x.endedAt !== null && x.endedAt >= a && x.endedAt <= b).length;
  }, y);
  await p.click('[data-range="custom"]');
  await p.fill('[data-ref="anFrom"]', y);
  await p.fill('[data-ref="anTo"]', y);
  await p.waitForFunction((n) => document.querySelectorAll('.an-kpi b')[2]?.textContent === String(n), expected, { timeout: 5000 });
  await p.waitForTimeout(1200); // debounced save
  await p.reload();
  await p.waitForFunction(() => window.__bidder?.ctrl.auction.lot, null, { timeout: 15000 });
  await toDashboard(p);
  await p.click('[data-range="30d"]');
  expect(Number(await kpi(p, 2)) >= total, 'history kept after reload');
  return `30D ${total}, yesterday ${expected}`;
});

await run('analytics РЕАЛНИ: only real server-recorded events — none exist, so no demo data is shown', {
  query: '?seed=3&competitors=0', before: (page) => enchevFixture(page),
}, async (p) => {
  await p.evaluate(() => window.__bidder.demo.server.burst(2));
  await toDashboard(p);
  await p.click('[data-ref="anGen"]');
  await p.click('[data-src="real"]');
  await p.waitForFunction(() => document.querySelector('[data-ref="anNote"]').textContent.includes('service-pending'), null, { timeout: 8000 });
  for (const r of ['live', '24h', '7d', '30d']) {
    await p.click(`[data-range="${r}"]`);
    const vals = await p.locator('.an-kpi b').allInnerTexts();
    expect(vals.every((v) => v === '—'), `${r}: ${vals.join(', ')}`);
    expect((await p.locator('[data-ref="anCsvAuctions"]').isDisabled()) && (await p.locator('[data-ref="anCsvBids"]').isDisabled()), 'no CSV export of demo data');
    expect((await p.locator('.src-badge').count()) === 0, 'no demo rows');
  }
  expect(!(await p.locator('[data-ref="anDemoTools"]').isVisible()), 'demo tools hidden for real data');
});

await run('analytics (phone 390): no overflow; filters, CSV and compact list usable', { ctx: PHONE(390, 844), query: '?seed=3&competitors=0' }, async (p) => {
  await p.tap('.bottomnav a[data-nav="dashboard"]');
  await p.waitForFunction(() => document.documentElement.dataset.route === 'dashboard');
  await p.evaluate(() => document.querySelector('[data-ref="anGen"]').click());
  await p.tap('[data-range="7d"]');
  await p.waitForTimeout(400);
  const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(m.sw <= m.iw, `no horizontal overflow (${m.sw}/${m.iw})`);
  const small = await p.evaluate(() => [...document.querySelectorAll('.an-range button, .an-src button, .an-actions .btn')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.height < 40 || r.width < 40); }).length);
  expect(small === 0, `${small} tap targets smaller than 40 px`);
  expect((await p.locator('[data-ref="anRows"] tr').count()) <= 16, 'list is paged on phones');
  await p.screenshot({ path: join(shots, 'mobile-390-analytics.png') });
});

await run('3D viewer: model loads (WebGL), drag rotates without errors', { query: '?seed=3&competitors=0' }, async (p) => {
  await p.waitForFunction(() => document.querySelector('[data-ref="viewer"]').dataset.viewer === 'ready', null, { timeout: 30000 });
  expect((await p.getAttribute('[data-ref="viewer"]', 'data-showroom')) === 'podium', 'showroom with podium');
  expect((await p.getAttribute('[data-ref="viewer"]', 'data-lights')) === 'studio', 'studio lights on the car');
  expect((await p.locator('.viewer-stage .ls').count()) === 5 && (await p.locator('.viewer-stage .rig').isVisible()), 'showroom wall with light strips and ceiling rig');
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

await run('round bubbles: AiBidder and AI Info are circles; panels open like a bubble from the button', { ctx: PHONE(390, 844), query: '?seed=3&competitors=0' }, async (p) => {
  const shape = await p.evaluate(() => ['aib', 'aii'].map((k) => { const e = document.querySelector(`[data-ref="${k}"]`); const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), br: getComputedStyle(e).borderRadius }; }));
  expect(shape.every((x) => x.w === x.h && x.w >= 44 && x.br === '50%'), `circles: ${JSON.stringify(shape)}`);
  await p.tap('[data-ref="aib"]');
  const a = await p.evaluate(() => { const s = getComputedStyle(document.querySelector('[data-ref="aibPanel"]')); return { anim: s.animationName, ox: parseFloat(s.getPropertyValue('--ox')), or: parseFloat(s.getPropertyValue('--or')) }; });
  expect(a.anim === 'bubble-open' && a.or > 100, `bubble opening: ${JSON.stringify(a)}`);
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(shots, 'mobile-390-bubble-open.png') });
});

await run('views: dashboard, AI, bids, history, settings render in Bulgarian', { query: '?seed=3&competitors=0' }, async (p) => {
  for (const [route, needle] of [['dashboard', 'Табло'], ['ai', 'AiBidder и DAVID'], ['bids', 'Моите оферти'], ['history', 'Транскрипт на DAVID'], ['real', 'Реални данни'], ['settings', 'Висок контраст']]) {
    await p.click(`.sidenav a[data-nav="${route}"]`);
    await p.waitForFunction((r) => document.documentElement.dataset.route === r, route);
    expect((await p.innerText('main')).includes(needle), `${route} contains ${needle}`);
    expect(!(await p.locator('.view-live').isVisible()), `${route}: the live demo view is hidden`);
  }
});

await browser.close();
srv.close();
const passed = results.filter((r) => r.status === 'pass').length;
mkdirSync(resolve(outFile, '..'), { recursive: true });
writeFileSync(outFile, JSON.stringify({ browser: `Chrome ${browserVersion} (headless, SwiftShader WebGL)`, passed, total: results.length, results }, null, 2));
console.log(`\nE2E ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
