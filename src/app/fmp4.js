// Rescales the timeline of a fragmented-MP4 media segment (moof+mdat) in place.
// Used for speed playback: LG's app media stack plays MSE at 1x no matter what
// playbackRate says, so we hand it a timeline compressed by `rate` and it shows
// the frames that much faster.

function type(view, p) {
  return String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7));
}

function each(view, start, end, fn) {
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    let header = 8;
    if (size === 1) {
      size = view.getUint32(p + 8) * 4294967296 + view.getUint32(p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) return;
    fn(type(view, p), p + header, p + size);
    p += size;
  }
}

function setU64(view, p, v) {
  view.setUint32(p, Math.floor(v / 4294967296));
  view.setUint32(p + 4, v % 4294967296);
}

// Places the fragment's first sample at `startTicks` (track timescale) and
// divides every duration and composition offset by `rate`. Returns the end tick.
export function rescaleFragment(bytes, startTicks, rate) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endTicks = startTicks;
  each(view, 0, bytes.byteLength, (t, body, end) => {
    if (t !== 'moof') return;
    each(view, body, end, (t2, body2, end2) => {
      if (t2 !== 'traf') return;
      let tfdt = -1;
      let tfdtVersion = 0;
      let defaultDuration = -1;
      const truns = [];
      each(view, body2, end2, (t3, body3) => {
        if (t3 === 'tfhd') {
          const flags = view.getUint32(body3) & 0xffffff;
          let p = body3 + 8; // version/flags + track_ID
          if (flags & 0x1) p += 8; // base_data_offset
          if (flags & 0x2) p += 4; // sample_description_index
          if (flags & 0x8) defaultDuration = p;
        } else if (t3 === 'tfdt') {
          tfdtVersion = view.getUint8(body3);
          tfdt = body3 + 4;
        } else if (t3 === 'trun') {
          truns.push(body3);
        }
      });
      let origSum = 0;
      let newSum = 0;
      let sawDurations = false;
      for (const b of truns) {
        const vf = view.getUint32(b);
        const version = vf >>> 24;
        const flags = vf & 0xffffff;
        const count = view.getUint32(b + 4);
        let p = b + 8;
        if (flags & 0x1) p += 4; // data_offset
        if (flags & 0x4) p += 4; // first_sample_flags
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) {
            sawDurations = true;
            origSum += view.getUint32(p);
            const next = Math.round(origSum / rate);
            view.setUint32(p, next - newSum);
            newSum = next;
            p += 4;
          } else if (defaultDuration !== -1) {
            origSum += view.getUint32(defaultDuration);
            newSum = Math.round(origSum / rate);
          }
          if (flags & 0x200) p += 4; // size
          if (flags & 0x400) p += 4; // flags
          if (flags & 0x800) {
            if (version === 0) view.setUint32(p, Math.round(view.getUint32(p) / rate));
            else view.setInt32(p, Math.round(view.getInt32(p) / rate));
            p += 4;
          }
        }
      }
      if (!sawDurations && defaultDuration !== -1) {
        view.setUint32(defaultDuration, Math.max(1, Math.round(view.getUint32(defaultDuration) / rate)));
      }
      if (tfdt !== -1) {
        if (tfdtVersion === 1) setU64(view, tfdt, startTicks);
        else view.setUint32(tfdt, startTicks);
      }
      endTicks = Math.max(endTicks, startTicks + newSum);
    });
  });
  return endTicks;
}
