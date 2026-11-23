// Mock Class101 (Firebase auth + GraphQL gateway + media) shared by the browser tests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const media = path.join(root, 'test/fixtures/media');

// videoFor(lecture, base) lets a test choose each lecture's videoUrl. data swaps in
// another catalogue (test/showcase-data.mjs: { graphql, serve }) and serveOpts is
// passed to its serve().
export async function startMock({ videoFor, data, serveOpts } = {}) {

// views: [klassId, lectureId] (updateUserViewHistory), enter: [ticketId, lectureId],
// sessions: [sessionId, lectureId, videoPlayed], playtime: { lessonId, authOk, requestId, body },
// timeline: { op, lessonId, at, doneAt } per GraphQL request (doneAt: when answered).
const calls = { signIn: 0, refresh: 0, progress: [], complete: [], ops: [], views: [], enter: [], sessions: [], playtime: [], timeline: [] };
// hold[operationName] = ms delays that operation's answer (to test waiting for writes).
// fail.refresh = true makes token refresh answer 503 (a failure that isn't expiry).
// fail.saveFalseFor = lessonId: that lesson's next position save answers false (once).
// fail.expireOnPage2 = true: page two of the class list answers UNAUTHENTICATED, and
// token refresh answers INVALID_REFRESH_TOKEN (the login was revoked meanwhile).
// state.morePages = true: the class list has a second page.
const hold = {};
// fail.lessonErrors[lessonId] = n: that lesson's next n TvLesson lookups fail.
const fail = { refresh: false, saveFalseFor: null, expireOnPage2: false, lessonErrors: {} };
const state = { morePages: false };
let base = '';

const LECTURES = [
  { _id: 'l1', index: 0, title: '오리엔테이션', completed: true, canAccess: true, video: { contentId: 'v1', duration: 150 } },
  { _id: 'l2', index: 1, title: '기초 다지기', completed: false, canAccess: true, video: { contentId: 'v2', duration: 150 } },
  { _id: 'l3', index: 2, title: '실전 연습', completed: false, canAccess: true, video: { contentId: 'v3', duration: 150 } },
  { _id: 'l4', index: 3, title: '잠긴 보너스 강의', completed: false, canAccess: false, video: { contentId: 'v4', duration: 150 } },
];
// Class k1 follows what the app reports, as Class101 does: its last lesson is the lesson
// whose position was saved last (opening a lecture doesn't move it), its progress the
// share of completed lectures. Class progress is in the real API's
// units, a percentage 0-100; k2 sits at 1% (an old bug showed that as 100%).
const k1 = { lastLecture: 'l2' };
const k1Progress = () => Math.round((LECTURES.filter((l) => l.completed).length / LECTURES.length) * 100);

function lastLessonOf(i) {
  const l = LECTURES.find((x) => x._id === (i === 0 ? k1.lastLecture : 'l2'));
  return { id: l._id, title: l.title, index: l.index, video: { id: `v-${l._id}`, progressSeconds: 30, progressRatio: 0.2, remainingMinutes: 2 } };
}

function classes() {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `k${i + 1}`,
    title: `테스트 클래스 ${i + 1}: 아주 긴 제목이 두 줄까지 보이는지 확인하는 클래스`,
    coverImageURL: `${base}/cover.png`,
    accessible: true,
    progressRatio: i === 0 ? k1Progress() : i === 1 ? 1 : (i + 1) * 10,
    remainingDays: 100,
    lastLesson: lastLessonOf(i),
    creator: { nickName: `크리에이터 ${i + 1}` },
    accessibility: { accessible: true, message: null },
  }));
}

