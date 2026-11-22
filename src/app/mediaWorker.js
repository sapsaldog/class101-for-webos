// Client for media.worker.js. The build inlines the bundled worker as the string
// __MEDIA_WORKER__ (scripts/worker.mjs); it runs from a blob: URL, which webOS
// allows for packaged (file://) apps. One worker per role, kept for the app's
// lifetime, so stretching sound never waits behind a video segment. If workers
// are unavailable the same code runs on the page instead.

const workers = {};

function inline(code, deliver) {
  const scope = { onmessage: null, postMessage: (data) => setTimeout(() => deliver(data), 0) };
  new Function('self', code)(scope);
  return { postMessage: (data) => setTimeout(() => scope.onmessage({ data }), 0) };
}

class MediaWorker {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.broken = null;
    const code = typeof __MEDIA_WORKER__ === 'string' ? __MEDIA_WORKER__ : '';
    if (!code) {
      this.broken = new Error('미디어 워커가 빌드에 없어요');
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      this.w = new Worker(url);
      this.w.onmessage = (e) => this.settle(e.data);
      this.w.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.broken = new Error(`미디어 워커 오류 ${(e && e.message) || ''}`.trim());
        for (const p of this.pending.values()) p.reject(this.broken);
        this.pending.clear();
      };
      this.thread = 'worker';
    } catch (err) {
      this.w = inline(code, (data) => this.settle(data));
      this.thread = 'page';
    }
  }

  settle(data) {
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data);
  }

  // Sends a job; the reply object comes back (transferred buffers included).
  call(msg, transfer) {
    if (this.broken) return Promise.reject(this.broken);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      msg.id = id;
      this.w.postMessage(msg, transfer || []);
    });
  }
}

export function mediaWorker(role) {
  if (!workers[role]) workers[role] = new MediaWorker();
  return workers[role];
}
