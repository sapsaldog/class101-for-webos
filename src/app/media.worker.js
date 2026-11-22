// Media worker: the CPU-heavy half of speed playback, off the TV's UI thread.
// scripts/worker.mjs bundles this file into a string; mediaWorker.js runs it as
// a blob: Web Worker. Jobs (request { id, type, ... } → reply { id, ... }):
//   transmux  HLS TS video segment → fMP4 (mux.js), timeline compressed by `rate`
//   stretch   PCM chunk → WSOLA-stretched PCM, pitch kept (`reset` starts a new stream)
// Only `self.*` globals are used, so the same code also runs inline on the page.
import muxjs from 'mux.js';
import { rescaleFragment } from './fmp4.js';
import { Wsola } from './wsola.js';

let wsola = null;

// A typed array that owns its whole buffer, so it can be transferred.
function own(u8) {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
}

function transmux(ts) {
  return new Promise((resolve) => {
    const tm = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
    let out = null;
    tm.on('data', (seg) => {
      if (seg.type === 'video' && !out) out = { init: seg.initSegment, data: seg.data };
    });
    tm.on('done', () => resolve(out));
    tm.push(ts);
    tm.flush();
  });
}

const jobs = {
  async transmux({ ts, startTicks, rate }) {
    const out = await transmux(new Uint8Array(ts));
    if (!out) throw new Error('영상 조각을 변환하지 못했어요');
    const init = own(out.init);
    const data = own(out.data);
    const endTicks = rescaleFragment(data, startTicks, rate);
    return [{ init, data, endTicks }, [init.buffer, data.buffer]];
  },
  async stretch({ reset, rate, channels, chunks }) {
    if (reset || !wsola) wsola = new Wsola(channels, rate);
    const out = wsola.push(chunks);
    return [{ out }, out.map((a) => a.buffer)];
  },
};

self.onmessage = (e) => {
  const { id, type } = e.data;
  Promise.resolve()
    .then(() => jobs[type](e.data))
    .then(
      ([reply, transfer]) => {
        reply.id = id;
        self.postMessage(reply, transfer);
      },
      (err) => self.postMessage({ id, error: String((err && err.message) || err) }),
    );
};
