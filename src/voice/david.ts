// DAVID voice: Bulgarian text-to-speech with captions.
// • Captions are ALWAYS produced (accessible fallback, and the transcript).
// • Speech only with a Bulgarian voice; if the device has none, DAVID stays in captions mode
//   and says so, instead of reading Bulgarian with a wrong-language voice.
// • Pause/mute affect the VOICE only. They never pause or influence the auction.
// • Voice starts muted until the user turns it on (browsers require a user gesture anyway).

export type CaptionKind = 'event' | 'alert' | 'advice' | 'system' | 'user';
export interface Caption { id: number; at: number; text: string; kind: CaptionKind; }
export type VoiceStatus = 'off' | 'idle' | 'speaking' | 'paused' | 'unavailable';

interface QueueItem { text: string; kind: CaptionKind; key?: string; }

export class David {
  captions: Caption[] = [];
  enabled = false;
  paused = false;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  supported: boolean;
  voiceChecked = false;
  speaking = false;
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private nextId = 1;
  private synth: SpeechSynthesis | null;

  constructor(private onChange: () => void, synth: SpeechSynthesis | null = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null) {
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

  get status(): VoiceStatus {
    if (!this.supported || (this.voiceChecked && !this.voice)) return this.enabled ? 'unavailable' : 'off';
    if (!this.enabled) return 'off';
    if (this.paused) return 'paused';
    return this.speaking ? 'speaking' : 'idle';
  }

  get unavailableReason(): string | null {
    if (!this.supported) return 'Браузърът не поддържа синтез на реч — DAVID показва надписи.';
    if (this.voiceChecked && !this.voice) return 'Няма инсталиран български глас на това устройство — DAVID показва надписи.';
    return null;
  }

  /** Add a caption and (if enabled) speak it. `key` coalesces: a newer item replaces a queued one. */
  say(text: string, kind: CaptionKind = 'event', key?: string): Caption {
    const cap: Caption = { id: this.nextId++, at: Date.now(), text, kind };
    this.captions.push(cap);
    if (this.captions.length > 300) this.captions.splice(0, this.captions.length - 300);
    if (this.enabled && this.voice && this.synth) {
      if (key) this.queue = this.queue.filter((q) => q.key !== key);
      const item: QueueItem = { text, kind, ...(key ? { key } : {}) };
      if (kind === 'alert') this.queue.unshift(item); else this.queue.push(item);
      if (this.queue.length > 6) this.queue.splice(6); // never fall far behind the live auction
      this.pump();
    }
    this.onChange();
    return cap;
  }

  private pump(): void {
    if (!this.synth || !this.voice || this.paused || this.current || !this.queue.length) return;
    const item = this.queue.shift()!;
    this.current = item;
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = this.voice.lang;
    u.voice = this.voice;
    u.rate = this.rate;
    const done = () => {
      if (this.current !== item) return;
      this.current = null;
      this.speaking = false;
      this.onChange();
      this.pump();
    };
    u.onend = done;
    u.onerror = done;
    this.speaking = true;
    this.synth.speak(u);
    this.onChange();
  }

  enable(on: boolean): void {
    this.enabled = on;
    if (!on) { this.queue = []; this.current = null; this.speaking = false; this.synth?.cancel(); }
    this.onChange();
  }

  /** Pauses DAVID's voice only. Implemented as cancel + requeue: speechSynthesis.pause() is unreliable on Android/Chrome. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.current) { this.queue.unshift(this.current); this.current = null; }
    this.speaking = false;
    this.synth?.cancel();
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
