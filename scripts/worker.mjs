// Bundles src/app/media.worker.js into one script string. The app build inlines it
// as __MEDIA_WORKER__ (see src/app/mediaWorker.js); tests that bundle engine
// modules themselves pass it the same way.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWorkerCode({ minify = true } = {}) {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src/app/media.worker.js')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['chrome53'],
    minify,
    legalComments: 'none',
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}
