// Renders the README screenshots into docs/screenshots/ from made-up demo data
// (test/showcase-data.mjs): no real account, no Class101 artwork. The app runs at
// the TV's 1280x720 against the mock backend, driven with remote keys.
//   npm run screenshots        (builds first; needs Google Chrome and ffmpeg)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChromium, Page } from '../test/cdp.mjs';
import { startMock } from '../test/mock-class101.mjs';
import * as showcase from '../test/showcase-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = path.join(root, 'docs/screenshots');
const tmp = path.join(root, 'test/.tmp/showcase');
const KEY = { ENTER: 13, UP: 38, DOWN: 40, BACK: 461 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });
const browser = await launchChromium(CHROME, { extraArgs: ['--headless=new', '--hide-scrollbars'] });
const page = await Page.open(browser.port);
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
// Headless pages never have window focus, and without it :focus (the remote's highlight) isn't drawn.
await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });

const press = (code, key) => page.key(code, key ? { key, code: key } : {});
const imagesLoaded = `[...document.images].every((i) => i.complete && i.naturalWidth > 0)`;
async function shot(name) {
  await sleep(500);
  const file = await page.screenshot(path.join(out, `${name}.png`));
  console.log(`${path.relative(root, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

let mock;
try {
  // The lecture "video": one slide held for 12 minutes (1 fps WebM).
  const video = path.join(tmp, 'lecture.webm');
  if (!fs.existsSync(video)) {
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(showcase.SLIDE_HTML));
    await sleep(500);
    const slide = await page.screenshot(path.join(tmp, 'slide.png'));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '1', '-i', slide,
      '-t', String(showcase.VIDEO_SECONDS), '-c:v', 'libvpx', '-b:v', '600k', '-g', '10', '-pix_fmt', 'yuv420p', video]);
  }
  mock = await startMock({ data: showcase, serveOpts: { videoFile: video } });
  const { base } = mock;
  const endpoints = JSON.stringify({ signIn: `${base}/signin`, refresh: `${base}/token`, graphql: `${base}/graphql` });

  await page.goto(`${base}/index.html`);
  await page.eval(`(() => { localStorage.clear(); localStorage.setItem('c101:endpoints', ${JSON.stringify(endpoints)}); location.reload(); })()`).catch(() => {});
  await page.waitFor(`!!document.querySelector('.login input[type=email]')`, 10000, 'login screen');
  await shot('login');

  // A made-up account that watches at 1.25x with Korean captions.
  await page.eval(`(() => {
    localStorage.setItem('c101:session', JSON.stringify({ email: 'me@example.com', idToken: 'tok-1', refreshToken: 'ref-1', expiresAt: Date.now() + 3600000 }));
    localStorage.setItem('c101:player', JSON.stringify({ rate: 1.25, captions: 'ko' }));
    location.reload();
  })()`).catch(() => {});
  await page.waitFor(`document.querySelectorAll('.home .card').length === 8 && ${imagesLoaded}`, 15000, 'home');
  await shot('home');

  await page.eval(`document.querySelector('.home .card').click()`);
  await page.waitFor(`document.querySelectorAll('.lec').length === 7 && ${imagesLoaded}`, 10000, 'curriculum');
  await shot('class');

  await press(KEY.ENTER, 'Enter'); // "이어보기" has the focus
  await page.waitFor(`(() => { const v = document.querySelector('.player video'); return v && !v.paused && v.currentTime > 250; })()`, 20000, 'playback').catch(async (err) => {
    const state = await page.eval(`(() => { const v = document.querySelector('video'); const a = document.activeElement; return { screens: [...document.querySelectorAll('.screen')].map((e) => e.className), active: a && (a.getAttribute('data-fk') || a.tagName), video: v && { src: v.currentSrc, t: v.currentTime, paused: v.paused, rs: v.readyState, err: v.error && v.error.code } }; })()`);
    throw new Error(`${err.message}\n${JSON.stringify(state)}`);
  });
  await page.waitFor(`!!document.querySelector('.player .captions')`, 8000, 'captions').catch(() => {});
  await sleep(1200);
  await press(KEY.DOWN, 'ArrowDown'); // progress overlay
  await shot('player');
  await press(KEY.UP, 'ArrowUp'); // quick menu
  await shot('menu');

  await press(KEY.BACK);
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.lec').length === 7`, 10000, 'back to the class');
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.home .card').length === 8`, 10000, 'back home');
  await page.eval(`document.querySelector('[data-fk="search"]').click()`);
  await page.waitFor(`document.querySelectorAll('.search .chip').length >= 6`, 10000, 'search');
  await page.eval(`document.querySelector('[data-fk="cat-cat1"]').click()`);
  await page.waitFor(`document.querySelectorAll('.search .card').length === 4 && ${imagesLoaded}`, 10000, 'category results');
  await page.eval(`document.querySelector('.search .card').focus()`);
  await shot('search-results');
} finally {
  page.close();
  await browser.close();
  if (mock) mock.close();
}
process.exit(0);
