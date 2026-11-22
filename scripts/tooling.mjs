// Resolves build tools from node_modules (CI / Vercel) or from environment overrides
// (offline development: ESBUILD_PATH, THREE_DIR, TSC_BIN).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

export async function loadEsbuild() {
  try { return await import('esbuild'); } catch { /* fall through */ }
  const p = process.env.ESBUILD_PATH;
  if (p && existsSync(p)) return import(pathToFileURL(join(p, 'lib/main.js')).href);
  throw new Error('esbuild not found: run npm install, or set ESBUILD_PATH');
}

export function threeDir() {
  const local = join(root, 'node_modules/three');
  if (existsSync(join(local, 'build/three.module.js'))) return local;
  if (process.env.THREE_DIR && existsSync(join(process.env.THREE_DIR, 'build/three.module.js'))) return process.env.THREE_DIR;
  throw new Error('three not found: run npm install, or set THREE_DIR');
}

export function tscBin() {
  const local = join(root, 'node_modules/.bin/tsc');
  if (existsSync(local)) return local;
  if (process.env.TSC_BIN && existsSync(process.env.TSC_BIN)) return process.env.TSC_BIN;
  throw new Error('typescript not found: run npm install, or set TSC_BIN');
}
