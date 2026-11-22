// Entry point. DEMO MODE only: a simulated in-browser auction server. Real mode stays disabled
// until an authorised Enchev Auctions endpoint is configured (see src/config.ts).
import { DemoAdapter } from './adapters/demo-adapter.js';
import { Controller } from './app/controller.js';
import { mountApp } from './ui/render.js';
import { CONFIG } from './config.js';

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
  },
  {
    unstable: q.get('unstable') === '1',
    ...(latency !== null ? { latencyMs: [Number(latency), Number(latency) + 1] as [number, number] } : {}),
  },
);
const ctrl = new Controller(demo);
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
mountApp(root, ctrl, demo);
void ctrl.david.loadClips('/audio/david/manifest.json'); // your own DAVID recordings, if any
ctrl.start();
(window as unknown as { __bidder: unknown }).__bidder = { ctrl, demo };
