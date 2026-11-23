// Entry point. DEMO MODE only: a simulated in-browser auction server. Real mode stays disabled
// until an authorised Enchev Auctions endpoint is configured (see src/config.ts).
import { DemoAdapter } from './adapters/demo-adapter.js';
import { DEMO_LOT, PEUGEOT_LOT } from './adapters/demo-lots.js';
import { Controller } from './app/controller.js';
import { mountApp } from './ui/render.js';
import { CONFIG } from './config.js';
import { AnalyticsStore, EventRecorder } from './analytics/store.js';
import { demoAllowed } from './analytics/sources.js';

const q = new URLSearchParams(location.search);
const num = (k: string): number | undefined => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
const latency = q.get('latency');

if (CONFIG.realMode.enabled) {
  // Intentionally unreachable in this lab: real mode needs an authorised backend and review.
  throw new Error('Real mode is not enabled in this build.');
}

const seed = num('seed');
const durationS = num('duration');
const activity = num('activity');
const skew = num('skew');
const demo = new DemoAdapter(
  {
    ...(seed !== undefined ? { seed } : {}),
    ...(durationS !== undefined ? { durationMs: durationS * 1000 } : {}),
    ...(activity !== undefined ? { activity } : {}),
    ...(skew !== undefined ? { clockSkewMs: skew } : {}),
    competitors: q.get('competitors') !== '0',
    openingBids: q.get('opening') === '1',
    // The user's own Peugeot 206 (real 3D scan) by default; ?lot=concept opens the E&A concept lot.
    lot: q.get('lot') === 'concept' ? DEMO_LOT : PEUGEOT_LOT,
  },
  {
    unstable: q.get('unstable') === '1',
    ...(latency !== null ? { latencyMs: [Number(latency), Number(latency) + 1] as [number, number] } : {}),
  },
);
const ctrl = new Controller(demo);
// Analytics history from the server's auction events. Demo events are recorded ONLY in demo builds.
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
const analytics = new AnalyticsStore(storage, () => ctrl.serverNow);
const recorder = demoAllowed(CONFIG) ? new EventRecorder(analytics, demo.bidderId, 'demo-session') : null;
if (recorder) ctrl.eventTaps.push((e) => recorder.record(e));
addEventListener('pagehide', () => analytics.flush());
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
mountApp(root, ctrl, demo, { store: analytics, recorder });
void ctrl.david.loadClips('/audio/david/manifest.json'); // your own DAVID recordings, if any
ctrl.start();
(window as unknown as { __bidder: unknown }).__bidder = { ctrl, demo, analytics, recorder };
