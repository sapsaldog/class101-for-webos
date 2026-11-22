export function duration(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function percent(ratio) {
  if (!isFinite(ratio) || ratio <= 0) return 0;
  // The API reports 0..1 on some fields and 0..100 on others.
  const p = ratio <= 1 ? ratio * 100 : ratio;
  return Math.max(0, Math.min(100, Math.round(p)));
}
