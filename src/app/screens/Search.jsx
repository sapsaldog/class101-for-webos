import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Nav } from '../App.jsx';
import { searchClasses, categoryClasses, discover } from '../api.js';
import { focusKey, focusFirst } from '../focus.js';

// Remembered while the app runs, so Back from a class returns to the same results.
let last = null;

export default function Search({ restoreFocus }) {
  const nav = useContext(Nav);
  const input = useRef(null);
  const [chips, setChips] = useState(last ? last.chips : null);
  const [result, setResult] = useState(last ? last.result : null); // { label, kind, key, items, pageInfo, total }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!chips)
      discover()
        .then((d) => setChips(d))
        .catch((err) => {
          if (!nav.fail(err)) setChips({ terms: [], categories: [] });
        });
    if (last && last.query) input.current.value = last.query;
    if (!focusKey(restoreFocus)) input.current.focus();
  }, []);

  useEffect(() => {
    last = { chips, result, query: input.current ? input.current.value : '' };
  }, [chips, result]);

  function run(kind, key, label, after) {
    setBusy(true);
    setError('');
    const req = kind === 'search' ? searchClasses(key, after) : categoryClasses(key, after);
    req
      .then((r) => {
        setBusy(false);
        setResult((prev) =>
          after && prev ? { ...prev, items: prev.items.concat(r.items), pageInfo: r.pageInfo } : { label, kind, key, ...r }
        );
        if (!after) setTimeout(() => focusFirst('.card') || null, 0);
      })
      .catch((err) => {
        setBusy(false);
        if (!nav.fail(err)) setError(err.message);
      });
  }

  function search(q) {
    const query = (q === undefined ? input.current.value : q).trim();
    if (!query) return input.current.focus();
    input.current.value = query;
    input.current.blur();
    run('search', query, `"${query}" 검색 결과`);
  }

  function onKeyDown(e) {
    if (e.keyCode !== 13) return;
    e.preventDefault();
    search();
  }

  return (
    <div class="screen search">
      <div class="search__bar">
        <input ref={input} type="search" data-fk="query" placeholder="클래스 검색 (OK를 누르면 입력)" onKeyDown={onKeyDown} />
        <button class="btn primary focusable" data-fk="go" onClick={() => search()}>
          검색
        </button>
      </div>

      {chips && chips.terms.length > 0 && (
        <div class="chips">
          <span class="chips__label muted">인기 검색어</span>
          {chips.terms.map((t) => (
            <button key={t} class="chip focusable" data-fk={`term-${t}`} onClick={() => search(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      {chips && chips.categories.length > 0 && (
        <div class="chips">
          <span class="chips__label muted">카테고리</span>
          {chips.categories.map((c) => (
            <button key={c.id} class="chip focusable" data-fk={`cat-${c.id}`} onClick={() => run('category', c.id, `${c.title} · PLUS 클래스`)}>
              {c.title}
            </button>
          ))}
        </div>
      )}

      {error && <p class="error">{error}</p>}
      {busy && !result && <div class="empty muted">찾는 중…</div>}
      {result && (
        <>
          <h2 class="section-title">
            {result.label} <span class="muted">({result.total}개)</span>
          </h2>
          {!result.items.length && <div class="empty muted">PLUS 구독으로 볼 수 있는 클래스를 찾지 못했어요.</div>}
          <div class="grid">
            {result.items.map((c) => (
              <button
                key={c.klassId}
                class="card focusable"
                data-fk={`found-${c.klassId}`}
                onClick={() => nav.push('klass', { klassId: c.klassId, title: c.title, cover: c.coverImageUrl })}
              >
                <div class="card__img">
                  <img src={c.coverImageUrl} alt="" />
                </div>
                <div class="card__title">{c.title}</div>
                <div class="card__meta muted">{c.author && c.author.displayName}</div>
              </button>
            ))}
          </div>
          {result.pageInfo.hasNextPage && (
            <p style={{ textAlign: 'center' }}>
              <button class="btn focusable" data-fk="more" disabled={busy} onClick={() => run(result.kind, result.key, result.label, result.pageInfo.endCursor)}>
                {busy ? '불러오는 중…' : '더 보기'}
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
