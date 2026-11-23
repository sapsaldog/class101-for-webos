// Class101 GraphQL gateway. Documents mirror the ones class101.net sends (minus its
// client-only @merge/@relayPagination directives), so the gateway accepts them.
import { endpoint } from './config.js';
import { idToken, loginId, AuthError } from './auth.js';
import { hasLuna, lunaCall, lunaSubscribe } from './luna.js';
import { request } from './net.js';

const SERVICE = 'luna://com.sapsaldog.class101.service';
// On the TV, requests go through our JS service. Tests and desktop browsers (no
// Luna, or mock endpoints) use plain fetch.
const onTv = hasLuna() && !localStorage.getItem('c101:endpoints');
let relayDownUntil = 0; // the Luna bus refused a read (service missing?): GraphQL uses fetch until then

// The signed-in account, to keep queued writes from going out under another one.
const account = () => loginId();

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
// to the TV menu language and Class101 then answers in English. A write is never
// sent a second way: whether a failed try reached Class101 is unknown (Luna can even
// answer "Message status unknown."), and a mutation could apply twice. A read may
// fall back to fetch for a minute when the bus refuses it (service missing).
async function post(body, token, isWrite) {
  if (onTv && Date.now() >= relayDownUntil) {
    try {
      const res = await lunaCall(`${SERVICE}/gql`, { body, token, language: 'ko', userAgent: navigator.userAgent });
      return { status: res.status, json: parse(res.body) };
    } catch (e) {
      if (isWrite || e.uncertain || (e.response && e.response.relayError)) throw e;
      relayDownUntil = Date.now() + 60000;
    }
  }
  const res = await request(endpoint('graphql'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'ko', authorization: `Bearer ${token}` },
    body,
  });
  return { status: res.status, json: parse(res.text) };
}

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// opts.who: the login a queued write belongs to. It is not sent (nor retried with a
// refreshed token) once another login is current. opts.strict: any GraphQL error fails
// the call, for answers where a missing field must not read as "none".
async function gql(operationName, query, variables, opts = {}) {
  const { who, strict, retried } = opts;
  const mine = () => who === undefined || account() === who;
  const changed = () => new ApiError('다른 계정으로 바뀌어 보내지 않았어요.', 'ACCOUNT_CHANGED');
  if (!mine()) throw changed();
  const token = await idToken({ force: !!retried });
  if (!mine()) throw changed();
  let res;
  try {
    res = await post(JSON.stringify({ operationName, query, variables: variables || {} }), token, /^\s*mutation\b/.test(query));
  } catch (e) {
    throw new ApiError('인터넷에 연결할 수 없어요.', 'NETWORK');
  }
  const json = res.json;
  if (!json) throw new ApiError(`서버 응답을 읽지 못했어요. (${res.status})`, 'BAD_RESPONSE');
  const errors = json.errors || [];
  const unauth = errors.some((e) => e.extensions && e.extensions.code === 'UNAUTHENTICATED') || res.status === 401;
  if (unauth && !retried) return gql(operationName, query, variables, { who, strict, retried: true });
  if (unauth) throw new AuthError('로그인이 만료됐어요. 다시 로그인해 주세요.', 'SESSION_EXPIRED');
  if (res.status >= 400 && !json.data) throw new ApiError(`서버가 요청을 처리하지 못했어요. (${res.status})`, `HTTP_${res.status}`);
  const data = json.data || {};
  const empty = Object.keys(data).every((k) => data[k] == null);
  if (errors.length && (empty || strict)) {
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
    `query TvLastClass { lastClass { id title coverImageURL progressRatio lastLesson { id } creator { nickName } } }`,
    {},
    { strict: true } // a failed lastLesson must not read as "no last lesson"
  );
  return data.lastClass || null;
}

