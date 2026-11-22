// D-pad focus for our own screens. A small geometric search over [data-fk]
// elements: predictable on grids and lists, which is all this app has (the WICG
// polyfill skipped adjacent grid cells whose boxes touch).

const EDGE = 2; // px of overlap tolerated between neighbours
const MARGIN = 48; // keep the focused item this far from a scroller's edge

function visible(el) {
  if (el.disabled) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function score(dir, c, r) {
  const vertical = dir === 'up' || dir === 'down';
  if (dir === 'down' && r.top < c.bottom - EDGE) return null;
  if (dir === 'up' && r.bottom > c.top + EDGE) return null;
  if (dir === 'right' && r.left < c.right - EDGE) return null;
  if (dir === 'left' && r.right > c.left + EDGE) return null;
  const gap = Math.max(
    0,
    dir === 'down' ? r.top - c.bottom : dir === 'up' ? c.top - r.bottom : dir === 'right' ? r.left - c.right : c.left - r.right
  );
  // How far apart the two boxes are across the direction of travel (0 when they overlap).
  const overlap = vertical
    ? Math.min(c.right, r.right) - Math.max(c.left, r.left)
    : Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top);
  const cross = overlap > 0 ? 0 : -overlap;
  // Tie-break: from a wide element (a banner) go to the first item in reading
  // order; otherwise to the item whose centre lines up best.
  const tie = vertical
    ? c.width > r.width * 2
      ? (r.left - c.left) * 0.01
      : Math.abs(r.left + r.right - c.left - c.right) * 0.05
    : Math.abs(r.top + r.bottom - c.top - c.bottom) * 0.05;
  return gap + cross * (vertical ? 2 : 4) + tie;
}

function scroller(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function reveal(el) {
  const box = scroller(el);
  if (!box) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top + MARGIN) box.scrollTop -= b.top + MARGIN - r.top;
  else if (r.bottom > b.bottom - MARGIN) box.scrollTop += r.bottom - (b.bottom - MARGIN);
}

export function focusEl(el) {
  if (!el) return false;
  el.focus();
  reveal(el);
  return true;
}

export function move(dir) {
  const all = Array.prototype.filter.call(document.querySelectorAll('[data-fk]'), visible);
  const cur = document.activeElement;
  if (!cur || all.indexOf(cur) === -1) return focusEl(all[0]);
  const c = cur.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const s = score(dir, c, el.getBoundingClientRect());
    if (s !== null && s < bestScore) {
      best = el;
      bestScore = s;
    }
  }
  if (best) return focusEl(best);
  // Nothing further that way: nudge the page so content beyond the edge shows.
  const box = scroller(cur);
  if (box && (dir === 'down' || dir === 'up')) box.scrollTop += (dir === 'down' ? 1 : -1) * box.clientHeight * 0.4;
  return false;
}

export function focusKey(key) {
  if (!key) return false;
  return focusEl(document.querySelector(`[data-fk="${CSS.escape(key)}"]`));
}

export function focusFirst(selector) {
  return focusEl(document.querySelector(selector || '[data-fk]'));
}

export function activeKey() {
  const el = document.activeElement;
  return el && el.getAttribute ? el.getAttribute('data-fk') : null;
}
