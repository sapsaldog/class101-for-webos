import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { SpeedAudio } from '../speedAudio.js';
import { SpeedVideo } from '../speedVideo.js';
import { parseCues, cueAt } from '../captions.js';
import { Nav, useKeys } from '../App.jsx';
import {
  lecture as fetchLecture,
  lesson as fetchLesson,
  curriculum,
  flattenLectures,
  saveProgress,
  lessonSaved,
  openLecture,
  lectureViewHistory,
  reportPlaytime,
  signedInAs,
} from '../api.js';
import { KEY, arrowOf, colorOf, digitOf, isBack } from '../keys.js';
import { AuthError } from '../auth.js';
import {
  toast,
  flashCenter,
  showOsd,
  hideOsd,
  openMenu,
  closeMenu,
  isMenuOpen,
  menuKey,
  toggleHelp,
  showCurtain,
  fmtRate,
  fmtTime,
} from '../overlay.js';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SETTINGS = 'c101:player';
const SAVE_EVERY_MS = 15000;
const NEXT_UP_SECONDS = 8;
const PLAYTIME_EVERY = 10; // seconds of lecture per watch-time report, as on class101.net
const LESSON_TRIES = 3; // the resume lookup, before giving up on playing
const VIEW_SESSION_DELAY = 10; // seconds after opening / play / pause

function loadSettings() {
  try {
    return { rate: 1, captions: '', ...JSON.parse(localStorage.getItem(SETTINGS) || '{}') };
  } catch (e) {
    return { rate: 1, captions: '' };
  }
}

function storeSettings(s) {
  try {
    localStorage.setItem(SETTINGS, JSON.stringify(s));
  } catch (e) {
    /* ignore */
  }
}

const isHls = (url) => /\.m3u8$/i.test(String(url).split('?')[0]);

