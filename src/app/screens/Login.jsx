import { useEffect, useRef, useState } from 'preact/hooks';
import { useContext } from 'preact/hooks';
import { Nav } from '../App.jsx';
import { signIn } from '../auth.js';

export default function Login({ message, pending }) {
  const nav = useContext(Nav);
  const email = useRef(null);
  const password = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(message || '');

  useEffect(() => {
    if (pending) return;
    let saved = '';
    try {
      saved = localStorage.getItem('c101:lastEmail') || '';
    } catch (e) {
      /* ignore */
    }
    if (saved) {
      email.current.value = saved;
      password.current.focus();
    } else {
      email.current.focus();
    }
  }, []);

  async function submit() {
    const e = email.current.value.trim();
    const p = password.current.value;
    if (!e) return email.current.focus();
    if (!p) return password.current.focus();
    setBusy(true);
    setError('');
    try {
      await signIn(e, p);
      try {
        localStorage.setItem('c101:lastEmail', e);
      } catch (err) {
        /* ignore */
      }
      nav.reset('home');
    } catch (err) {
      if (err.code === 'SESSION_CHANGED') return; // a hand-over signed in meanwhile and took over
      setBusy(false);
      setError(err.message);
      password.current.focus();
    }
  }

  // The TV keyboard sends Enter when its "done" key is pressed.
  function onKey(field) {
    return (ev) => {
      if (ev.keyCode !== 13) return;
      ev.preventDefault();
      if (field === 'email') password.current.focus();
      else submit();
    };
  }

  if (pending) {
    return (
      <div class="screen login">
        <div class="login__card">
          <div class="brand">
            <img src="largeIcon.png" alt="" />
            클래스101
          </div>
          <h1>로그인 중…</h1>
          <p class="sub muted">컴퓨터에서 보낸 로그인 정보를 확인하고 있어요.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="screen login">
      <div class="login__card">
        <div class="brand">
          <img src="largeIcon.png" alt="" />
          클래스101
        </div>
        <h1>로그인</h1>
        <p class="sub muted">클래스101 이메일 계정으로 로그인해 주세요.</p>
        <input ref={email} type="email" data-fk="email" placeholder="이메일" autocomplete="username" onKeyDown={onKey('email')} />
        <input ref={password} type="password" data-fk="password" placeholder="비밀번호" autocomplete="current-password" onKeyDown={onKey('password')} />
        <button class="btn primary focusable" data-fk="submit" disabled={busy} onClick={submit}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
        <p class="error">{error}</p>
        <p class="note muted">
          카카오·네이버·구글·애플·페이스북으로 가입했다면 비밀번호가 없어요. 컴퓨터에서 <b>npm run tv:login</b>을
          실행하고, 열린 창에서 클래스101에 로그인하면 TV가 저절로 로그인돼요.
          <br />
          OK: 입력 · 방향키: 이동 · 뒤로 두 번: 종료
        </p>
      </div>
    </div>
  );
}
