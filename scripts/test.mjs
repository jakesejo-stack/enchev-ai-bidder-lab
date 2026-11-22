#!/usr/bin/env node
// Compiles tests/unit/*.test.ts with esbuild and runs them with Node's built-in test runner.
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEsbuild } from './tooling.mjs';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.test-build');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const esbuild = await loadEsbuild();
const files = readdirSync(join(root, 'tests/unit')).filter((f) => f.endsWith('.test.ts'));
await esbuild.build({
  entryPoints: files.map((f) => join(root, 'tests/unit', f)),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--test', ...files.map((f) => join(out, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
