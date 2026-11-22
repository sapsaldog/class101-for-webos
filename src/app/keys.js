// LG webOS remote key codes (Magic Remote and the older IR remotes).
// Color buttons differ by remote and region, so each color has several codes
// (the extra ones come from webosbrew/youtube-webos).

export const KEY = {
  ENTER: 13,
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  BACK: 461,
  ESCAPE: 27,
  CH_UP: 33, // reported as PageUp
  CH_DOWN: 34, // reported as PageDown
  PLAY: 415,
  PAUSE: 19,
  PLAY_PAUSE: 179, // MediaPlayPause on USB/Bluetooth keyboards
  STOP: 413,
  REWIND: 412,
  FAST_FORWARD: 417,
  INFO: 457,
};

const COLOR_BY_CODE = new Map([
  [403, 'red'],
  [404, 'green'],
  [172, 'green'],
  [405, 'yellow'],
  [170, 'yellow'],
  [406, 'blue'],
  [167, 'blue'],
  [191, 'blue'],
]);

export function colorOf(event) {
  return COLOR_BY_CODE.get(event.keyCode) || COLOR_BY_CODE.get(event.charCode) || null;
}

const ARROWS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

export function arrowOf(event) {
  return ARROWS[event.keyCode] || null;
}

// 0-9 on the number pad or the top row. Returns null for anything else.
export function digitOf(event) {
  const c = event.keyCode;
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 96 && c <= 105) return c - 96;
  return null;
}

export function isBack(event) {
  return event.keyCode === KEY.BACK || event.keyCode === KEY.ESCAPE || event.key === 'GoBack';
}
