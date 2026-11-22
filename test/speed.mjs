// SpeedAudio in a real engine (Chromium 68 = webOS 5): a muted video plays at 1.25x
// while the HLS audio rendition is time-stretched through Web Audio. Checks that
// audio gets scheduled and stays within the drift budget across pause and seek.
//   node test/speed.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { launchChromium, Page } from './cdp.mjs';
import { buildWorkerCode } from '../scripts/worker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = path.join(root, 'test/fixtures/media');
const ENGINE = path.join(os.homedir(), '.cache/class101-for-webos/chromium-68/chrome-mac/Chromium.app/Contents/MacOS/Chromium');

const bundle = await esbuild.build({
  stdin: { contents: "import { SpeedAudio } from './src/app/speedAudio.js'; window.SpeedAudio = SpeedAudio;", resolveDir: root },
  bundle: true,
  write: false,
  format: 'iife',
  target: ['chrome53'],
  define: { __MEDIA_WORKER__: JSON.stringify(await buildWorkerCode({ minify: false })) },
});
const js = bundle.outputFiles[0].text;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><video id="v" src="/media/lecture1.webm" preload="auto"></video><script>${js}</script>`);
  }
  const file = path.join(media, path.normalize(url.pathname.replace(/^\/media\//, '')));
  if (!file.startsWith(media) || !fs.existsSync(file)) return res.writeHead(404).end();
  const type = { '.webm': 'video/webm', '.wav': 'audio/wav', '.m3u8': 'application/vnd.apple.mpegurl' }[path.extname(file)];
  res.writeHead(200, { 'content-type': type || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChromium(ENGINE);
const page = await Page.open(browser.port);
const errors = [];
page.on('Runtime.exceptionThrown', (p) => errors.push((p.exceptionDetails.exception?.description || '').split('\n')[0]));
await page.send('Page.enable');
await page.send('Runtime.enable');
try {
  await page.goto(`${base}/`);
  await page.eval(`(() => {
    const v = document.getElementById('v');
    window.created = 0;
    const orig = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () { window.created++; return orig.call(this); };
    window.errorsSeen = [];
    window.engine = new SpeedAudio(v, '${base}/media/speed/master.m3u8?Policy=x', { onError: (e) => window.errorsSeen.push(e.message) });
    v.play();
    v.playbackRate = 1.25;
    window.engine.setRate(1.25);
  })()`);
  await page.waitFor(`window.created > 0`, 8000, 'audio scheduled').catch(() => {});
  check('stretched audio gets scheduled', (await page.eval('window.created')) > 0, await page.eval('window.errorsSeen'));
  check('the video is muted while the engine plays', await page.eval(`document.getElementById('v').muted === true`));

  const drifts = [];
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    drifts.push(await page.eval('(Math.round(window.engine.drift() * 1000) + 0)'));
  }
  check('audio stays within ±200 ms of the picture at 1.25x', drifts.every((d) => Math.abs(d) <= 200), drifts);

  await page.eval(`document.getElementById('v').pause()`);
  await sleep(500);
  check('pause stops the stretched audio', (await page.eval('window.engine.sources.length')) === 0);
  await page.eval(`document.getElementById('v').play()`);
  await sleep(1500);
  check('play resumes it', (await page.eval('window.engine.sources.length')) > 0);

  await page.eval(`document.getElementById('v').currentTime = 20`);
  await sleep(2500);
  const d = await page.eval('(Math.round(window.engine.drift() * 1000) + 0)');
  check('after a seek the audio re-locks to the picture', Math.abs(d) <= 200, d);

  await page.eval(`window.engine.setRate(1)`);
  await sleep(300);
  check('back to 1x hands sound back to the player (unmuted, engine idle)', await page.eval(`!document.getElementById('v').muted && window.engine.sources.length === 0`));
  check('no engine errors', (await page.eval('window.errorsSeen.length')) === 0, await page.eval('window.errorsSeen'));
  check('no page exceptions', errors.length === 0, errors);
} catch (e) {
  failures++;
  console.log('  ✗ crashed:', e.message);
} finally {
  page.close();
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
