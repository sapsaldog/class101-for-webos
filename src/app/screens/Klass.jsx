import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Nav } from '../App.jsx';
import { curriculum, classLastLesson, flattenLectures, settled, writing } from '../api.js';
import { focusKey, focusFirst } from '../focus.js';
import { duration } from '../format.js';
import { toast } from '../overlay.js';

export default function Klass({ klassId, title, cover, lastLessonId, restoreFocus }) {
  const nav = useContext(Nav);
  const [klass, setKlass] = useState(null);
  const [lastId, setLastId] = useState(lastLessonId);
  const [error, setError] = useState('');
  // Newest answers, for 이어보기 pressed while the reload after the player is pending.
  // lastFresh: Class101 answered the last-lesson lookup in the newest load.
  const now = useRef({ klass: null, lastId: lastLessonId, lastFresh: false, alive: true, refreshing: null, resuming: false });

  useEffect(() => {
    const st = now.current;
    st.alive = true;
    // afterWrites: this load runs after the player's writes, so its last lesson is
    // current (fresh). The list and the last lesson are applied each on its own, and an
    // older answer never replaces a newer one: a list from an earlier load still fills
    // the screen when the newer load's list failed.
    let started = 0;
    let listShown = 0;
    let lastShown = 0;
    const load = (afterWrites) => {
      const n = ++started;
      if (afterWrites) st.lastFresh = false;
      return Promise.all([
        curriculum(klassId).then((k) => ({ k }), (err) => ({ err })),
        classLastLesson(klassId).then((id) => ({ id }), () => null),
      ]).then(([list, last]) => {
        if (!st.alive) return;
        if (list.k && n > listShown) {
          listShown = n;
          st.klass = list.k;
          setKlass(list.k);
        } else if (list.err && !nav.fail(list.err) && n === started && !st.klass) setError(list.err.message);
        if (last && n > lastShown) {
          // What Class101 has now, not what Home knew; none means no 이어보기.
          lastShown = n;
          st.lastId = last.id;
          setLastId(last.id);
          if (afterWrites) st.lastFresh = true;
        }
      });
    };
    // Back from the player its last writes may still be on the way: show the list now,
    // and load it again once they are done, so ✓ marks and 이어보기 are current.
    if (writing()) load(false);
    const reload = settled()
      .then(() => st.alive && load(true))
      .then(() => {
        if (st.refreshing === reload) st.refreshing = null;
      });
    st.refreshing = reload;
    return () => {
      st.alive = false;
    };
  }, [klassId]);

  const lectures = klass ? flattenLectures(klass) : [];
  const current = lectures.find((l) => l._id === lastId);
  const firstOpen = lectures.find((l) => l.canAccess !== false);

  // Focus once, when the list first appears; a later reload must not move it.
  const ready = !!klass;
  useEffect(() => {
    if (!ready) return;
    if (!focusKey(restoreFocus) && !focusKey('resume') && !focusKey('first')) focusFirst('.lec');
  }, [ready]);

  function play(lec) {
    nav.push('player', { klassId, lectureId: lec._id, lectures: flattenLectures(now.current.klass || klass) });
  }

  // 이어보기 opens the class's last lesson as Class101 has it after the player's writes:
  // pressed before the reload lands it waits for it, and if that lookup failed it asks
  // again. One press at a time, so a second OK can't open a second player.
  function resume() {
    const st = now.current;
    if (st.resuming) return;
    st.resuming = true;
    const open = (id) => {
      const lec = st.klass && flattenLectures(st.klass).find((l) => l._id === id);
      if (st.alive && lec) play(lec);
      else st.resuming = false;
    };
    if (!st.refreshing && st.lastFresh) return open(st.lastId);
    toast('최근 강의를 확인하는 중…', 1500);
    Promise.resolve(st.refreshing)
      .then(() => (st.lastFresh ? st.lastId : classLastLesson(klassId)))
      .then(open, () => {
        st.resuming = false;
        toast('최근 강의를 확인하지 못했어요. 다시 눌러 주세요.', 3000);
      });
  }

  let n = 0;
  return (
    <div class="screen klass">
      <div class="klass__side">
        {(cover || (klass && klass.coverImage)) && <img src={cover || klass.coverImage} alt="" />}
        <h1>{(klass && klass.title) || title}</h1>
        <div class="muted">{lectures.length ? `강의 ${lectures.length}개 · 완료 ${lectures.filter((l) => l.completed).length}개` : ''}</div>
        {current && (
          <button class="btn primary focusable" data-fk="resume" onClick={resume}>
            ▶ 이어보기
          </button>
        )}
        {firstOpen && (
          <button class="btn focusable" data-fk="first" onClick={() => play(firstOpen)}>
            처음부터
          </button>
        )}
        {current && <div class="muted" style={{ fontSize: '15px' }}>최근 본 강의: {current.title}</div>}
      </div>
      <div class="klass__list">
        {error && <p class="error">{error}</p>}
        {!klass && !error && <div class="empty muted">강의 목록을 불러오는 중…</div>}
        {klass &&
          klass.chapters.map((ch) => (
            <div key={ch._id}>
              <div class="chapter">{ch.title}</div>
              {(ch.lectures || []).map((l) => {
                n++;
                const locked = l.canAccess === false;
                const cls = ['lec', 'focusable', l.completed ? 'done' : '', l._id === lastId ? 'current' : '', locked ? 'locked' : ''].join(' ');
                return (
                  <button key={l._id} class={cls} data-fk={`lec-${l._id}`} onClick={() => (locked ? null : play(l))}>
                    <span class="lec__idx">{n}</span>
                    <span class="lec__title">{l.title}</span>
                    <span class="lec__dur">{l.video ? duration(l.video.duration) : ''}</span>
                    <span class="lec__state">{locked ? '🔒' : l.completed ? '✓' : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
      </div>
    </div>
  );
}
