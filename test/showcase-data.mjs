// Made-up classes for README screenshots (scripts/screenshots.mjs). Every title,
// creator and cover here is invented, so screenshots show no real account and no
// Class101 artwork. Plugged into the mock with startMock({ data: showcase }).

const CLASSES = [
  { id: 'k1', last: '선 긋기와 기본 도형', title: '아이패드로 시작하는 감성 드로잉', creator: '하루그림', cat: '드로잉', emoji: '🎨', colors: ['#ff9a8b', '#ff5e7e'], progress: 42 },
  { id: 'k2', last: 'pandas로 표 다루기', title: '왕초보를 위한 파이썬 데이터 분석', creator: '데이터랩 민', cat: '개발', emoji: '🐍', colors: ['#5ee7df', '#3a7bd5'], progress: 18 },
  { id: 'k3', last: '르방 키우기 3일차', title: '집에서 굽는 천연발효 빵', creator: '오븐 앞 소피', cat: '베이킹', emoji: '🥐', colors: ['#f6d365', '#fda085'], progress: 75 },
  { id: 'k4', last: '말린 어깨 풀기', title: '하루 10분, 거북목 펴는 홈트레이닝', creator: '코치 준', cat: '운동', emoji: '🧘', colors: ['#89a7ff', '#6dd5ed'], progress: 30 },
  { id: 'k5', last: '첫 문장 고르는 법', title: '읽히는 글쓰기: 첫 문장부터 퇴고까지', creator: '문장수선공', cat: '글쓰기', emoji: '✍️', colors: ['#b8e986', '#4fb286'], progress: 60 },
  { id: 'k6', last: '역광에서 얼굴 살리기', title: '스마트폰으로 찍는 인물 사진', creator: '포토그래퍼 윤', cat: '사진', emoji: '📷', colors: ['#bdc3c7', '#5d6d7e'], progress: 10 },
  { id: 'k7', last: '세븐스 코드 익히기', title: '기초부터 배우는 재즈 피아노', creator: '건반 위 레오', cat: '음악', emoji: '🎹', colors: ['#c471f5', '#fa71cd'], progress: 5 },
  { id: 'k8', last: '물 주기 달력 만들기', title: '식물 집사 입문: 실내 가드닝', creator: '초록손 지니', cat: '라이프', emoji: '🪴', colors: ['#96fbc4', '#2f9e7a'], progress: 90 },
];
const EXTRA = [
  { id: 'k9', title: '수채화로 그리는 여행 일러스트', creator: '물빛 화실', cat: '드로잉', emoji: '🖌️', colors: ['#84fab0', '#8fd3f4'] },
  { id: 'k10', title: '인물 크로키 30일 챌린지', creator: '선 하나 스튜디오', cat: '드로잉', emoji: '✏️', colors: ['#fbc2eb', '#a18cd1'] },
  { id: 'k11', title: '귀여운 캐릭터로 이모티콘 만들기', creator: '몽글 작가', cat: '드로잉', emoji: '🐻', colors: ['#ffe29f', '#ffa99f'] },
];
const ALL = [...CLASSES, ...EXTRA];

// The class the screenshots open: chapters with done, current and locked lectures.
const LECTURES = [
  { _id: 'l1', chapter: 0, title: '오리엔테이션: 이 클래스에서 그릴 것들', min: 6, completed: true },
  { _id: 'l2', chapter: 0, title: '프로크리에이트 화면과 브러시 익히기', min: 12, completed: true },
  { _id: 'l3', chapter: 1, title: '선 긋기와 기본 도형', min: 12, completed: false },
  { _id: 'l4', chapter: 1, title: '명암으로 입체감 주기', min: 14, completed: false },
  { _id: 'l5', chapter: 1, title: '나만의 컬러 팔레트 만들기', min: 11, completed: false },
  { _id: 'l6', chapter: 2, title: '창가의 카페 풍경 완성하기', min: 18, completed: false },
  { _id: 'l7', chapter: 2, title: '보너스: 나만의 브러시 만들기', min: 9, completed: false, locked: true },
];
const CHAPTERS = ['1부 준비하기', '2부 선과 도형', '3부 작품 완성'];
export const RESUME = { lectureId: 'l3', seconds: 252 };
export const VIDEO_SECONDS = 12 * 60;

function cover(base, c) {
  return `${base}/showcase/covers/${c.id}.svg`;
}

function lecture(l) {
  return {
    _id: l._id,
    index: LECTURES.indexOf(l),
    title: l.title,
    completed: l.completed,
    canAccess: !l.locked,
    video: { contentId: `v-${l._id}`, duration: l.min * 60 },
  };
}

function card(base, c, i) {
  return {
    id: c.id,
    title: c.title,
    coverImageURL: cover(base, c),
    accessible: true,
    progressRatio: c.progress,
    remainingDays: 300 - i * 20,
    lastLesson: { id: 'l3', title: c.last, index: 2, video: { id: 'v-l3', progressSeconds: RESUME.seconds, progressRatio: 0.35, remainingMinutes: 8 } },
    creator: { nickName: c.creator },
    accessibility: { accessible: true, message: null },
  };
}

function products(base, list) {
  const edges = list.map((c) => ({
    node: { _id: `p-${c.id}`, title: c.title, klassId: c.id, coverImageUrl: cover(base, c), isIncludedInPlusPlan: true, author: { displayName: c.creator } },
  }));
  return { mixedProducts: { edges, pageInfo: { hasNextPage: false, endCursor: null }, totalCount: edges.length } };
}

