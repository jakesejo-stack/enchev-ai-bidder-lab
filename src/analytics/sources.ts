// Which analytics sources may be shown. In a production (real-mode) build ONLY real, server-recorded
// events are allowed: the demo recorder is never started and demo history cannot be generated.
import type { AppConfig } from '../config.js';

export type SourceKind = 'demo' | 'real';

export function availableSources(cfg: AppConfig): SourceKind[] {
  return cfg.realMode.enabled ? ['real'] : ['demo', 'real'];
}

export function defaultSource(cfg: AppConfig): SourceKind {
  return availableSources(cfg)[0]!;
}

/** True only where demo data may exist at all (never in a real-mode build). */
export function demoAllowed(cfg: AppConfig): boolean {
  return !cfg.realMode.enabled;
}
