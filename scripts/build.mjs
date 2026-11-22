// Builds the webOS app folder in dist/:
//   dist/appinfo.json         (version copied from package.json)
//   dist/index.html, *.png    (static shell and icons)
//   dist/app.js, dist/app.css (Preact app bundled for the TV's engine; app.js
//                              carries the media worker inline, see scripts/worker.mjs)
// It also leaves build/media.worker.js for `npm run check:compat`.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkerCode } from './worker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dev = process.argv.includes('--dev');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const appinfo = JSON.parse(fs.readFileSync(path.join(root, 'app/appinfo.json'), 'utf8'));
appinfo.version = pkg.version;
fs.writeFileSync(path.join(dist, 'appinfo.json'), JSON.stringify(appinfo, null, 2) + '\n');
// app/local/ (gitignored) can hold your own icon.png, largeIcon.png and splash.png;
// --no-local ignores it (README screenshots use the repo's icons).
const local = [];
for (const file of ['index.html', 'icon.png', 'largeIcon.png', 'splash.png']) {
  const own = path.join(root, 'app/local', file);
  const useOwn = !process.argv.includes('--no-local') && fs.existsSync(own);
  if (useOwn) local.push(file);
  fs.copyFileSync(useOwn ? own : path.join(root, 'app', file), path.join(dist, file));
}

const workerCode = await buildWorkerCode({ minify: !dev });
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/media.worker.js'), workerCode);

await esbuild.build({
  entryPoints: [path.join(root, 'src/app/main.jsx')],
  define: { __MEDIA_WORKER__: JSON.stringify(workerCode) },
  outfile: path.join(dist, 'app.js'),
  bundle: true,
  format: 'iife',
  // webOS 4 (2018, Chromium 53) and newer. The user's TV is webOS 5 (Chromium 68).
  target: ['chrome53'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'warning',
});

const size = (f) => (fs.statSync(path.join(dist, f)).size / 1024).toFixed(1);
console.log(`built dist/ v${pkg.version}: app.js ${size('app.js')} KB (worker ${(workerCode.length / 1024).toFixed(1)} KB), app.css ${size('app.css')} KB${local.length ? ` · from app/local: ${local.join(', ')}` : ''}`);
