import { useContext, useEffect, useState } from 'preact/hooks';
import { Nav } from '../App.jsx';
import { myClasses, lastClass, settled, recentLecture } from '../api.js';
import { currentUser, signOut } from '../auth.js';
import { focusKey, focusFirst } from '../focus.js';
import { toggleHelp } from '../overlay.js';
import { percent } from '../format.js';

// Kept across visits so coming back from a class shows the list instantly,
// then refreshes it (progress changes after watching).
let cache = null;

function Progress({ ratio }) {
  return (
    <div class="progress">
      <i style={{ width: `${percent(ratio)}%` }} />
    </div>
  );
}

export default function Home({ restoreFocus }) {
  const nav = useContext(Nav);
  const [data, setData] = useState(cache);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const user = currentUser();

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([lastClass().catch(() => null), myClasses()])
        .then(([last, list]) => {
          if (!alive) return;
          cache = { last, items: list.items, pageInfo: list.pageInfo };
          setData(cache);
        })
        .catch((err) => {
          if (!alive || nav.fail(err)) return;
          setError(err.message);
        });
    // Back from the player its last saves may still be on the way: wait for them (at
    // most 4 s), and if some were slower, load again once they are done.
    settled(4000).then((done) => load().then(() => (done || !alive ? null : settled().then(() => alive && load()))));
    return () => {
      alive = false;
    };
  }, []);

  // Focus once content exists: where we left off, else the hero, else the first card.
  const ready = !!data;
  useEffect(() => {
    if (!ready) return;
    if (!focusKey(restoreFocus) && !focusKey('hero')) focusFirst('.card');
  }, [ready]);

  function more() {
    setLoadingMore(true);
    myClasses(data.pageInfo.endCursor)
      .then((list) => {
        cache = { ...data, items: data.items.concat(list.items), pageInfo: list.pageInfo };
        setData(cache);
        setLoadingMore(false);
      })
      .catch((err) => {
        setLoadingMore(false);
        if (!nav.fail(err)) setError(err.message);
      });
  }

  function logout() {
    cache = null;
    signOut();
    nav.reset('login');
  }

  const last = data && data.last && data.last.lastLesson ? data.last : null;

  return (
    <div class="screen home">
      <div class="topbar">
        <div class="brand">
          <img src="largeIcon.png" alt="" />
          클래스101
        </div>
        <div class="topbar__right">
          <span class="muted">{user && user.email}</span>
          <button class="btn primary focusable" data-fk="search" onClick={() => nav.push('search')}>
            🔍 클래스 찾기
          </button>
          <button class="btn focusable" data-fk="help" onClick={() => toggleHelp(true)}>
            도움말
          </button>
          <button class="btn focusable" data-fk="logout" onClick={logout}>
            로그아웃
          </button>
        </div>
      </div>

      {error && <p class="error">{error}</p>}
      {!data && !error && <div class="empty muted">내 클래스를 불러오는 중…</div>}

      {last && (
        <button
          class="hero focusable"
          data-fk="hero"
          onClick={() => nav.push('player', { klassId: last.id, lectureId: recentLecture(last.id) || last.lastLesson.id })}
        >
          <img src={last.coverImageURL} alt="" />
          <div class="hero__body">
            <div class="hero__label">이어보기</div>
            <div class="hero__title">{last.title}</div>
            <div class="hero__meta muted">{last.creator && last.creator.nickName}</div>
            <Progress ratio={last.progressRatio} />
            <div class="hero__cta">OK를 누르면 보던 곳부터 재생</div>
          </div>
        </button>
      )}

      {data && (
        <>
          <h2 class="section-title">내 클래스 {data.items.length ? `(${data.items.length}${data.pageInfo.hasNextPage ? '+' : ''})` : ''}</h2>
          {!data.items.length && <div class="empty muted">수강 중인 클래스가 없어요. 클래스101에서 클래스를 시작하면 여기에 보여요.</div>}
          <div class="grid">
            {data.items.map((c) => (
              <button
                key={c.id}
                class="card focusable"
                data-fk={`class-${c.id}`}
                onClick={() => nav.push('klass', { klassId: c.id, title: c.title, cover: c.coverImageURL, lastLessonId: c.lastLesson && c.lastLesson.id })}
              >
                <div class="card__img">
                  <img src={c.coverImageURL} alt="" />
                </div>
                <div class="card__title">{c.title}</div>
                <div class="card__meta muted">
                  {c.lastLesson ? `최근: ${c.lastLesson.title}` : c.creator && c.creator.nickName}
                </div>
                <Progress ratio={c.progressRatio} />
              </button>
            ))}
          </div>
          {data.pageInfo.hasNextPage && (
            <p style={{ textAlign: 'center' }}>
              <button class="btn focusable" data-fk="more" disabled={loadingMore} onClick={more}>
                {loadingMore ? '불러오는 중…' : '더 보기'}
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
