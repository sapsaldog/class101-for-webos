import { useContext, useEffect, useState } from 'preact/hooks';
import { Nav } from '../App.jsx';
import { curriculum, flattenLectures, settled, recentLecture } from '../api.js';
import { focusKey, focusFirst } from '../focus.js';
import { duration } from '../format.js';

export default function Klass({ klassId, title, cover, lastLessonId, restoreFocus }) {
  const nav = useContext(Nav);
  const [klass, setKlass] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      curriculum(klassId)
        .then((k) => alive && setKlass(k))
        .catch((err) => {
          if (alive && !nav.fail(err)) setError(err.message);
        });
    // Back from the player: wait for its last writes (at most 4 s), and load again if
    // some were slower, so ✓ marks are current.
    settled(4000).then((done) => load().then(() => (done || !alive ? null : settled().then(() => alive && load()))));
    return () => {
      alive = false;
    };
  }, [klassId]);

  const lectures = klass ? flattenLectures(klass) : [];
  // The lecture opened last on this TV beats the one Home knew when it opened us.
  const lastId = recentLecture(klassId) || lastLessonId;
  const current = lectures.find((l) => l._id === lastId);
  const firstOpen = lectures.find((l) => l.canAccess !== false);

  useEffect(() => {
    if (!klass) return;
    if (!focusKey(restoreFocus) && !focusKey('resume') && !focusKey('first')) focusFirst('.lec');
  }, [klass]);

  function play(lec) {
    nav.push('player', { klassId, lectureId: lec._id, lectures });
  }

  let n = 0;
  return (
    <div class="screen klass">
      <div class="klass__side">
        {(cover || (klass && klass.coverImage)) && <img src={cover || klass.coverImage} alt="" />}
        <h1>{(klass && klass.title) || title}</h1>
        <div class="muted">{lectures.length ? `강의 ${lectures.length}개 · 완료 ${lectures.filter((l) => l.completed).length}개` : ''}</div>
        {current && (
          <button class="btn primary focusable" data-fk="resume" onClick={() => play(current)}>
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