// The class's last lesson as Class101 has it: the lesson whose position was saved last
// (setLessonProgress moves it; opening a lecture does not). The site asks the same way.
export async function classLastLesson(klassId) {
  const data = await gql(
    'TvClassLastLesson',
    `query TvClassLastLesson($classId: ID!) { class(classId: $classId, marked: true) { id lastLesson { id } } }`,
    { classId: klassId },
    { strict: true } // a failed lastLesson must not read as "no last lesson"
  );
  return (data.class && data.class.lastLesson && data.class.lastLesson.id) || null;
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

// Resolves once every write in flight now has finished. Each is bounded: Luna times
// out after 25 s, and fetch (net.request) after 20 s.
export function settled() {
  return Promise.all(pending.map((p) => p.catch(() => {}))).then(() => undefined);
}

export function writing() {
  return pending.length > 0;
}

// Position saves go out one at a time, in the order they were made, across lessons:
// each also moves the class's last lesson on Class101 (see classLastLesson), so a
// lecture left behind must not land after the one opened next. Saves of one lesson
// still waiting are merged into its newest position. `who` is the account the player
// was opened with; the save is dropped if another one is signed in by then.
let saving = Promise.resolve();
const unsent = {}; // "<who> <lessonId>" → newest position not sent yet
let lastSent = null; // { key, value, at } of the save confirmed last
const lessonStep = {}; // "<who> <lessonId>" → its newest queued step
// A save turned down or failed, with no later step to carry it, is tried again a few
// times. (The site doesn't retry at all; nothing is kept across an app restart.)
const RETRY_MS = [2000, 5000, 15000];
const retries = {}; // key → { tries, timer }

export function saveProgress(lessonId, progressSeconds, who = account()) {
  const key = `${who} ${lessonId}`;
  unsent[key] = Math.max(0, Math.round(progressSeconds));
  return enqueue(key, lessonId, who);
}

function enqueue(key, lessonId, who) {
  const step = () => {
    const value = unsent[key];
    if (value === undefined) return null; // merged into an earlier step
    delete unsent[key];
    // Leaving saves twice (Back, then unmount): skip the same position of the same lesson
    // confirmed just before, with no other lesson in between.
    if (lastSent && lastSent.key === key && lastSent.value === value && Date.now() - lastSent.at < 5000) return null;
    lastSent = null; // set again only once this one is confirmed
    // Not confirmed: unless a newer position is waiting, hand this one to the next step
    // for the lesson (a save merged into this one, or a retry a little later).
    const putBack = () => {
      if (unsent[key] === undefined) unsent[key] = value;
      retryLater(key, lessonId, who);
    };
    return gql(
      'TvSetLessonProgress',
      `mutation TvSetLessonProgress($lessonId: String!, $progressSeconds: Float!) {
        setLessonProgress(lessonID: $lessonId, progressSeconds: $progressSeconds)
      }`,
      { lessonId, progressSeconds: value },
      { who }
    ).then(
      (data) => {
        // Only a confirmed save counts (the site checks the answer the same way).
        if (!data.setLessonProgress) return putBack();
        lastSent = { key, value, at: Date.now() };
        delete retries[key];
      },
      () => {
        putBack();
        return null;
      }
    );
  };
  saving = saving.then(step, step);
  lessonStep[key] = saving;
  return write(saving);
}

function retryLater(key, lessonId, who) {
  const r = retries[key] || (retries[key] = { tries: 0, timer: 0 });
  if (r.timer || r.tries >= RETRY_MS.length) return;
  r.timer = setTimeout(() => {
    r.timer = 0;
    r.tries++;
    if (unsent[key] !== undefined) enqueue(key, lessonId, who); // nothing sent it meanwhile
  }, RETRY_MS[r.tries]);
}

// Resolves when the lesson's queued position saves are done (and so every save queued
// before them). The player waits for it before reading the resume position, so
// reopening a lecture quickly can't resume (and then save) from an older position.
export function lessonSaved(lessonId) {
  const p = lessonStep[`${account()} ${lessonId}`];
  return p ? p.then(() => undefined) : Promise.resolve();
}

// Class tickets, cached once found (a class can get a ticket later).
const tickets = {};
function klassTicket(klassId, who) {
  const key = `${who} ${klassId}`;
  if (tickets[key]) return Promise.resolve(tickets[key]);
  return gql(
    'TvKlassTicket',
    `query TvKlassTicket($klassId: String!) { klassTicket: getKlassTicketByKlassId(klassId: $klassId) { _id } }`,
    { klassId },
    { who }
  ).then((data) => {
    const id = (data.klassTicket && data.klassTicket._id) || null;
    if (id) tickets[key] = id;
    return id;
  });
}

// Opening a lecture: the site sends both when its lecture page opens, each on its own
// (the user's view history, and enterLecture with the class ticket); they move the
// class's last-watched time, not its last lesson. Visits go out one after another in
// opening order, and finish even after the player closes.
let visits = Promise.resolve();
export function openLecture(klassId, lectureId, who = account()) {
  const run = () =>
    Promise.all([
      gql(
        'TvViewHistory',
        `mutation TvViewHistory($klassId: String!, $lectureId: String!) { updateUserViewHistory(klassId: $klassId, missionId: $lectureId) }`,
        { klassId, lectureId },
        { who }
      ).catch(() => null),
      klassTicket(klassId, who)
        .then((ticket) =>
          ticket // the site skips enterLecture without a ticket too
            ? gql(
                'TvEnterLecture',
                `mutation TvEnterLecture($klassTicketId: String!, $missionId: String) { enterLecture(klassTicketId: $klassTicketId, missionId: $missionId) { lastWatchedAt } }`,
                { klassTicketId: ticket, missionId: lectureId },
                { who }
              )
            : null
        )
        .catch(() => null),
    ]);
  visits = visits.then(run, run);
  return write(visits);
}

// Lecture view session: the site sends this 10 s after the page opens and 10 s after
// playback starts or pauses, passing back the session id it got the last time. Without
// one, leave sessionId out: an explicit null fails on the gateway ("Cannot return null
// for non-nullable field Mutation.updateLectureViewHistory").
export function lectureViewHistory(sessionId, klassId, lectureId, videoPlayed, who) {
  const variables = { klassId, lectureId, videoPlayed: !!videoPlayed };
  if (sessionId) variables.sessionId = sessionId;
  return write(
    gql(
      'TvLectureViewHistory',
      `mutation TvLectureViewHistory($sessionId: String, $klassId: String!, $lectureId: String!, $videoPlayed: Boolean!) {
        sessionId: updateLectureViewHistory(sessionId: $sessionId, klassId: $klassId, lectureId: $lectureId, videoPlayed: $videoPlayed)
      }`,
      variables,
      { who }
    ).then((data) => data.sessionId || sessionId || null)
  );
}

export function signedInAs() {
  return account();
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
  const res = await request(endpoint('api') + path, {
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
export function reportPlaytime(lessonId, videoId, playbackLocation, interval, who = account()) {
  // `who` earned it; it is dropped if another account is signed in by the time it goes.
  const path = `/v1/playtime-tracking/lessons/${encodeURIComponent(lessonId)}/play`;
  const earned = { playbackLocation, interval, timestamp: new Date().toISOString() };
  return write(
    Promise.resolve(videoId).then((id) => {
      if (!id) return null; // no video id for this lesson: nothing to report it against
      const payload = { ...earned, videoId: id };
      const send = (force) => idToken({ force }).then((token) => (account() === who ? rest(path, payload, token) : 0));
      return send(false)
        .then((status) => (status === 401 ? send(true) : status))
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
