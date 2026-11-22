// Pitch-preserving sound for speed playback on webOS TV apps.
//
// LG's app media stack can't do "1.25x with sound": the native player speeds up
// the video but mutes audio (trick play), and MSE ignores playbackRate. So while
// the speed isn't 1x, this module plays the lecture's separate audio rendition
// (HLS EXT-X-MEDIA, packed AAC segments) through Web Audio, time-stretched with
// WSOLA (wsola.js, run in the media worker) so voices keep their pitch, and keeps
// it locked to the picture's clock.
import { mediaWorker } from './mediaWorker.js';

// ---- HLS audio rendition --------------------------------------------------

function attr(line, name) {
  const m = new RegExp(`${name}=("([^"]*)"|[^,]*)`).exec(line);
  return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
}

export function audioRenditionUrl(masterText, masterUrl) {
  const media = masterText
    .split('\n')
    .filter((l) => /^#EXT-X-MEDIA:/.test(l) && attr(l, 'TYPE') === 'AUDIO' && attr(l, 'URI'))
    .map((l) => ({ name: attr(l, 'NAME') || '', def: attr(l, 'DEFAULT') === 'YES', auto: attr(l, 'AUTOSELECT') === 'YES', uri: attr(l, 'URI') }));
  // "vocals" is Class101's voice-only track; prefer the full mix.
  const pick =
    media.find((m) => m.def && !/vocal/i.test(m.name)) ||
    media.find((m) => m.auto && !/vocal/i.test(m.name)) ||
    media.find((m) => !/vocal/i.test(m.name)) ||
    media[0];
  return pick ? new URL(pick.uri, masterUrl).href : null;
}

export function parseMediaPlaylist(text, url) {
  const segments = [];
  let t = 0;
  let dur = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) || 0;
    else if (line && !line.startsWith('#')) {
      segments.push({ url: new URL(line, url).href, start: t, duration: dur });
      t += dur;
      dur = 0;
    }
  }
  return segments;
}

// ---- player-side engine -----------------------------------------------------

