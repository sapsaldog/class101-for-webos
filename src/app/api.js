// Class101 GraphQL gateway. Documents mirror the ones class101.net sends (minus its
// client-only @merge/@relayPagination directives), so the gateway accepts them.
import { endpoint } from './config.js';
import { idToken, currentUser, AuthError } from './auth.js';
import { hasLuna, lunaCall, lunaSubscribe } from './luna.js';

const SERVICE = 'luna://com.sapsaldog.class101.service';
// On the TV, requests go through our JS service. Tests and desktop browsers (no
// Luna, or mock endpoints) use plain fetch.
const onTv = hasLuna() && !localStorage.getItem('c101:endpoints');
let relayDownUntil = 0; // the Luna bus failed (service missing?): GraphQL uses fetch until then

// Keep the relay service warm while the app is open.
export function warmUp() {
  if (onTv) lunaSubscribe(`${SERVICE}/keepAlive`, {});
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// GraphQL goes through the service on the TV: the web engine forces Accept-Language
// to the TV menu language and Class101 then answers in English. Only a definite "no"
// from the Luna bus (the service is not installed) switches to fetch, for a minute.
// After a timeout, a garbled reply, or a network error the service reports, the
// request may have gone out, so it is not sent again another way: a mutation could
// apply twice.
async function post(body, token) {
  if (onTv && Date.now() >= relayDownUntil) {
    try {
      const res = await lunaCall(`${SERVICE}/gql`, { body, token, language: 'ko', userAgent: navigator.userAgent });
      return { status: res.status, json: parse(res.body) };
    } catch (e) {
      if (e.uncertain || (e.response && e.response.relayError)) throw e;
      relayDownUntil = Date.now() + 60000;
    }
  }
  const res = await fetch(endpoint('graphql'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'ko', authorization: `Bearer ${token}` },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function gql(operationName, query, variables, retried) {
  const token = await idToken({ force: !!retried });
  let res;
  try {
    res = await post(JSON.stringify({ operationName, query, variables: variables || {} }), token);
  } catch (e) {
    throw new ApiError('인터넷에 연결할 수 없어요.', 'NETWORK');
  }
  const json = res.json;
  if (!json) throw new ApiError(`서버 응답을 읽지 못했어요. (${res.status})`, 'BAD_RESPONSE');
  const errors = json.errors || [];
  const unauth = errors.some((e) => e.extensions && e.extensions.code === 'UNAUTHENTICATED') || res.status === 401;
  if (unauth && !retried) return gql(operationName, query, variables, true);
  if (unauth) throw new AuthError('로그인이 만료됐어요. 다시 로그인해 주세요.', 'SESSION_EXPIRED');
  const data = json.data || {};
  const empty = Object.keys(data).every((k) => data[k] == null);
  if (errors.length && empty) {
    const e = errors[0];
    throw new ApiError(e.message || '요청을 처리하지 못했어요.', e.extensions && e.extensions.code);
  }
  return data;
}

const CLASS_CARD = `
  id title coverImageURL accessible progressRatio remainingDays
  lastLesson { id title index video { id progressSeconds progressRatio remainingMinutes } }
  creator { nickName }
  accessibility { accessible message }
`;

export async function myClasses(after) {
  const data = await gql(
    'TvTakingClasses',
    `query TvTakingClasses($first: Int!, $after: String) {
      viewer { takingClasses(first: $first, after: $after) {
        edges { node { ${CLASS_CARD} } }
        pageInfo { hasNextPage endCursor }
      } }
    }`,
    { first: 40, after: after || null }
  );
  const conn = (data.viewer && data.viewer.takingClasses) || { edges: [], pageInfo: {} };
  return { items: conn.edges.map((e) => e.node), pageInfo: conn.pageInfo || {} };
}

export async function lastClass() {
  const data = await gql(
    'TvLastClass',
    `query TvLastClass { lastClass { id title coverImageURL progressRatio lastLesson { id } creator { nickName } } }`
  );
  return data.lastClass || null;
}

export async function curriculum(klassId) {
  const data = await gql(
    'TvCurriculum',
    `query TvCurriculum($klassId: ID!) {
      klassById(klassId: $klassId) {
        _id title coverImage
        chapters: chaptersV2 {
          _id index title subtitle isSecret willOpenAt
          lectures { _id index title completed canAccess video { contentId duration } }
        }
      }
    }`,
    { klassId }
  );
  if (!data.klassById) throw new ApiError('클래스를 찾을 수 없어요.', 'NOT_FOUND');
  return data.klassById;
}

export async function lecture(lectureId) {
  const data = await gql(
    'TvLecture',
    `query TvLecture($lectureId: String!) {
      lecture: lectureV2ById(lectureId: $lectureId) {
        _id title completed canAccess videoUrl
        video { contentId duration }
        klass { _id title }
      }
    }`,
    { lectureId }
  );
  return data.lecture;
}

export async function lesson(lessonId) {
  const data = await gql(
    'TvLesson',
    `query TvLesson($lessonId: ID!) {
      lesson(lessonId: $lessonId) {
        id title
        video { id progressSeconds }
        captions { language isAutoGenerated url label }
      }
    }`,
    { lessonId }
  );
  return data.lesson;
}

// ---- watching: what class101.net's lecture page reports ----

// Writes still in flight. Screens that show progress wait for them, or they could
// read the server before it has the lecture that was just watched.
const pending = [];
function write(promise) {
  pending.push(promise);
  const done = () => {
    const i = pending.indexOf(promise);
    if (i !== -1) pending.splice(i, 1);
  };
  promise.then(done, done);
  return promise;
}

// Resolves once every write in flight now has finished. Each is bounded by its
// transport's timeout (Luna 25 s on the TV).
export function settled() {
  return Promise.all(pending.map((p) => p.catch(() => {}))).then(() => undefined);
}

export function writing() {
  return pending.length > 0;
}

// Per-account memory for this app session, keyed "<email> <id>".
const account = () => (currentUser() || {}).email || '';
const accountKey = (id) => `${account()} ${id}`;

// Position saves for one lesson go out one at a time, newest position wins: two
// requests in flight could reach the server in the other order. A save still queued
// when the account changes is dropped.
const saves = {};
export function saveProgress(lessonId, progressSeconds) {
  const who = account();
  const key = `${who} ${lessonId}`;
  const q = saves[key] || (saves[key] = { chain: Promise.resolve(), next: null, saved: null, savedAt: 0 });
  q.next = Math.max(0, Math.round(progressSeconds));
  q.chain = q.chain.then(() => {
    const value = q.next;
    if (value === null) return null; // already sent by an earlier step
    q.next = null;
    if (account() !== who) return null;
    // Leaving saves twice (Back, then unmount): skip the same position saved just now.
    if (value === q.saved && Date.now() - q.savedAt < 5000) return null;
    return gql(
      'TvSetLessonProgress',
      `mutation TvSetLessonProgress($lessonId: String!, $progressSeconds: Float!) {
        setLessonProgress(lessonID: $lessonId, progressSeconds: $progressSeconds)
      }`,
      { lessonId, progressSeconds: value }
    ).then(
      () => {
        q.saved = value;
        q.savedAt = Date.now();
      },
      () => null
    );
  });
  return write(q.chain);
}

// Resolves when the lesson's queued position saves are done. The player waits for it
// before reading the resume position, so reopening a lecture quickly can't resume
// (and then save) from an older position.
export function lessonSaved(lessonId) {
  const q = saves[accountKey(lessonId)];
  return q ? q.chain.then(() => undefined) : Promise.resolve();
}

// The lecture last opened on this TV, per class, for a few minutes: enough for the
// class screen's 이어보기 and the home hero to follow it while the server's own last
// lesson catches up, and short enough not to hide watching on another device.
const OPENED_FOR_MS = 5 * 60 * 1000;
const opened = {};
export function recentLecture(klassId) {
  const o = opened[accountKey(klassId)];
  return o && Date.now() - o.at < OPENED_FOR_MS ? o.lectureId : null;
}

// Class tickets, cached once found (a class can get a ticket later).
const tickets = {};
function klassTicket(klassId) {
  const key = accountKey(klassId);
  if (tickets[key]) return Promise.resolve(tickets[key]);
  return gql(
    'TvKlassTicket',
    `query TvKlassTicket($klassId: String!) { klassTicket: getKlassTicketByKlassId(klassId: $klassId) { _id } }`,
    { klassId }
  ).then((data) => {
    const id = (data.klassTicket && data.klassTicket._id) || null;
    if (id) tickets[key] = id;
    return id;
  });
}

// Opening a lecture: the site sends both when its lecture page opens, each on its own
// (the user's view history, and enterLecture with the class ticket). Here visits go
// out in opening order and finish even after the player closes; an older visit skips
// enterLecture once a newer one exists, so a slow ticket lookup can't make it the
// latest.
let visits = Promise.resolve();
let lastVisit = 0;
export function openLecture(klassId, lectureId) {
  const seq = ++lastVisit;
  const who = account();
  opened[accountKey(klassId)] = { lectureId, at: Date.now() };
  const run = async () => {
    if (account() !== who) return;
    await gql(
      'TvViewHistory',
      `mutation TvViewHistory($klassId: String!, $lectureId: String!) { updateUserViewHistory(klassId: $klassId, missionId: $lectureId) }`,
      { klassId, lectureId }
    ).catch(() => null);
    const ticket = await klassTicket(klassId).catch(() => null);
    if (!ticket || seq !== lastVisit || account() !== who) return; // the site skips it without a ticket too
    await gql(
      'TvEnterLecture',
      `mutation TvEnterLecture($klassTicketId: String!, $missionId: String) { enterLecture(klassTicketId: $klassTicketId, missionId: $missionId) { lastWatchedAt } }`,
      { klassTicketId: ticket, missionId: lectureId }
    ).catch(() => null);
  };
  visits = visits.then(run, run);
  return write(visits);
}

// Lecture view session: the site sends this 10 s after the page opens and 10 s after
// playback starts or pauses, passing back the session id it got the last time. Without
// one, leave sessionId out: an explicit null fails on the gateway ("Cannot return null
// for non-nullable field Mutation.updateLectureViewHistory").
export function lectureViewHistory(sessionId, klassId, lectureId, videoPlayed) {
  const variables = { klassId, lectureId, videoPlayed: !!videoPlayed };
  if (sessionId) variables.sessionId = sessionId;
  return write(
    gql(
      'TvLectureViewHistory',
      `mutation TvLectureViewHistory($sessionId: String, $klassId: String!, $lectureId: String!, $videoPlayed: Boolean!) {
        sessionId: updateLectureViewHistory(sessionId: $sessionId, klassId: $klassId, lectureId: $lectureId, videoPlayed: $videoPlayed)
      }`,
      variables
    ).then((data) => data.sessionId || sessionId || null)
  );
}

function requestId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.prototype.map.call(b, (x) => (x + 0x100).toString(16).slice(1)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Class101's REST API. On the TV this always goes through the service: the API's CORS
// filter rejects the "Origin: null" of a file:// app ("Invalid CORS request"), so a
// direct fetch there cannot work.
async function rest(path, payload, token) {
  const body = JSON.stringify(payload);
  const id = requestId();
  if (onTv) {
    const res = await lunaCall(`${SERVICE}/rest`, { path, body, token, requestId: id, userAgent: navigator.userAgent });
    return res.status;
  }
  const res = await fetch(endpoint('api') + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-request-id': id },
    body,
  });
  return res.status;
}

// Watch time. The site posts it for every 10 s of lecture played (counted on the
// lecture's own clock, so every 5 s at 2x) and does not resend failed ones; here only
// a 401 is retried once, with a refreshed token. It never calls completeLectureV3 for
// video lectures: Class101 finishes those from watch time (the site polls
// lectureV2ById.completed to notice). The app leaves it to Class101 too.
// videoId may be a promise while the player is still looking it up; the interval is
// tracked as a write from the moment it was earned.
export function reportPlaytime(lessonId, videoId, playbackLocation, interval) {
  const path = `/v1/playtime-tracking/lessons/${encodeURIComponent(lessonId)}/play`;
  const earned = { playbackLocation, interval, timestamp: new Date().toISOString() };
  return write(
    Promise.resolve(videoId).then((id) => {
      if (!id) return null; // no video id for this lesson: nothing to report it against
      const payload = { ...earned, videoId: id };
      return idToken()
        .then((token) => rest(path, payload, token))
        .then((status) => (status === 401 ? idToken({ force: true }).then((token) => rest(path, payload, token)) : status))
        .then((status) => {
          if (status >= 400) throw new ApiError(`시청 시간을 보내지 못했어요. (${status})`, 'PLAYTIME');
          return status;
        });
    })
  );
}

// ---- finding classes (PLUS catalog) ----

const PRODUCT = `... on ProductV3 { _id title klassId coverImageUrl isIncludedInPlusPlan author { displayName } }`;

function products(conn) {
  const c = conn && conn.mixedProducts;
  if (!c) return { items: [], pageInfo: {}, total: 0 };
  return {
    items: c.edges.map((e) => e.node).filter((n) => n && n.klassId),
    pageInfo: c.pageInfo || {},
    total: c.totalCount || 0,
  };
}

export async function searchClasses(query, after) {
  const data = await gql(
    'TvSearch',
    `query TvSearch($query: String!, $filter: ProductSearchFilterV2, $first: Int, $after: String) {
      searchProductsV5(query: $query, filter: $filter) {
        mixedProducts(first: $first, after: $after) { edges { node { ${PRODUCT} } } pageInfo { hasNextPage endCursor } totalCount }
      }
    }`,
    { query, filter: { isIncludedInPlusPlan: true }, first: 24, after: after || null }
  );
  return products(data.searchProductsV5);
}

export async function categoryClasses(categoryId, after) {
  const data = await gql(
    'TvCategory',
    `query TvCategory($filter: ProductSearchFilterV2!, $first: Int, $after: String) {
      categoryProductsV4(filter: $filter) {
        mixedProducts(first: $first, after: $after) { edges { node { ${PRODUCT} } } pageInfo { hasNextPage endCursor } totalCount }
      }
    }`,
    { filter: { categoryIds: [categoryId], isIncludedInPlusPlan: true }, first: 24, after: after || null }
  );
  return products(data.categoryProductsV4);
}

export async function discover() {
  const data = await gql('TvDiscover', `query TvDiscover { trendingSearchTermsV2(limit: 12) popularCategories(depth: 1) { id title } }`);
  return { terms: data.trendingSearchTermsV2 || [], categories: data.popularCategories || [] };
}

// Lectures in curriculum order, with chapter titles attached.
export function flattenLectures(klass) {
  const out = [];
  for (const ch of klass.chapters || []) {
    for (const l of ch.lectures || []) out.push({ ...l, chapterTitle: ch.title });
  }
  return out;
}