// Two ways to play a lecture:
//  native – <video src=HLS>, LG's player. Used at 1x (and for non-HLS sources,
//           where browsers handle playbackRate themselves).
//  speed  – any other speed on HLS: SpeedVideo feeds MSE a time-compressed copy
//           of the video and SpeedAudio plays pitch-kept stretched sound, because
//           webOS apps can't change playback speed with sound.
// Everything outside this component's media plumbing works in content time
// (seconds of the lecture), via s.time() / s.seek() / s.dur().
export default function Player({ klassId, lectureId, lectures }) {
  const nav = useContext(Nav);
  const videoRef = useRef(null);
  const [info, setInfo] = useState(null);
  const [message, setMessage] = useState('');
  const [nextUp, setNextUp] = useState(null);
  const [caption, setCaption] = useState('');
  const s = useRef({
    list: lectures || null,
    settings: loadSettings(),
    savedAt: 0,
    savedPos: -1,
    seekRepeat: 0,
    tracks: [],
    cues: [],
    mode: 'native',
    // The account this player was opened with: its saves and reports belong to it,
    // even the save on unmount after a login hand-over has switched accounts.
    who: signedInAs(),
    time: () => 0,
    dur: () => NaN,
    seek: () => {},
  }).current;

  // Inspector handle for debugging on the TV (ares-inspect).
  window.__c101Player = s;

  const title = info ? info.lecture.title : '';

  // What the OSD reads: content time, content duration, chosen speed.
  const clockView = {
    get currentTime() {
      return s.time();
    },
    get duration() {
      return s.dur();
    },
    get playbackRate() {
      return s.settings.rate;
    },
    get paused() {
      return videoRef.current ? videoRef.current.paused : true;
    },
    get ended() {
      return videoRef.current ? videoRef.current.ended : false;
    },
    get buffered() {
      const b = videoRef.current ? videoRef.current.buffered : { length: 0 };
      const k = s.mode === 'speed' ? s.settings.rate : 1;
      return { length: b.length, start: (i) => b.start(i) * k, end: (i) => b.end(i) * k };
    },
  };
  const osd = (ms) => showOsd(clockView, title, ms);

  // ---- loading ----
  useEffect(() => {
    let alive = true;
    showCurtain(true, '강의를 불러오는 중…');
    // The lesson holds where to resume. Playing without it would start at 0 and soon
    // save that over the real position, so it is asked again, and the player doesn't
    // start if it keeps failing (the site doesn't render its player without it either).
    const lessonWithRetry = (n = 1) =>
      fetchLesson(lectureId)
        .then((les) => {
          // No video data (a missing or failed field) is no answer: it would read as 0.
          if (!les || !les.video) throw new Error('이어볼 위치가 오지 않았어요.');
          return les;
        })
        .catch((err) => {
          if (!alive || n >= LESSON_TRIES || err instanceof AuthError) throw err;
          return new Promise((r) => setTimeout(r, 1000 * n)).then(() => lessonWithRetry(n + 1));
        });
    Promise.all([
      fetchLecture(lectureId),
      // After this lesson's queued position saves, so a quick reopen resumes from the newest one.
      lessonSaved(lectureId)
        .then(() => lessonWithRetry())
        .catch((err) => {
          if (err instanceof AuthError) throw err;
          throw new Error(`이어볼 위치를 불러오지 못해서 재생하지 않았어요. ${err.message}`);
        }),
      s.list ? null : curriculum(klassId).then(flattenLectures).catch(() => null),
    ])
      .then(([lec, les, list]) => {
        if (!alive) return;
        if (list) s.list = list;
        if (!lec) throw new Error('강의를 찾을 수 없어요.');
        if (lec.canAccess === false) throw new Error('이 강의는 지금 볼 수 없어요. 수강권이나 구독이 필요해요.');
        if (!lec.videoUrl) throw new Error('이 강의에는 재생할 영상이 없어요.');
        s.tracks = (les && les.captions) || [];
        setInfo({ lecture: lec, lesson: les });
      })
      .catch((err) => {
        if (!alive) return;
        showCurtain(false);
        if (!nav.fail(err)) setMessage(err.message);
      });
    return () => {
      alive = false;
      showCurtain(false);
      hideOsd();
      closeMenu();
    };
  }, [lectureId]);

  // ---- progress ----
  function save(force) {
    if (!info) return;
    const t = s.time();
    if (!isFinite(t) || t <= 0) return;
    if (!force && Math.abs(t - s.savedPos) < 3) return;
    s.savedPos = t;
    s.savedAt = Date.now();
    saveProgress(lectureId, t, s.who).catch(() => {});
  }

  // ---- playback plumbing ----
  function teardown() {
    const v = videoRef.current;
    if (s.audio) s.audio.destroy();
    if (s.video) s.video.destroy();
    s.audio = null;
    s.video = null;
    if (v) {
      v.muted = false;
      v.removeAttribute('src');
      v.load();
    }
  }

  function startPlayback(at, rate, autoplay) {
    const v = videoRef.current;
    if (!v || !info) return;
    const src = info.lecture.videoUrl;
    teardown();
    s.native = null;
    if (isHls(src) && Math.abs(rate - 1) > 0.01 && !s.speedBroken) {
      s.mode = 'speed';
      showCurtain(true, `${fmtRate(rate)}로 재생 준비 중…`);
      const fail = (err) => {
        if (s.video !== sv) return;
        s.speedBroken = true;
        toast(`배속 재생을 하지 못해 1배속으로 돌아가요 (${err.message})`, 4500);
        startPlayback(s.time() || at, 1, true);
      };
      const sv = new SpeedVideo(v, src, rate, { onError: fail });
      const sa = new SpeedAudio(v, src, { onError: fail, clock: () => sv.contentTime() });
      s.video = sv;
      s.audio = sa;
      s.time = () => sv.contentTime();
      s.dur = () => sv.duration() || (info.lecture.video && info.lecture.video.duration) || NaN;
      s.seek = (t) => sv.seek(t);
      sv.start(at)
        .then(() => {
          if (s.video !== sv) return;
          sa.setRate(rate);
          if (autoplay) {
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          }
        })
        .catch(fail);
    } else {
      s.mode = 'native';
      s.time = () => v.currentTime;
      s.dur = () => v.duration;
      s.seek = (t) => {
        const d = v.duration;
        v.currentTime = Math.max(0, isFinite(d) && d > 0 ? Math.min(t, d - 0.5) : t);
      };
      // Browsers (tests, non-HLS) honour playbackRate; LG's HLS player only at 1x.
      s.native = { at, rate: isHls(src) ? 1 : rate, autoplay };
      v.src = src;
    }
  }

  function setRate(r) {
    s.settings.rate = Math.max(RATES[0], Math.min(RATES[RATES.length - 1], r));
    storeSettings(s.settings);
    toast(`재생 속도 ${fmtRate(s.settings.rate)}`);
    const v = videoRef.current;
    if (!v || !info) return;
    const src = info.lecture.videoUrl;
    const wantSpeed = isHls(src) && Math.abs(s.settings.rate - 1) > 0.01 && !s.speedBroken;
    if (!isHls(src)) {
      v.playbackRate = s.settings.rate;
    } else if (wantSpeed && s.mode === 'speed' && s.audio) {
      // Different speed, same mode: rebuild with the new timeline.
      startPlayback(s.time(), s.settings.rate, !v.paused);
    } else if (wantSpeed !== (s.mode === 'speed')) {
      startPlayback(s.time(), s.settings.rate, !v.paused);
    }
  }

  useEffect(() => {
    if (!info) return;
    const dur = info.lecture.video && info.lecture.video.duration;
    const resumeAt = info.lesson && info.lesson.video ? info.lesson.video.progressSeconds : 0;
    const at = resumeAt > 5 && (!dur || resumeAt < dur - 15) ? resumeAt : 0;
    if (at) toast(`이어서 재생 (${fmtTime(at)}부터)`, 2500);
    startPlayback(at, s.settings.rate, true);
    return () => {
      save(true);
      teardown();
    };
  }, [info]);

  // ---- media events ----
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !info) return;
    const onMeta = () => {
      const n = s.native;
      if (!n) return;
      s.native = null;
      if (n.at > 0) v.currentTime = n.at;
      v.playbackRate = n.rate;
      if (n.autoplay) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    };
    const onPlaying = () => {
      showCurtain(false);
      osd(3000);
    };
    const onTime = () => {
      if (!v.paused && Date.now() - s.savedAt > SAVE_EVERY_MS) save(false);
    };
    // Every pause saves; the queue skips a repeat of the position just confirmed.
    const onPause = () => save(true);
    // Finishing is Class101's call, from watch time (see reportPlaytime).
    const onEnded = () => {
      const next = neighbour(1);
      if (next) setNextUp({ lecture: next, seconds: NEXT_UP_SECONDS });
      else {
        toast('마지막 강의까지 다 봤어요', 4000);
        osd(6000);
      }
    };
    const onError = () => {
      if (!v.getAttribute('src')) return; // teardown
      showCurtain(false);
      if (s.mode === 'speed') return; // SpeedVideo reports its own failures
      const code = v.error ? v.error.code : 0;
      setMessage(`영상을 재생하지 못했어요. (오류 ${code})`);
    };
    // Going to the background: pause, and save where we are even if already paused
    // (a seek while paused has no pause event to save it).
    const onHidden = () => {
      if (!document.hidden) return;
      if (!v.paused) v.pause();
      save(true);
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [info]);

  // ---- what class101.net's lecture page reports besides the position ----
  // The app used to send only the position, and 내 클래스 progress didn't move after
  // watching on the TV. The site finishes video lectures on Class101's side.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !info) return;
    const klass = (info.lecture.klass && info.lecture.klass._id) || klassId;
    if (!klass) return;
    let alive = true;
    const who = s.who;
    openLecture(klass, lectureId, who);

    // View session, like the site: VIEW_SESSION_DELAY s after opening and after the
    // playing state changes ('playing' / 'pause'), one request at a time, with the id
    // from the last answer; on errors the wait doubles.
    let session = null;
    let playing = false;
    let wait = VIEW_SESSION_DELAY;
    let timer = 0;
    let sending = Promise.resolve();
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const wasPlaying = playing; // the state this report is about, not the one at sending time
        sending = sending.then(() => {
          if (!alive) return null;
          return lectureViewHistory(session, klass, lectureId, wasPlaying, who).then(
            (id) => {
              session = id;
              wait = VIEW_SESSION_DELAY;
            },
            () => {
              if (!alive) return;
              wait = Math.min(wait * 2, 600);
              schedule();
            }
          );
        });
      }, wait * 1000);
    };
    const onPlaying = () => {
      if (playing) return;
      playing = true;
      schedule();
    };
    const onPaused = () => {
      if (!playing) return;
      playing = false;
      schedule();
    };
    schedule();
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPaused);

    // Watch time on the lecture's clock (content seconds), like the site: the sampling
    // baseline restarts on seeks, pauses and buffering, and steps over 3 s don't count;
    // a remainder under PLAYTIME_EVERY is dropped (the site does both too). If the
    // lesson lookup failed, the video id is looked up again when a report is due; an
    // earned report is sent even if the player closes meanwhile.
    let videoId = info.lesson && info.lesson.video && info.lesson.video.id;
    let lookup = null;
    const withVideoId = () => {
      if (videoId) return Promise.resolve(videoId);
      if (!lookup) {
        lookup = fetchLesson(lectureId)
          .then((l) => (videoId = (l && l.video && l.video.id) || null), () => null)
          .then((id) => {
            lookup = null;
            return id;
          });
      }
      return lookup;
    };
    let last = null;
    let played = 0;
    const restart = () => {
      last = null;
    };
    const breaks = ['seeking', 'seeked', 'waiting', 'pause', 'emptied'];
    breaks.forEach((name) => v.addEventListener(name, restart));
    const tick = setInterval(() => {
      const t = s.time();
      if (v.paused || v.seeking || v.ended || !isFinite(t)) {
        last = null;
        return;
      }
      if (last !== null && t >= last && t - last <= 3) played += t - last;
      last = t;
      if (played >= PLAYTIME_EVERY) {
        played %= PLAYTIME_EVERY;
        reportPlaytime(lectureId, withVideoId(), t, PLAYTIME_EVERY, who).catch(() => {});
      }
    }, 500);

    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(tick);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('pause', onPaused);
      breaks.forEach((name) => v.removeEventListener(name, restart));
    };
  }, [info]);

  // ---- captions (drawn by the app, matched on content time) ----
  function loadCues() {
    const want = s.settings.captions;
    const c = s.tracks.find((t) => t.language === want || t.label === want);
    s.cues = [];
    setCaption('');
    if (!c || !c.url) return;
    fetch(c.url)
      .then((r) => r.text())
      .then((text) => {
        if (s.settings.captions === want) s.cues = parseCues(text);
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (!info) return;
    loadCues();
    let shown = '';
    const timer = setInterval(() => {
      const text = s.cues.length ? cueAt(s.cues, s.time()) : '';
      if (text !== shown) {
        shown = text;
        setCaption(text);
      }
    }, 200);
    return () => clearInterval(timer);
  }, [info]);

  function captionLabel() {
    if (!s.settings.captions) return '끔';
    const c = s.tracks.find((t) => t.language === s.settings.captions || t.label === s.settings.captions);
    return c ? c.label || c.language : '끔';
  }

  function cycleCaptions() {
    const options = [''].concat(s.tracks.map((t) => t.language || t.label));
    const i = options.indexOf(s.settings.captions);
    s.settings.captions = options[(i + 1) % options.length];
    storeSettings(s.settings);
    loadCues();
    toast(`자막 ${captionLabel()}`);
  }

  // ---- neighbours ----
  function neighbour(dir) {
    const list = s.list || [];
    let i = list.findIndex((l) => l._id === lectureId);
    if (i === -1) return null;
    for (i += dir; i >= 0 && i < list.length; i += dir) {
      if (list[i].canAccess !== false) return list[i];
    }
    return null;
  }

  function go(lec) {
    if (!lec) return;
    save(true);
    setNextUp(null);
    nav.replace('player', { klassId, lectureId: lec._id, lectures: s.list });
  }

  function gotoLecture(dir) {
    const lec = neighbour(dir);
    if (!lec) return toast(dir > 0 ? '마지막 강의예요' : '첫 강의예요');
    toast(dir > 0 ? '다음 강의로 이동' : '이전 강의로 이동');
    go(lec);
  }

  function leave() {
    save(true);
    nav.pop();
  }

  // ---- next-up countdown after a lecture ends ----
  useEffect(() => {
    if (!nextUp) return;
    if (nextUp.seconds <= 0) {
      go(nextUp.lecture);
      return;
    }
    const t = setTimeout(() => setNextUp({ ...nextUp, seconds: nextUp.seconds - 1 }), 1000);
    return () => clearTimeout(t);
  }, [nextUp]);

  // ---- controls ----
  function stepRate(dir) {
    let i = RATES.findIndex((r) => Math.abs(r - s.settings.rate) < 0.01);
    if (i === -1) i = RATES.indexOf(1);
    setRate(RATES[Math.max(0, Math.min(RATES.length - 1, i + dir))]);
  }

  function togglePlay() {
    const v = videoRef.current;
    if (v.paused || v.ended) {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      flashCenter('▶');
    } else {
      v.pause();
      flashCenter('❚❚');
    }
    osd();
  }

  function seekBy(delta) {
    const d = s.dur();
    let t = s.time() + delta;
    if (isFinite(d) && d > 0) t = Math.min(t, Math.max(0, d - 0.5));
    s.seek(Math.max(0, t));
  }

  function quickMenu() {
    hideOsd();
    const items = [{ label: '재생 속도', value: () => fmtRate(s.settings.rate), adjust: (d) => stepRate(d) }];
    if (s.tracks.length) items.push({ label: '자막', value: captionLabel, adjust: () => cycleCaptions() });
    items.push(
      { label: '다음 강의', run: () => gotoLecture(1), disabled: !neighbour(1) },
      { label: '이전 강의', run: () => gotoLecture(-1), disabled: !neighbour(-1) },
      {
        label: '처음부터 보기',
        run: () => {
          s.seek(0);
          osd();
        },
      },
      { label: '강의 목록으로', run: leave },
      { label: '리모컨 도움말', run: () => toggleHelp(true) }
    );
    openMenu(items);
  }

  useKeys((e) => {
    const v = videoRef.current;
    const code = e.keyCode;
    const dir = arrowOf(e);
    const color = colorOf(e);

    if (isMenuOpen()) {
      if (dir) menuKey(dir);
      else if (code === KEY.ENTER) menuKey('ok');
      else if (isBack(e)) closeMenu();
      return true;
    }
    if (nextUp) {
      if (code === KEY.ENTER) go(nextUp.lecture);
      else if (isBack(e)) setNextUp(null);
      return true;
    }
    if (isBack(e)) {
      leave();
      return true;
    }
    if (!v || !info || message) return !!dir || code === KEY.ENTER;

    if (code === KEY.ENTER || code === KEY.PLAY_PAUSE) {
      if (!e.repeat) togglePlay();
    } else if (code === KEY.PLAY) {
      if (v.paused) togglePlay();
    } else if (code === KEY.PAUSE || code === KEY.STOP) {
      if (!v.paused) togglePlay();
    } else if (dir === 'left' || dir === 'right' || code === KEY.REWIND || code === KEY.FAST_FORWARD) {
      s.seekRepeat = e.repeat ? s.seekRepeat + 1 : 0;
      const big = code === KEY.REWIND || code === KEY.FAST_FORWARD || s.seekRepeat > 4;
      const step = big ? 30 : 10;
      const sign = dir === 'left' || code === KEY.REWIND ? -1 : 1;
      seekBy(sign * step);
      flashCenter(`${sign < 0 ? '−' : '+'}${step}초`, 500);
      osd();
    } else if (dir === 'up') {
      quickMenu();
    } else if (dir === 'down' || code === KEY.INFO) {
      osd(5000);
    } else if (code === KEY.CH_UP || code === KEY.CH_DOWN) {
      if (!e.repeat) gotoLecture(code === KEY.CH_UP ? 1 : -1);
    } else if (color === 'red' || color === 'green') {
      stepRate(color === 'red' ? -1 : 1);
    } else if (color === 'blue') {
      toggleHelp();
    } else if (digitOf(e) !== null) {
      const d = s.dur();
      if (isFinite(d) && d > 0) {
        s.seek((d * digitOf(e)) / 10);
        flashCenter(`${digitOf(e) * 10}%`, 600);
        osd();
      }
    } else {
      return false;
    }
    return true;
  });

  return (
    <div class="screen player">
      {info && <video ref={videoRef} preload="auto" />}
      {caption && <div class="captions">{caption}</div>}
      {message && (
        <div class="player__msg">
          {message}
          <br />
          <span class="muted">뒤로 버튼을 누르면 강의 목록으로 돌아가요</span>
        </div>
      )}
      {nextUp && (
        <div class="next-up">
          <div class="next-up__label">다음 강의 · {nextUp.seconds}초 후 재생</div>
          <div class="next-up__title">{nextUp.lecture.title}</div>
          <div class="next-up__hint">OK 지금 재생 · 뒤로 취소</div>
        </div>
      )}
    </div>
  );
}
