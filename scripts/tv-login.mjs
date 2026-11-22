// Hands a Class101 login from this computer to the TV app. Every way Class101 lets
// you sign in works (Kakao, Naver, Google, Apple, Facebook, email), because you
// sign in on class101.net itself, in a real browser window:
//
//   npm run tv:login                 open a clean Chrome-family window on class101.net
//   npm run tv:login -- --manual     no browser automation: run a snippet in your own
//                                    browser's console on class101.net, paste the result
//   npm run tv:login -- --dry-run    everything except sending to the TV
//   CHROME_PATH=/path/to/browser npm run tv:login
//
// 1. Starts Chrome, Edge, Brave or Chromium with a new temporary profile and opens
//    class101.net's login page. Sign in there any way you like.
// 2. Reads the Firebase session class101.net keeps in IndexedDB over the DevTools
//    protocol, then closes the window and deletes the temporary profile.
// 3. Relaunches the TV app with the refresh token as a launch parameter over the
//    Developer Mode connection (ares-launch). The app stores it and signs in.
// The token is never printed or saved to a file.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appId = JSON.parse(fs.readFileSync(path.join(root, 'app/appinfo.json'), 'utf8')).id;
const device = process.env.TV_DEVICE || 'tv';
const args = process.argv.slice(2);
const manual = args.includes('--manual');
const dryRun = args.includes('--dry-run');
// Tests point these at a local page and run the browser headless.
const LOGIN_URL = process.env.C101TV_LOGIN_URL || 'https://class101.net/ko/login';
const HEADLESS = process.env.C101TV_LOGIN_HEADLESS === '1';
const isLoginOrigin = (url) =>
  process.env.C101TV_LOGIN_URL ? url.startsWith(new URL(LOGIN_URL).origin + '/') : /^https:\/\/([a-z0-9-]+\.)*class101\.net\//.test(url);
const TIMEOUT_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in a class101.net page: the signed-in Firebase user, if any. Aborting the
// upgrade keeps it from creating the database before Firebase does.
const READ_SESSION = `new Promise((resolve) => {
  const req = indexedDB.open('firebaseLocalStorageDb');
  req.onupgradeneeded = () => req.transaction.abort();
  req.onerror = () => resolve(null);
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('firebaseLocalStorage')) return resolve(null);
    const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
    all.onsuccess = () => {
      const r = (all.result || []).find((x) => /^firebase:authUser:/.test(x.fbase_key));
      const u = r && r.value;
      resolve(u && u.stsTokenManager && u.stsTokenManager.refreshToken ? { refreshToken: u.stsTokenManager.refreshToken, email: u.email || '' } : null);
    };
    all.onerror = () => resolve(null);
  };
})`;

// The same read, as a one-liner for a browser console (copy() is a console helper).
const CONSOLE_SNIPPET = `(async()=>{const s=await ${READ_SESSION.replace(/\s*\n\s*/g, ' ')};if(!s){console.log('클래스101에 로그인되어 있지 않아요');return}const t=JSON.stringify(s);try{copy(t);console.log('복사했어요. 터미널에 붙여넣으세요.')}catch(e){console.log(t)}})()`;

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const home = os.homedir();
  const candidates = {
    darwin: ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].flatMap((name) => [
      `/Applications/${name}.app/Contents/MacOS/${name}`,
      path.join(home, `Applications/${name}.app/Contents/MacOS/${name}`),
    ]),
    win32: [
      ['Google', 'Chrome', 'chrome.exe'],
      ['Microsoft', 'Edge', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'brave.exe'],
    ].flatMap(([vendor, product, exe]) =>
      [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
        .filter(Boolean)
        .map((base) => path.join(base, vendor, product, 'Application', exe)),
    ),
  }[process.platform];
  if (candidates) return candidates.find((p) => fs.existsSync(p)) || null;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

// Minimal DevTools protocol session on one page target (Node 22+ WebSocket).
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error('DevTools connection failed'));
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('DevTools connection closed'));
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        close: () => ws.close(),
      });
  });
}

