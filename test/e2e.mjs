// End-to-end test of the TV app against a mock Class101 (auth + GraphQL + media),
// driven with simulated remote keys in Chromium 68 = the webOS 5 engine.
//
//   npm test                     (builds with --dev first)
//   node test/e2e.mjs --engine=/path/to/chromium
//
// Chromium 68: Mac snapshot 561733 from the chromium-browser-snapshots bucket,
// unzipped into ~/.cache/class101-for-webos/chromium-68/ (see README).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, Page } from './cdp.mjs';
import { startMock } from './mock-class101.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = path.join(root, 'test/fixtures/media');
const shots = path.join(root, 'test/.tmp');
const argEngine = (process.argv.find((a) => a.startsWith('--engine=')) || '').split('=')[1];
const ENGINE = argEngine || path.join(os.homedir(), '.cache/class101-for-webos/chromium-68/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
const UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 WebAppManager';
const KEY = { ENTER: 13, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, BACK: 461, CH_UP: 33, CH_DOWN: 34, BLUE: 406 };

if (!fs.existsSync(path.join(media, 'lecture1.webm'))) {
  console.error('Test videos missing: run sh test/make-media.sh (needs ffmpeg).');
  process.exit(1);
}
if (!fs.existsSync(ENGINE)) {
  console.error(`Chromium not found at ${ENGINE}`);
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await sleep(100);
  return fn();
}

// ---------------------------------------------------------------- mock Class101

const mock = await startMock();
const { base, calls } = mock; // mock.hold delays answers per operation
const server = { close: mock.close };

// ---------------------------------------------------------------- run

const browser = await launchChromium(ENGINE);
const page = await Page.open(browser.port);
const errors = [];
page.on('Runtime.exceptionThrown', (p) => errors.push((p.exceptionDetails.exception?.description || p.exceptionDetails.text || '').split('\n')[0]));
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await page.send('Network.setUserAgentOverride', { userAgent: UA });

// Screenshots are best effort: Chromium 68 headless sometimes never answers.
const shot = (name) =>
  Promise.race([page.screenshot(path.join(shots, `${name}.png`)), sleep(6000)]).catch(() => {});
// Chromium 68's CDP has no Input.insertText; send one char event per character.
async function type(text) {
  for (const ch of text) await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
}
const press = (code, key) => page.key(code, key ? { key, code: key } : {});
const active = () => page.eval(`(() => { const a = document.activeElement; return a ? (a.getAttribute('data-fk') || a.tagName) : null; })()`);
const videoState = `(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused, rate: v.playbackRate, src: v.currentSrc, tracks: v.textTracks.length } : null; })()`;

try {
  // Point the app at the mock and start clean.
  await page.goto(`${base}/index.html`);
  await page.eval(`localStorage.clear(); localStorage.setItem('c101:endpoints', ${JSON.stringify(JSON.stringify({ signIn: `${base}/signin`, refresh: `${base}/token`, graphql: `${base}/graphql`, api: `${base}/api` }))}); location.reload();`).catch(() => {});
  await page.waitFor(`!!document.querySelector('.login input[type=email]')`, 8000, 'login screen');
  await page.waitFor(`document.activeElement && document.activeElement.getAttribute('data-fk') === 'email'`, 3000, 'email focus').catch(() => {});
  check('starts on the login screen with the email field focused', (await active()) === 'email', await active());
  await shot('01-login');

  // Wrong password, then the right one.
  await type('tv@example.com');
  await press(KEY.ENTER, 'Enter');
  check('Enter in the email field moves to the password', (await active()) === 'password');
  await type('wrong');
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`/맞지 않아요/.test(document.querySelector('.error').textContent)`, 5000, 'login error');
  check('wrong password shows a Korean error', true);
  await page.eval(`document.querySelector('input[type=password]').value = ''`);
  await type('secret');
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`document.querySelectorAll('.card').length === 6`, 8000, 'home with 6 classes');
  check('login lands on 내 클래스 with the class grid', true);
  check(
    'class progress is shown as the percentage the API sends (1 → 1%, not 100%)',
    (await page.eval(`document.querySelector('[data-fk="class-k2"] .progress i').style.width`)) === '1%',
    await page.eval(`document.querySelector('[data-fk="class-k2"] .progress i').style.width`)
  );
  await page.waitFor(`document.activeElement && document.activeElement.getAttribute('data-fk') === 'hero'`, 3000, 'hero focus').catch(() => {});
  check('continue-watching hero is focused', (await active()) === 'hero', await active());
  await sleep(500);
  await shot('02-home');

  // Grid navigation and opening a class.
  await press(KEY.DOWN, 'ArrowDown');
  check('▼ from the hero reaches the first class card', (await active()) === 'class-k1', await active());
  await press(KEY.RIGHT, 'ArrowRight');
  await press(KEY.RIGHT, 'ArrowRight');
  await press(KEY.RIGHT, 'ArrowRight');
  check('▶▶▶ walks the row card by card', (await active()) === 'class-k4', await active());
  await press(KEY.DOWN, 'ArrowDown');
  check('▼ from the row end drops to the nearest card below', (await active()) === 'class-k6', await active());
  await press(KEY.UP, 'ArrowUp');
  await press(KEY.LEFT, 'ArrowLeft');
  await press(KEY.LEFT, 'ArrowLeft');
  await press(KEY.LEFT, 'ArrowLeft');
  check('◀ back to the first card', (await active()) === 'class-k1', await active());
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`document.querySelectorAll('.lec').length === 4`, 8000, 'curriculum');
  check('class screen lists the curriculum (4 lectures, 2 chapters)', (await page.eval(`document.querySelectorAll('.chapter').length`)) === 2);
  check('이어보기 is focused on the class screen', (await active()) === 'resume', await active());
  check('locked lecture is marked', await page.eval(`document.querySelector('[data-fk="lec-l4"]').classList.contains('locked')`));
  await shot('03-class');

  // Play from where we left off.
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 25; })()`, 10000, 'resume playback');
  let vs = await page.eval(videoState);
  check('player resumes at the saved position (30 s)', vs.t >= 29 && vs.t < 40, vs);

  // What class101.net's lecture page reports, so Class101 moves 이어보기 and progress.
  await until(() => calls.views.length && calls.enter.length, 3000);
  check('opening a lecture records the view (updateUserViewHistory)', calls.views.some(([k, l]) => k === 'k1' && l === 'l2'), calls.views);
  check('…and enters it with the class ticket (enterLecture)', calls.enter.some(([t, l]) => t === 'ticket-k1' && l === 'l2'), calls.enter);
  await until(() => calls.playtime.length && calls.sessions.length, 15000);
  const pt = calls.playtime[0] || { body: {} };
  check(
    '10 s of playback reports watch time for the lesson',
    pt.lessonId === 'l2' && pt.body.videoId === 'v-l2' && pt.body.interval === 10 && pt.body.playbackLocation >= 39,
    pt
  );
  check('…with the login token, a timestamp and a request id', pt.authOk === true && !isNaN(Date.parse(pt.body.timestamp)) && /^[0-9a-f-]{36}$/.test(pt.requestId || ''), pt);
  check('the view session opens 10 s after playback starts (no sessionId yet)', calls.sessions.length === 1 && calls.sessions[0][0] === '(none)' && calls.sessions[0][1] === 'l2' && calls.sessions[0][2] === true, calls.sessions);

  await sleep(600);
  await shot('04-player');

  const beforeSeek = (await page.eval(videoState)).t;
  await press(KEY.RIGHT, 'ArrowRight');
  vs = await page.eval(videoState);
  check('▶ seeks +10 s', vs.t - beforeSeek >= 9 && vs.t - beforeSeek < 12, { before: beforeSeek, after: vs.t });
  await press(KEY.ENTER, 'Enter');
  check('OK pauses', (await page.eval(videoState)).paused);
  await press(KEY.ENTER, 'Enter');
  await sleep(300);
  check('OK resumes', !(await page.eval(videoState)).paused);

  await press(KEY.UP, 'ArrowUp');
  check('▲ opens the quick menu', await page.eval(`!!document.querySelector('.c101-menu[data-show]')`));
  await press(KEY.RIGHT, 'ArrowRight');
  check('speed goes to 1.25x from the menu', (await page.eval(videoState)).rate === 1.25);
  await press(KEY.DOWN, 'ArrowDown');
  await press(KEY.RIGHT, 'ArrowRight');
  await page.waitFor(`/테스트 자막/.test((document.querySelector('.captions') || {}).textContent || '')`, 3000, 'captions shown').catch(() => {});
  check('자막 item turns on app-drawn captions (SRT parsed)', await page.eval(`/테스트 자막/.test((document.querySelector('.captions') || {}).textContent || '')`));
  await shot('05-menu');
  await press(KEY.BACK);
  check('Back closes the menu and stays in the player', await page.eval(`!document.querySelector('.c101-menu[data-show]') && !!document.querySelector('video')`));

  // Pausing saves progress for this lecture.
  await press(KEY.ENTER, 'Enter');
  await sleep(400);
  check('pausing saves the lesson position', calls.progress.some(([id, t]) => id === 'l2' && t >= 30), calls.progress);
  await press(KEY.ENTER, 'Enter');

  // End of lecture → next-up countdown → next lecture.
  await page.eval(`(() => { const v = document.querySelector('video'); v.currentTime = v.duration - 1; })()`);
  await page.waitFor(`!!document.querySelector('.next-up')`, 8000, 'next-up');
  check('ending a lecture leaves finishing it to Class101 (no completeLectureV3, as on the site)', calls.complete.length === 0, calls.complete);
  check('next-up card shows the next lecture', /실전 연습/.test(await page.eval(`document.querySelector('.next-up').textContent`)));
  await shot('06-next-up');
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`(() => { const v = document.querySelector('video'); return v && /lecture2/.test(v.currentSrc) && !v.paused; })()`, 10000, 'next lecture plays');
  check('OK on next-up plays the next lecture', true);
  check('remembered speed carries to the next lecture', (await page.eval(videoState)).rate === 1.25);

  // CH▼ goes back a lecture, while the server is slow with position saves (4 s each):
  // l3's exit save must still reach it before l2's first one, since the lesson saved
  // last is the class's last lesson.
  mock.hold.TvSetLessonProgress = 4000;
  const holdAt = Date.now();
  await until(() => calls.timeline.some((e) => e.op === 'TvSetLessonProgress' && e.lessonId === 'l3' && e.at >= holdAt), 8000);
  await sleep(1200); // l3 plays on, so its exit save has a position of its own
  await press(KEY.CH_DOWN, 'PageDown');
  await page.waitFor(`(() => { const v = document.querySelector('video'); return v && /lecture1/.test(v.currentSrc); })()`, 10000, 'previous lecture');
  check('CH▼ goes to the previous lecture', true);
  await until(() => calls.timeline.some((e) => e.op === 'TvSetLessonProgress' && e.lessonId === 'l2' && e.at >= holdAt), 15000);
  mock.hold.TvSetLessonProgress = 0;
  const savesSince = calls.timeline.filter((e) => e.op === 'TvSetLessonProgress' && e.at >= holdAt).map((e) => e.lessonId);
  check(
    'a slow save of the lecture left behind still lands before the next lecture\'s',
    savesSince.length >= 3 && savesSince.lastIndexOf('l3') < savesSince.indexOf('l2') && savesSince[savesSince.length - 1] === 'l2',
    savesSince
  );

  // Back to the class screen, focus where we were, then home.
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.lec').length === 4`, 8000, 'back to class');
  check('Back leaves the player for the class screen', true);
  check('leaving the player saved progress again', calls.progress.length >= 2, calls.progress.length);

  // Another lecture from the list, played a little (its position is saved, which is
  // what moves a class's last lesson on Class101), then Back: once the player's writes
  // are done, the class screen asks Class101 again and its 이어보기 follows.
  await page.eval(`document.querySelector('[data-fk="lec-l3"]').click()`);
  await page.waitFor(`(() => { const v = document.querySelector('video'); return v && /lecture2/.test(v.currentSrc) && !v.paused; })()`, 10000, 'l3 from the list');
  await sleep(1500);
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.lec').length === 4`, 8000, 'back to class again');
  await page.waitFor(`!!document.querySelector('.lec.current[data-fk="lec-l3"]')`, 5000, 'class screen follows').catch(() => {});
  check(
    'the class screen\'s 이어보기 follows the lesson saved last (asked again after the player)',
    await page.eval(`!!document.querySelector('.lec.current[data-fk="lec-l3"]') && /실전 연습/.test(document.querySelector('.klass__side').textContent)`)
  );
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.card').length === 6`, 8000, 'back home');
  check('Back again returns to 내 클래스 with the class card focused', (await active()) === 'class-k1', await active());
  await page.waitFor(`document.querySelector('[data-fk="class-k1"] .progress i').style.width === '50%'`, 5000, 'k1 progress').catch(() => {});
  check(
    '내 클래스 shows the progress the server now reports (l2 got watch time: 2 of 4 done)',
    (await page.eval(`document.querySelector('[data-fk="class-k1"] .progress i').style.width`)) === '50%',
    await page.eval(`document.querySelector('[data-fk="class-k1"] .progress i').style.width`)
  );
  check('the class card shows the lesson saved last (l3)', /실전 연습/.test(await page.eval(`document.querySelector('[data-fk="class-k1"] .card__meta').textContent`)));

  // 이어보기 opens that lesson (l3).
  await press(KEY.UP, 'ArrowUp');
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`(() => { const v = document.querySelector('video'); return v && /lecture2/.test(v.currentSrc) && !v.paused; })()`, 10000, 'hero playback').catch(() => {});
  check('이어보기 opens the class\'s last lesson (l3)', await page.eval(`(() => { const v = document.querySelector('video'); return !!v && /lecture2/.test(v.currentSrc); })()`));
  // CH▼ to l2 and play on, then leave while the server holds the exit save for 1.5 s and
  // press OK on 이어보기 at once. The cached list still says l3: 이어보기 must wait for
  // the reload and open l2, the lesson saved last.
  await press(KEY.CH_DOWN, 'PageDown');
  await page.waitFor(`(() => { const v = document.querySelector('video'); return v && /lecture1/.test(v.currentSrc) && !v.paused; })()`, 10000, 'l2 from the hero');
  await press(KEY.RIGHT, 'ArrowRight');
  await sleep(1500);
  mock.hold.TvSetLessonProgress = 1500;
  const backAt = Date.now();
  await press(KEY.BACK);
  await page.waitFor(`!!document.querySelector('.home') && document.activeElement && document.activeElement.getAttribute('data-fk') === 'hero'`, 5000, 'home, hero focused');
  const cachedSaysL3 = /실전 연습/.test(await page.eval(`document.querySelector('[data-fk="class-k1"] .card__meta').textContent`));
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`(() => { const v = document.querySelector('video'); return v && /lecture1/.test(v.currentSrc); })()`, 10000, 'player after the reload').catch(() => {});
  mock.hold.TvSetLessonProgress = 0;
  check(
    '이어보기 pressed while 내 클래스 reloads waits for it, then opens the lesson saved last (l2)',
    cachedSaysL3 && (await page.eval(`(() => { const v = document.querySelector('video'); return !!v && /lecture1/.test(v.currentSrc); })()`)),
    { cachedSaysL3 }
  );
  const reload = calls.timeline.find((e) => e.op === 'TvTakingClasses' && e.at >= backAt);
  const exitSaves = calls.timeline.filter((e) => e.op === 'TvSetLessonProgress' && e.at >= backAt - 100 && (!reload || e.at < reload.at));
  check(
    '내 클래스 reloads only after the server answered the player\'s exit save',
    exitSaves.length > 0 && exitSaves.every((e) => e.lessonId === 'l2' && e.doneAt) && !!reload && reload.at >= Math.max(...exitSaves.map((e) => e.doneAt)),
    { exitSaves: exitSaves.map((e) => [e.lessonId, e.at - backAt, e.doneAt - backAt]), reloadAt: reload && reload.at - backAt }
  );
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.card').length === 6 && /기초 다지기/.test(document.querySelector('[data-fk="class-k1"] .card__meta').textContent)`, 10000, 'home after l2').catch(() => {});
  check('Back from the player shows the lesson saved last on the class card (l2)', /기초 다지기/.test(await page.eval(`document.querySelector('[data-fk="class-k1"] .card__meta').textContent`)));
  check('…with the hero focused again', (await active()) === 'hero', await active());
  await press(KEY.DOWN, 'ArrowDown');

  // Finding a class: ▲▲ to the top bar's 클래스 찾기, search, open a result, come back.
  await press(KEY.UP, 'ArrowUp');
  await press(KEY.UP, 'ArrowUp');
  check('▲ from the hero reaches 클래스 찾기', (await active()) === 'search', await active());
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`!!document.querySelector('.search input')`, 5000, 'search screen');
  await page.waitFor(`document.querySelectorAll('.chip').length === 5`, 5000, 'trending + categories').catch(() => {});
  check('search screen shows trending terms and categories', (await page.eval(`document.querySelectorAll('.chip').length`)) === 5);
  check('the search field is focused', (await active()) === 'query', await active());
  await type('블로그');
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`document.querySelectorAll('.search .card').length === 3`, 8000, 'search results');
  check('search shows PLUS results and focuses the first one', (await active()) === 'found-k1', await active());
  await shot('07-search');
  await press(KEY.ENTER, 'Enter');
  await page.waitFor(`document.querySelectorAll('.lec').length === 4`, 8000, 'class from search');
  check('a result opens its curriculum', true);
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.search .card').length === 3`, 5000, 'back to results');
  check('Back returns to the same results with the card focused', (await active()) === 'found-k1', await active());
  await page.eval(`document.querySelector('[data-fk="cat-cat2"]').click()`);
  await page.waitFor(`/창업/.test(document.querySelector('.search .section-title').textContent)`, 5000, 'category results').catch(() => {});
  check('a category chip lists that category\'s PLUS classes', (await page.eval(`document.querySelectorAll('.search .card').length`)) === 2);
  await press(KEY.BACK);
  await page.waitFor(`document.querySelectorAll('.home .card').length === 6`, 5000, 'home again');

  // A refresh that fails without the login being expired (503) keeps the session:
  // 내 클래스 shows the error instead of the login screen.
  mock.fail.refresh = true;
  await page.eval(`(() => { window.__beforeReload = true; const s = JSON.parse(localStorage.getItem('c101:session')); s.expiresAt = 0; localStorage.setItem('c101:session', JSON.stringify(s)); location.reload(); })()`).catch(() => {});
  await page.waitFor(`!window.__beforeReload && !!document.querySelector('.home .error')`, 8000, 'refresh error on home').catch(() => {});
  check(
    'a failed token refresh shows an error and keeps the login',
    await page.eval(`!document.querySelector('.login') && /갱신하지 못했어요/.test((document.querySelector('.home .error') || {}).textContent || '') && !!localStorage.getItem('c101:session')`)
  );
  mock.fail.refresh = false;

  // Expired ID token is refreshed transparently.
  // The marker dies with the old page, so the wait can't pass before the reload.
  await page.eval(`(() => { window.__beforeReload = true; const s = JSON.parse(localStorage.getItem('c101:session')); s.expiresAt = 0; localStorage.setItem('c101:session', JSON.stringify(s)); location.reload(); })()`).catch(() => {});
  await page.waitFor(`!window.__beforeReload && document.querySelectorAll('.home .card').length === 6`, 8000, 'home after reload');
  check('session survives an app restart (no login screen)', true);
  check('expired ID token was refreshed', calls.refresh >= 1, calls.refresh);

  // Exit confirm at the root.
  await page.eval(`window.close = () => { window.__closed = true; }`);
  await press(KEY.BACK);
  await sleep(200);
  check('Back on 내 클래스 warns before exiting', await page.eval(`/한 번 더/.test(document.querySelector('.c101-toast').textContent)`));
  await press(KEY.BACK);
  check('second Back exits the app', await page.eval(`window.__closed === true`));

  // Logout.
  await page.eval(`document.querySelector('[data-fk="logout"]').click()`);
  await page.waitFor(`!!document.querySelector('.login')`, 5000, 'login after logout');
  await page.waitFor(`document.querySelector('input[type=email]').value === 'tv@example.com'`, 3000, 'remembered email').catch(() => {});
  check('로그아웃 returns to the login screen with the email remembered', await page.eval(`document.querySelector('input[type=email]').value === 'tv@example.com'`));
  check('…and the password field focused', (await active()) === 'password', await active());

  // Login handed over from the Mac (Google accounts): refresh token in launch params.
  const handover = async (token) => {
    const p2 = await Page.open(browser.port);
    p2.on('Runtime.exceptionThrown', (p) => errors.push((p.exceptionDetails.exception?.description || '').split('\n')[0]));
    await p2.send('Page.enable');
    await p2.send('Runtime.enable');
    await p2.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.PalmSystem = { launchParams: ${JSON.stringify(JSON.stringify({ c101RefreshToken: token, email: 'google-user@example.com' }))} };`,
    });
    await p2.goto(`${base}/index.html`);
    return p2;
  };
  await page.eval(`localStorage.removeItem('c101:session')`);
  const good = await handover('ref-1');
  await good.waitFor(`document.querySelectorAll('.card').length === 6`, 8000, 'home after hand-over').catch(() => {});
  check('a refresh token from the Mac logs the TV in (no typing)', await good.eval(`document.querySelectorAll('.card').length === 6`));
  check('…and shows the handed-over account', await good.eval(`/google-user@example.com/.test(document.querySelector('.topbar').textContent)`));
  good.close();
  await page.eval(`localStorage.removeItem('c101:session')`);
  const bad = await handover('revoked-token');
  await bad.waitFor(`!!document.querySelector('.login .error') && /로그인하지 못했어요/.test(document.querySelector('.login .error').textContent)`, 8000, 'hand-over error').catch(() => {});
  check('a bad hand-over token falls back to the login screen with a reason', await bad.eval(`/로그인하지 못했어요/.test((document.querySelector('.login .error') || {}).textContent || '')`));
  bad.close();

  check('no page exceptions', errors.length === 0, errors.slice(0, 5));
} catch (e) {
  failures++;
  console.log('  ✗ crashed:', e.message);
  await shot('crash').catch(() => {});
} finally {
  page.close();
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
