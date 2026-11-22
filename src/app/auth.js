// Firebase Auth over REST: email/password sign-in, then ID tokens refreshed from
// the long-lived refresh token kept in localStorage (the TV app's own storage).
import { FIREBASE_API_KEY, endpoint } from './config.js';

const STORE = 'c101:session';

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const MESSAGES = {
  EMAIL_NOT_FOUND: '가입되지 않은 이메일이에요.',
  INVALID_PASSWORD: '비밀번호가 맞지 않아요.',
  INVALID_LOGIN_CREDENTIALS: '이메일 또는 비밀번호가 맞지 않아요.',
  INVALID_EMAIL: '이메일 형식이 올바르지 않아요.',
  MISSING_PASSWORD: '비밀번호를 입력해 주세요.',
  USER_DISABLED: '사용이 중지된 계정이에요.',
  TOO_MANY_ATTEMPTS_TRY_LATER: '로그인 시도가 너무 많아요. 잠시 후 다시 해 주세요.',
};

let session = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch (e) {
    return null;
  }
}

function save(next) {
  session = next;
  if (next) localStorage.setItem(STORE, JSON.stringify(next));
  else localStorage.removeItem(STORE);
}

export function currentUser() {
  return session ? { email: session.email } : null;
}

async function postJson(url, body, type) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': type || 'application/json' },
      body,
    });
  } catch (e) {
    throw new AuthError('인터넷에 연결할 수 없어요.', 'NETWORK');
  }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export async function signIn(email, password) {
  const { res, data } = await postJson(
    `${endpoint('signIn')}?key=${FIREBASE_API_KEY}`,
    JSON.stringify({ email, password, returnSecureToken: true, clientType: 'CLIENT_TYPE_WEB' })
  );
  if (!res.ok) {
    const code = String((data.error && data.error.message) || res.status).split(' ')[0];
    throw new AuthError(MESSAGES[code] || `로그인하지 못했어요. (${code})`, code);
  }
  save({
    email: data.email || email,
    uid: data.localId,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
  });
  return currentUser();
}

let refreshing = null;

async function refresh() {
  const { res, data } = await postJson(
    `${endpoint('refresh')}?key=${FIREBASE_API_KEY}`,
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
    'application/x-www-form-urlencoded'
  );
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      save(null);
      throw new AuthError('로그인이 만료됐어요. 다시 로그인해 주세요.', 'SESSION_EXPIRED');
    }
    throw new AuthError(`로그인 정보를 갱신하지 못했어요. (${res.status})`, 'REFRESH_FAILED');
  }
  save({
    ...session,
    idToken: data.id_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
  return session.idToken;
}

export function idToken({ force = false } = {}) {
  if (!session) return Promise.reject(new AuthError('로그인이 필요해요.', 'NO_SESSION'));
  if (!force && session.idToken && Date.now() < session.expiresAt - 60000) return Promise.resolve(session.idToken);
  if (!refreshing) {
    refreshing = refresh().then(
      (token) => {
        refreshing = null;
        return token;
      },
      (err) => {
        refreshing = null;
        throw err;
      }
    );
  }
  return refreshing;
}

// Google/Kakao/Apple accounts have no password, so they sign in on a computer
// and a computer hands the Firebase refresh token to the TV (scripts/tv-login.mjs).
export async function adoptRefreshToken(refreshToken, email) {
  save({ email: email || '', uid: '', idToken: '', refreshToken, expiresAt: 0 });
  await idToken({ force: true });
  if (!session.email) {
    const { res, data } = await postJson(`${endpoint('lookup')}?key=${FIREBASE_API_KEY}`, JSON.stringify({ idToken: session.idToken }));
    const user = res.ok && data.users && data.users[0];
    if (user) save({ ...session, email: user.email || '', uid: user.localId || '' });
  }
  return currentUser();
}

export function signOut() {
  save(null);
}
