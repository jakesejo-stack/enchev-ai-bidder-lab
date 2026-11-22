// Document files: type detection from the file's own bytes (not its name), SHA-256, and storage.
// DEMO storage = this device only (IndexedDB, in-memory fallback). Nothing is uploaded to a server.
// A real deployment must store files server-side (private bucket, per-deal access control,
// short-lived signed URLs, malware scan) and keep the SHA-256 recorded in the deal log.
import { sha256Hex } from './chain.js';
import { ALLOWED_MIME, MAX_FILE_BYTES, type AllowedMime, type FileMeta } from './model.js';

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** File type from magic bytes. Returns null for anything that is not an allowed image or PDF. */
export function sniffMime(head: Uint8Array): AllowedMime | null {
  if (head.length >= 4 && ascii(head, 0, 4) === '%PDF') return 'application/pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head[0] === 0x89 && ascii(head, 1, 4) === 'PNG') return 'image/png';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  return null;
}

export type Prepared = { ok: true; meta: FileMeta; blob: Blob } | { ok: false; message: string };

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Validates a picked/captured file and computes its SHA-256. */
export async function prepareFile(file: Blob & { name?: string }, amount?: number): Promise<Prepared> {
  if (file.size === 0) return { ok: false, message: 'Файлът е празен.' };
  if (file.size > MAX_FILE_BYTES) return { ok: false, message: 'Файлът е над 15 MB.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes.subarray(0, 16));
  if (!mime || !(ALLOWED_MIME as readonly string[]).includes(mime)) return { ok: false, message: 'Позволени са само снимки (JPG, PNG, WEBP, HEIC) и PDF.' };
  const name = (file.name || 'snimka').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
  const meta: FileMeta = { fileId: newId(), name, mime, size: file.size, sha256: await sha256Hex(bytes), ...(amount !== undefined ? { amount } : {}) };
  return { ok: true, meta, blob: new Blob([bytes], { type: mime }) };
}

export interface FileStore {
  put(dealKey: string, meta: FileMeta, blob: Blob): Promise<void>;
  get(fileId: string): Promise<Blob | null>;
  remove(fileId: string): Promise<void>;
  removeDeal(dealKey: string): Promise<void>;
  readonly kind: 'indexeddb' | 'memory';
}

export function memoryFileStore(): FileStore {
  const m = new Map<string, { dealKey: string; blob: Blob }>();
  return {
    kind: 'memory',
    async put(dealKey, meta, blob) { m.set(meta.fileId, { dealKey, blob }); },
    async get(id) { return m.get(id)?.blob ?? null; },
    async remove(id) { m.delete(id); },
    async removeDeal(dealKey) { for (const [k, v] of m) if (v.dealKey === dealKey) m.delete(k); },
  };
}

/** IndexedDB on this device; falls back to memory where IndexedDB is unavailable (private mode). */
export async function openFileStore(): Promise<FileStore> {
  if (typeof indexedDB === 'undefined') return memoryFileStore();
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open('enchev-deal-files', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('files', { keyPath: 'fileId' }).createIndex('dealKey', 'dealKey'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  if (!db) return memoryFileStore();
  const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => new Promise((resolve, reject) => {
    const t = db.transaction('files', mode);
    const r = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return {
    kind: 'indexeddb',
    async put(dealKey, meta, blob) { await tx('readwrite', (s) => s.put({ fileId: meta.fileId, dealKey, sha256: meta.sha256, blob })); },
    async get(id) { const r = await tx<{ blob: Blob } | undefined>('readonly', (s) => s.get(id)); return r?.blob ?? null; },
    async remove(id) { await tx('readwrite', (s) => { s.delete(id); }); },
    async removeDeal(dealKey) {
      const keys = await tx<IDBValidKey[]>('readonly', (s) => s.index('dealKey').getAllKeys(dealKey));
      if (keys?.length) await tx('readwrite', (s) => { for (const k of keys) s.delete(k); });
    },
  };
}

/** Re-hashes a stored file: proves it is still the exact file that was uploaded and reviewed. */
export async function verifyStoredFile(store: FileStore, meta: FileMeta): Promise<'ok' | 'missing' | 'changed'> {
  const blob = await store.get(meta.fileId);
  if (!blob) return 'missing';
  return (await sha256Hex(await blob.arrayBuffer())) === meta.sha256 ? 'ok' : 'changed';
}

/** A FileStore usable at once; IndexedDB is opened in the background (no top-level await). */
export function lazyFileStore(): FileStore {
  const ready = openFileStore().catch(() => memoryFileStore());
  let kind: FileStore['kind'] = 'memory';
  void ready.then((s) => { kind = s.kind; });
  return {
    get kind() { return kind; },
    put: async (k, m, b) => (await ready).put(k, m, b),
    get: async (id) => (await ready).get(id),
    remove: async (id) => (await ready).remove(id),
    removeDeal: async (k) => (await ready).removeDeal(k),
  };
}
