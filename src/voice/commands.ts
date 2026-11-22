// Bulgarian voice commands via the Web Speech API (where available).
// Commands can only INFORM or OPEN the confirmation dialog — they never place a bid.

export type VoiceCommand = 'price' | 'open_bid' | 'pause_voice' | 'resume_voice' | 'limit' | 'unknown';

export function parseCommand(text: string): VoiceCommand {
  const t = text.toLowerCase();
  if (/пауза|спри гласа|тихо/.test(t)) return 'pause_voice';
  if (/продължи|пусни гласа/.test(t)) return 'resume_voice';
  if (/наддай|оферта|наддаване/.test(t)) return 'open_bid';
  if (/лимит/.test(t)) return 'limit';
  if (/цена|колко|текущ/.test(t)) return 'price';
  return 'unknown';
}

export type MicState = 'unsupported' | 'idle' | 'listening' | 'denied' | 'error';

interface RecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export class Microphone {
  state: MicState;
  private rec: RecognitionLike | null = null;
  constructor(private onText: (t: string) => void, private onChange: () => void) {
    const w = globalThis as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    this.state = Ctor ? 'idle' : 'unsupported';
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'bg-BG';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? '';
      if (text) this.onText(text);
    };
    rec.onerror = (e) => {
      this.state = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'denied' : 'error';
      this.onChange();
    };
    rec.onend = () => {
      if (this.state === 'listening') this.state = 'idle';
      this.onChange();
    };
    this.rec = rec;
  }

  toggle(): void {
    if (!this.rec) return;
    if (this.state === 'listening') { this.rec.stop(); this.state = 'idle'; this.onChange(); return; }
    try {
      this.rec.start();
      this.state = 'listening';
    } catch {
      this.state = 'error';
    }
    this.onChange();
  }
}
