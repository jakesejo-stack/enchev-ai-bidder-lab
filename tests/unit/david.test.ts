import { test } from 'node:test';
import assert from 'node:assert/strict';
import { David } from '../../src/voice/david.js';

// Minimal browser stand-ins for Node.
(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
  lang = ''; voice: unknown = null; rate = 1; onend: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public text: string) {}
};
function fakeSynth(voices: { lang: string }[]) {
  const spoken: string[] = [];
  const synth = {
    getVoices: () => voices,
    speak(u: { text: string; onend: (() => void) | null }) { spoken.push(u.text); setTimeout(() => u.onend?.(), 0); },
    cancel() {},
    addEventListener() {},
  };
  return { synth: synth as unknown as SpeechSynthesis, spoken };
}
function fakeAudio(mode: 'ok' | 'reject') {
  const played: string[] = [];
  const el = {
    src: '', playbackRate: 1, onended: null as ((ev: Event) => unknown) | null, onerror: null as ((ev: Event) => unknown) | null,
    play() {
      played.push(el.src);
      if (mode === 'reject') return Promise.reject(new Error('autoplay blocked'));
      setTimeout(() => el.onended?.(new Event('ended')), 0);
      return Promise.resolve();
    },
    pause() {}, removeAttribute() {},
  };
  return { make: () => el, played };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const BASE = 'https://lab.test/audio/david/manifest.json';

test('DAVID: recorded clip replaces TTS for that event; other events keep the Bulgarian voice', async () => {
  const { synth, spoken } = fakeSynth([{ lang: 'bg-BG' }]);
  const audio = fakeAudio('ok');
  const d = new David(() => {}, synth, audio.make);
  d.setClips({ new_bid: 'new_bid.mp3', not_a_key: 'x.mp3', outbid: 'https://elsewhere.example/outbid.mp3' }, BASE);
  assert.deepEqual([...d.clips.entries()], [['new_bid', '/audio/david/new_bid.mp3']], 'only known keys, same origin');
  d.enable(true);
  d.say('Има нова оферта: 43 500 евро.', 'event', 'price', 'new_bid');
  await tick();
  assert.deepEqual(audio.played, ['/audio/david/new_bid.mp3']);
  assert.ok(!spoken.some((t) => t.startsWith('Има нова оферта')), 'no TTS for an event with a clip');
  d.say('Остават 10 секунди.', 'alert', 'time', 'time_10');
  await tick();
  assert.ok(spoken.includes('Остават 10 секунди.'), 'event without a clip uses TTS');
  assert.ok(d.captions.some((c) => c.text.includes('43 500')), 'amount stays in the caption');
});

test('DAVID: blocked or failing clip falls back to the system voice', async () => {
  const { synth, spoken } = fakeSynth([{ lang: 'bg-BG' }]);
  const audio = fakeAudio('reject');
  const d = new David(() => {}, synth, audio.make);
  d.setClips({ outbid: 'outbid.mp3' }, BASE);
  d.enable(true);
  d.say('Някой те надмина: 44 000 евро.', 'alert', 'price', 'outbid');
  await tick();
  assert.equal(audio.played.length, 1);
  assert.ok(spoken.includes('Някой те надмина: 44 000 евро.'));
});

test('DAVID: with clips but no Bulgarian voice — clips play, the rest is captions only', async () => {
  const { synth, spoken } = fakeSynth([{ lang: 'en-US' }]);
  const audio = fakeAudio('ok');
  const d = new David(() => {}, synth, audio.make);
  d.setClips({ ended: 'ended.mp3' }, BASE);
  d.enable(true);
  assert.notEqual(d.status, 'unavailable');
  assert.equal(d.unavailableReason, null);
  d.say('Има нова оферта: 45 000 евро.', 'event', 'price', 'new_bid');
  d.say('Търгът приключи.', 'alert', undefined, 'ended');
  await tick();
  assert.deepEqual(audio.played, ['/audio/david/ended.mp3']);
  assert.equal(spoken.length, 0, 'never a wrong-language voice');
  assert.equal(d.captions.length, 2);
});
