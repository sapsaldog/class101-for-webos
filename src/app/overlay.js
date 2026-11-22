// Player overlays: toast, playback OSD, centre flash, quick menu, help, curtain.
// Imperative DOM in one fixed layer, so the player can update them every frame
// without re-rendering the Preact tree.


function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (k === 'text') el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
  }
  for (const c of children || []) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

function show(el, on) {
  if (on) el.setAttribute('data-show', '');
  else el.removeAttribute('data-show');
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export function fmtRate(rate) {
  return (Math.round(rate * 100) / 100).toString() + 'x';
}

let layer = null;
const parts = {};
const timers = {};

export function ensureLayer() {
  if (layer && layer.isConnected) return layer;
  layer = h('div', { class: 'c101-layer', id: 'c101-layer', 'aria-hidden': 'true' });

  parts.curtain = h('div', { class: 'c101-curtain' }, [h('span', { text: '불러오는 중…' })]);

  parts.osdTitle = h('span', { class: 'c101-osd__title' });
  parts.osdBadge = h('span', { class: 'c101-osd__badge', hidden: '' });
  parts.osdBuffer = h('div', { class: 'c101-osd__buffer' });
  parts.osdFill = h('div', { class: 'c101-osd__fill' });
  parts.osdTime = h('span', { class: 'c101-osd__time' });
  parts.osdHint = h('span', {
    class: 'c101-osd__hint',
    text: 'OK 재생/일시정지 · ◀▶ 10초 · ▲ 메뉴 · CH▲▼ 다음/이전 강의 · 뒤로 목록',
  });
  parts.osd = h('div', { class: 'c101-osd' }, [
    h('div', { class: 'c101-osd__top' }, [parts.osdTitle, parts.osdBadge]),
    h('div', { class: 'c101-osd__bar' }, [parts.osdBuffer, parts.osdFill]),
    h('div', { class: 'c101-osd__row' }, [parts.osdTime, parts.osdHint]),
  ]);

  parts.center = h('div', { class: 'c101-center' });
  parts.toast = h('div', { class: 'c101-toast', role: 'status' });

  parts.menuList = h('div');
  parts.menu = h('div', { class: 'c101-menu' }, [
    h('div', { class: 'c101-menu__title', text: '빠른 메뉴' }),
    parts.menuList,
    h('div', { class: 'c101-menu__foot', text: '▲▼ 이동 · ◀▶ 값 바꾸기 · OK 선택 · 뒤로 닫기' }),
  ]);

  parts.help = buildHelp();

  for (const k of ['curtain', 'osd', 'center', 'menu', 'help', 'toast']) layer.appendChild(parts[k]);
  document.body.appendChild(layer);
  return layer;
}

function buildHelp() {
  const rows = (pairs) => {
    const dl = h('dl');
    for (const [k, v] of pairs) {
      dl.appendChild(h('dt', { text: k }));
      dl.appendChild(h('dd', { text: v }));
    }
    return dl;
  };
  return h('div', { class: 'c101-help' }, [
    h('h2', { text: '리모컨 사용법' }),
    h('p', { text: '뒤로 또는 OK를 누르면 닫혀요.' }),
    h('div', { class: 'c101-help__cols' }, [
      h('div', { class: 'c101-help__col' }, [
        h('h3', { text: '강의 영상' }),
        rows([
          ['OK', '재생 / 일시정지'],
          ['◀ ▶', '10초 뒤로 / 앞으로 (길게 누르면 30초씩)'],
          ['▲', '빠른 메뉴: 속도, 자막, 이전·다음 강의, 처음부터'],
          ['▼', '진행 상태 보기'],
          ['CH ▲ / CH ▼', '다음 강의 / 이전 강의'],
          ['뒤로', '강의 목록으로 (보던 위치 저장)'],
          ['빨강 / 초록', '속도 느리게 / 빠르게'],
          ['숫자 1~9, 0', '10~90% 위치로, 0은 처음으로'],
        ]),
      ]),
      h('div', { class: 'c101-help__col' }, [
        h('h3', { text: '목록 화면' }),
        rows([
          ['방향키', '항목 사이 이동'],
          ['OK', '선택'],
          ['뒤로', '이전 화면 (첫 화면에서 두 번 누르면 종료)'],
          ['파랑', '이 도움말 열기 / 닫기'],
        ]),
      ]),
    ]),
  ]);
}

export function toast(message, ms) {
  ensureLayer();
  parts.toast.textContent = message;
  show(parts.toast, true);
  clearTimeout(timers.toast);
  timers.toast = setTimeout(() => show(parts.toast, false), ms || 2200);
}

export function flashCenter(text, ms) {
  ensureLayer();
  parts.center.textContent = text;
  show(parts.center, true);
  clearTimeout(timers.center);
  timers.center = setTimeout(() => show(parts.center, false), ms || 700);
}

// ---- OSD ----

let osdVideo = null;
let osdTitleText = '';
let osdHoldWhilePaused = true;

export function updateOsd() {
  const v = osdVideo;
  if (!v || !parts.osd) return;
  const dur = v.duration;
  const cur = v.currentTime;
  const known = isFinite(dur) && dur > 0;
  parts.osdTitle.textContent = osdTitleText;
  parts.osdTime.textContent = known ? `${fmtTime(cur)} / ${fmtTime(dur)}` : fmtTime(cur);
  parts.osdFill.style.width = known ? `${Math.min(100, (cur / dur) * 100)}%` : '0%';
  let buffered = 0;
  try {
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= cur + 0.5) buffered = Math.max(buffered, v.buffered.end(i));
    }
  } catch (e) {
    buffered = 0;
  }
  parts.osdBuffer.style.width = known ? `${Math.min(100, (buffered / dur) * 100)}%` : '0%';
  if (Math.abs(v.playbackRate - 1) > 0.01) {
    parts.osdBadge.textContent = fmtRate(v.playbackRate);
    parts.osdBadge.removeAttribute('hidden');
  } else {
    parts.osdBadge.setAttribute('hidden', '');
  }
}