function graphql(body, auth) {
  calls.ops.push(body.operationName);
  if (!/^Bearer tok-/.test(auth || '')) {
    return { errors: [{ message: 'You need to authenticate first.', extensions: { code: 'UNAUTHENTICATED' } }], data: null };
  }
  const v = body.variables || {};
  const custom = data && data.graphql(body, base);
  if (custom) return custom;
  switch (body.operationName) {
    case 'TvTakingClasses': {
      if (v.after === 'page2') {
        if (fail.expireOnPage2) return { errors: [{ message: 'You need to authenticate first.', extensions: { code: 'UNAUTHENTICATED' } }], data: null };
        const extra = { ...classes()[5], id: 'k7', title: '테스트 클래스 7' };
        return { data: { viewer: { takingClasses: { edges: [{ node: extra }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      }
      const pageInfo = state.morePages ? { hasNextPage: true, endCursor: 'page2' } : { hasNextPage: false, endCursor: null };
      return { data: { viewer: { takingClasses: { edges: classes().map((node) => ({ node })), pageInfo } } } };
    }
    case 'TvLastClass':
      return { data: { lastClass: { id: 'k1', title: '테스트 클래스 1', coverImageURL: `${base}/cover.png`, progressRatio: k1Progress(), lastLesson: { id: k1.lastLecture }, creator: { nickName: '크리에이터 1' } } } };
    case 'TvCurriculum':
      return {
        data: {
          klassById: {
            _id: v.klassId,
            title: '테스트 클래스 1',
            coverImage: `${base}/cover.png`,
            chapters: [
              { _id: 'c1', index: 0, title: '1부 시작하기', subtitle: null, isSecret: false, willOpenAt: null, lectures: LECTURES.slice(0, 2) },
              { _id: 'c2', index: 1, title: '2부 실전', subtitle: null, isSecret: false, willOpenAt: null, lectures: LECTURES.slice(2) },
            ],
          },
        },
      };
    case 'TvLecture': {
      const l = LECTURES.find((x) => x._id === v.lectureId);
      return {
        data: {
          lecture: l && {
            _id: l._id,
            title: l.title,
            completed: l.completed,
            canAccess: l.canAccess,
            videoUrl: !l.canAccess ? null : videoFor ? videoFor(l, base) : `${base}/media/${l._id === 'l3' ? 'lecture2' : 'lecture1'}.webm`,
            video: l.video,
            klass: { _id: 'k1', title: '테스트 클래스 1' },
          },
        },
      };
    }
    case 'TvLesson':
      if (fail.lessonErrors[v.lessonId] > 0) {
        fail.lessonErrors[v.lessonId]--;
        return { errors: [{ message: 'Gateway timeout', extensions: { code: 'INTERNAL_SERVER_ERROR' } }], data: null };
      }
      return {
        data: {
          lesson: {
            id: v.lessonId,
            title: 'x',
            video: { id: `v-${v.lessonId}`, progressSeconds: v.lessonId === 'l2' ? 30 : 0 },
            captions: [{ language: 'ko', isAutoGenerated: false, url: `${base}/media/ko.srt`, label: '한국어' }],
          },
        },
      };
    case 'TvDiscover':
      return { data: { trendingSearchTermsV2: ['블로그', '영어', '드로잉'], popularCategories: [{ id: 'cat1', title: 'AI 스킬업' }, { id: 'cat2', title: '창업 · 부업' }] } };
    case 'TvSearch':
    case 'TvCategory': {
      const n = body.operationName === 'TvSearch' ? 3 : 2;
      const edges = Array.from({ length: n }, (_, i) => ({
        node: { _id: `p${i}`, title: `${body.operationName === 'TvSearch' ? v.query : '카테고리'} 클래스 ${i + 1}`, klassId: `k${i + 1}`, coverImageUrl: `${base}/cover.png`, isIncludedInPlusPlan: true, author: { displayName: `작가 ${i + 1}` } },
      }));
      const conn = { mixedProducts: { edges, pageInfo: { hasNextPage: false, endCursor: null }, totalCount: n } };
      return { data: body.operationName === 'TvSearch' ? { searchProductsV5: conn } : { categoryProductsV4: conn } };
    }
    case 'TvSetLessonProgress':
      calls.progress.push([v.lessonId, v.progressSeconds]);
      if (fail.saveFalseFor === v.lessonId) {
        fail.saveFalseFor = null;
        return { data: { setLessonProgress: false } }; // not applied
      }
      if (LECTURES.some((l) => l._id === v.lessonId)) k1.lastLecture = v.lessonId;
      return { data: { setLessonProgress: true } };
    case 'TvClassLastLesson':
      return { data: { class: { id: v.classId, lastLesson: { id: v.classId === 'k1' ? k1.lastLecture : 'l2' } } } };
    case 'TvCompleteLecture': {
      calls.complete.push(v.lectureId);
      const l = LECTURES.find((x) => x._id === v.lectureId);
      if (l) l.completed = true;
      return { data: { completeLecture: { _id: v.lectureId, completed: true } } };
    }
    case 'TvViewHistory':
      calls.views.push([v.klassId, v.lectureId]);
      return { data: { updateUserViewHistory: true } };
    case 'TvKlassTicket':
      return { data: { klassTicket: { _id: `ticket-${v.klassId}` } } };
    case 'TvEnterLecture':
      calls.enter.push([v.klassTicketId, v.missionId]);
      return { data: { enterLecture: { lastWatchedAt: new Date().toISOString() } } };
    case 'TvLectureViewHistory':
      // Like the real gateway: no sessionId opens a session; an explicit null fails.
      calls.sessions.push(['sessionId' in v ? v.sessionId : '(none)', v.lectureId, v.videoPlayed]);
      if ('sessionId' in v && !v.sessionId) {
        return { errors: [{ message: 'Cannot return null for non-nullable field Mutation.updateLectureViewHistory.', extensions: { code: 'INTERNAL_SERVER_ERROR' } }], data: null };
      }
      return { data: { sessionId: v.sessionId || `session-${calls.sessions.length}` } };
    default:
      return { errors: [{ message: `unknown op ${body.operationName}` }], data: null };
  }
}

function serveFile(res, file, type, req) {
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec((req && req.headers.range) || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/signin') {
    calls.signIn++;
    const body = JSON.parse(await readJson(req));
    if (body.email === 'tv@example.com' && body.password === 'secret') {
      return json(200, { email: body.email, localId: 'u1', idToken: 'tok-1', refreshToken: 'ref-1', expiresIn: '3600' });
    }
    return json(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } });
  }
  if (url.pathname === '/token') {
    calls.refresh++;
    if (fail.refresh) return json(503, { error: { message: 'UNAVAILABLE' } });
    if (fail.expireOnPage2) return json(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
    const body = await readJson(req);
    if (/refresh_token=ref-1/.test(body)) return json(200, { id_token: `tok-r${calls.refresh}`, refresh_token: 'ref-1', expires_in: '3600' });
    return json(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
  }
  if (url.pathname === '/graphql') {
    const body = JSON.parse(await readJson(req));
    const entry = { op: body.operationName, lessonId: (body.variables || {}).lessonId, at: Date.now(), doneAt: 0 };
    calls.timeline.push(entry);
    const answer = graphql(body, req.headers.authorization);
    const send = () => {
      entry.doneAt = Date.now();
      json(200, answer);
    };
    return hold[body.operationName] ? setTimeout(send, hold[body.operationName]) : send();
  }
  const play = /^\/api\/v1\/playtime-tracking\/lessons\/([^/]+)\/play$/.exec(url.pathname);
  if (play && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    const authOk = /^Bearer tok-/.test(auth);
    const lessonId = decodeURIComponent(play[1]);
    calls.playtime.push({ lessonId, authOk, requestId: req.headers['x-request-id'], body: JSON.parse((await readJson(req)) || '{}') });
    if (!authOk) return json(401, { result: 'FAIL', errorCode: 'http/unauthorized' });
    // Class101 finishes video lectures from watch time. The mock's stand-in rule: a
    // lecture counts as finished once any watch time for it arrives.
    const l = LECTURES.find((x) => x._id === lessonId);
    if (l) l.completed = true;
    return res.writeHead(200).end();
  }
  if (data && data.serve) {
    const handled = data.serve(url, res, serveOpts);
    if (handled && handled.file) return serveFile(res, handled.file, handled.type, req);
    if (handled) return;
  }
  if (url.pathname === '/cover.png') return serveFile(res, path.join(dist, 'splash.png'), 'image/png');
  if (url.pathname === '/media/ko.srt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('1\n00:00:00,000 --> 00:10:00,000\n테스트 자막입니다\n');
  }
  if (url.pathname.startsWith('/media/')) {
    const rel = path.normalize(url.pathname.slice('/media/'.length)).replace(/^(\.\.[/\\])+/, '');
    const ext = path.extname(rel);
    const type = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : ext === '.m4s' || ext === '.mp4' ? 'video/mp4' : 'video/webm';
    return serveFile(res, path.join(media, rel), type, req);
  }
  const file = path.join(dist, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
  return serveFile(res, file, types[path.extname(file)] || 'application/octet-stream');
});


  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, hold, fail, state, close: () => server.close() };
}
