// Streaming WSOLA (waveform-similarity overlap-add) time stretcher: speeds speech
// up without raising its pitch. Plain JS with no browser APIs, so it runs in the
// media worker (media.worker.js) and in Node for the unit test.

const FRAME = 2048; // analysis/synthesis frame (~43 ms at 48 kHz)
const HOP = FRAME / 2; // synthesis hop; 50% overlap with a Hann window sums to 1
const SEARCH = 512; // ± samples searched for the best-matching frame
const COARSE = 8; // coarse search step
const DECIM = 4; // correlation decimation in the coarse pass

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
const WINDOW = hann(FRAME);

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// push() takes one Float32Array per channel and returns the stretched output
// (same channel count); output length ≈ input length / rate. Output sample i
// lines up with input sample i * rate, so callers can map times either way.
export class Wsola {
  constructor(channels, rate) {
    this.channels = channels;
    this.rate = rate;
    this.buf = [];
    for (let c = 0; c < channels; c++) this.buf.push(new Float32Array(0));
    this.mono = new Float32Array(0); // mono mix of buf, for the similarity search
    this.base = 0; // absolute input index of buf[c][0]
    this.k = 0; // next output frame
    this.prev = -1; // absolute start of the previous frame
    this.acc = [];
    for (let c = 0; c < channels; c++) this.acc.push(new Float32Array(FRAME));
  }

  push(chunks) {
    const add = [];
    for (let c = 0; c < this.channels; c++) add.push(chunks[c] || chunks[0]);
    for (let c = 0; c < this.channels; c++) this.buf[c] = concat(this.buf[c], add[c]);
    const n = add[0].length;
    const o = this.mono.length;
    const mono = new Float32Array(o + n);
    mono.set(this.mono, 0);
    if (this.channels === 1) mono.set(add[0], o);
    else for (let i = 0; i < n; i++) mono[o + i] = (add[0][i] + add[1][i]) * 0.5;
    this.mono = mono;
    return this.run();
  }

  // Best frame start near `nominal` whose first half matches the natural
  // continuation of the previous frame (x[target .. target + HOP)).
  search(nominal, target) {
    const m = this.mono;
    const base = this.base;
    const t = target - base;
    const lo = Math.max(base, nominal - SEARCH);
    const hi = nominal + SEARCH;
    let best = nominal;
    let bestScore = -Infinity;
    for (let cand = lo; cand <= hi; cand += COARSE) {
      const c = cand - base;
      let dot = 0;
      let energy = 1e-9;
      for (let j = 0; j < HOP; j += DECIM) {
        const a = m[c + j];
        dot += a * m[t + j];
        energy += a * a;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    const flo = Math.max(lo, best - COARSE);
    const fhi = Math.min(hi, best + COARSE);
    bestScore = -Infinity;
    let fine = best;
    for (let cand = flo; cand <= fhi; cand++) {
      const c = cand - base;
      let dot = 0;
      let energy = 1e-9;
      for (let j = 0; j < HOP; j += 2) {
        const a = m[c + j];
        dot += a * m[t + j];
        energy += a * a;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        fine = cand;
      }
    }
    return fine;
  }

  run() {
    const out = [];
    for (let c = 0; c < this.channels; c++) out.push([]);
    const end = () => this.base + this.buf[0].length;
    for (;;) {
      const nominal = Math.round(this.k * HOP * this.rate);
      const need = Math.max(nominal + SEARCH + FRAME, this.prev >= 0 ? this.prev + HOP + HOP : 0);
      if (need > end()) break;
      const start = this.prev >= 0 ? this.search(nominal, this.prev + HOP) : nominal;
      for (let c = 0; c < this.channels; c++) {
        const acc = this.acc[c];
        const src = this.buf[c];
        const off = start - this.base;
        for (let i = 0; i < FRAME; i++) acc[i] += src[off + i] * WINDOW[i];
        out[c].push(acc.slice(0, HOP));
        acc.copyWithin(0, HOP);
        acc.fill(0, FRAME - HOP);
      }
      this.prev = start;
      this.k++;
      // Drop input no later frame can reach.
      const keep = Math.min(Math.round(this.k * HOP * this.rate) - SEARCH, this.prev + HOP);
      const drop = keep - this.base;
      if (drop > 48000) {
        for (let c = 0; c < this.channels; c++) this.buf[c] = this.buf[c].slice(drop);
        this.mono = this.mono.slice(drop);
        this.base += drop;
      }
    }
    return out.map((parts) => {
      let n = 0;
      for (const p of parts) n += p.length;
      const joined = new Float32Array(n);
      let o = 0;
      for (const p of parts) {
        joined.set(p, o);
        o += p.length;
      }
      return joined;
    });
  }
}
