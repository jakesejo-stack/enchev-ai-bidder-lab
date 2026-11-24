// Server-clock estimation. The countdown is always derived from the server's end time and an
// estimated offset between the server clock and this device — never from a local timer alone.
// Offset is estimated NTP-style from request/response pairs, preferring low round-trip samples.

export interface ClockSample {
  sentAt: number; // local ms when the time request left
  serverTime: number; // server ms in the response
  receivedAt: number; // local ms when the response arrived
}

export class ServerClock {
  private offset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  private samples = 0;
  constructor(private readonly localNow: () => number = () => Date.now()) {}

  sample({ sentAt, serverTime, receivedAt }: ClockSample): void {
    const rtt = Math.max(0, receivedAt - sentAt);
    const estimate = serverTime + rtt / 2 - receivedAt;
    if (this.samples === 0) {
      this.offset = estimate;
      this.bestRtt = rtt;
    } else if (rtt <= this.bestRtt * 1.5 + 20) {
      // Trust low-latency samples; smooth to avoid countdown jumps.
      this.offset = this.offset * 0.7 + estimate * 0.3;
      this.bestRtt = Math.min(this.bestRtt, rtt);
    }
    this.samples++;
  }

  /** Push events carry a serverTime but no RTT: only use them to catch large drift. */
  observeServerTime(serverTime: number, receivedAt: number): void {
    const estimate = serverTime - receivedAt;
    if (this.samples === 0) { this.offset = estimate; this.samples = 1; return; }
    // Event delivery latency makes estimates late (server time older): only correct if we are clearly behind.
    if (estimate > this.offset + 1000) this.offset = estimate;
  }

  get offsetMs(): number { return this.offset; }
  get synced(): boolean { return this.samples > 0; }
  now(): number { return this.localNow() + this.offset; }
  remainingMs(endsAt: number): number { return Math.max(0, endsAt - this.now()); }
}

export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
