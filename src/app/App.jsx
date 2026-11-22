// Screen stack + remote-key routing. Only the top screen is rendered; each screen
// can claim keys through useKeys(), everything else gets the defaults below
// (arrows move focus, OK clicks, Back pops, blue toggles help).
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { KEY, arrowOf, colorOf, isBack } from './keys.js';
import { move, activeKey } from './focus.js';
import { toast, toggleHelp, isHelpOpen } from './overlay.js';
import { currentUser, signOut, adoptRefreshToken, AuthError } from './auth.js';
import Login from './screens/Login.jsx';
import Home from './screens/Home.jsx';
import Klass from './screens/Klass.jsx';
import Player from './screens/Player.jsx';
import Search from './screens/Search.jsx';

const SCREENS = { login: Login, home: Home, klass: Klass, player: Player, search: Search };

let seq = 0;
const entry = (name, props) => ({ id: ++seq, name, props: props || {} });

export const Nav = createContext(null);

export function useKeys(handler) {
  const nav = useContext(Nav);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => nav.setKeyHandler((e) => ref.current(e)), []);
  useEffect(() => () => nav.setKeyHandler(null), []);
}

// Parameters from `ares-launch -p` (initial launch) or a relaunch while running.
function launchParams() {
  try {
    const sys = window.webOSSystem || window.PalmSystem;
    const raw = sys && sys.launchParams;
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  } catch (e) {
    return {};
  }
}

function exitApp() {
  const sys = window.webOSSystem || window.PalmSystem;
  if (sys && typeof sys.platformBack === 'function') sys.platformBack();
  else window.close();
}

export default function App() {
  const [stack, setStack] = useState(() => {
    if (launchParams().c101RefreshToken) return [entry('login', { pending: true })];
    return [entry(currentUser() ? 'home' : 'login')];
  });
  const keyHandler = useRef(null);
  const exitArmed = useRef(0);

  const nav = useRef(null);
  if (!nav.current) {
    nav.current = {
      setKeyHandler: (fn) => {
        keyHandler.current = fn;
      },
      push: (name, props) =>
        setStack((s) => {
          const copy = s.slice();
          copy[copy.length - 1] = { ...copy[copy.length - 1], focus: activeKey() };
          return copy.concat(entry(name, props));
        }),
      pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      replace: (name, props) => setStack((s) => s.slice(0, -1).concat(entry(name, props))),
      reset: (name, props) => setStack([entry(name, props)]),
      // Any screen can hand us an error; an expired login sends everyone back to the login screen.
      fail: (err) => {
        if (err instanceof AuthError) {
          signOut();
          setStack([entry('login', { message: err.message })]);
          return true;
        }
        return false;
      },
    };
  }

  const stackRef = useRef(stack);
  stackRef.current = stack;

  const back = useCallback(() => {
    if (stackRef.current.length > 1) {
      setStack((s) => s.slice(0, -1));
    } else if (Date.now() < exitArmed.current) {
      exitApp();
    } else {
      exitArmed.current = Date.now() + 2500;
      toast('뒤로 버튼을 한 번 더 누르면 앱을 닫아요', 2500);
    }
  }, []);

  // Login handed over from a computer (accounts without a password: scripts/tv-login.mjs).
  useEffect(() => {
    function adopt(params) {
      if (!params || !params.c101RefreshToken) return;
      setStack([entry('login', { pending: true })]);
      adoptRefreshToken(params.c101RefreshToken, params.email)
        .then((user) => {
          toast(`${user && user.email ? user.email + ' 계정으로 ' : ''}로그인했어요`, 3000);
          setStack([entry('home')]);
        })
        .catch((err) => {
          signOut();
          setStack([entry('login', { message: `받은 로그인 정보로 로그인하지 못했어요. ${err.message}` })]);
        });
    }
    adopt(launchParams());
    const onRelaunch = (e) => adopt(e.detail || launchParams());
    document.addEventListener('webOSRelaunch', onRelaunch);
    return () => document.removeEventListener('webOSRelaunch', onRelaunch);
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (!e.isTrusted) return;
      if (isHelpOpen()) {
        if (isBack(e) || e.keyCode === KEY.ENTER || colorOf(e) === 'blue') toggleHelp(false);
        e.preventDefault();
        return;
      }
      if (keyHandler.current && keyHandler.current(e) === true) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const dir = arrowOf(e);
      if (dir) {
        const a = document.activeElement;
        if (a && a.tagName === 'INPUT' && (dir === 'left' || dir === 'right')) return; // caret
        move(dir);
        e.preventDefault();
      } else if (isBack(e)) {
        const a = document.activeElement;
        if (a && a.tagName === 'INPUT') a.blur();
        else back();
        e.preventDefault();
      } else if (e.keyCode === KEY.ENTER) {
        const a = document.activeElement;
        if (a && a !== document.body && !/^(BUTTON|INPUT|A|TEXTAREA|SELECT)$/.test(a.tagName)) {
          a.click();
          e.preventDefault();
        }
      } else if (colorOf(e) === 'blue') {
        toggleHelp();
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [back]);

  const top = stack[stack.length - 1];
  const Screen = SCREENS[top.name];
  return (
    <Nav.Provider value={nav.current}>
      <Screen key={top.id} {...top.props} restoreFocus={top.focus} />
    </Nav.Provider>
  );
}