async function viaBrowser() {
  const exe = findBrowser();
  if (!exe) {
    throw new Error('크롬 계열 브라우저(Chrome, Edge, Brave, Chromium)를 찾지 못했어요. CHROME_PATH로 지정하거나 --manual로 실행해 주세요.');
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'class101-login-'));
  const proc = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      ...(HEADLESS ? ['--headless=new'] : ['--new-window']),
      LOGIN_URL,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let exited = false;
  proc.on('exit', () => (exited = true));
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));
  const cleanup = async () => {
    if (!exited) proc.kill('SIGTERM');
    for (let i = 0; i < 30 && !exited; i++) await sleep(100);
    fs.rmSync(profile, { recursive: true, force: true });
  };
  const onSignal = () => cleanup().then(() => process.exit(130));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    let port = null;
    for (let i = 0; i < 300 && !port; i++) {
      const m = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) port = m[1];
      else if (exited) throw new Error(`브라우저가 바로 종료됐어요.\n${stderr.slice(-600)}`);
      else await sleep(100);
    }
    if (!port) throw new Error('브라우저의 DevTools 포트를 찾지 못했어요.');
    console.log(`${path.basename(exe)} 창에서 클래스101에 로그인해 주세요 (카카오·네이버·구글·애플·페이스북·이메일 모두 돼요).`);
    console.log('로그인이 끝나면 창이 저절로 닫혀요. 그만두려면 창을 닫거나 Ctrl+C.');

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error('로그인 전에 브라우저 창이 닫혔어요. 다시 실행해 주세요.');
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((r) => r.json())
        .catch(() => []);
      for (const t of targets) {
        if (t.type !== 'page' || !isLoginOrigin(t.url) || !t.webSocketDebuggerUrl) continue;
        const cdp = await connect(t.webSocketDebuggerUrl).catch(() => null);
        if (!cdp) continue;
        try {
          const res = await cdp.send('Runtime.evaluate', { expression: READ_SESSION, awaitPromise: true, returnByValue: true });
          const session = res && res.result && res.result.value;
          if (session && session.refreshToken) return session;
        } catch (e) {
          /* page navigating; try again */
        } finally {
          cdp.close();
        }
      }
      await sleep(1500);
    }
    throw new Error('10분 안에 로그인이 끝나지 않았어요. 다시 실행해 주세요.');
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

// Reads one line from the terminal without echoing it.
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => (data += d));
      stdin.on('end', () => resolve(data.trim()));
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let line = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write(line ? ' (입력됨)\n' : '\n');
          return resolve(line.trim());
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          return reject(new Error('취소했어요.'));
        }
        if (ch === '\u007f') line = line.slice(0, -1);
        else line += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function viaConsole() {
  console.log(`1. 평소 쓰는 브라우저에서 ${LOGIN_URL} 에 로그인해 주세요.`);
  console.log('2. 그 탭에서 개발자 도구 콘솔을 열고(맥: ⌥⌘J / 윈도: Ctrl+Shift+J) 아래 한 줄을 붙여넣어 실행해 주세요.');
  console.log('   (크롬이 붙여넣기를 막으면 "allow pasting"을 먼저 입력하세요.)\n');
  console.log(CONSOLE_SNIPPET + '\n');
  console.log('3. 복사된 결과를 여기에 붙여넣고 Enter를 누르세요. 화면에는 보이지 않아요.');
  const text = await readHidden('> ');
  let session = null;
  try {
    session = JSON.parse(text);
  } catch (e) {
    /* handled below */
  }
  if (!session || typeof session.refreshToken !== 'string' || session.refreshToken.length < 20) {
    throw new Error('붙여넣은 내용이 로그인 정보가 아니에요. 콘솔에 나온 결과를 그대로 붙여넣어 주세요.');
  }
  return { refreshToken: session.refreshToken, email: typeof session.email === 'string' ? session.email : '' };
}

function ares(cmd, cmdArgs) {
  return spawnSync(path.join(root, 'node_modules/.bin', cmd), cmdArgs, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  return domain ? `${name.slice(0, 2)}…@${domain}` : '(이메일 없음)';
}

try {
  const session = manual ? await viaConsole() : await viaBrowser();
  console.log(`클래스101 로그인 정보를 받았어요: ${maskEmail(session.email)}`);
  if (dryRun) {
    console.log('--dry-run: TV에는 보내지 않았어요.');
    process.exit(0);
  }
  console.log('TV 앱을 다시 실행하면서 로그인 정보를 보내는 중…');
  ares('ares-launch', ['--device', device, '--close', appId]);
  const params = JSON.stringify({ c101RefreshToken: session.refreshToken, email: session.email });
  const res = ares('ares-launch', ['--device', device, appId, '-p', params]);
  if (res.error || res.status !== 0) {
    throw new Error(
      `TV에 보내지 못했어요. TV가 켜져 있는지, 앱이 설치됐는지, npm run tv:info가 되는지 확인해 주세요.\n${((res.stderr || res.stdout || '') + '').slice(-400)}`,
    );
  }
  console.log('보냈어요. TV에 내 클래스 화면이 열리면 끝이에요.');
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
