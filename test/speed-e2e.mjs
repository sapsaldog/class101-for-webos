// Speed playback end to end, in Google Chrome (it decodes H.264/AAC; Chromium 68
// snapshots can't). Lectures are Class101-shaped HLS: H.264 TS video variant plus a
// separate packed-AAC audio rendition. At 1.25x the app must use SpeedVideo (MSE,
// compressed timeline) + SpeedAudio (WSOLA) and keep content time, sound and the
// end-of-lecture flow right.
//   node test/speed-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, Page } from './cdp.mjs';
import { startMock } from './mock-class101.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(path.join(root, 'test/fixtures/media/class101/master.m3u8'))) {
  console.error('HLS fixture missing: run sh test/make-media.sh');
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMock({ videoFor: (l, base) => `${base}/media/class101/master.m3u8?Policy=p&Signature=s` });
const { base, calls } = mock;
const browser = await launchChromium(CHROME, { extraArgs: ['--headless=new'] });
const page = await Page.open(browser.port);
const errors = [];
page.on('Runtime.exceptionThrown', (p) => errors.push((p.exceptionDetails.exception?.description || '').split('\n')[0]));
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

const state = `(() => {
  const v = document.querySelector('.player video');
  if (!v) return null;
  return { src: v.currentSrc.slice(0, 5), t: v.currentTime, paused: v.paused, muted: v.muted, rate: v.playbackRate,
    osd: (document.querySelector('.c101-osd__time') || {}).textContent || '' };
})()`;

try {
  await page.goto(`${base}/index.html`);
  await page.eval(`(() => {
    localStorage.clear();
    localStorage.setItem('c101:endpoints', ${JSON.stringify(JSON.stringify({ signIn: `${base}/signin`, refresh: `${base}/token`, graphql: `${base}/graphql` }))});
    localStorage.setItem('c101:session', JSON.stringify({ email: 'tv@example.com', idToken: 'tok-1', refreshToken: 'ref-1', expiresAt: Date.now() + 3600000 }));
    localStorage.setItem('c101:player', JSON.stringify({ rate: 1.25, captions: '' }));
    location.reload();
  })()`).catch(() => {});
  await page.waitFor(`document.querySelectorAll('.home .card').length === 6`, 10000, 'home');
  await page.eval(`document.querySelector('[data-fk="hero"]').click()`);
  await page.waitFor(`(() => { const v = document.querySelector('.player video'); return v && /^blob:/.test(v.currentSrc) && !v.paused && v.currentTime > 0.3; })()`, 20000, 'speed playback');
  check('1.25x on an HLS lecture plays through MSE (blob: source)', true);
  const a = await page.eval(state);
  check('the <video> itself runs at 1x and muted (sound comes from Web Audio)', a.rate === 1 && a.muted, a);

  // Resume point is 30 s of content; at 1.25x that is media time 24 s.
  const c0 = await page.eval(`(() => { const v = document.querySelector('.player video'); return { media: v.currentTime, wall: performance.now() }; })()`);
  check('resumes at the saved content position (30 s → media 24 s)', c0.media >= 23.5 && c0.media < 30, c0.media);
  await sleep(4000);
  const c1 = await page.eval(`(() => { const v = document.querySelector('.player video'); return { media: v.currentTime, wall: performance.now() }; })()`);
  const contentRate = ((c1.media - c0.media) * 1.25) / ((c1.wall - c0.wall) / 1000);
  check('content advances ~1.25 s per second', contentRate > 1.15 && contentRate < 1.35, contentRate.toFixed(2));
  const audio = await page.eval(`(() => { const a = window.__c101Player.audio; return { sources: a.sources.length, drift: Math.round(a.drift() * 1000) + 0, ctx: a.ctx && a.ctx.state }; })()`);
  check('stretched audio is scheduled and within ±200 ms of the picture', audio.sources > 0 && Math.abs(audio.drift) <= 200 && audio.ctx === 'running', audio);

  await page.eval(`document.querySelector('.player video').dispatchEvent(new Event('x'))`);
  await page.key(40, { key: 'ArrowDown', code: 'ArrowDown' });
  const osd = (await page.eval(state)).osd;
  check('OSD shows content time, not media time', /^0?0:3\d|^00:4\d/.test(osd), osd);

  // Seek +10 s of content.
  const before = await page.eval(`document.querySelector('.player video').currentTime * 1.25`);
  await page.key(39, { key: 'ArrowRight', code: 'ArrowRight' });
  await sleep(1500);
  const after = await page.eval(`document.querySelector('.player video').currentTime * 1.25`);
  check('▶ seeks +10 s of content in speed mode', after - before > 9 && after - before < 13, (after - before).toFixed(2));

  // Back to 1x switches to the native path (Chrome can't play HLS natively, so only check the switch).
  await page.key(403); // red: 1.25 → 1
  await sleep(800);
  const native = await page.eval(`(() => { const v = document.querySelector('.player video'); return { src: v.getAttribute('src') || '', muted: v.muted }; })()`);
  check('1x hands playback back to the native player (HLS src, unmuted)', /master\.m3u8/.test(native.src) && !native.muted, native);

  // And up again: 1.5x rebuilds the speed pipeline near the same content position.
  await page.key(404); // green: 1 → 1.25
  await page.key(404); // green: 1.25 → 1.5
  await page.waitFor(`(() => { const v = document.querySelector('.player video'); return v && /^blob:/.test(v.currentSrc) && !v.paused; })()`, 15000, '1.5x speed playback').catch(() => {});
  const fast = await page.eval(`(() => { const v = document.querySelector('.player video'); return { content: v.currentTime * 1.5, blob: /^blob:/.test(v.currentSrc) }; })()`);
  check('1.5x resumes in speed mode near the same content position', fast.blob && fast.content > 30 && fast.content < 70, fast);

  // Jump near the end and let it finish → completion + next-up.
  await page.key(57, { key: '9', code: 'Digit9' });
  await page.waitFor(`!!document.querySelector('.next-up')`, 20000, 'next-up after end').catch(() => {});
  check('finishing a lecture in speed mode completes it and offers the next one', !!(await page.eval(`!!document.querySelector('.next-up')`)) && calls.complete.length > 0, calls.complete);
  check('progress saved in content seconds', calls.progress.some(([id, t]) => t > 30), calls.progress.slice(-3));
  check('no page exceptions', errors.length === 0, errors.slice(0, 5));
} catch (e) {
  failures++;
  console.log('  ✗ crashed:', e.message);
} finally {
  page.close();
  await browser.close();
  mock.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
