// scripts/tv-login.mjs without a real Class101 login or TV: a local page plays
// class101.net and writes a Firebase session into IndexedDB a moment after loading
// (like a finished sign-in); the script must pick it up, mask the email, delete its
// temporary browser profile, and (with --dry-run) not call the TV.
//   node test/login.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOKEN = 'ref-test-0123456789abcdef0123456789';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
}

const page = `<!doctype html><title>login</title><script>
setTimeout(() => {
  const req = indexedDB.open('firebaseLocalStorageDb', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
  req.onsuccess = () => {
    const tx = req.result.transaction('firebaseLocalStorage', 'readwrite');
    tx.objectStore('firebaseLocalStorage').put({ fbase_key: 'firebase:authUser:KEY:[DEFAULT]', value: { email: 'tv@example.com', stsTokenManager: { refreshToken: ${JSON.stringify(TOKEN)} } } });
  };
}, 2500);
</script>`;
const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/ko/login`;

const profilesBefore = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('class101-login-')).length;
const run = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(root, 'scripts/tv-login.mjs'), '--dry-run'], {
    env: { ...process.env, C101TV_LOGIN_URL: url, C101TV_LOGIN_HEADLESS: '1', CHROME_PATH: CHROME },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, out });
  });
});
server.close();
check('browser login: picks up the session once the page signs in', run.code === 0 && /tv…@example\.com/.test(run.out), run.out.trim().split('\n').slice(-2));
check('browser login: never prints the token', !run.out.includes(TOKEN));
check('browser login: --dry-run does not contact the TV', /--dry-run/.test(run.out) && !/보내는 중/.test(run.out));
const profilesAfter = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('class101-login-')).length;
check('browser login: temporary profile deleted', profilesAfter <= profilesBefore, { profilesBefore, profilesAfter });

const pasted = spawnSync(process.execPath, [path.join(root, 'scripts/tv-login.mjs'), '--manual', '--dry-run'], {
  input: JSON.stringify({ refreshToken: TOKEN, email: 'me@example.com' }),
  encoding: 'utf8',
});
check('--manual: accepts the pasted console result', pasted.status === 0 && /me…@example\.com/.test(pasted.stdout), (pasted.stdout + pasted.stderr).trim().split('\n').slice(-1));
check('--manual: never prints the token', !(pasted.stdout + pasted.stderr).includes(TOKEN));
const junk = spawnSync(process.execPath, [path.join(root, 'scripts/tv-login.mjs'), '--manual', '--dry-run'], { input: 'hello', encoding: 'utf8' });
check('--manual: rejects text that is not a session', junk.status === 1 && /로그인 정보가 아니에요/.test(junk.stderr), junk.stderr.trim());

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
