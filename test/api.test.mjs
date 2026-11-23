// Unit test of the position-save queue in src/app/api.js, in Node, with a fake
// GraphQL server in place of fetch: replies can be held and released one by one.
//   node test/api.test.mjs
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {}; // no PalmServiceBridge: the fetch path
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test' } }); // Node 21+ has one
store.set('c101:endpoints', JSON.stringify({ graphql: 'http://fake/graphql', api: 'http://fake/api' }));
store.set('c101:session', JSON.stringify({ sid: 's1', email: 'a@example.com', idToken: 'tok-1', refreshToken: 'ref-1', expiresAt: Date.now() + 3600000 }));

const log = []; // requests in the order the fake server gets them
const held = []; // replies waiting for release()
let holding = false;
let turnDown = {}; // lessonId → how many of its saves to answer false
let failNext = {}; // lessonId → how many of its saves fail as network errors
globalThis.fetch = (url, opts) => {
  const body = JSON.parse(opts.body);
  const v = body.variables || {};
  log.push({ op: body.operationName, v });
  if (failNext[v.lessonId] > 0) {
    failNext[v.lessonId]--;
    return Promise.reject(new TypeError('network'));
  }
  let ok = true;
  if (body.operationName === 'TvSetLessonProgress' && turnDown[v.lessonId] > 0) {
    turnDown[v.lessonId]--;
    ok = false;
  }
  const reply = () => ({ status: 200, ok: true, text: async () => JSON.stringify({ data: { setLessonProgress: ok } }) });
  return holding ? new Promise((resolve) => held.push(() => resolve(reply()))) : Promise.resolve(reply());
};

const api = await import('../src/app/api.js');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
async function releaseOne() {
  held.shift()();
  await flush();
}
async function drain() {
  while (held.length) await releaseOne();
}
const saves = () => log.filter((e) => e.op === 'TvSetLessonProgress').map((e) => `${e.v.lessonId}@${e.v.progressSeconds}`).join(' ');
const reset = () => {
  log.length = 0;
  turnDown = {};
  failNext = {};
};

// Order across lessons: each save moves the class's last lesson on Class101.
reset();
holding = true;
api.saveProgress('A', 10);
await flush();
api.saveProgress('B', 5);
await flush();
check('a save waits for the one before it, even for another lesson', saves() === 'A@10', saves());
await drain();
check('…and goes out once that one is answered', saves() === 'A@10 B@5', saves());

// Saves of one lesson still waiting merge into its newest position.
reset();
api.saveProgress('A', 20);
await flush();
api.saveProgress('B', 6);
api.saveProgress('B', 7);
await flush();
await drain();
check('waiting saves of one lesson merge into the newest position', saves() === 'A@20 B@7', saves());

// A repeat of the position just confirmed is skipped, but not across another lesson.
reset();
holding = false;
api.saveProgress('B', 7);
await flush();
check('repeating the position just confirmed is skipped', saves() === '', saves());
api.saveProgress('A', 21);
await flush();
api.saveProgress('B', 7);
await flush();
check('…but not once another lesson was saved in between', saves() === 'A@21 B@7', saves());

// Back and unmount both wait behind another lesson's save and merge into one step.
// When that one is turned down, the second step must still send the position.
reset();
holding = true;
api.saveProgress('A', 30);
await flush();
turnDown.C = 1;
api.saveProgress('C', 9);
api.saveProgress('C', 9);
await flush();
await drain();
check('a save turned down goes out again with the save merged into it', saves() === 'A@30 C@9 C@9', saves());

// A network failure puts the position back the same way.
reset();
holding = false;
failNext.E = 1;
api.saveProgress('E', 4);
api.saveProgress('E', 4);
await flush();
check('a save that failed on the network goes out again with the next step', saves() === 'E@4 E@4', saves());

// A failed save with nothing after it is tried again a little later (2 s first).
reset();
holding = false;
failNext.F = 1;
api.saveProgress('F', 8);
await flush();
check('a lone failed save goes out once at first', saves() === 'F@8', saves());
await new Promise((r) => setTimeout(r, 2300));
await flush();
check('…and is retried a little later', saves() === 'F@8 F@8', saves());

// lessonSaved() waits for that lesson's queued saves.
reset();
holding = true;
api.saveProgress('D', 3);
await flush();
let saved = false;
api.lessonSaved('D').then(() => (saved = true));
await flush();
check('lessonSaved waits while the lesson has a save in flight', saved === false);
await drain();
check('…and resolves once it is answered', saved === true);
let other = false;
api.lessonSaved('Z').then(() => (other = true));
await flush();
check('a lesson with nothing queued resolves at once', other === true);
await api.settled();
check('settled() resolves when the queue is empty', true);

console.log(failures ? `\n${failures} check(s) failed` : '\nall passed');
process.exit(failures ? 1 : 0);