const LEAD = 0.3; // s between deciding and hearing (scheduling headroom)
const AHEAD = 8; // s of stretched audio kept scheduled
const CHUNK = 1; // s of input per worker job, so the first sound comes back fast
const SAMPLE_MS = 50; // picture clock sampling period
const CHECKS = 5; // drift check every CHECKS samples (250 ms)
const HISTORY_MS = 2500; // picture clock samples kept for the estimate
const MAX_DRIFT = 0.15; // s of content; resync past this...
const STRIKES = 3; // ...on this many checks in a row

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SpeedAudio {
  // clock(): content time of the picture (video.currentTime unless the video's
  // timeline is compressed, see SpeedVideo.contentTime). Content advances at the
  // engine's rate per second while the video plays.
  constructor(video, masterUrl, { onError, clock } = {}) {
    this.video = video;
    this.masterUrl = masterUrl;
    this.onError = onError || (() => {});
    this.clock = clock || (() => video.currentTime);
    this.rate = 1;
    this.session = 0;
    this.sources = [];
    this.cache = new Map();
    this.timer = null;
    this.samples = [];
    this.lastClock = undefined;
    this.strikes = 0;
    this.resyncs = 0;
    this.mutedBefore = video.muted;
    this.events = {
      pause: () => this.stop(),
      waiting: () => this.stop(),
      seeking: () => this.stop(),
      ended: () => this.stop(),
      playing: () => this.restart(),
      seeked: () => this.restart(),
    };
    for (const k of Object.keys(this.events)) video.addEventListener(k, this.events[k]);
  }

  get active() {
    return Math.abs(this.rate - 1) > 0.01;
  }

  setRate(rate) {
    this.rate = rate;
    this.forget();
    if (!this.active) {
      this.halt();
      this.video.muted = this.mutedBefore;
      return;
    }
    // The native player is silent off 1x anyway; muting makes sure we never double up.
    this.video.muted = true;
    this.restart();
  }

  halt() {
    this.session++;
    clearInterval(this.timer);
    this.timer = null;
    this.strikes = 0;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch (e) {
        /* already stopped */
      }
    }
    this.sources = [];
  }

  // Silence, and forget the picture clock: it is about to jump or stall.
  stop() {
    this.halt();
    this.forget();
  }

  // ---- clocks ----

  forget() {
    this.samples = [];
    this.lastClock = undefined;
  }

  // Records the picture clock each time it steps. On webOS video.currentTime
  // moves in ~200 ms steps and reads stale while the page is busy, so a fresh
  // step is never ahead of the truth: each step, extrapolated to now, is a lower
  // bound, and the largest is the estimate. Unchanged readings are not kept: a
  // stalled clock (seeking, starting up) must not be extrapolated.
  sample() {
    const p = performance.now();
    const c = this.clock();
    if (this.lastClock !== undefined && c !== this.lastClock) this.samples.push({ p, c });
    this.lastClock = c;
    while (this.samples.length && p - this.samples[0].p > HISTORY_MS) this.samples.shift();
  }

  pictureNow() {
    const p = performance.now();
    let best = this.clock();
    for (const s of this.samples) {
      if (p - s.p <= HISTORY_MS) best = Math.max(best, s.c + ((p - s.p) / 1000) * this.rate);
    }
    return best;
  }

  // Has the clock stepped lately (so the estimate has a fresh reading)?
  clockSettled() {
    return this.samples.length > 0;
  }

  // Wait (up to 0.6 s) for the picture clock to step once.
  async settle(session) {
    const until = performance.now() + 600;
    this.sample();
    while (session === this.session && !this.clockSettled() && performance.now() < until) {
      await sleep(15);
      this.sample();
    }
  }

  // Context time of the sound leaving the speakers now. getOutputTimestamp is
  // smooth and includes the output latency; currentTime moves in render chunks.
  heardNow() {
    const ctx = this.ctx;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
  }

  // Seconds of content the sound is ahead (+) or behind (−) the picture.
  drift() {
    if (!this.anchor || !this.ctx) return 0;
    const a = this.anchor;
    return a.t0 + (this.heardNow() - a.a0) * a.rate - this.pictureNow();
  }

  // ---- stretched sound ----

  async playlist() {
    if (!this.segments) {
      const master = await (await fetch(this.masterUrl)).text();
      const audioUrl = audioRenditionUrl(master, this.masterUrl);
      if (!audioUrl) throw new Error('이 영상에는 별도 소리 트랙이 없어요');
      this.segments = parseMediaPlaylist(await (await fetch(audioUrl)).text(), audioUrl);
      if (!this.segments.length) throw new Error('소리 트랙이 비어 있어요');
    }
    return this.segments;
  }

  decode(index) {
    if (this.cache.has(index)) return this.cache.get(index);
    const seg = this.segments[index];
    const p = fetch(seg.url)
      .then((r) => {
        if (!r.ok) throw new Error(`소리 조각 ${r.status}`);
        return r.arrayBuffer();
      })
      .then((data) => new Promise((resolve, reject) => this.ctx.decodeAudioData(data, resolve, reject)));
    this.cache.set(index, p);
    p.catch(() => this.cache.delete(index));
    if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value);
    return p;
  }

  async restart() {
    this.halt();
    if (!this.active || this.video.paused || this.video.seeking) return;
    const session = this.session;
    try {
      const segments = await this.playlist();
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (session !== this.session) return;
      if (!this.clockSettled()) await this.settle(session);
      if (session !== this.session) return;

      // Content t0 starts at context time a0; pick t0 so that it is what the
      // picture shows when a0 reaches the speakers.
      const a0 = this.ctx.currentTime + LEAD;
      const t0 = this.pictureNow() + (a0 - this.heardNow()) * this.rate;
      let index = segments.findIndex((s) => t0 < s.start + s.duration);
      if (index === -1) return;
      this.anchor = { a0, t0, rate: this.rate };
      this.out = 0;
      let skip = Math.max(0, t0 - segments[index].start);
      let reset = true;
      let ticks = 0;
      this.timer = setInterval(() => {
        if (++ticks % CHECKS === 0) this.check(session);
        else this.sample();
      }, SAMPLE_MS);

      // Pump: decode → stretch (worker) → schedule, staying AHEAD seconds in front.
      const worker = mediaWorker('audio');
      while (session === this.session && index < segments.length) {
        const buffered = this.sr ? this.anchor.a0 + this.out / this.sr - this.ctx.currentTime : 0;
        if (buffered > AHEAD) {
          await sleep(500);
          continue;
        }
        const next = index + 1 < segments.length ? index + 1 : -1;
        const audio = await this.decode(index);
        if (next !== -1) this.decode(next).catch(() => {}); // prefetch
        if (session !== this.session) return;
        this.sr = audio.sampleRate;
        const left = audio.getChannelData(0);
        const right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
        const step = Math.round(CHUNK * this.sr);
        for (let from = Math.min(left.length, Math.round(skip * this.sr)); from < left.length; from += step) {
          const to = Math.min(left.length, from + step);
          const chunks = [left.slice(from, to), right.slice(from, to)];
          const res = await worker.call({ type: 'stretch', reset, rate: this.rate, channels: 2, chunks }, [chunks[0].buffer, chunks[1].buffer]);
          if (session !== this.session) return;
          reset = false;
          this.schedule(session, res.out);
        }
        skip = 0;
        index++;
      }
    } catch (err) {
      if (session === this.session) {
        this.halt();
        this.onError(err);
      }
    }
  }

  schedule(session, out) {
    const n = out[0].length;
    if (!n || session !== this.session) return;
    const when = this.anchor.a0 + this.out / this.sr;
    this.out += n;
    const now = this.ctx.currentTime;
    if (when + n / this.sr <= now) return; // already late; the drift check resyncs
    const buffer = this.ctx.createBuffer(2, n, this.sr);
    buffer.getChannelData(0).set(out[0]);
    buffer.getChannelData(1).set(out[1]);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    if (when < now) src.start(now, now - when);
    else src.start(when);
    src.onended = () => {
      const i = this.sources.indexOf(src);
      if (i !== -1) this.sources.splice(i, 1);
    };
    this.sources.push(src);
  }

  // Resync only when the sound stays off the picture: a restart is audible.
  check(session) {
    if (session !== this.session) return;
    this.sample();
    // Judge only a moving picture clock and a sound that has started.
    if (this.video.paused || !this.anchor || !this.clockSettled() || this.heardNow() < this.anchor.a0) {
      this.strikes = 0;
      return;
    }
    const d = this.drift();
    this.strikes = Math.abs(d) > MAX_DRIFT ? this.strikes + 1 : 0;
    if (this.strikes >= STRIKES) {
      this.resyncs++;
      this.lastResync = d;
      this.restart();
    }
  }

  destroy() {
    this.halt();
    for (const k of Object.keys(this.events)) this.video.removeEventListener(k, this.events[k]);
    this.video.muted = this.mutedBefore;
    if (this.ctx && this.ctx.close) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
