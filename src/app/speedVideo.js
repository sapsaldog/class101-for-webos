// Speed playback for the picture. webOS apps play MSE at 1x whatever playbackRate
// says, so this player fetches the HLS video variant itself, has the media worker
// transmux each TS segment to fMP4 (mux.js) and compress its timeline by `rate`
// (fmp4.js), and appends it. The <video> runs at 1x over a shorter timeline:
//   media time = content time / rate.
// Sound comes from SpeedAudio, locked to contentTime().
import { mediaWorker } from './mediaWorker.js';
import { parseMediaPlaylist } from './speedAudio.js';

const TIMESCALE = 90000; // mux.js video track timescale
const AHEAD = 30; // seconds of media buffered in front of the playhead
const BEHIND = 15; // seconds kept behind it

function attr(line, name) {
  const m = new RegExp(`${name}=("([^"]*)"|[^,]*)`).exec(line);
  return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
}

// Highest rendition up to `maxHeight`, with its avc1 codec string. On webOS 5 the
// MSE path decodes 1080p at only ~23 fps, too slow for a compressed timeline.
export function pickVideoVariant(masterText, masterUrl, maxHeight = 720) {
  const lines = masterText.split('\n').map((l) => l.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri) continue;
    const res = attr(lines[i], 'RESOLUTION') || '';
    const height = parseInt(res.split('x')[1], 10) || 0;
    const codecs = (attr(lines[i], 'CODECS') || '').split(',').map((c) => c.trim());
    const avc = codecs.find((c) => /^avc1\./.test(c)) || 'avc1.64001f';
    variants.push({ url: new URL(uri, masterUrl).href, height, avc });
  }
  const fit = variants.filter((v) => v.height <= maxHeight).sort((a, b) => b.height - a.height);
  return fit[0] || variants.sort((a, b) => a.height - b.height)[0] || null;
}

export class SpeedVideo {
  constructor(video, masterUrl, rate, { onError } = {}) {
    this.video = video;
    this.masterUrl = masterUrl;
    this.rate = rate;
    this.onError = onError || (() => {});
    this.session = 0;
    this.busy = false;
    this.ended = false;
  }

  contentTime() {
    return this.video.currentTime * this.rate;
  }

  duration() {
    return this.total || 0;
  }

  async start(contentStart) {
    const master = await (await fetch(this.masterUrl)).text();
    // Faster speeds need more frames per second from the decoder: drop resolution.
    const variant = pickVideoVariant(master, this.masterUrl, this.rate > 1.5 ? 540 : 720);
    if (!variant) throw new Error('영상 화질 목록이 없어요');
    this.segments = parseMediaPlaylist(await (await fetch(variant.url)).text(), variant.url);
    if (!this.segments.length) throw new Error('영상 조각 목록이 비어 있어요');
    const last = this.segments[this.segments.length - 1];
    this.total = last.start + last.duration;

    this.ms = new MediaSource();
    this.url = URL.createObjectURL(this.ms);
    this.video.src = this.url;
    await new Promise((r) => this.ms.addEventListener('sourceopen', r, { once: true }));
    this.sb = this.ms.addSourceBuffer(`video/mp4; codecs="${variant.avc}"`);
    this.ms.duration = this.total / this.rate;
    this.initDone = false;
    this.from(contentStart);
    // Position first: the pump measures "buffered ahead" from the playhead.
    this.video.currentTime = contentStart / this.rate;
    this.timer = setInterval(() => this.pump(), 500);
    await this.pump();
  }

  // Continue loading from the segment that holds `content`.
  from(content) {
    this.session++;
    let i = this.segments.findIndex((s) => content < s.start + s.duration);
    if (i === -1) i = this.segments.length - 1;
    this.next = i;
    this.nextTicks = Math.round((this.segments[i].start * TIMESCALE) / this.rate);
    this.ended = false;
  }

  bufferedAhead() {
    const t = this.video.currentTime;
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && t < b.end(i)) return b.end(i) - t;
    return 0;
  }

  append(buf) {
    return new Promise((resolve, reject) => {
      const done = () => {
        this.sb.removeEventListener('updateend', done);
        this.sb.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        this.sb.removeEventListener('updateend', done);
        this.sb.removeEventListener('error', fail);
        reject(new Error('영상 조각을 넣지 못했어요'));
      };
      this.sb.addEventListener('updateend', done);
      this.sb.addEventListener('error', fail);
      this.sb.appendBuffer(buf);
    });
  }

  remove(from, to) {
    return new Promise((resolve) => {
      if (to <= from) return resolve();
      const done = () => {
        this.sb.removeEventListener('updateend', done);
        resolve();
      };
      this.sb.addEventListener('updateend', done);
      try {
        this.sb.remove(from, to);
      } catch (e) {
        this.sb.removeEventListener('updateend', done);
        resolve();
      }
    });
  }

  async pump() {
    if (this.busy || !this.ms || this.ms.readyState !== 'open') return;
    this.busy = true;
    const session = this.session;
    try {
      while (session === this.session && this.next < this.segments.length && this.bufferedAhead() < AHEAD) {
        const seg = this.segments[this.next];
        const res = await fetch(seg.url);
        if (!res.ok) throw new Error(`영상 조각 ${res.status}`);
        const ts = await res.arrayBuffer();
        if (session !== this.session) return;
        const out = await mediaWorker('video').call({ type: 'transmux', ts, startTicks: this.nextTicks, rate: this.rate }, [ts]);
        if (session !== this.session) return;
        if (!this.initDone) {
          await this.append(out.init);
          this.initDone = true;
        }
        this.nextTicks = out.endTicks;
        await this.append(out.data);
        this.next++;
      }
      if (session === this.session && this.next >= this.segments.length && !this.ended && !this.sb.updating) {
        this.ended = true;
        this.ms.endOfStream();
      }
      const t = this.video.currentTime;
      if (session === this.session && this.sb.buffered.length && t - this.sb.buffered.start(0) > BEHIND * 2) {
        await this.remove(0, t - BEHIND);
      }
    } catch (err) {
      if (session === this.session) this.onError(err);
    } finally {
      this.busy = false;
    }
  }

  // Seek in content time; reload from the right segment if it isn't buffered.
  async seek(content) {
    const media = Math.max(0, Math.min(content, this.total - 0.5)) / this.rate;
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= media && media < b.end(i) - 0.5) {
        this.video.currentTime = media;
        return;
      }
    }
    this.from(content);
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    if (this.ms.readyState === 'ended') {
      // endOfStream() locks appends; a new append reopens the source in Chrome.
      this.ended = false;
    }
    await this.remove(0, Infinity);
    this.video.currentTime = media;
    this.pump();
  }

  destroy() {
    this.session++;
    clearInterval(this.timer);
    if (this.url) URL.revokeObjectURL(this.url);
    this.ms = null;
  }
}
