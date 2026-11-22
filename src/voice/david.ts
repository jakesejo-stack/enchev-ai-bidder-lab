// DAVID — the voice of the auction (announces events). Advice lives in AiBidder, not here.
// • Captions are ALWAYS produced (accessible fallback, and the transcript).
// • Voice sources, in order: your own recorded clip for that event (public/audio/david/manifest.json)
//   → a Bulgarian system voice (speechSynthesis) → captions only. Never a wrong-language voice.
// • Recorded clips are fixed phrases ("Нова оферта!"); amounts always appear in the caption.
// • Pause/mute affect the VOICE only. They never pause or influence the auction.
// • Voice starts muted until the user turns it on (browsers require a user gesture anyway).

export type CaptionKind = 'event' | 'alert' | 'advice' | 'system' | 'user';
export interface Caption { id: number; at: number; text: string; kind: CaptionKind; }
export type VoiceStatus = 'off' | 'idle' | 'speaking' | 'paused' | 'unavailable';

/** Event keys that can have a recorded clip, with what the recording should say (Bulgarian). */
export const CLIP_KEYS = {
  connected: 'Свързан съм с търга.',
  new_bid: 'Има нова оферта.',
  outbid: 'Някой те надмина.',
  you_lead: 'Твоята оферта е най-високата.',
  extended: 'Търгът е удължен.',
  time_60: 'Остава една минута.',
  time_30: 'Остават трийсет секунди.',
  time_10: 'Остават десет секунди.',
  ended: 'Търгът приключи.',
  ended_won: 'Търгът приключи. Твоята оферта е най-високата.',
  connection_lost: 'Връзката е прекъсната. Наддаването е спряно.',
  connection_back: 'Връзката е възстановена.',
  offline: 'Устройството е без интернет.',
  bid_rejected: 'Офертата не е приета.',
  voice_on: 'Гласът на DAVID е включен.',
  confirm_opened: 'Отворих потвърждението. Провери сумата и потвърди.',
} as const;
export type ClipKey = keyof typeof CLIP_KEYS;
export const isClipKey = (k: string): k is ClipKey => Object.prototype.hasOwnProperty.call(CLIP_KEYS, k);

interface QueueItem { text: string; kind: CaptionKind; key?: string; clip?: ClipKey; }
interface AudioLike {
  src: string; playbackRate: number;
  onended: ((ev: Event) => unknown) | null; onerror: ((ev: Event) => unknown) | null;
  play(): Promise<void>; pause(): void; removeAttribute(name: string): void;
}

export class David {
  captions: Caption[] = [];
  enabled = false;
  paused = false;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  supported: boolean;
  voiceChecked = false;
  speaking = false;
  /** Recorded clips available on this deployment (event key → same-origin URL). */
  readonly clips = new Map<ClipKey, string>();
  /** Clips actually played (for the transcript/tests). */
  readonly playedClips: ClipKey[] = [];
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private nextId = 1;
  private synth: SpeechSynthesis | null;
  private audio: AudioLike | null = null;

  constructor(
    private onChange: () => void,
    synth: SpeechSynthesis | null = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null,
    private makeAudio: (() => AudioLike) | null = typeof Audio !== 'undefined' ? () => new Audio() : null,
  ) {
    this.synth = synth;
    this.supported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
    if (this.synth) {
      this.pickVoice();
      this.synth.addEventListener?.('voiceschanged', () => { this.pickVoice(); this.onChange(); });
      setTimeout(() => { this.voiceChecked = true; this.onChange(); }, 1500);
    } else {
      this.voiceChecked = true;
    }
  }

  private pickVoice(): void {
    const voices = this.synth?.getVoices() ?? [];
    this.voice = voices.find((v) => v.lang.toLowerCase() === 'bg-bg') ?? voices.find((v) => v.lang.toLowerCase().startsWith('bg')) ?? null;
    if (voices.length) this.voiceChecked = true;
  }

