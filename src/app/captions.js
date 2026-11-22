// Captions drawn by the app (not <track>): in speed mode the video's own timeline
// is compressed, so cues are matched against content time instead.

function seconds(ts) {
  const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(ts);
  if (!m) return NaN;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / Math.pow(10, m[4].length);
}

// WebVTT or SRT → [{ start, end, text }] sorted by start.
export function parseCues(text) {
  const cues = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.indexOf('-->') !== -1);
    if (i === -1) continue;
    const [a, b] = lines[i].split('-->');
    const start = seconds(a);
    const end = seconds(b);
    if (!isFinite(start) || !isFinite(end)) continue;
    const body = lines
      .slice(i + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

export function cueAt(cues, t) {
  // Cues are short and sorted; a binary search finds the last one starting before t.
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found !== -1 && t < cues[found].end ? cues[found].text : '';
}
