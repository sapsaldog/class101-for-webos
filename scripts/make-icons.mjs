// Renders assets/*.svg into the PNGs webOS needs (80x80, 130x130, 1920x1080).
// Needs rsvg-convert (brew install librsvg). The PNGs are committed, so a normal
// build does not need this.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobs = [
  ['assets/icon.svg', 'app/icon.png', 80, 80],
  ['assets/icon.svg', 'app/largeIcon.png', 130, 130],
  ['assets/splash.svg', 'app/splash.png', 1920, 1080],
];
for (const [src, out, w, h] of jobs) {
  execFileSync('rsvg-convert', ['-w', String(w), '-h', String(h), '-o', path.join(root, out), path.join(root, src)]);
  console.log(`${out} ${w}x${h}`);
}