// GraphQL answers; null means "let the mock's default handle it".
export function graphql(body, base) {
  const v = body.variables || {};
  switch (body.operationName) {
    case 'TvTakingClasses':
      return { data: { viewer: { takingClasses: { edges: CLASSES.map((c, i) => ({ node: card(base, c, i) })), pageInfo: { hasNextPage: false, endCursor: null } } } } };
    case 'TvLastClass': {
      const c = CLASSES[0];
      return { data: { lastClass: { id: c.id, title: c.title, coverImageURL: cover(base, c), progressRatio: c.progress, lastLesson: { id: RESUME.lectureId }, creator: { nickName: c.creator } } } };
    }
    case 'TvCurriculum': {
      const c = ALL.find((x) => x.id === v.klassId) || CLASSES[0];
      return {
        data: {
          klassById: {
            _id: c.id,
            title: c.title,
            coverImage: cover(base, c),
            chapters: CHAPTERS.map((title, i) => ({
              _id: `c${i + 1}`,
              index: i,
              title,
              subtitle: null,
              isSecret: false,
              willOpenAt: null,
              lectures: LECTURES.filter((l) => l.chapter === i).map(lecture),
            })),
          },
        },
      };
    }
    case 'TvLecture': {
      const l = LECTURES.find((x) => x._id === v.lectureId);
      if (!l) return { data: { lecture: null } };
      return {
        data: {
          lecture: {
            ...lecture(l),
            videoUrl: l.locked ? null : `${base}/showcase/lecture.webm`,
            video: { contentId: `v-${l._id}`, duration: VIDEO_SECONDS },
            klass: { _id: CLASSES[0].id, title: CLASSES[0].title },
          },
        },
      };
    }
    case 'TvLesson':
      return {
        data: {
          lesson: {
            id: v.lessonId,
            title: 'x',
            video: { id: `v-${v.lessonId}`, progressSeconds: v.lessonId === RESUME.lectureId ? RESUME.seconds : 0 },
            captions: [{ language: 'ko', isAutoGenerated: true, url: `${base}/showcase/ko.srt`, label: '한국어' }],
          },
        },
      };
    case 'TvDiscover':
      return {
        data: {
          trendingSearchTermsV2: ['드로잉', '파이썬', '영어 회화', '홈베이킹', '재테크', '피아노'],
          popularCategories: [
            { id: 'cat1', title: '드로잉 · 일러스트' },
            { id: 'cat2', title: '프로그래밍' },
            { id: 'cat3', title: '요리 · 베이킹' },
            { id: 'cat4', title: '운동 · 건강' },
            { id: 'cat5', title: '커리어 · 자기계발' },
          ],
        },
      };
    case 'TvSearch':
      return { data: { searchProductsV5: products(base, ALL.filter((c) => c.cat === '드로잉')) } };
    case 'TvCategory':
      return { data: { categoryProductsV4: products(base, ALL.filter((c) => c.cat === '드로잉')) } };
    default:
      return null;
  }
}

function coverSvg(c) {
  const [a, b] = c.colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <circle cx="545" cy="70" r="130" fill="#fff" opacity="0.14"/>
  <circle cx="70" cy="340" r="170" fill="#fff" opacity="0.10"/>
  <text x="330" y="235" font-size="160" text-anchor="middle" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${c.emoji}</text>
  <text x="34" y="62" font-size="32" font-weight="800" fill="#fff" font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif">${c.cat}</text>
</svg>`;
}

const SRT = `1
00:00:00,000 --> 00:30:00,000
펜 압력은 살짝 빼고, 팔 전체로 길게 그어 볼게요
`;

// Extra routes: covers, captions and the slide video made by the screenshot script.
export function serve(url, res, { videoFile } = {}) {
  const m = /^\/showcase\/covers\/(k\d+)\.svg$/.exec(url.pathname);
  if (m) {
    const c = ALL.find((x) => x.id === m[1]);
    if (!c) return false;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(coverSvg(c));
    return true;
  }
  if (url.pathname === '/showcase/ko.srt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(SRT);
    return true;
  }
  if (url.pathname === '/showcase/lecture.webm' && videoFile) return { file: videoFile, type: 'video/webm' };
  return false;
}

// The lecture "slide" the video shows (rendered to PNG by the screenshot script).
export const SLIDE_HTML = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #fbf7f2; font-family: "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
  .left { position: absolute; left: 90px; top: 120px; width: 520px; color: #2b2b2b; }
  .kicker { color: #ff5e7e; font-weight: 800; font-size: 26px; letter-spacing: 1px; }
  h1 { font-size: 58px; line-height: 1.2; margin: 18px 0 28px; }
  li { font-size: 28px; line-height: 1.9; color: #555; }
  .pad { position: absolute; right: 90px; top: 90px; width: 500px; height: 540px; border-radius: 36px; background: #fff; box-shadow: 0 18px 50px rgba(0,0,0,0.12); }
</style>
<div class="left"><div class="kicker">2부 · 선과 도형</div><h1>선 긋기와<br>기본 도형</h1>
<ul><li>긴 선은 팔 전체로</li><li>원은 두 번에 나눠서</li><li>도형을 겹쳐 형태 잡기</li></ul></div>
<div class="pad"><svg width="500" height="540" viewBox="0 0 500 540">
  <path d="M60 110 C 170 70, 300 150, 440 100" stroke="#2b2b2b" stroke-width="6" fill="none" stroke-linecap="round"/>
  <path d="M60 170 C 170 140, 300 200, 440 160" stroke="#2b2b2b" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.6"/>
  <circle cx="160" cy="330" r="85" stroke="#ff5e7e" stroke-width="7" fill="none"/>
  <rect x="270" y="250" width="160" height="160" rx="14" stroke="#3a7bd5" stroke-width="7" fill="none"/>
  <path d="M110 480 L 250 430 L 390 480" stroke="#2f9e7a" stroke-width="7" fill="none" stroke-linejoin="round"/>
</svg></div>`;
