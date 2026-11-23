export function duration(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// A class's progressRatio is a percentage, 0-100 (the real API sends 25, 44, ...; the
// site shows it as is). Lesson-level video.progressRatio is 0-1, but isn't shown.
export function percent(value) {
  if (!isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
