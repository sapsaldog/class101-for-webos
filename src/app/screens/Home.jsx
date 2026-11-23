import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Nav } from '../App.jsx';
import { myClasses, lastClass, settled } from '../api.js';
import { currentUser, loginId, signOut } from '../auth.js';
import { focusKey, focusFirst } from '../focus.js';
import { toggleHelp, toast } from '../overlay.js';
import { percent } from '../format.js';

// Kept across visits so coming back from a class shows the list instantly, then
// refreshes it (progress changes after watching). It belongs to one login: another
// account on the same TV never sees it. { who, last, list: { items, pageInfo } }
let cache = null;
const cachedFor = (who) => (cache && cache.who === who ? cache : null);

function Progress({ ratio }) {
  return (
    <div class="progress">
      <i style={{ width: `${percent(ratio)}%` }} />
    </div>
  );
}

export default function Home({ restoreFocus }) {
  const nav = useContext(Nav);
  const who = loginId();
  const mine = cachedFor(who);
  const [data, setData] = useState(mine && mine.list); // the class list
  const [hero, setHero] = useState(mine && mine.last); // the last class, shown on its own
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const user = currentUser();
  // st.last: the last class as Class101 answered after the player's writes (fresh);
  // refreshing: that reload, until it lands (the list on screen is cached till then).
  const st = useRef({ alive: true, last: null, fresh: false, refreshing: null, resuming: false });

  useEffect(() => {
    const now = st.current;
    now.alive = true;
    const load = () =>
      Promise.all([lastClass().then((l) => ({ l }), () => null), myClasses().then((r) => ({ r }), (err) => ({ err }))]).then(([a, b]) => {
        if (!now.alive || loginId() !== who) return; // another login took over meanwhile
        const prev = cachedFor(who);
        now.fresh = !!a;
        if (a) {
          now.last = a.l;
          setHero(a.l);
        }
        const list = b.r ? { items: b.r.items, pageInfo: b.r.pageInfo } : prev && prev.list;
        if (b.r) setData(list);
        else if (!nav.fail(b.err)) setError(b.err.message);
        cache = { who, last: a ? a.l : prev && prev.last, list };
      });
    // Back from the player its last writes may still be on the way: the cached list
    // stays up until they are done, then the server's view loads.
    const reload = settled()
      .then(() => now.alive && load())
      .then(() => {
        if (now.refreshing === reload) now.refreshing = null;
      });
    now.refreshing = reload;
    return () => {
      now.alive = false;
    };
  }, []);

  // 이어보기 opens the class's last lesson as Class101 has it after the player's writes:
  // pressed before the reload lands it waits for it, and if that lookup failed it asks
  // again. One press at a time, so a second OK can't open a second player.
  function resume() {
    const now = st.current;
    if (now.resuming) return;
    now.resuming = true;
    const open = (l) => {
      if (now.alive && l && l.lastLesson) nav.push('player', { klassId: l.id, lectureId: l.lastLesson.id });
      else now.resuming = false;
    };
    if (!now.refreshing && now.fresh) return open(now.last);
    toast('최근 강의를 확인하는 중…', 1500);
    Promise.resolve(now.refreshing)
      .then(() => (now.fresh ? now.last : lastClass()))
      .then(open, () => {
        now.resuming = false;
        toast('최근 강의를 확인하지 못했어요. 다시 눌러 주세요.', 3000);
      });
  }

  // Focus once content exists: where we left off, else the hero, else the first card.
  const ready = !!data || !!hero;
  useEffect(() => {
    if (!ready) return;
    if (!focusKey(restoreFocus) && !focusKey('hero')) focusFirst('.card');
  }, [ready]);

  function more() {
    setLoadingMore(true);
    myClasses(data.pageInfo.endCursor)
      .then((list) => {
        if (!st.current.alive || loginId() !== who) return;
        const next = { items: data.items.concat(list.items), pageInfo: list.pageInfo };
        setData(next);
        cache = { who, last: cache && cache.who === who ? cache.last : null, list: next };
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

  const last = hero && hero.lastLesson ? hero : null;

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
          onClick={resume}
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