  /** Loads the clip manifest. Missing/invalid manifest = no clips (TTS or captions). Same-origin files only. */
  async loadClips(url = '/audio/david/manifest.json'): Promise<void> {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return;
      this.setClips(((await res.json()) as { clips?: Record<string, unknown> }).clips ?? {}, new URL(url, location.href).href);
    } catch { /* no clips */ }
  }

  setClips(map: Record<string, unknown>, baseUrl: string): void {
    this.clips.clear();
    const origin = new URL(baseUrl).origin;
    for (const [k, file] of Object.entries(map)) {
      if (!isClipKey(k) || typeof file !== 'string' || !file.trim()) continue;
      const u = new URL(file.trim(), baseUrl);
      if (u.origin !== origin) continue; // CSP: media-src 'self'
      this.clips.set(k, u.pathname + u.search);
    }
    this.onChange();
  }

  private get canTts(): boolean { return !!this.synth && !!this.voice && this.supported; }
  private get hasClips(): boolean { return this.clips.size > 0 && !!this.makeAudio; }

  get status(): VoiceStatus {
    if (!this.hasClips && (!this.supported || (this.voiceChecked && !this.voice))) return this.enabled ? 'unavailable' : 'off';
    if (!this.enabled) return 'off';
    if (this.paused) return 'paused';
    return this.speaking ? 'speaking' : 'idle';
  }

  get unavailableReason(): string | null {
    if (this.hasClips) return null;
    if (!this.supported) return 'Браузърът не поддържа синтез на реч — DAVID показва надписи.';
    if (this.voiceChecked && !this.voice) return 'Няма инсталиран български глас на това устройство — DAVID показва надписи.';
    return null;
  }

  /** Short description of the voice source for settings. */
  get audioInfo(): string {
    const n = this.clips.size, total = Object.keys(CLIP_KEYS).length;
    if (!n) return `Собствени аудио записи: няма (0 от ${total}). DAVID ползва ${this.canTts ? 'български синтезиран глас' : 'само надписи'}.`;
    return `Собствени аудио записи: ${n} от ${total}. За останалите събития: ${this.canTts ? 'синтезиран глас' : 'само надписи'}.`;
  }

  /** Add a caption and (if enabled) voice it. `key` coalesces: a newer item replaces a queued one. */
  say(text: string, kind: CaptionKind = 'event', key?: string, clip?: ClipKey): Caption {
    const cap: Caption = { id: this.nextId++, at: Date.now(), text, kind };
    this.captions.push(cap);
    if (this.captions.length > 300) this.captions.splice(0, this.captions.length - 300);
    const voiced = (clip && this.hasClips && this.clips.has(clip)) || this.canTts;
    if (this.enabled && voiced) {
      if (key) this.queue = this.queue.filter((q) => q.key !== key);
      const item: QueueItem = { text, kind, ...(key ? { key } : {}), ...(clip ? { clip } : {}) };
      if (kind === 'alert') this.queue.unshift(item); else this.queue.push(item);
      if (this.queue.length > 6) this.queue.splice(6); // never fall far behind the live auction
      this.pump();
    }
    this.onChange();
    return cap;
  }

  private finish(item: QueueItem): void {
    if (this.current !== item) return;
    this.current = null;
    this.speaking = false;
    this.onChange();
    this.pump();
  }

  private pump(): void {
    if (this.paused || this.current || !this.queue.length) return;
    const item = this.queue.shift()!;
    const url = item.clip && this.hasClips ? this.clips.get(item.clip) : undefined;
    this.current = item;
    if (url) this.playClip(item, url);
    else if (this.canTts) this.speakTts(item);
    else { this.current = null; this.pump(); }
  }

  private playClip(item: QueueItem, url: string): void {
    const a = (this.audio ??= this.makeAudio!());
    let settled = false;
    const fallback = () => {
      if (settled || this.current !== item) return;
      settled = true;
      if (this.canTts) this.speakTts(item); else this.finish(item);
    };
    a.onended = () => { if (!settled) { settled = true; this.finish(item); } };
    a.onerror = fallback;
    a.src = url;
    a.playbackRate = this.rate;
    this.speaking = true;
    this.playedClips.push(item.clip!);
    this.onChange();
    a.play().catch(fallback); // autoplay blocked or file missing → system voice / captions
  }

  private speakTts(item: QueueItem): void {
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = this.voice!.lang;
    u.voice = this.voice;
    u.rate = this.rate;
    u.onend = () => this.finish(item);
    u.onerror = () => this.finish(item);
    this.speaking = true;
    this.synth!.speak(u);
    this.onChange();
  }

  private stopOutput(): void {
    this.synth?.cancel();
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); }
  }

  enable(on: boolean): void {
    this.enabled = on;
    if (!on) { this.queue = []; this.current = null; this.speaking = false; this.stopOutput(); }
    this.onChange();
  }

  /** Pauses DAVID's voice only. Implemented as stop + requeue: speechSynthesis.pause() is unreliable on Android/Chrome. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.current) { this.queue.unshift(this.current); this.current = null; }
    this.speaking = false;
    this.stopOutput();
    this.onChange();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.onChange();
    this.pump();
  }

  setRate(r: number): void {
    this.rate = Math.min(1.6, Math.max(0.7, r));
    this.onChange();
  }

  get latest(): Caption | null { return this.captions[this.captions.length - 1] ?? null; }
}