export function showOsd(video, title, ms) {
  ensureLayer();
  osdVideo = video;
  osdTitleText = title || '';
  updateOsd();
  show(parts.osd, true);
  clearInterval(timers.osdTick);
  timers.osdTick = setInterval(updateOsd, 250);
  clearTimeout(timers.osd);
  const hideLater = () => {
    timers.osd = setTimeout(() => {
      // Keep the bar up while paused so the viewer can see where they are.
      if (osdHoldWhilePaused && osdVideo && osdVideo.paused && !osdVideo.ended) return hideLater();
      hideOsd();
    }, ms || 3500);
  };
  hideLater();
}

export function hideOsd() {
  if (!parts.osd) return;
  show(parts.osd, false);
  clearTimeout(timers.osd);
  clearInterval(timers.osdTick);
}

export function isOsdVisible() {
  return !!(parts.osd && parts.osd.hasAttribute('data-show'));
}

// ---- Quick menu ----

let menuItems = [];
let menuIndex = 0;

export function openMenu(items) {
  ensureLayer();
  menuItems = items;
  menuIndex = Math.max(0, items.findIndex((it) => !it.disabled));
  renderMenu();
  show(parts.menu, true);
}

export function renderMenu() {
  parts.menuList.textContent = '';
  menuItems.forEach((it, i) => {
    const row = h('div', { class: 'c101-menu__item' }, [h('span', { text: it.label })]);
    if (it.value) row.appendChild(h('span', { class: 'c101-menu__value', text: it.value() }));
    if (i === menuIndex) row.setAttribute('data-selected', '');
    if (it.disabled) row.setAttribute('data-disabled', '');
    parts.menuList.appendChild(row);
  });
}

export function closeMenu() {
  if (parts.menu) show(parts.menu, false);
  menuItems = [];
}

export function isMenuOpen() {
  return !!(parts.menu && parts.menu.hasAttribute('data-show'));
}

// Returns true when the key was consumed by the menu.
export function menuKey(dir) {
  if (!menuItems.length) return false;
  const item = menuItems[menuIndex];
  if (dir === 'up' || dir === 'down') {
    const step = dir === 'up' ? -1 : 1;
    let i = menuIndex;
    for (let n = 0; n < menuItems.length; n++) {
      i = (i + step + menuItems.length) % menuItems.length;
      if (!menuItems[i].disabled) break;
    }
    menuIndex = i;
  } else if ((dir === 'left' || dir === 'right') && item && item.adjust) {
    item.adjust(dir === 'left' ? -1 : 1);
  } else if (dir === 'ok' && item && !item.disabled) {
    if (item.adjust && !item.run) item.adjust(1);
    else if (item.run) {
      closeMenu();
      item.run();
      return true;
    }
  }
  renderMenu();
  return true;
}

// ---- Help ----

export function toggleHelp(force) {
  ensureLayer();
  const on = force === undefined ? !parts.help.hasAttribute('data-show') : force;
  show(parts.help, on);
  if (on) show(parts.toast, false);
  return on;
}

export function isHelpOpen() {
  return !!(parts.help && parts.help.hasAttribute('data-show'));
}

// ---- Curtain (black screen between lectures) ----

export function showCurtain(on, text) {
  ensureLayer();
  if (text) parts.curtain.firstChild.textContent = text;
  show(parts.curtain, on);
}
