export interface ViewerHandle { destroy(): void; }
export function mountViewer(
  host: HTMLElement,
  opts: { modelUrl: string; scan?: boolean; length?: number; onState?: (s: 'loading' | 'ready' | 'fallback', detail?: string) => void; reducedMotion?: boolean; maxDpr?: number },
): ViewerHandle;
