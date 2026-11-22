// Minimal Chrome DevTools Protocol client (Node 22+ global WebSocket), so tests can
// drive an old Chromium (94 = webOS TV 23's engine) that modern Playwright no longer speaks to.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChromium(executable, { headless = true, width = 1280, height = 720, extraArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c101-chrome-'));
  const args = [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`,
    ...(headless ? ['--headless'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let wsUrl = null;
  const deadline = Date.now() + 30000;
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) wsUrl = m[1];
  });
  while (!wsUrl) {
    if (Date.now() > deadline) throw new Error('Chromium did not start:\n' + stderr.slice(-2000));
    if (proc.exitCode !== null) throw new Error('Chromium exited:\n' + stderr.slice(-2000));
    await sleep(100);
  }
  const port = new URL(wsUrl).port;
  return {
    port,
    proc,
    async close() {
      proc.kill('SIGTERM');
      await sleep(300);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export class Page {
  static async open(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => null);
    const target = res && res.ok ? await res.json() : await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`)).json();
    const page = new Page(target.webSocketDebuggerUrl);
    await page.ready;
    return page;
  }

  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject, method } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(`${method}: ${data.error.message}`));
        else resolve(data.result);
      } else if (data.method) {
        for (const fn of this.listeners.get(data.method) || []) fn(data.params);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error('eval failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  }

  async waitFor(expression, timeout = 10000, label = expression) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
  }

  async goto(url) {
    const loaded = new Promise((resolve) => {
      const done = () => resolve();
      this.on('Page.loadEventFired', done);
      setTimeout(done, 30000);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  // keyCode is what KeyboardEvent.keyCode reports on the TV (461 Back, 33 CH+, 403 red ...).
  async key(keyCode, { key = '', code = '', autoRepeat = false } = {}) {
    const base = { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, key, code, autoRepeat };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter') await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(120);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    this.ws.close();
  }
}
