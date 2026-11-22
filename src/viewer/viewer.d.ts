export interface ViewerHandle { destroy(): void; }
export function mountViewer(
  host: HTMLElement,
  opts: { modelUrl: string; onState?: (s: 'loading' | 'ready' | 'fallback', detail?: string) => void; reducedMotion?: boolean; maxDpr?: number },
): ViewerHandle;
