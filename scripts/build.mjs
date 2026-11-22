#!/usr/bin/env node
// Production build: bundles src/ with esbuild into dist/, copies public/, injects the hashed entry.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEsbuild, threeDir } from './tooling.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const model = join(root, 'public/models/ea-demo-concept-coupe.glb');
if (!existsSync(model)) {
  // Original E&A procedural model; the generator is deterministic and dependency-free.
  const r = spawnSync(process.execPath, [join(root, 'scripts/generate-demo-concept-glb.mjs')], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'public'), dist, { recursive: true });

// Font: the repo ships a Latin+Cyrillic Montserrat subset. If it is absent (e.g. a source-only upload),
// fall back to the same family from @fontsource-variable/montserrat (OFL), else system fonts.
if (!existsSync(join(dist, 'fonts/montserrat-var.woff'))) {
  const fs = join(root, 'node_modules/@fontsource-variable/montserrat/files');
  const faces = [['latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'], ['cyrillic', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116']];
  const found = faces.filter(([sub]) => existsSync(join(fs, `montserrat-${sub}-wght-normal.woff2`)));
  if (found.length) {
    mkdirSync(join(dist, 'fonts'), { recursive: true });
    let css = '';
    for (const [sub, range] of found) {
      cpSync(join(fs, `montserrat-${sub}-wght-normal.woff2`), join(dist, `fonts/montserrat-${sub}.woff2`));
      css += `@font-face{font-family:"Montserrat EA";src:url("/fonts/montserrat-${sub}.woff2") format("woff2");font-weight:100 900;font-display:swap;unicode-range:${range}}\n`;
    }
    const stylesPath = join(dist, 'styles.css');
    writeFileSync(stylesPath, css + readFileSync(stylesPath, 'utf8'));
    console.log('font: @fontsource-variable/montserrat (' + found.map((f) => f[0]).join(', ') + ')');
  } else {
    console.warn('font: Montserrat not available — using system fonts');
  }
  // Drop the preload for the absent subset file.
  const indexPath = join(dist, 'index.html');
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace(/<link rel="preload" href="\/fonts\/montserrat-var\.woff"[^>]*>\n?/, ''));
}

const esbuild = await loadEsbuild();
const three = threeDir();
// The Porsche demo lot switches on automatically once its approved GLB is added to the repo.
const porscheGlb = existsSync(join(root, 'public/models/porsche-911-gt3.glb'));
console.log(`model: ${porscheGlb ? 'Porsche 911 GT3 GLB (public/models/porsche-911-gt3.glb)' : 'E&A concept (no Porsche GLB yet)'}`);
const result = await esbuild.build({
  entryPoints: { app: join(root, 'src/main.ts') },
  bundle: true, splitting: true, format: 'esm', target: ['es2020', 'safari15'], minify: true, sourcemap: 'linked',
  outdir: join(dist, 'assets'), entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
  alias: { three: join(three, 'build/three.module.js'), 'three/examples': join(three, 'examples') },
  metafile: true, legalComments: 'linked', logLevel: 'warning',
  define: { __PORSCHE_GLB__: JSON.stringify(porscheGlb) },
});
const entry = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint && o.entryPoint.endsWith('src/main.ts'));
if (!entry) throw new Error('entry output not found');
const appPath = '/' + relative(dist, join(root, entry[0])).replaceAll('\\', '/');
const htmlPath = join(dist, 'index.html');
writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('%APP_JS%', appPath));

const sizes = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js')).map((f) => `${f} ${(statSync(join(dist, 'assets', f)).size / 1024).toFixed(1)} KB`);
console.log(`BUILD OK entry=${appPath}\n  ${sizes.join('\n  ')}`);
