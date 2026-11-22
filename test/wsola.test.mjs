// Unit test for the WSOLA time stretcher: speed changes, pitch does not.
//   node test/wsola.test.mjs
import { Wsola } from '../src/app/wsola.js';
import { audioRenditionUrl, parseMediaPlaylist } from '../src/app/speedAudio.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `  (${detail})` : ''}`);
}

const SR = 48000;
function tone(freq, seconds, amp = 0.5) {
  const n = Math.round(SR * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}
// Frequency from zero crossings over the middle of the signal (avoids edge fades).
function freqOf(x) {
  const from = Math.floor(x.length * 0.2);
  const to = Math.floor(x.length * 0.8);
  let z = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
  return (z / 2) / ((to - from) / SR);
}
function rms(x) {
  const from = Math.floor(x.length * 0.2);
  const to = Math.floor(x.length * 0.8);
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

for (const rate of [1.25, 1.5, 2, 0.75]) {
  const input = tone(440, 6);
  const w = new Wsola(2, rate);
  // Feed in uneven chunks like HLS segments.
  const outs = [];
  let pos = 0;
  for (const size of [SR * 2, SR * 1.5, SR * 2.5]) {
    const part = input.subarray(pos, pos + size);
    outs.push(w.push([part, part])[0]);
    pos += size;
  }
  const n = outs.reduce((s, o) => s + o.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of outs) {
    out.set(p, o);
    o += p.length;
  }
  const expected = (input.length - 2048 - 512) / rate;
  const f = freqOf(out);
  check(`rate ${rate}: length ≈ input / rate`, Math.abs(n - expected) / expected < 0.03, `${n} vs ${Math.round(expected)}`);
  check(`rate ${rate}: pitch kept at 440 Hz`, Math.abs(f - 440) < 4, `${f.toFixed(1)} Hz`);
  check(`rate ${rate}: loudness kept`, Math.abs(rms(out) / rms(input) - 1) < 0.08, (rms(out) / rms(input)).toFixed(3));
  check(`rate ${rate}: no NaN`, !out.some((v) => Number.isNaN(v)));
}

const master = [
  '#EXTM3U',
  '#EXT-X-MEDIA:LANGUAGE="en",AUTOSELECT=YES,TYPE=AUDIO,URI="audio/stream_1.m3u8?Policy=a",GROUP-ID="g",DEFAULT=NO,NAME="stream_1"',
  '#EXT-X-MEDIA:AUTOSELECT=NO,TYPE=AUDIO,URI="audio/vocals.m3u8?Policy=a",GROUP-ID="g",DEFAULT=NO,NAME="vocals"',
  '#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",AUDIO="g"',
  '720.m3u8?Policy=a',
].join('\n');
check('picks the full-mix audio rendition, not "vocals"', audioRenditionUrl(master, 'https://cdn.example/v/1/hls/master.m3u8?Policy=x') === 'https://cdn.example/v/1/hls/audio/stream_1.m3u8?Policy=a');
const segs = parseMediaPlaylist('#EXTM3U\n#EXTINF:5.0,\na0.aac?s=1\n#EXTINF:5.5,\na1.aac?s=1\n#EXT-X-ENDLIST', 'https://cdn.example/v/1/hls/audio/stream_1.m3u8');
check('media playlist → segment start times', segs.length === 2 && segs[1].start === 5 && segs[1].url === 'https://cdn.example/v/1/hls/audio/a1.aac?s=1', JSON.stringify(segs[1]));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
