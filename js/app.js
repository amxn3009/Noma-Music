import { Bfstm } from './bfstm.js';
import { Kawarp } from 'https://cdn.jsdelivr.net/npm/@kawarp/core@1.3.1/+esm';

let LIBRARY = [];

const DEV_DURATION_TOOL = false; // true only when scanning

const state = {
  currentGame: null,
  queue: [],
  queueIndex: -1,
  playing: false,
  shuffle: false,
  loopMode: "off", // "off" | "one" | "count"
  loopsRemaining: 0, // countdown for "count" mode (shown on badge)
  duration: 0,
  currentTime: 0,
};

const SETTINGS_KEY = "noma-settings-v1";
const DEFAULT_SETTINGS = {
  loopTimes: 2,       // 1-99
  transitionSec: 10,   // 0 | 5 | 10
  volume: 0.5,          // 0-1
  queueLoop: true,      // after last track: restart queue vs stop
  bgMode: "kawarp", // "kawarp" | "css" — switch later in settings
};

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    settings.loopTimes = clampInt(parsed.loopTimes, 1, 99, 2);
    settings.transitionSec = [0, 5, 10].includes(parsed.transitionSec)
      ? parsed.transitionSec
      : 10;
    const vol = Number(parsed.volume);
    settings.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 0.5;
    settings.queueLoop =
      typeof parsed.queueLoop === "boolean"
        ? parsed.queueLoop
        : DEFAULT_SETTINGS.queueLoop;
    settings.bgMode =
      parsed.bgMode === "css" || parsed.bgMode === "kawarp"
        ? parsed.bgMode
        : DEFAULT_SETTINGS.bgMode;
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getTransitionSec() {
  return settings.transitionSec;
}

const RESTART_THRESHOLD = 10; // seconds
const CLICK_RAMP = 0.03; // ~30ms, all devices

let transitioning = false;
let transitionStartedAt = 0; // audioCtx.currentTime
let transitionProgress = 0; // seconds into the fade when paused
let lastLoopCycle = -1; // -1 = still in first playthrough (before any wrap)
let forceFullLoop = false; // true when track has LoopFromStoE
let scrubbing = false;
let queueDragging = false; // true while a queue row is being dragged
let queueDragFrom = -1; // index of the row being dragged, or -1
let playGen = 0; // invalidates in-flight playCurrent when skipping
let softEndTimer = null; // wall-clock backup for fade → next
let softEndFadeAt = 0;   // audioCtx.currentTime when fade should start
let softEndFadeSec = 0;
let softEndStartTimer = null; // sets transitioning when fade begins
let pauseStopGen = 0; // invalidates delayed pause cleanup after resume
let bufferCtxSuspended = false; // true = BFSTM paused via AudioContext.suspend()
let softEndRemainMs = 0;        // wall-clock soft-end left when suspended
let softEndStartRemainMs = 0;

// ── Sleep / Ruhemodus ──
let sleepEndsAt = 0;       // Date.now() deadline (duration mode)
let sleepMode = null;      // null | "duration" | "end"
let sleepTickId = null;

const PLACEHOLDER = "Assets/MusicPlayer/PlaceholderImage.jpg";

const $ = (sel) => document.querySelector(sel);
const gamesGrid = $("#games-grid");
const gameDetail = $("#game-detail");
const tabGames = $("#tab-games");
const tabPlaylists = $("#tab-playlists");
const trackListEl = $("#track-list");
const contextMenu = $("#context-menu");
const bgLayer = $("#bg-layer");
const bgKawarpCanvas = $("#bg-kawarp");

let kawarp = null;
let kawarpReady = false;
let lastBgUrl = "";

let contextTrack = null;

// ─── Web Audio state ───────────────────────────────────────────
let unshuffledQueue = null; // canonical order while shuffle is on
let audioCtx = null;
let currentSource = null;
let currentGain = null;
let startTime = 0;       // audioCtx.currentTime when source started
let pauseOffset = 0;     // seconds already played when paused
let animFrame = null;
let decodedBuffer = null;
let loopStartSample = 0;
let sampleRate = 44100;
let masterVolume = 1; // 0–1

function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Route Web Audio like music apps — ignore ringer mute on iOS 17+. */
function ensurePlaybackAudioSession() {
  try {
    if ("audioSession" in navigator && navigator.audioSession) {
      navigator.audioSession.type = "playback";
    }
  } catch (_) {}
}

let mediaEl = null;       // HTMLAudioElement when streaming
let useMediaEl = false;   // true = not using AudioBuffer
let mediaRaf = null;
let mediaLoopStart = 0;   // seconds
let mediaForceFullLoop = false;

function applyBgModeClass() {
  document.body.classList.toggle("bg-mode-kawarp", settings.bgMode === "kawarp" && kawarpReady);
  document.body.classList.toggle("bg-mode-css", settings.bgMode !== "kawarp" || !kawarpReady);
}

async function initKawarp() {
  if (!bgKawarpCanvas) {
    kawarpReady = false;
    applyBgModeClass();
    return;
  }
  try {
    kawarp = new Kawarp(bgKawarpCanvas, {
      warpIntensity: 1.0,
      blurPasses: 8,
      animationSpeed: 1.0,
      transitionDuration: 700,
      saturation: 1.5,
      tintColor: [0.04, 0.04, 0.06],
      tintIntensity: 0.2,
      dithering: 0.008,
      scale: 1.15,
    });
    // Idle look = same PlaceholderImage as empty player cover (frozen until play)
    await kawarp.loadImage(PLACEHOLDER);
    kawarpReady = true;
    try {
      kawarp.start(); // idle placeholder animates until a track is paused
    } catch (_) {}
  } catch (err) {
    console.warn("[Noma] Kawarp init failed — CSS background fallback", err);
    kawarp = null;
    kawarpReady = false;
  }
  applyBgModeClass();
  syncKawarpPlayback();
}

/** Ambient: PlaceholderImage when idle (static); album cover when playing (Kawarp moves). */
async function setAmbientBackground(url, { force = false } = {}) {
  const idle =
    !url ||
    url === PLACEHOLDER ||
    state.queueIndex < 0 ||
    state.queue.length === 0;

  const src = idle ? PLACEHOLDER : url;
  const key = idle ? "__idle__" : src;
  if (!force && key === lastBgUrl) return;
  lastBgUrl = key;

  if (bgLayer) {
    bgLayer.style.backgroundImage = `url("${src}")`;
  }

  if (settings.bgMode === "kawarp" && kawarp && kawarpReady) {
    try {
      await kawarp.loadImage(src);
    } catch (err) {
      console.warn("[Noma] Kawarp loadImage failed", err);
    }
  }

  syncKawarpPlayback();
}

function onBgResize() {
  try {
    kawarp?.resize();
  } catch (_) {}
}

/** Kawarp motion: run while playing OR idle (placeholder); freeze only when paused mid-track. */
function syncKawarpPlayback() {
  if (!kawarp || !kawarpReady || settings.bgMode !== "kawarp") return;

  const idle = state.queueIndex < 0 || state.queue.length === 0;
  const shouldRun =
    document.visibilityState === "visible" && (state.playing || idle);

  try {
    if (shouldRun) {
      kawarp.start();
    } else {
      kawarp.stop(); // paused with a track loaded — freeze last frame
    }
  } catch (_) {}
}

// One element for real stream plays (opus/m4a) — separate from silent shield
let persistentMediaEl = null;

function getPersistentMedia() {
  if (!persistentMediaEl) {
    persistentMediaEl = new Audio();
    persistentMediaEl.preload = "auto";
    persistentMediaEl.setAttribute("playsinline", "");
    persistentMediaEl.setAttribute("webkit-playsinline", "");
  }
  return persistentMediaEl;
}

/** Dedicated silence element — must NOT share persistentMediaEl (Media Session tracks HTMLAudio). */
let silentShieldEl = null;
let bgSessionKeepAliveId = null;

function getSilentShieldEl() {
  if (!silentShieldEl) {
    silentShieldEl = new Audio();
    silentShieldEl.preload = "auto";
    silentShieldEl.loop = true;
    silentShieldEl.volume = 0.001; // not 0 — some iOS builds treat 0 as "not playing"
    silentShieldEl.setAttribute("playsinline", "");
    silentShieldEl.setAttribute("webkit-playsinline", "");
  }
  return silentShieldEl;
}

/** Keep silent <audio> looping so Web Audio (BFSTM) is audible under mute + Media Session stays "playing". */
async function startSilentShield() {
  if (!isIOS()) return;
  ensurePlaybackAudioSession();
  const el = getSilentShieldEl();
  try {
    const silenceUrl = new URL("Assets/Audio/silence.m4a", location.href).href;
    if (!el.src || !el.src.includes("silence.m4a")) {
      el.src = silenceUrl;
      el.loop = true;
    }
    el.volume = 0.001;
    await el.play();
  } catch (_) {}
}

function stopSilentShield() {
  if (!silentShieldEl) return;
  try {
    silentShieldEl.pause();
  } catch (_) {}
}

function clearBgSessionKeepAlive() {
  if (bgSessionKeepAliveId) {
    clearInterval(bgSessionKeepAliveId);
    bgSessionKeepAliveId = null;
  }
}

/** While backgrounded + playing: keep silence alive and force Media Session = playing. */
function startBgSessionKeepAlive() {
  clearBgSessionKeepAlive();
  if (!state.playing) return;
  bgSessionKeepAliveId = setInterval(() => {
    if (!state.playing || document.visibilityState === "visible") {
      clearBgSessionKeepAlive();
      return;
    }
    ensurePlaybackAudioSession();
    // Re-assert session so lock screen never sticks on "paused"
    try {
      navigator.mediaSession.playbackState = "playing";
    } catch (_) {}
    // Silence element often gets paused by iOS on lock — restart it
    if (!useMediaEl) {
      const el = getSilentShieldEl();
      if (el.paused) {
        el.play().catch(() => {});
      }
    } else if (mediaEl && mediaEl.paused) {
      mediaEl.play().catch(() => {});
    }
    try {
      updateMediaSession();
    } catch (_) {}
  }, 1500);
}

/** Full teardown when the tab/PWA is closed or killed — not on mere lock/minimize. */
function teardownOnAppKill() {
  try {
    clearBgSessionKeepAlive();
    playGen++;
    clearSoftEndTimers();
    if (typeof cancelTransition === "function") cancelTransition(false);
    transitioning = false;
    state.playing = false;

    // Media Session wipe first
    if (typeof clearMediaSessionHard === "function") {
      clearMediaSessionHard();
    } else if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "none";
      } catch (_) {}
      try {
        navigator.mediaSession.metadata = null;
      } catch (_) {}
      for (const action of [
        "play",
        "pause",
        "previoustrack",
        "nexttrack",
        "seekto",
        "seekbackward",
        "seekforward",
      ]) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch (_) {}
      }
    }

    // Web Audio graph
    if (currentSource) {
      try {
        currentSource.onended = null;
        currentSource.stop();
        currentSource.disconnect();
      } catch (_) {}
      currentSource = null;
    }
    if (currentGain) {
      try {
        currentGain.disconnect();
      } catch (_) {}
      currentGain = null;
    }
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
    if (mediaRaf) {
      cancelAnimationFrame(mediaRaf);
      mediaRaf = null;
    }

    // Dual-stream elements
    streamHandoffArmed = false;
    for (const el of [mediaA, mediaB]) {
      if (!el) continue;
      try {
        el.onended = null;
        el.ontimeupdate = null;
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch (_) {}
    }
    mediaA = mediaB = null;

    // Silence shield — destroy, not just pause
    if (silentShieldEl) {
      try {
        silentShieldEl.onended = null;
        silentShieldEl.pause();
        silentShieldEl.removeAttribute("src");
        silentShieldEl.load();
      } catch (_) {}
      silentShieldEl = null;
    }
    if (typeof stopSilentShield === "function") {
      try {
        stopSilentShield();
      } catch (_) {}
    }

    // Persistent media
    if (typeof hardPausePersistentMedia === "function") {
      hardPausePersistentMedia();
    }
    if (persistentMediaEl) {
      try {
        persistentMediaEl.onended = null;
        persistentMediaEl.ontimeupdate = null;
        persistentMediaEl.pause();
        persistentMediaEl.removeAttribute("src");
        persistentMediaEl.load();
        persistentMediaEl.dataset.keepAlive = "0";
      } catch (_) {}
    }
    mediaEl = null;
    useMediaEl = false;

    // Close AudioContext so iOS can drop the process
    if (audioCtx) {
      try {
        audioCtx.suspend();
      } catch (_) {}
      try {
        audioCtx.close();
      } catch (_) {}
      audioCtx = null;
      audioWarmed = false;
    }

    document.body.classList.remove("is-playing", "is-transitioning");
  } catch (_) {}
}

/** Unlock HTMLAudio on first user gesture (call from play paths that had a click). */
async function unlockMediaElement() {
  const el = getPersistentMedia();
  if (el.dataset.unlocked === "1") {
    // re-assert play if iOS paused it
    if (el.paused && el.dataset.keepAlive === "1") {
      try {
        el.volume = 0;
        await el.play();
      } catch (_) {}
    }
    return;
  }
  try {
    // Prefer real silence file so decode/play succeeds on iOS
    const silenceUrl = new URL("Assets/Audio/silence.m4a", location.href).href;
    if (!el.src || el.dataset.keepAlive !== "1") {
      el.src = silenceUrl;
      el.loop = true;
      el.dataset.keepAlive = "1";
    }
    el.volume = 0;
    await el.play();
    el.dataset.unlocked = "1";
    ensurePlaybackAudioSession();
  } catch (err) {
    console.warn("[Noma] media unlock failed", err);
  }
}

function isMobileLike() {
  return isIOS() || /Android/i.test(navigator.userAgent || "") ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 900);
}

function hardPausePersistentMedia() {
  if (!persistentMediaEl) return;
  try {
    persistentMediaEl.onended = null;
    persistentMediaEl.ontimeupdate = null;
    persistentMediaEl.pause();
  } catch (_) {}
}

function stopMediaEl() {
  if (mediaRaf) {
    cancelAnimationFrame(mediaRaf);
    mediaRaf = null;
  }
  hardPausePersistentMedia();
  if (mediaEl && mediaEl !== persistentMediaEl) {
    try {
      mediaEl.onended = null;
      mediaEl.ontimeupdate = null;
      mediaEl.pause();
    } catch (_) {}
  }
  mediaEl = null;
  useMediaEl = false;
}

async function decodeWebAudio(url) {
  const hit = decodeCacheGet(url);
  if (hit?.audioBuffer) return hit.audioBuffer;

  const ctx = await resumeAudio();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
  decodeCacheSet(url, {
    audioBuffer,
    loopStartSample: 0,
    sampleRate: audioBuffer.sampleRate,
  });
  return audioBuffer;
}

function resetPlayerToIdle() {
  stopSource();
  stopSilentShield();
  playGen++;
  clearSoftEndTimers();
  if (typeof cancelTransition === "function") cancelTransition(false);
  transitioning = false;
  lastLoopCycle = -1;
  decodedBuffer = null;
  pauseOffset = 0;
  loopStartSample = 0;
  forceFullLoop = false;
   unshuffledQueue = null;
  state.playing = false;
  state.queueIndex = -1;
  state.currentTime = 0;
  state.duration = 0;
  state.queue = [];
  state.queueIndex = -1;
  unshuffledQueue = null;

  document.body.classList.remove("is-playing", "is-transitioning");

  $("#now-cover").src = PLACEHOLDER;
  $("#now-title").textContent = "Nichts läuft";
  $("#now-game").textContent = "Keinen Song ausgewählt";

  $("#fs-cover").src = PLACEHOLDER;
  $("#fs-title").textContent = "Nichts läuft";
  $("#fs-game").textContent = "Keinen Song ausgewählt";

  lastBgUrl = ""; // force clear old album
  setAmbientBackground(PLACEHOLDER, { force: true });

  const fill = $("#progress-fill");
  if (fill) fill.style.width = "0%";
  const tCur = $("#time-current");
  if (tCur) tCur.textContent = "0:00";
  const tTot = $("#time-total");
  if (tTot) tTot.textContent = "0:00";

  markPlayingTrack(null);
  updatePlayerUI();
  syncKawarpPlayback();
  renderQueue();
  clearMediaSessionHard();
}

/** Best playable URL for this track on this device */
function getTrackUrl(track) {
  if (!track) return "";
  if (isIOS() && track.fileIos) return track.fileIos;
  return track.file;
}

function isWebAudioFile(url) {
  return /\.(opus|m4a|mp3|wav|ogg)($|\?)/i.test(url || "");
}

function ensureAudioContext() {
  ensurePlaybackAudioSession();
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// at start of playCurrent / togglePlay when starting sound:
let audioWarmed = false;

async function resumeAudio() {
  ensurePlaybackAudioSession();
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  // One silent buffer tick — stabilizes iOS output on first session
  if (!audioWarmed && isIOS()) {
    audioWarmed = true;
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = 0;
      src.buffer = buf;
      src.connect(g);
      g.connect(ctx.destination);
      src.start(0);
    } catch (_) {}
  }
  return ctx;
}

const durationCache = new Map(); // url → seconds

// Decode cache (BFSTM / web audio). Cap memory — long tracks are heavy.
const DECODE_CACHE_MAX = isIOS() ? 4 : 8;
const decodeCache = new Map(); // url → { audioBuffer, loopStartSample, sampleRate, loopFlag? }

function decodeCacheGet(url) {
  if (!decodeCache.has(url)) return null;
  const entry = decodeCache.get(url);
  // LRU: re-insert
  decodeCache.delete(url);
  decodeCache.set(url, entry);
  return entry;
}

function decodeCacheSet(url, entry) {
  if (decodeCache.has(url)) decodeCache.delete(url);
  decodeCache.set(url, entry);
  while (decodeCache.size > DECODE_CACHE_MAX) {
    const oldest = decodeCache.keys().next().value;
    decodeCache.delete(oldest);
  }
}

async function getTrackDuration(url, track) {
  if (track && Number.isFinite(track.duration) && track.duration > 0) {
    durationCache.set(url, track.duration);
    return track.duration;
  }
  if (durationCache.has(url)) return durationCache.get(url);

  if (isWebAudioFile(url)) {
    try {
      const audioBuffer = await decodeWebAudio(url);
      durationCache.set(url, audioBuffer.duration);
      return audioBuffer.duration;
    } catch (err) {
      console.warn("[Noma] duration failed:", url, err);
      return null;
    }
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const buf = await res.arrayBuffer();
    const bfstm = new Bfstm(buf);
    const sec = bfstm.metadata.totalSamples / bfstm.metadata.sampleRate;
    durationCache.set(url, sec);
    return sec;
  } catch (err) {
    console.warn("[Noma] duration failed:", url, err);
    return null;
  }
}

function rescheduleSoftEndAfterResume() {
  if (!audioCtx || !decodedBuffer || softEndFadeAt <= 0) return;
  const now = audioCtx.currentTime;
  const fadeSec = softEndFadeSec;
  const timeToFadeStart = Math.max(0, softEndFadeAt - now);

  clearSoftEndTimers();
  softEndFadeAt = now + timeToFadeStart;
  softEndFadeSec = fadeSec;

  if (currentGain) {
    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(masterVolume, now);
    if (fadeSec <= 0) {
      currentGain.gain.setValueAtTime(0, softEndFadeAt);
    } else {
      currentGain.gain.setValueAtTime(masterVolume, softEndFadeAt);
      currentGain.gain.linearRampToValueAtTime(0, softEndFadeAt + fadeSec);
    }
  }

  softEndStartTimer = setTimeout(() => {
    softEndStartTimer = null;
    if (!state.playing || !currentGain) return;
    transitioning = true;
    transitionStartedAt = softEndFadeAt;
    document.body.classList.add("is-transitioning");
    lastLoopCycle = Math.max(0, lastLoopCycle);
    updateProgressUI();
  }, timeToFadeStart * 1000);

  softEndTimer = setTimeout(() => {
    softEndTimer = null;
    if (!state.playing) return;
    finishTransition();
  }, (timeToFadeStart + Math.max(0, fadeSec)) * 1000 + 40);
}

function clearSoftEndTimers() {
  if (softEndTimer) {
    clearTimeout(softEndTimer);
    softEndTimer = null;
  }
  if (softEndStartTimer) {
    clearTimeout(softEndStartTimer);
    softEndStartTimer = null;
  }
  softEndFadeAt = 0;
  softEndFadeSec = 0;
}

function syncSoftEndFromClock() {
  if (!audioCtx || !decodedBuffer || softEndFadeAt <= 0) return;

  const now = audioCtx.currentTime;
  const fadeEnd = softEndFadeAt + Math.max(0, softEndFadeSec);

  if (now >= softEndFadeAt && now < fadeEnd) {
    // Mid-fade after minimize — restore transition UI from real audio time
    transitioning = true;
    transitionStartedAt = softEndFadeAt;
    document.body.classList.add("is-transitioning");
    if (state.playing) updateProgressUI();
  } else if (now >= fadeEnd && state.playing) {
    // Fade already finished while backgrounded
    finishTransition();
  }
}

function stopSource(opts = {}) {
  // keepMediaAlive: leave silent HTMLAudio running (needed for iOS auto-advance)
  bufferCtxSuspended = false;
  softEndRemainMs = 0;
  softEndStartRemainMs = 0;
  // If we had suspended for pause, wake context so the next play works
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  const keepMediaAlive = !!opts.keepMediaAlive;

  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
  clearSoftEndTimers();
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch (_) {}
    currentSource.disconnect();
    currentSource = null;
  }

  // dual stream always stops
  streamHandoffArmed = false;
  for (const el of [mediaA, mediaB]) {
    if (!el) continue;
    try {
      el.onended = null;
      el.ontimeupdate = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch (_) {}
  }
  mediaA = mediaB = null;
  mediaActive = "A";

  if (mediaRaf) {
    cancelAnimationFrame(mediaRaf);
    mediaRaf = null;
  }

  if (!keepMediaAlive) {
    hardPausePersistentMedia();
    mediaEl = null;
    useMediaEl = false;
  } else {
    // keep persistent silence running; clear "current track" pointer only
    if (mediaEl && mediaEl !== persistentMediaEl) {
      try {
        mediaEl.pause();
      } catch (_) {}
    }
    // if we were playing a real track on persistent, pause it but restart silence
    if (persistentMediaEl && persistentMediaEl.dataset.keepAlive !== "1") {
      try {
        persistentMediaEl.onended = null;
        persistentMediaEl.pause();
      } catch (_) {}
      // re-arm silence in background (no user gesture needed if already unlocked)
      if (persistentMediaEl.dataset.unlocked === "1") {
        const silenceUrl = new URL("Assets/Audio/silence.m4a", location.href).href;
        persistentMediaEl.src = silenceUrl;
        persistentMediaEl.loop = true;
        persistentMediaEl.volume = 0;
        persistentMediaEl.dataset.keepAlive = "1";
        persistentMediaEl.play().catch(() => {});
      }
    }
    mediaEl = null;
    useMediaEl = false;
  }
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Album total only — e.g. "1h 12min", "45min", "2h". No seconds. */
function formatAlbumDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}min`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}min`;
  return "0min";
}

function getLoopStartSec() {
  if (forceFullLoop) return 0;
  return loopStartSample > 0 ? loopStartSample / sampleRate : 0;
}

/** Actual playback position in seconds (handles intro + seamless loop). */
function getPlaybackPosition() {
  if (useMediaEl && mediaEl) {
    return mediaEl.currentTime || 0;
  }

  if (!decodedBuffer) return 0;

  const duration = decodedBuffer.duration;
  const loopStart = getLoopStartSec();
  const looping = !!(currentSource && currentSource.loop);

  let elapsed;
  if (state.playing && audioCtx) {
    elapsed = pauseOffset + (audioCtx.currentTime - startTime);
  } else {
    elapsed = pauseOffset;
  }

  if (!looping) {
    return Math.min(Math.max(0, elapsed), duration);
  }

  if (elapsed < duration) {
    return Math.min(Math.max(0, elapsed), duration);
  }
  const loopLen = Math.max(0.001, duration - loopStart);
  const afterEnd = elapsed - duration;
  return loopStart + (afterEnd % loopLen);
}

function getMediaPosition() {
  return mediaEl ? mediaEl.currentTime : 0;
}

function updateMediaProgress() {
  if (!mediaEl || scrubbing) {
    if (state.playing && useMediaEl) {
      mediaRaf = requestAnimationFrame(updateMediaProgress);
    }
    return;
  }

  const duration = mediaEl.duration || state.duration || 0;
  let t = mediaEl.currentTime;

    if (
    state.playing &&
    !transitioning &&
    state.loopMode === "one" &&
    duration > 0 &&
    t >= duration - 0.05
  ) {
    mediaEl.currentTime = mediaLoopStart > 0 ? mediaLoopStart : 0;
    t = mediaEl.currentTime;
  }

  // custom loop point (same idea as BFSTM loopStart)
  if (
    state.playing &&
    !transitioning &&
    (mediaForceFullLoop || mediaLoopStart > 0) &&
    (state.loopMode === "one" ||
      state.loopMode === "off" ||
      state.loopMode === "count")
  ) {
    // soft-end / count handled like buffer path via cycle logic if you want;
    // simple seamless loop for "one" and soft loop:
    if (
      state.loopMode === "one" ||
      ((state.loopMode === "off" || state.loopMode === "count") &&
        (mediaForceFullLoop || mediaLoopStart > 0))
    ) {
      if (duration > 0 && t >= duration - 0.05) {
        // wrap
        if (state.loopMode === "off" || state.loopMode === "count") {
          // reuse your lastLoopCycle / loopsRemaining logic if desired
        }
        mediaEl.currentTime = mediaForceFullLoop ? 0 : mediaLoopStart;
        t = mediaEl.currentTime;
      }
    }
  }

  state.currentTime = t;
  state.duration = duration;
  const ratio = duration > 0 ? Math.min(1, t / duration) : 0;
  const fill = $("#progress-fill");
  if (fill) fill.style.width = `${ratio * 100}%`;
  const tCur = $("#time-current");
  if (tCur) tCur.textContent = formatTime(t);
  const tTot = $("#time-total");
  if (tTot) tTot.textContent = formatTime(duration);

  if (state.playing) {
    mediaRaf = requestAnimationFrame(updateMediaProgress);
    maybeUpdateMediaSessionPosition();
  }
}

async function playMediaUrl(url, track, offsetSec = 0) {
  // Stop dual A/B only — do NOT wipe the persistent element via stopStreamPair’s nulling
  streamHandoffArmed = false;
  for (const el of [mediaA, mediaB]) {
    if (!el) continue;
    try {
      el.onended = null;
      el.ontimeupdate = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch (_) {}
  }
  mediaA = mediaB = null;
  mediaActive = "A";

  if (mediaRaf) {
    cancelAnimationFrame(mediaRaf);
    mediaRaf = null;
  }

  await resumeAudio();

  mediaEl = getPersistentMedia();
  mediaEl.onended = null;
  mediaEl.ontimeupdate = null;
  mediaEl.preload = "auto";
  mediaEl.volume = masterVolume;
  useMediaEl = true;

  mediaForceFullLoop = !!track.LoopFromStoE;
  mediaLoopStart = mediaForceFullLoop
    ? 0
    : Number.isFinite(track.loopStart) && track.loopStart > 0
      ? track.loopStart
      : 0;

  // Real track — leave keep-alive silence mode
  mediaEl.dataset.keepAlive = "0";
  mediaEl.loop = state.loopMode === "one" && !(mediaLoopStart > 0);

  const abs = new URL(url, location.href).href;
  const needLoad = mediaEl.getAttribute("src") !== abs && mediaEl.src !== abs;

  if (needLoad) {
    try {
      mediaEl.pause();
    } catch (_) {}
    mediaEl.src = abs;
  }

  await new Promise((resolve, reject) => {
    // Only skip waiting if THIS file is already loaded
    if (!needLoad && mediaEl.readyState >= 1) {
      resolve();
      return;
    }
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("Media load failed"));
    };
    const cleanup = () => {
      mediaEl.removeEventListener("loadedmetadata", onMeta);
      mediaEl.removeEventListener("error", onErr);
    };
    mediaEl.addEventListener("loadedmetadata", onMeta);
    mediaEl.addEventListener("error", onErr);
    mediaEl.load();
  });

  state.duration =
    Number.isFinite(track.duration) && track.duration > 0
      ? track.duration
      : mediaEl.duration;
  decodedBuffer = null;

  const startAt = Math.max(0, Math.min(offsetSec, (state.duration || 1) - 0.05));
  try {
    mediaEl.currentTime = startAt;
  } catch (_) {}
  pauseOffset = startAt;

  mediaEl.onended = () => {
    if (!state.playing || transitioning) return;
    if (state.loopMode === "one") {
      mediaEl.currentTime = mediaLoopStart > 0 ? mediaLoopStart : 0;
      mediaEl.play().catch(() => {});
      return;
    }
    nextTrack(true);
  };

  try {
    mediaEl.volume = masterVolume;
    await mediaEl.play();
    mediaEl.dataset.unlocked = "1";
  } catch (err) {
    if (err && (err.name === "NotAllowedError" || err.name === "AbortError")) {
      await resumeAudio();
      try {
        await mediaEl.play();
        mediaEl.dataset.unlocked = "1";
      } catch (err2) {
        console.warn("[Noma] media play blocked:", err2);
        state.playing = false;
        document.body.classList.remove("is-playing");
        updatePlayerUI();
        return;
      }
    } else {
      throw err;
    }
  }

  state.playing = true;
  document.body.classList.add("is-playing");
  updatePlayerUI();
  markPlayingTrack(getCurrentTrackId());
  updateMediaProgress();
  syncKawarpPlayback();
  bindMediaSession();
  updateMediaSession();
}

function getPlaybackMode(track) {
  const mode = (track?.playback || "").toLowerCase();
  if (mode === "buffer" || mode === "stream") return mode;

  // default: long tracks stream; looping shorts buffer
  const dur = Number(track?.duration) || 0;
  const needsLoop =
    !!track?.LoopFromStoE ||
    (Number.isFinite(track?.loopStart) && track.loopStart > 0);
  if (dur > 180) return "stream";
  if (needsLoop) return "buffer";
  return "stream";
}

// ── Dual-stream loop (opus/m4a) ─────────────────────────
let mediaA = null;
let mediaB = null;
let mediaActive = "A";
let streamHandoffArmed = false;

function stopStreamPair() {
  streamHandoffArmed = false;
  for (const el of [mediaA, mediaB]) {
    if (!el) continue;
    try {
      el.onended = null;
      el.ontimeupdate = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch (_) {}
  }
  mediaA = mediaB = null;
  mediaActive = "A";
  hardPausePersistentMedia();
  mediaEl = null;
  useMediaEl = false;
  if (mediaRaf) {
    cancelAnimationFrame(mediaRaf);
    mediaRaf = null;
  }
}

function activeMedia() {
  return mediaActive === "A" ? mediaA : mediaB;
}

function standbyMedia() {
  return mediaActive === "A" ? mediaB : mediaA;
}

function bindStreamProgress() {
  if (mediaRaf) cancelAnimationFrame(mediaRaf);
  const tick = () => {
    if (!useMediaEl || scrubbing) {
      if (state.playing && useMediaEl) mediaRaf = requestAnimationFrame(tick);
      return;
    }
    const cur = activeMedia();
    if (!cur) return;

    const duration = cur.duration || state.duration || 0;
    let t = cur.currentTime || 0;

    // handoff ~120ms before end
    const canLoop =
      state.loopMode === "one" ||
      mediaForceFullLoop ||
      mediaLoopStart > 0;

    if (
      state.playing &&
      !transitioning &&
      duration > 0 &&
      canLoop
    ) {
      const lead = 0.12;
      if (t >= duration - lead) {
        handoffStreamLoop(duration);
        t = activeMedia()?.currentTime || mediaLoopStart || 0;
      }
    }

    state.currentTime = t;
    state.duration = duration;
    const ratio = duration > 0 ? Math.min(1, t / duration) : 0;
    const fill = $("#progress-fill");
    if (fill) fill.style.width = `${ratio * 100}%`;
    const tCur = $("#time-current");
    if (tCur) tCur.textContent = formatTime(t);
    const tTot = $("#time-total");
    if (tTot) tTot.textContent = formatTime(duration);

    if (state.playing) mediaRaf = requestAnimationFrame(tick);
  };
  mediaRaf = requestAnimationFrame(tick);
  maybeUpdateMediaSessionPosition();
}

function handoffStreamLoop(duration) {
  const cur = activeMedia();
  const next = standbyMedia();
  if (!cur || !next || !state.playing) return;

  // count / off: first full play → transition (same idea as buffer path)
  if (state.loopMode === "off" && lastLoopCycle < 0 && !mediaForceFullLoop && !(mediaLoopStart > 0)) {
    // no loop points: natural end → next track
    nextTrack(true);
    return;
  }

  if (state.loopMode === "count") {
    // optional: mirror your loopsRemaining logic here
  }

  const startAt = mediaForceFullLoop ? 0 : mediaLoopStart > 0 ? mediaLoopStart : 0;

  try {
    next.currentTime = startAt;
    next.volume = masterVolume;
    next.play().catch(() => {});
  } catch (_) {}

  try {
    cur.pause();
    cur.volume = 0;
    cur.currentTime = startAt; // re-arm
  } catch (_) {}

  mediaActive = mediaActive === "A" ? "B" : "A";
  mediaEl = activeMedia();
  lastLoopCycle = Math.max(0, lastLoopCycle + 1);
}

async function playMediaUrlStreamLoop(url, track, offsetSec = 0) {
  stopStreamPair();
  stopMediaEl();
  releaseDecodedBuffer();
  await resumeAudio();

  mediaA = new Audio();
  mediaB = new Audio();
  mediaA.preload = "auto";
  mediaB.preload = "auto";
  mediaA.src = url;
  mediaB.src = url;
  mediaA.loop = false;
  mediaB.loop = false;

  mediaForceFullLoop = !!track.LoopFromStoE;
  mediaLoopStart = mediaForceFullLoop
    ? 0
    : Number.isFinite(track.loopStart) && track.loopStart > 0
      ? track.loopStart
      : 0;

  useMediaEl = true;
  mediaActive = "A";
  mediaEl = mediaA;

  await Promise.all([
    new Promise((res, rej) => {
      mediaA.onloadedmetadata = () => res();
      mediaA.onerror = () => rej(new Error("Media A load failed"));
    }),
    new Promise((res, rej) => {
      mediaB.onloadedmetadata = () => res();
      mediaB.onerror = () => rej(new Error("Media B load failed"));
    }),
  ]);

  state.duration =
    Number.isFinite(track.duration) && track.duration > 0
      ? track.duration
      : mediaA.duration;

  const startAt = Math.max(0, Math.min(offsetSec, state.duration - 0.05));
  mediaA.currentTime = startAt;
  mediaA.volume = masterVolume;
  mediaB.currentTime = mediaLoopStart;
  mediaB.volume = 0;
  pauseOffset = startAt;

  // natural end with no loop → next track
  mediaA.onended = mediaB.onended = () => {
    if (!state.playing || transitioning) return;
    if (state.loopMode === "one" || mediaForceFullLoop || mediaLoopStart > 0) {
      handoffStreamLoop(state.duration);
      return;
    }
    nextTrack(true);
  };

  await mediaA.play();
  state.playing = true;
  document.body.classList.add("is-playing");
  updatePlayerUI();
  markPlayingTrack(getCurrentTrackId());
  bindStreamProgress();
  syncKawarpPlayback();
}

function updateProgressUI() {
  if (!decodedBuffer) return;

  if (scrubbing) {
    // keep the loop alive so we can resume after scrub, but don't overwrite the fill
    if (state.playing) animFrame = requestAnimationFrame(updateProgressUI);
    return;
  }

  const duration = decodedBuffer.duration;
  const loopStart = getLoopStartSec();

  // ── Transition mode: 5s bar ──────────────────────────
  if (transitioning && audioCtx) {
    const sec = getTransitionSec();
    if (sec <= 0) {
      finishTransition();
      return;
    }
    const t = Math.min(sec, Math.max(0, audioCtx.currentTime - transitionStartedAt));
    const ratio = t / sec;

    const fill = $("#progress-fill");
    if (fill) fill.style.width = `${ratio * 100}%`;
    const tCur = $("#time-current");
    if (tCur) tCur.textContent = formatTime(t);
    const tTot = $("#time-total");
    if (tTot) tTot.textContent = formatTime(sec);

    if (t >= sec - 0.03) {
      finishTransition();
      return;
    }
    if (state.playing) {
      animFrame = requestAnimationFrame(updateProgressUI);
      maybeUpdateMediaSessionPosition();
    }
    return;
  }

  // ── Normal progress ──────────────────────────────────
  const elapsed = getPlaybackPosition();
  state.currentTime = elapsed;
  state.duration = duration;

  const ratio = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 0;

  const fill = $("#progress-fill");
  if (fill) fill.style.width = `${ratio * 100}%`;
  const tCur = $("#time-current");
  if (tCur) tCur.textContent = formatTime(elapsed);
  const tTot = $("#time-total");
  if (tTot) tTot.textContent = formatTime(duration);

  if (
    (state.loopMode === "off" || state.loopMode === "count") &&
    state.playing &&
    (loopStart > 0 || forceFullLoop) &&
    currentSource &&
    currentSource.loop &&
    !transitioning &&
    audioCtx
  ) {
    const absoluteElapsed = pauseOffset + (audioCtx.currentTime - startTime);
    const loopLen = forceFullLoop
      ? Math.max(0.001, duration)
      : Math.max(0.001, duration - loopStart);

    if (absoluteElapsed < duration) {
      lastLoopCycle = -1;
    } else {
      const cycle = Math.floor((absoluteElapsed - duration) / loopLen);

      if (cycle > lastLoopCycle) {
        lastLoopCycle = cycle;
        if (state.loopMode === "off") {
          // First wrap → outro (same as before)
          startTransition();
        } else if (state.loopMode === "count") {
          if (state.loopsRemaining > 0) {
            // Still have loops left — count down, keep playing
            state.loopsRemaining -= 1;
            updatePlayerUI();
          } else {
            // Already at 0: this end is the last one → outro
            startTransition();
          }
        }
      }
    }
  }

  if (state.playing) {
    animFrame = requestAnimationFrame(updateProgressUI);
    maybeUpdateMediaSessionPosition();
  }
}

function playBuffer(audioBuffer, offsetSeconds = 0) {
  pauseStopGen++; // cancel any delayed pause stopSource / silence re-arm
  stopSource({ keepMediaAlive: true });   // full stop — no silence under BFSTM
  clearSoftEndTimers();

  // iOS mute switch: open playback channel via silent HTMLAudio
  startSilentShield();

  const ctx = ensureAudioContext();

  const duration = audioBuffer.duration;
  let loopStart = getLoopStartSec();
  let offset = Math.max(0, offsetSeconds);

  if (!transitioning) {
    lastLoopCycle = -1;
  }

  currentSource = ctx.createBufferSource();
  currentSource.buffer = audioBuffer;
  currentGain = ctx.createGain();
  currentSource.connect(currentGain);
  currentGain.connect(ctx.destination);

  const now = ctx.currentTime;
  // never start at full volume — iOS click
  currentGain.gain.cancelScheduledValues(now);
  currentGain.gain.setValueAtTime(0, now);
  currentGain.gain.linearRampToValueAtTime(masterVolume, now + CLICK_RAMP);

  const wantInfiniteLoop = state.loopMode === "one";
  const wantSoftEnd =
    (state.loopMode === "off" || state.loopMode === "count") &&
    (loopStart > 0 || forceFullLoop) &&
    !transitioning;

  if (wantInfiniteLoop || wantSoftEnd) {
    currentSource.loop = true;
    if (forceFullLoop) {
      currentSource.loopStart = 0;
      currentSource.loopEnd = duration;
      loopStart = 0;
    } else if (loopStart > 0) {
      currentSource.loopStart = loopStart;
      currentSource.loopEnd = duration;
    }
    if (offset >= duration) {
      if (forceFullLoop) {
        offset = offset % duration;
      } else if (loopStart > 0) {
        const loopLen = duration - loopStart;
        offset = loopStart + ((offset - duration) % loopLen);
      }
    }
  } else {
    currentSource.loop = false;
    offset = Math.min(offset, Math.max(0, duration - 0.01));
  }

  currentSource.onended = () => {
    if (!state.playing || transitioning) return;
    nextTrack(true);
  };

  pauseOffset = offset;
  startTime = ctx.currentTime;
  currentSource.start(0, offset);

  // Pre-schedule soft-end fade in the audio graph (runs even if tab is minimized).
  // loopMode "off": after first full playthrough. "count": after last remaining loop.
  if (wantSoftEnd) {
    const fadeSec = getTransitionSec();
    let loopsAfterFirst = 0;
    if (state.loopMode === "count") {
      loopsAfterFirst = Math.max(0, state.loopsRemaining);
    }
    const loopLen = forceFullLoop
      ? Math.max(0.001, duration)
      : Math.max(0.001, duration - loopStart);
    const timeToFadeStart =
      Math.max(0.01, duration - offset) + loopsAfterFirst * loopLen;

    softEndFadeAt = startTime + timeToFadeStart;
    softEndFadeSec = fadeSec;

    // keep the short fade-in; only schedule the later outro
    // Don't touch the fade-in window — only schedule after it
    const afterIn = startTime + CLICK_RAMP + 0.001;
    currentGain.gain.cancelScheduledValues(afterIn);
    currentGain.gain.setValueAtTime(masterVolume, afterIn);
    if (fadeSec <= 0) {
      currentGain.gain.setValueAtTime(0, softEndFadeAt);
    } else {
      currentGain.gain.setValueAtTime(masterVolume, softEndFadeAt);
      currentGain.gain.linearRampToValueAtTime(0, softEndFadeAt + fadeSec);
    }

    // Enter transition mode when fade starts (so progress bar uses transition UI)
    softEndStartTimer = setTimeout(() => {
      softEndStartTimer = null;
      if (!state.playing || !currentGain) return;
      transitioning = true;
      transitionStartedAt = softEndFadeAt;
      document.body.classList.add("is-transitioning");
      lastLoopCycle = Math.max(0, lastLoopCycle);
      updateProgressUI();
    }, timeToFadeStart * 1000);

    softEndTimer = setTimeout(() => {
      softEndTimer = null;
      if (!state.playing) return;
      finishTransition();
    }, (timeToFadeStart + Math.max(0, fadeSec)) * 1000 + 40);
  }

  state.playing = true;
  if (document.visibilityState !== "visible") startBgSessionKeepAlive();
  document.body.classList.add("is-playing");
  updatePlayerUI();
  markPlayingTrack(getCurrentTrackId());
  updateProgressUI();
  syncKawarpPlayback();
  bindMediaSession();
  updateMediaSession();
}

function startTransition() {
  if (transitioning || !audioCtx || !currentGain) return;

  clearSoftEndTimers();

  const sec = getTransitionSec();
  if (sec <= 0) {
    // instant advance
    finishTransition();
    return;
  }

  transitioning = true;
  transitionStartedAt = audioCtx.currentTime;
  document.body.classList.add("is-transitioning");

  const now = audioCtx.currentTime;
  currentGain.gain.cancelScheduledValues(now);
  currentGain.gain.setValueAtTime(currentGain.gain.value, now);
  currentGain.gain.linearRampToValueAtTime(0, now + sec);
}

function cancelTransition(keepPlaying = false) {
  transitionProgress = 0;
  transitioning = false;
  lastLoopCycle = -1;
  document.body.classList.remove("is-transitioning");
  if (currentGain && audioCtx) {
    const now = audioCtx.currentTime;
    currentGain.gain.cancelScheduledValues(now);
    if (keepPlaying) {
      currentGain.gain.setValueAtTime(masterVolume, now);
    }
  }
}

function finishTransition() {
  clearSoftEndTimers();
  if (currentGain && audioCtx) {
    const now = audioCtx.currentTime;
    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(0, now);
  }
  try {
    if (currentSource) {
      currentSource.onended = null;
      currentSource.stop();
    }
  } catch (_) {}

  cancelTransition(false);

  // BFSTM is done — stop Web Audio fully, then briefly warm HTMLAudio for next stream track
  stopSource();
  if (isIOS() || isMobileLike()) {
    unlockMediaElement().catch(() => {});
  }

  if (sleepMode === "end") {
    fireSleepTimer();
    return;
  }

  setTimeout(() => {
    nextTrack(true);
  }, 30);
}

function setVolume(value) {
  masterVolume = Math.min(1, Math.max(0, value));

  const slider = $("#volume-slider");
  if (slider && Number(slider.value) !== masterVolume) {
    slider.value = masterVolume;
  }

  if (mediaA) mediaA.volume = mediaActive === "A" ? masterVolume : 0;
  if (mediaB) mediaB.volume = mediaActive === "B" ? masterVolume : 0;
  if (mediaEl && !mediaA) mediaEl.volume = masterVolume;

  settings.volume = masterVolume;
  saveSettings();

  if (!currentGain || !audioCtx) return;

  const now = audioCtx.currentTime;

  if (transitioning) {
    const elapsed = Math.max(0, now - transitionStartedAt);
    const progress = Math.min(1, elapsed / getTransitionSec());
    const remaining = Math.max(0.05, getTransitionSec() - elapsed);
    const levelNow = masterVolume * (1 - progress);

    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(levelNow, now);
    currentGain.gain.linearRampToValueAtTime(0, now + remaining);
  } else {
    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(masterVolume, now);
  }
}

function bindVolume() {
  const wrap = $("#volume-wrap");
  const slider = $("#volume-slider");
  if (!wrap || !slider) return;

  slider.value = masterVolume;

  slider.addEventListener("input", () => {
    setVolume(Number(slider.value));
  });

  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setVolume(masterVolume + delta);
    },
    { passive: false }
  );
}

function bindHotkeys() {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

    // Volume: allow hold-to-repeat
    if (e.code === "ArrowUp" || e.code === "ArrowDown") {
      e.preventDefault();
      setVolume(masterVolume + (e.code === "ArrowUp" ? 0.05 : -0.05));
      showVolumeSlider();
      return;
    }

    if (e.repeat) return;

    let handled = false;
    switch (e.code) {
      case "Space":
        e.preventDefault();
        togglePlay();
        handled = true;
        break;
      case "KeyF":
        e.preventDefault();
        toggleFullscreen();
        handled = true;
        break;
      case "Escape":
        e.preventDefault();
        if (!$("#settings-view")?.classList.contains("hidden")) {
          closeSettings();
        } else if (!$("#fullscreen-player")?.classList.contains("hidden")) {
          toggleFullscreen();
        } else if (state.currentGame && gameDetail.classList.contains("active")) {
          $("#back-to-games")?.click();
        }
        handled = true;
        break;
      case "KeyQ":
        e.preventDefault();
        $("#btn-queue")?.click();
        handled = true;
        break;
      case "KeyL":
        e.preventDefault();
        toggleLoop();
        handled = true;
        break;
      case "KeyS":
        e.preventDefault();
        toggleShuffle();
        handled = true;
        break;
      case "ArrowLeft":
        e.preventDefault();
        prevTrack();   // same as ← button
        handled = true;
        break;
      case "ArrowRight":
        e.preventDefault();
        nextTrack();   // same as → button
        handled = true;
        break;
      default:
        break;
    }

    if (handled && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

let volumeHideTimer = null;

function showVolumeSlider() {
  const wrap = $("#volume-wrap");
  if (!wrap) return;
  wrap.classList.add("force-open");
  clearTimeout(volumeHideTimer);
  volumeHideTimer = setTimeout(() => {
    wrap.classList.remove("force-open");
  }, 1200);
}

function toggleFullscreen() {
  const sleepPanel = $("#sleep-panel");
  const sleepBtn = $("#btn-sleep");
  sleepPanel?.classList.add("hidden");
  sleepBtn?.setAttribute("aria-expanded", "false");

  const fs = $("#fullscreen-player");
  const btnFs = $("#btn-fullscreen");
  const btnMin = $("#btn-minimize");

  if (!fs) return;

  const open = fs.classList.contains("hidden");
  if (open) {
    if (!$("#settings-view")?.classList.contains("hidden")) {
      closeSettings();
    }

    // Always mirror bottom player (works for idle + playing)
    const nowTitle = $("#now-title")?.textContent?.trim() || "Nichts läuft";
    const nowGame = $("#now-game")?.textContent?.trim() || "Keinen Song ausgewählt";
    const nowCover = $("#now-cover")?.getAttribute("src") || PLACEHOLDER;

    const fsTitle = $("#fs-title");
    const fsGame = $("#fs-game");
    const fsCover = $("#fs-cover");
    if (fsTitle) fsTitle.textContent = nowTitle;
    if (fsGame) fsGame.textContent = nowGame;
    if (fsCover) fsCover.src = nowCover;

    fs.classList.remove("hidden");
    document.body.classList.add("fs-open");
    btnFs?.classList.add("hidden");
    btnMin?.classList.remove("hidden");
  } else {
    fs.classList.add("hidden");
    document.body.classList.remove("fs-open");
    btnMin?.classList.add("hidden");
    btnFs?.classList.remove("hidden");
  }
}

function cloneQueue(q) {
  return q.map((item) => ({
    gameId: item.gameId,
    track: item.track,
    insert: item.insert ?? null,
  }));
}

function toggleShuffle() {
  if (!state.shuffle) {
    // Save current order, then shuffle view under current song
    unshuffledQueue = cloneQueue(state.queue);

    if (state.queue.length > 1 && state.queueIndex >= 0) {
      const current = state.queue[state.queueIndex];
      const rest = state.queue.filter((_, i) => i !== state.queueIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      state.queue = [current, ...rest];
      state.queueIndex = 0;
    }
    state.shuffle = true;
  } else {
    // Restore exact saved order (includes play-next / end adds / moves)
    if (unshuffledQueue && unshuffledQueue.length) {
      const currentId = getCurrentTrackId();
      state.queue = cloneQueue(unshuffledQueue);
      const idx = state.queue.findIndex((i) => i.track?.id === currentId);
      state.queueIndex = idx >= 0 ? idx : 0;
    }
    unshuffledQueue = null;
    state.shuffle = false;
  }

  updatePlayerUI();
  renderQueue();
}

function releaseDecodedBuffer() {
  stopSource(); // was: keepMediaAlive on iOS
  decodedBuffer = null;
  if (typeof window.gc === "function") {
    try { window.gc(); } catch (_) {}
  }
}

async function decodeBfstm(url) {
  const hit = decodeCacheGet(url);
  if (hit?.audioBuffer) {
    return {
      audioBuffer: hit.audioBuffer,
      loopStartSample: hit.loopStartSample,
      sampleRate: hit.sampleRate,
      loopFlag: !!hit.loopFlag,
    };
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const bfstm = new Bfstm(arrayBuffer);
  const meta = bfstm.metadata;
  const channels = bfstm.getAllSamples();

  const ctx = ensureAudioContext();
  const audioBuffer = ctx.createBuffer(
    meta.numberChannels,
    meta.totalSamples,
    meta.sampleRate
  );

  for (let c = 0; c < meta.numberChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    const src = channels[c];
    for (let i = 0; i < src.length; i++) {
      channelData[i] = (src[i] / 32768) * 0.98;
    }
  }

  const out = {
    audioBuffer,
    loopStartSample: meta.loopFlag ? meta.loopStartSample : 0,
    sampleRate: meta.sampleRate,
    loopFlag: !!meta.loopFlag,
  };
  decodeCacheSet(url, out);
  return out;
}

// ─── App UI ────────────────────────────────────────────────────

async function init() {
  try {
   const res = await fetch("/Assets/games.json");
    if (!res.ok) throw new Error(res.status);
    LIBRARY = await res.json();
  } catch (err) {
    console.error("[Noma] Failed to load games.json:", err);
    LIBRARY = [];
  }
  renderGames();
  bindTabs();
  bindPlayerChrome();
  bindMediaSession();
  bindQueuePanel();
  bindClearQueueConfirm();
  bindFullscreen();
  bindContextMenu();
  bindGameHeaderToggle();
  updatePlayerUI();
  bindVolume();
  bindHotkeys();
  loadSettings();
  masterVolume = settings.volume ?? 1;
  const volSlider = $("#volume-slider");
  if (volSlider) volSlider.value = String(masterVolume);
  window.addEventListener("resize", onBgResize, { passive: true });
  bindSettings();
  bindSleepTimer();
  updateSleepUI();
  $("#now-cover").src = PLACEHOLDER;
  $("#fs-cover").src = PLACEHOLDER;
  $("#now-title").textContent = "Nichts läuft";
  $("#now-game").textContent = "Keinen Song ausgewählt";
  await initKawarp();
  applyBgModeClass();
  lastBgUrl = ""; // force idle paint
  await setAmbientBackground(PLACEHOLDER, { force: true });
  window.addEventListener("resize", onBgResize, { passive: true });
  document.addEventListener("dragstart", (e) => {
    if (e.target instanceof HTMLImageElement) {
      e.preventDefault();
    }
  });
  mountDurationDevTool();
   document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      syncSoftEndFromClock();
      try {
        kawarp?.stop();
      } catch (_) {}
      if (state.playing) {
        try {
          navigator.mediaSession.playbackState = "playing";
        } catch (_) {}
        if (!useMediaEl) startSilentShield();
        startBgSessionKeepAlive();
      }
      return;
    }

    // ── Foreground ──
    clearBgSessionKeepAlive();
    ensurePlaybackAudioSession();
    syncSoftEndFromClock();

    // App was killed / reloaded while audio was "ghosting": force idle UI + session
    if (!state.playing) {
      clearMediaSessionHard();
      // If silence or a stream element is still running, hard-stop it
      stopSilentShield();
      try {
        if (persistentMediaEl && !useMediaEl) {
          persistentMediaEl.pause();
        }
      } catch (_) {}
    } else {
      if (!useMediaEl && decodedBuffer) startSilentShield();
      if (useMediaEl && mediaEl) {
        const cur = (typeof activeMedia === "function" && activeMedia()) || mediaEl;
        if (cur && cur.paused) cur.play().catch(() => {});
      }
      if (decodedBuffer && !scrubbing) updateProgressUI();
      if (useMediaEl) {
        if (mediaA && mediaB) bindStreamProgress();
        else updateMediaProgress();
      }
      bindMediaSession();
      updateMediaSession();
    }

    syncKawarpPlayback();
  });

  // Kill only on real leave (swipe away / close tab) — not on lock
  window.addEventListener("pagehide", () => {
    teardownOnAppKill();
  });
  window.addEventListener("beforeunload", () => {
    teardownOnAppKill();
  });
  document.addEventListener("freeze", () => {
    teardownOnAppKill();
  });
}

function renderGames() {
  gamesGrid.innerHTML = LIBRARY.map(
    (g) => `
    <article class="game-card" data-id="${g.id}">
      <img src="${g.cover}" alt="${escapeHtml(g.title)}" loading="lazy">
      <div class="card-body">
        <h3>${escapeHtml(g.short)}</h3>
        <p>${g.tracks.length} Titel</p>
      </div>
    </article>
  `
  ).join("");

  gamesGrid.querySelectorAll(".game-card").forEach((card) => {
    card.addEventListener("click", () => openGame(card.dataset.id));
  });
}

function openGame(id) {
  const game = LIBRARY.find((g) => g.id === id);
  if (!game) return;
  state.currentGame = game;

  tabGames.classList.remove("active");
  tabPlaylists.classList.remove("active");
  gameDetail.classList.remove("hidden");
  gameDetail.classList.add("active");

  $("#game-cover").src = game.cover;
  $("#game-title").textContent = game.title;

  const titleEl = $("#game-title");
  if (titleEl) {
    titleEl.dataset.full = game.title || "";
    titleEl.dataset.short = game.short || game.title || "";
    const compact = document.querySelector(".game-sticky-top")?.classList.contains("is-collapsed");
    titleEl.textContent = compact ? titleEl.dataset.short : titleEl.dataset.full;
  }

  const totalSec = (game.tracks || []).reduce(
    (sum, t) => sum + (Number.isFinite(t.duration) ? t.duration : 0),
    0
  );
  const countEl = $("#game-track-count");
  if (countEl) {
    const albumDur = formatAlbumDuration(totalSec);
    countEl.textContent = albumDur
      ? `${game.tracks.length} Titel · ${albumDur}`
      : `${game.tracks.length} Titel`;
  }

  const composerName = $("#game-composer-name");
  if (composerName) composerName.textContent = game.composer || "";
  const composerEl = $("#game-composer");
  if (composerEl) composerEl.style.display = game.composer ? "" : "none";

  trackListEl.innerHTML = game.tracks
    .map(
      (t, i) => `
    <div class="track-row" data-track-id="${t.id}" data-index="${i}">
      <span class="track-num">
        <span class="num">${i + 1}</span>
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="hover-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </span>
      <span class="track-name">${escapeHtml(t.title)}</span>
      <span class="track-duration" data-file="${escapeHtml(t.file)}">–:––</span>
      <span class="track-actions" data-action="menu">⋮</span>
    </div>
  `
    )
    .join("");

  // Durations (JSON first, else file)
  game.tracks.forEach(async (t) => {
    const url = typeof getTrackUrl === "function" ? getTrackUrl(t) : t.file;
    const sec = await getTrackDuration(url, t);
    if (sec == null) return;
    const el = trackListEl.querySelector(
      `.track-duration[data-file="${CSS.escape(t.file)}"]`
    );
    if (el) el.textContent = formatTime(sec);
  });

  bindTrackListFade();
  bindGameHeaderToggle();
  requestAnimationFrame(updateTrackFade);

  trackListEl.querySelectorAll(".track-row").forEach((row) => {
      if (row.dataset.suppressClick === "1") {
        delete row.dataset.suppressClick;
        return;
      }
    row.addEventListener("click", (e) => {
      if (e.target.closest(".track-actions")) {
        e.preventDefault();
        e.stopPropagation();
        const track = game.tracks[+row.dataset.index];
        const actionsBtn = e.target.closest(".track-actions");
        const rect = actionsBtn.getBoundingClientRect();
        showContextMenu(
          rect.left,
          rect.bottom + 4,
          { game, track, fromQueue: false },
          actionsBtn
        );
        return;
      }
      const track = game.tracks[+row.dataset.index];
      playFromGame(game, track);
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const track = game.tracks[+row.dataset.index];
      showContextMenu(e.clientX, e.clientY, { game, track, fromQueue: false });
    });

    let lpTimer = null;
    let lpMoved = false;
    row.addEventListener(
      "pointerdown",
      (e) => {
      if (e.pointerType === "mouse") return;
        if (e.target.closest(".track-actions")) return;
        lpMoved = false;
        const x = e.clientX;
        const y = e.clientY;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (lpMoved) return;
          const track = game.tracks[+row.dataset.index];
          if (!track) return;
          showContextMenu(x, y, { game, track, fromQueue: false });
          row.dataset.suppressClick = "1";
        }, 480);
      },
      { passive: true }
    );
    row.addEventListener(
      "pointermove",
      (e) => {
        if (!lpTimer) return;
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) {
          lpMoved = true;
          clearTimeout(lpTimer);
          lpTimer = null;
        }
      },
      { passive: true }
    );
    const cancelLp = () => {
      if (lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    };
    row.addEventListener("pointerup", cancelLp);
    row.addEventListener("pointercancel", cancelLp);
  });

  const currentId = getCurrentTrackId();
  if (currentId) markPlayingTrack(currentId);

  $("#play-all-btn").onclick = () => {
    unlockMediaElement().catch(() => {});
    unshuffledQueue = null;
    state.queue = game.tracks.map((t) => ({
      gameId: game.id,
      track: t,
      insert: null,
    }));
    state.queueIndex = 0;
    state.shuffle = false;
    if (state.loopMode === "count") {
      state.loopsRemaining = settings.loopTimes;
    } else {
      state.loopsRemaining = 0;
    }
    playCurrent();
    renderQueue();
    updatePlayerUI();
  };

  $("#shuffle-all-btn").onclick = () => {
    unlockMediaElement().catch(() => {});
    unshuffledQueue = game.tracks.map((t) => ({
      gameId: game.id,
      track: t,
      insert: null,
    }));

    const items = game.tracks.map((t) => ({
      gameId: game.id,
      track: t,
      insert: null,
    }));
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    state.queue = items;
    state.queueIndex = 0;
    state.shuffle = true;
    if (state.loopMode === "count") {
      state.loopsRemaining = settings.loopTimes;
    } else {
      state.loopsRemaining = 0;
    }
    playCurrent();
    renderQueue();
    updatePlayerUI();
  };

  // Album ⋯ — OUTSIDE shuffle, every time openGame runs
  const albumBtn = $("#album-menu-btn");
  if (albumBtn) {
    albumBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = albumBtn.getBoundingClientRect();
      showContextMenu(
        r.left,
        r.bottom + 6,
        { game, album: true },
        albumBtn
      );
    };
  }

  // ── these must run every time you open a game (NOT inside shuffle) ──
  setupGameTrackSearch();
  bindTrackSearch();
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));

      const name = tab.dataset.tab;

      if (name === "games" && state.currentGame) {
        // return to the game you were in
        gameDetail.classList.remove("hidden");
        gameDetail.classList.add("active");
        openGame(state.currentGame.id);
        return;
      }

      gameDetail.classList.add("hidden");
      gameDetail.classList.remove("active");
      const panel = $(`#tab-${name}`);
      if (panel) panel.classList.add("active");
    });
  });

  $("#back-to-games").addEventListener("click", () => {
    state.currentGame = null;
    gameDetail.classList.add("hidden");
    gameDetail.classList.remove("active");
    tabGames.classList.add("active");
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    $("#tab-games")?.classList.add("active");
  });
}

function playFromGame(game, track) {
  unlockMediaElement().catch(() => {});
  unshuffledQueue = null;
  const idx = game.tracks.findIndex((t) => t.id === track.id);
  state.queue = game.tracks.map((t) => ({
    gameId: game.id,
    track: t,
    insert: null,
  }));
  state.queueIndex = Math.max(0, idx);
  if (state.loopMode === "count") {
    state.loopsRemaining = settings.loopTimes;
  } else {
    state.loopsRemaining = 0;
  }
  playCurrent();
  renderQueue();
}

async function playCurrent() {
  const gen = ++playGen;
  // iOS mute switch: unlock HTMLAudio + set session to "playback"
  try {
    await unlockMediaElement();
  } catch (_) {}

  ensurePlaybackAudioSession();
  cancelTransition(false);
  clearSoftEndTimers();

  const item = state.queue[state.queueIndex];
  if (!item) return;

  const game = LIBRARY.find((g) => g.id === item.gameId);
  const track = item.track;

  if (state.loopMode === "count") {
    state.loopsRemaining =
      Number(settings.loopTimes) || DEFAULT_SETTINGS.loopTimes;
  }

  $("#now-cover").src = game?.cover || PLACEHOLDER;
  $("#now-title").textContent = track.title;
  $("#now-game").textContent = game?.short || "";
  $("#fs-cover").src = game?.cover || PLACEHOLDER;
  $("#fs-title").textContent = track.title;
  $("#fs-game").textContent = game?.short || "";
  // set cover only once we know the track — avoids idle→placeholder→cover flash
  if (game?.cover) {
    setAmbientBackground(game.cover);
  }
  document.body.classList.add("is-playing");
  markPlayingTrack(track.id);

  releaseDecodedBuffer();
  state.playing = false;
  pauseOffset = 0;
  // Update in-app chrome only — skip media session until we actually start
  const playIcon = $("#icon-play");
  const pauseIcon = $("#icon-pause");
  if (playIcon && pauseIcon) {
    playIcon.classList.remove("hidden");
    pauseIcon.classList.add("hidden");
  }
  // keep previous metadata until new track is ready

  const url = typeof getTrackUrl === "function" ? getTrackUrl(track) : track.file;

  try {
    await resumeAudio();
    // mark unlock opportunity when this call is still in a click stack
    if (persistentMediaEl) persistentMediaEl.dataset.unlocked = persistentMediaEl.dataset.unlocked || "";
  } catch (_) {}

  try {
    if (typeof resumeAudio === "function") {
      await resumeAudio();
    } else {
      ensureAudioContext();
    }
    if (gen !== playGen) return; // skipped while loading

    if (typeof isWebAudioFile === "function" && isWebAudioFile(url)) {
      forceFullLoop = !!track.LoopFromStoE;
      const mode = getPlaybackMode(track);

      if (mode === "buffer") {
        const audioBuffer = await decodeWebAudio(url);
        if (gen !== playGen) return;

        decodedBuffer = audioBuffer;
        sampleRate = audioBuffer.sampleRate;

        if (forceFullLoop) {
          loopStartSample = 0;
        } else if (Number.isFinite(track.loopStart) && track.loopStart > 0) {
          loopStartSample = Math.floor(track.loopStart * sampleRate);
        } else {
          loopStartSample = 0;
        }

        state.duration =
          Number.isFinite(track.duration) && track.duration > 0
            ? track.duration
            : audioBuffer.duration;
        state.currentTime = 0;

        playBuffer(decodedBuffer, 0);
      } else {
        // Dual A/B is heavy + breaks auto-advance on iOS (NotAllowedError).
        // Single element is faster and keeps the autoplay “session” more reliably.
        if (isIOS() || isMobileLike()) {
          await playMediaUrl(url, track, 0);
        } else {
          await playMediaUrlStreamLoop(url, track, 0);
          if (gen !== playGen) return;
        }
      }

      if (!$("#queue-panel")?.classList.contains("hidden")) renderQueue();
      return;
    }

    // BFSTM
    const decoded = await decodeBfstm(url);
    if (gen !== playGen) return;

    decodedBuffer = decoded.audioBuffer;
    loopStartSample = decoded.loopStartSample;
    sampleRate = decoded.sampleRate;
    forceFullLoop = !!track.LoopFromStoE;

    if (
      !forceFullLoop &&
      Number.isFinite(track.loopStart) &&
      track.loopStart > 0
    ) {
      loopStartSample = Math.floor(track.loopStart * sampleRate);
    }

    state.duration =
      Number.isFinite(track.duration) && track.duration > 0
        ? track.duration
        : decodedBuffer.duration;
    state.currentTime = 0;

    playBuffer(decodedBuffer, 0);
    if (!$("#queue-panel")?.classList.contains("hidden")) renderQueue();
  } catch (err) {
    if (gen !== playGen) return; // ignore errors from cancelled loads
    console.error("[Noma] decode/play failed:", err);
    const blocked =
      err &&
      (err.name === "NotAllowedError" ||
        /not allowed by the user agent/i.test(String(err.message || "")));
    if (!blocked) {
      alert(`Konnte Track nicht abspielen:\n${track.title}\n\n${err.message}`);
    } else {
      console.warn("[Noma] autoplay blocked — press play:", track.title, err);
    }
    document.body.classList.remove("is-playing");
    state.playing = false;
    updatePlayerUI();
  }
}

function getCurrentTrackId() {
  const item = state.queue[state.queueIndex];
  return item?.track?.id ?? null;
}

function markPlayingTrack(trackId) {
  // ── Game track list ──
  document.querySelectorAll(".track-row").forEach((row) => {
    const isCurrent = trackId && row.dataset.trackId === trackId;
    row.classList.toggle("playing", !!isCurrent);

    if (!isCurrent) {
      row.classList.remove("audio-on");
      clearEqInline(row);
      return;
    }

    if (state.playing) {
      clearEqInline(row);
      row.classList.add("audio-on");
    } else {
      smoothPauseEq(row);
      row.classList.remove("audio-on");
    }
  });

  // ── Queue list ──
  document.querySelectorAll(".queue-item").forEach((row) => {
    const isCurrent = +row.dataset.index === state.queueIndex;
    row.classList.toggle("current", isCurrent);

    if (!isCurrent) {
      row.classList.remove("audio-on");
      clearEqInline(row);
      return;
    }

    if (state.playing) {
      clearEqInline(row);
      row.classList.add("audio-on");
    } else {
      smoothPauseEq(row);
      row.classList.remove("audio-on");
    }
  });
}

function clearEqInline(row) {
  row.querySelectorAll(".eq i").forEach((bar) => {
    bar.style.transition = "";
    bar.style.transform = "";
    bar.style.animation = "";
  });
}

function smoothPauseEq(row) {
  row.querySelectorAll(".eq i").forEach((bar) => {
    const current = getComputedStyle(bar).transform;
    bar.style.animation = "none";
    bar.style.transform = current === "none" ? "scaleY(0.35)" : current;
    // next frame → transition to resting size
    requestAnimationFrame(() => {
      bar.style.transition = "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)";
      bar.style.transform = "scaleY(0.35)";
    });
  });
}


async function togglePlay() {
  if (state.queueIndex < 0 && state.queue.length === 0) return;

  // ── Pause ──
  if (state.playing) {
    if (useMediaEl && mediaEl) {
      const cur = activeMedia() || mediaEl;
      pauseOffset = cur.currentTime;
      cur.pause();
      if (mediaA && mediaA !== cur) mediaA.pause();
      if (mediaB && mediaB !== cur) mediaB.pause();
      if (mediaRaf) {
        cancelAnimationFrame(mediaRaf);
        mediaRaf = null;
      }
      state.playing = false;
      document.body.classList.remove("is-playing");
      clearBgSessionKeepAlive();
      markPlayingTrack(getCurrentTrackId());
      updatePlayerUI();
      syncKawarpPlayback()
      return;
    }

    if (transitioning && audioCtx) {
      transitionProgress = Math.max(0, audioCtx.currentTime - transitionStartedAt);
      pauseOffset = getPlaybackPosition();
      if (currentGain) {
        const now = audioCtx.currentTime;
        currentGain.gain.cancelScheduledValues(now);
        currentGain.gain.setValueAtTime(currentGain.gain.value, now);
      }
      stopSource();
      state.playing = false;
      document.body.classList.remove("is-playing");
      clearBgSessionKeepAlive();
      markPlayingTrack(getCurrentTrackId());
      updatePlayerUI();
      syncKawarpPlayback()
      return;
    }

    // BFSTM: fade out, stop source, keep context RUNNING (no suspend lag)
    pauseOffset = getPlaybackPosition();
    const myPauseGen = ++pauseStopGen;
    bufferCtxSuspended = false;

    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }

    if (softEndFadeAt > 0 && audioCtx) {
      const now = audioCtx.currentTime;
      softEndRemainMs = Math.max(0, (softEndFadeAt + softEndFadeSec - now) * 1000);
      softEndStartRemainMs = Math.max(0, (softEndFadeAt - now) * 1000);
    }
    if (softEndTimer) {
      clearTimeout(softEndTimer);
      softEndTimer = null;
    }
    if (softEndStartTimer) {
      clearTimeout(softEndStartTimer);
      softEndStartTimer = null;
    }
    softEndFadeAt = 0;
    softEndFadeSec = 0;

    const src = currentSource;
    const g = currentGain;

    if (g && audioCtx) {
      const t = audioCtx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + CLICK_RAMP);
    }

    state.playing = false;
    document.body.classList.remove("is-playing");
    // so iOS doesn't keep treating silence.m4a as "still playing"
    clearBgSessionKeepAlive();
    stopSilentShield();
    markPlayingTrack(getCurrentTrackId());
    updatePlayerUI();
    syncKawarpPlayback();

    setTimeout(() => {
      if (myPauseGen !== pauseStopGen) return;
      try {
        if (src) {
          src.onended = null;
          src.stop();
          src.disconnect();
        }
        if (g) g.disconnect();
      } catch (_) {}
      if (currentSource === src) currentSource = null;
      if (currentGain === g) currentGain = null;
      // do NOT suspend, do NOT keepMediaAlive
    }, Math.ceil(CLICK_RAMP * 1000) + 8);
    return;
  }

  // ── Resume / start ──
  if (useMediaEl && mediaEl) {
    try {
      unlockMediaElement().catch(() => {});
      const cur = activeMedia() || mediaEl;
      cur.currentTime = pauseOffset;
      cur.volume = 0;
      await cur.play();
      // short volume ramp
      const target = masterVolume;
      const steps = 6;
      let i = 0;
      const tick = () => {
        i++;
        cur.volume = target * (i / steps);
        if (i < steps) requestAnimationFrame(tick);
        else cur.volume = target;
      };
      requestAnimationFrame(tick);
      state.playing = true;
      document.body.classList.add("is-playing");
      markPlayingTrack(getCurrentTrackId());
      updatePlayerUI();
      syncKawarpPlayback()
      if (mediaA && mediaB) {
        bindStreamProgress(); // dual
      } else {
        updateMediaProgress(); // single
      }
    } catch (err) {
      console.warn("[Noma] media resume failed", err);
    }
    return;
  }

  if (transitioning && decodedBuffer) {
    const sec = getTransitionSec();
    const already = Math.min(sec, Math.max(0, transitionProgress));
    const remaining = Math.max(0.05, sec - already);

    playBuffer(decodedBuffer, pauseOffset);

    if (currentGain && audioCtx) {
      const now = audioCtx.currentTime;
      const startGain = masterVolume * (1 - already / sec);
      currentGain.gain.cancelScheduledValues(now);
      currentGain.gain.setValueAtTime(Math.max(0, startGain), now);
      currentGain.gain.linearRampToValueAtTime(0, now + remaining);
      transitionStartedAt = now - already;
      transitioning = true;
      document.body.classList.add("is-transitioning");
    }
    updatePlayerUI();
    return;
  }

  // BFSTM resume: context still running → instant start at pauseOffset
  if (decodedBuffer) {
    pauseStopGen++; // cancel any delayed stop from pause fade
    bufferCtxSuspended = false;
    ensurePlaybackAudioSession();
    await resumeAudio();
    startSilentShield(); // re-arm for mute switch
    playBuffer(decodedBuffer, pauseOffset);
    updateMediaSession();

    // restore soft-end after playBuffer if we had one
    if (softEndRemainMs > 0 || softEndStartRemainMs > 0) {
      const now = audioCtx.currentTime;
      softEndFadeAt = now + softEndStartRemainMs / 1000;
      softEndFadeSec = Math.max(0, (softEndRemainMs - softEndStartRemainMs) / 1000);
      softEndRemainMs = 0;
      softEndStartRemainMs = 0;
      // playBuffer already scheduled soft-end for "off/count"; if you need exact
      // remain times, call rescheduleSoftEndAfterResume() instead of playBuffer's own —
      // simplest: let playBuffer recalculate from pauseOffset (preferred)
      softEndRemainMs = 0;
      softEndStartRemainMs = 0;
    }
    return;
  }

  await unlockMediaElement();
  playCurrent();
  updatePlayerUI();
}

function nextTrack(fromNaturalEnd = false) {
  if (state.queue.length === 0) return;

  // Sleep: end of current song
  if (fromNaturalEnd && sleepMode === "end") {
    fireSleepTimer();
    return;
  }

  if (transitioning) {
    cancelTransition(false);
    stopSource();
  }

  const atLast = state.queueIndex >= state.queue.length - 1;

  if (atLast && !settings.queueLoop) {
    // Stop after last track (no wrap)
    stopSource();
    state.playing = false;
    document.body.classList.remove("is-playing");
    pauseOffset = 0;
    markPlayingTrack(getCurrentTrackId());
    updatePlayerUI();
    if (fromNaturalEnd) {
      // stay on last track, idle
      const fill = $("#progress-fill");
      if (fill) fill.style.width = "100%";
    }
    return;
  }

  let next = (state.queueIndex + 1) % state.queue.length;

  if (queueDragging && queueDragFrom >= 0 && next === queueDragFrom) {
    if (state.queue.length <= 1) {
      next = state.queueIndex;
    } else {
      next = (next + 1) % state.queue.length;
      if (next === queueDragFrom) {
        next = (next + 1) % state.queue.length;
      }
    }
  }

  state.queueIndex = next;

  if (state.loopMode === "count") {
    state.loopsRemaining = settings.loopTimes;
  } else {
    state.loopsRemaining = 0;
  }
  playCurrent();
}

function prevTrack() {
  if (state.queue.length === 0) return;

  if (transitioning) {
    cancelTransition(false);
    stopSource();
  }

  const pos = getPlaybackPosition();
  const dur =
    (decodedBuffer && decodedBuffer.duration) ||
    state.duration ||
    (mediaEl && mediaEl.duration) ||
    0;

  // Restart current if far enough into the track (works for BFSTM + stream/Credits)
  if (dur > RESTART_THRESHOLD && pos > RESTART_THRESHOLD) {
    pauseOffset = 0;
    if (useMediaEl && mediaEl) {
      const cur = activeMedia() || mediaEl;
      cur.currentTime = 0;
      pauseOffset = 0;
      if (state.playing) {
        cur.play().catch(() => {});
        if (mediaA && mediaB) bindStreamProgress();
        else updateMediaProgress();
      } else {
        const fill = $("#progress-fill");
        if (fill) fill.style.width = "0%";
        const tCur = $("#time-current");
        if (tCur) tCur.textContent = "0:00";
      }
      return;
    }
    if (state.playing && decodedBuffer) {
      playBuffer(decodedBuffer, 0);
    } else {
      $("#progress-fill").style.width = "0%";
      $("#time-current").textContent = "0:00";
    }
    return;
  }

  // Near start: go to previous track
  if (state.queueIndex <= 0) {
    if (settings.queueLoop && state.queue.length > 1) {
      state.queueIndex = state.queue.length - 1;
    } else {
      // no wrap — stay on first, jump to 0:00
      pauseOffset = 0;
      if (useMediaEl && mediaEl) {
        const cur = activeMedia() || mediaEl;
        cur.currentTime = 0;
        if (state.playing) cur.play().catch(() => {});
      } else if (state.playing && decodedBuffer) {
        playBuffer(decodedBuffer, 0);
      } else {
        $("#progress-fill").style.width = "0%";
        $("#time-current").textContent = "0:00";
      }
      return;
    }
  } else {
    state.queueIndex -= 1;
  }

  if (state.loopMode === "count") {
    state.loopsRemaining = settings.loopTimes;
  } else {
    state.loopsRemaining = 0;
  }
  playCurrent();
}

function toggleLoop() {
  const modes = ["off", "one", "count"];
  const i = modes.indexOf(state.loopMode);
  state.loopMode = modes[(i + 1) % modes.length];

  if (state.loopMode === "count") {
    state.loopsRemaining = Number(settings.loopTimes) || DEFAULT_SETTINGS.loopTimes;
  } else {
    state.loopsRemaining = 0;
  }

  updatePlayerUI();

  if (transitioning) return;

  // Stream: only flip HTMLAudio.loop
  if (useMediaEl && mediaEl) {
    mediaEl.loop = state.loopMode === "one" && !(mediaLoopStart > 0);
    lastLoopCycle = -1;
    return;
  }

  // BFSTM: change loop flags on the LIVE source — no stop/restart
  if (!decodedBuffer || !currentSource) return;

  const duration = decodedBuffer.duration;
  const loopStart = getLoopStartSec();
  const wantInfinite = state.loopMode === "one";
  const wantSoftEnd =
    (state.loopMode === "off" || state.loopMode === "count") &&
    (loopStart > 0 || forceFullLoop);

  if (wantInfinite || wantSoftEnd) {
    currentSource.loop = true;
    if (forceFullLoop) {
      currentSource.loopStart = 0;
      currentSource.loopEnd = duration;
    } else if (loopStart > 0) {
      currentSource.loopStart = loopStart;
      currentSource.loopEnd = duration;
    } else {
      currentSource.loopStart = 0;
      currentSource.loopEnd = duration;
    }
  } else {
    currentSource.loop = false;
  }

  lastLoopCycle = -1;

  // Rebuild soft-end schedule from current position (no new BufferSource)
  if (softEndTimer) {
    clearTimeout(softEndTimer);
    softEndTimer = null;
  }
  if (softEndStartTimer) {
    clearTimeout(softEndStartTimer);
    softEndStartTimer = null;
  }
  softEndFadeAt = 0;
  softEndFadeSec = 0;

  if (wantSoftEnd && state.playing && audioCtx && currentGain && !bufferCtxSuspended) {
    const offset = getPlaybackPosition();
    const fadeSec = getTransitionSec();
    let loopsAfterFirst = 0;
    if (state.loopMode === "count") {
      loopsAfterFirst = Math.max(0, state.loopsRemaining);
    }
    const loopLen = forceFullLoop
      ? Math.max(0.001, duration)
      : Math.max(0.001, duration - loopStart);
    const timeToFadeStart =
      Math.max(0.01, duration - offset) + loopsAfterFirst * loopLen;

    softEndFadeAt = audioCtx.currentTime + timeToFadeStart;
    softEndFadeSec = fadeSec;

    const now = audioCtx.currentTime;
    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(masterVolume, now);
    if (fadeSec <= 0) {
      currentGain.gain.setValueAtTime(0, softEndFadeAt);
    } else {
      currentGain.gain.setValueAtTime(masterVolume, softEndFadeAt);
      currentGain.gain.linearRampToValueAtTime(0, softEndFadeAt + fadeSec);
    }

    softEndStartTimer = setTimeout(() => {
      softEndStartTimer = null;
      if (!state.playing || !currentGain) return;
      transitioning = true;
      transitionStartedAt = softEndFadeAt;
      document.body.classList.add("is-transitioning");
      lastLoopCycle = Math.max(0, lastLoopCycle);
      updateProgressUI();
    }, timeToFadeStart * 1000);

    softEndTimer = setTimeout(() => {
      softEndTimer = null;
      if (!state.playing) return;
      finishTransition();
    }, (timeToFadeStart + Math.max(0, fadeSec)) * 1000 + 40);
  }
}

function updatePlayerUI() {
  const playing = state.playing;
  const playIcon = $("#icon-play");
  const pauseIcon = $("#icon-pause");
  if (playIcon && pauseIcon) {
    playIcon.classList.toggle("hidden", playing);
    pauseIcon.classList.toggle("hidden", !playing);
  }
  $("#btn-loop")?.classList.toggle("active", state.loopMode !== "off");
  $("#btn-shuffle")?.classList.toggle("active", state.shuffle);

  const badge = $("#loop-badge");
  if (badge) {
    if (state.loopMode === "one") {
      badge.textContent = "∞";
      badge.style.fontSize = "1rem";
      badge.classList.remove("hidden");
    } else if (state.loopMode === "count") {
      badge.textContent = String(Math.max(0, state.loopsRemaining));
      badge.style.fontSize = "";
      badge.classList.remove("hidden");
    } else {
      badge.textContent = "";
      badge.classList.add("hidden");
    }
  }

  // sync lock screen / Control Center — NOT bindMediaSession()
  updateMediaSession();
}

function absoluteAssetUrl(path) {
  if (!path) return new URL(PLACEHOLDER, location.href).href;
  try {
    return new URL(path, location.href).href;
  } catch (_) {
    return path;
  }
}

function bindMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const set = (action, handler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (_) {}
  };

  // iOS re-enables these after background — clear, then override if it ignores null
  try {
    navigator.mediaSession.setActionHandler("seekbackward", null);
  } catch (_) {}
  try {
    navigator.mediaSession.setActionHandler("seekforward", null);
  } catch (_) {}

  // If the OS still shows ± controls, make them skip tracks (not ±10s)
  set("seekbackward", () => {
    prevTrack();
    updateMediaSession();
  });
  set("seekforward", () => {
    nextTrack();
    updateMediaSession();
  });

  set("play", async () => {
    if (!state.playing) await togglePlay();
    updateMediaSession();
  });

  set("pause", async () => {
    if (state.playing) await togglePlay();
    updateMediaSession();
  });

  set("previoustrack", () => {
    prevTrack();
    updateMediaSession();
  });

  set("nexttrack", () => {
    nextTrack();
    updateMediaSession();
  });

  set("seekto", (details) => {
    if (!details || !Number.isFinite(details.seekTime)) return;
    if (transitioning) return;
    const t = Math.max(0, details.seekTime);

    if (useMediaEl && mediaEl) {
      const cur = activeMedia() || mediaEl;
      cur.currentTime = t;
      pauseOffset = t;
      if (state.playing) {
        if (mediaA && mediaB) bindStreamProgress();
        else updateMediaProgress();
      }
    } else if (decodedBuffer) {
      if (state.playing) playBuffer(decodedBuffer, t);
      else {
        pauseOffset = t;
        const fill = $("#progress-fill");
        if (fill) fill.style.width = `${(t / decodedBuffer.duration) * 100}%`;
        const tCur = $("#time-current");
        if (tCur) tCur.textContent = formatTime(t);
      }
    }
    updateMediaSession();
  });
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const item = state.queue[state.queueIndex];
  if (!item || state.queueIndex < 0 || !item.track) {
    try {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
    } catch (_) {}
    return;
  }

  const game = LIBRARY.find((g) => g.id === item.gameId);
  const track = item.track;
  // Always absolute https URL — iOS drops relative artwork
  const coverPath = game?.cover || PLACEHOLDER;
  const cover = absoluteAssetUrl(coverPath);

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "Noma Music",
      artist: game?.composer || "Noma Music",
      album: game?.short || game?.title || "Noma Music",
      artwork: [
        { src: cover, sizes: "96x96", type: "image/jpeg" },
        { src: cover, sizes: "128x128", type: "image/jpeg" },
        { src: cover, sizes: "192x192", type: "image/jpeg" },
        { src: cover, sizes: "256x256", type: "image/jpeg" },
        { src: cover, sizes: "384x384", type: "image/jpeg" },
        { src: cover, sizes: "512x512", type: "image/jpeg" },
      ],
    });
  } catch (err) {
    console.warn("[Noma] MediaMetadata failed", err);
  }

  try {
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  } catch (_) {}

  const duration = Math.max(
    0,
    Number(state.duration) ||
      decodedBuffer?.duration ||
      (mediaEl && Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0) ||
      0
  );
  if (!(duration > 0.5)) return;

  let position;
  if (transitioning) {
    position = duration;
  } else if (decodedBuffer || (useMediaEl && mediaEl)) {
    position = getPlaybackPosition();
  } else {
    return;
  }
  if (!Number.isFinite(position)) return;
  position = Math.min(Math.max(0, position), duration);

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position,
    });
  } catch (_) {}
}

/** Wipe lock-screen session completely (idle / after kill / desync). */
function clearMediaSessionHard() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = "none";
  } catch (_) {}
  try {
    navigator.mediaSession.metadata = null;
  } catch (_) {}
  for (const action of [
    "play",
    "pause",
    "previoustrack",
    "nexttrack",
    "seekto",
    "seekbackward",
    "seekforward",
  ]) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch (_) {}
  }
}

let lastMediaSessionPosAt = 0;
function maybeUpdateMediaSessionPosition() {
  const now = performance.now();
  if (now - lastMediaSessionPosAt < 800) return;
  lastMediaSessionPosAt = now;
  updateMediaSession();
}

function addPlayNext(game, track) {
  const item = { gameId: game.id, track, insert: "next" };

  if (state.queueIndex < 0) {
    state.queue = [item];
    state.queueIndex = 0;
    unshuffledQueue = null;
    playCurrent();
    return;
  }

  state.queue.splice(state.queueIndex + 1, 0, item);

  if (state.shuffle && unshuffledQueue) {
    const curId = getCurrentTrackId();
    let i = unshuffledQueue.findIndex((x) => x.track?.id === curId);
    if (i < 0) i = unshuffledQueue.length - 1;
    unshuffledQueue.splice(i + 1, 0, { ...item });
  }

  renderQueue();
}

function addToEnd(game, track) {
  const item = { gameId: game.id, track, insert: "end" };
  state.queue.push(item);

  if (state.shuffle && unshuffledQueue) {
    unshuffledQueue.push({ ...item });
  }

  if (state.queueIndex < 0) {
    state.queueIndex = 0;
    playCurrent();
  }
  renderQueue();
}

function albumQueueItems(game) {
  return (game.tracks || []).map((t) => ({
    gameId: game.id,
    track: t,
    insert: null,
  }));
}

function addAlbumPlayNext(game) {
  const items = albumQueueItems(game);
  if (!items.length) return;
  if (state.queueIndex < 0 || !state.queue.length) {
    state.queue = items;
    state.queueIndex = 0;
    playCurrent();
  } else {
    state.queue.splice(state.queueIndex + 1, 0, ...items);
  }
  if (state.shuffle && unshuffledQueue) {
    unshuffledQueue = cloneQueue(state.queue);
  }
  renderQueue();
  updatePlayerUI();
}

function addAlbumToEnd(game) {
  const items = albumQueueItems(game);
  if (!items.length) return;
  if (!state.queue.length) {
    state.queue = items;
    state.queueIndex = 0;
    playCurrent();
  } else {
    state.queue.push(...items);
  }
  if (state.shuffle && unshuffledQueue) {
    unshuffledQueue = cloneQueue(state.queue);
  }
  renderQueue();
  updatePlayerUI();
}

function shuffleAlbumIntoQueue(game) {
  const items = albumQueueItems(game);
  if (!items.length) return;
  // Fisher–Yates
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  if (state.queueIndex < 0 || !state.queue.length) {
    state.queue = items;
    state.queueIndex = 0;
    playCurrent();
  } else {
    state.queue.splice(state.queueIndex + 1, 0, ...items);
  }
  if (state.shuffle && unshuffledQueue) {
    unshuffledQueue = cloneQueue(state.queue);
  }
  renderQueue();
  updatePlayerUI();
}

function renderQueue() {
  const list = $("#queue-list");
  if (!list) return;

  // While dragging: only refresh "current" / EQ classes — never destroy the DOM
    if (queueDragging) {
    list.querySelectorAll(".queue-item").forEach((row) => {
      const i = +row.dataset.index;
      const isCurrent = i === state.queueIndex;
      row.classList.toggle("current", isCurrent);
      row.classList.toggle("audio-on", isCurrent && state.playing);
    });
    return; // DOM + ghost stay intact
  }

  list.innerHTML = state.queue
    .map((item, i) => {
      const game = LIBRARY.find((g) => g.id === item.gameId);
      const isCurrent = i === state.queueIndex;
      const file = item.track.file;
      return `
      <li class="queue-item ${isCurrent ? "current" : ""} ${
        isCurrent && state.playing ? "audio-on" : ""
      }"
          data-index="${i}" data-game-id="${item.gameId}" data-track-id="${escapeHtml(
        item.track.id
      )}">
        <span class="q-drag" title="Ziehen" data-drag-handle="1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5h2v2H9V5zm0 6h2v2H9v-2zm0 6h2v2H9v-2zm4-12h2v2h-2V5zm0 6h2v2h-2v-2zm0 6h2v2h-2v-2z"/></svg>
        </span>
        <img class="q-cover" src="${game?.cover || PLACEHOLDER}" alt="" draggable="false">
        <span class="q-num">
          <span class="num">${i + 1}</span>
          <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="q-hover-play" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </span>
        </span>
        <div class="q-meta">
          <div class="q-title">${escapeHtml(item.track.title)}</div>
          <div class="q-game muted">${escapeHtml(game?.short || game?.title || "")}</div>
        </div>
        <span class="q-duration" data-file="${escapeHtml(file)}">–:––</span>
        <span class="track-actions q-actions" data-action="menu">⋮</span>
        <button class="q-remove" type="button" data-remove="${i}" title="Entfernen" aria-label="Entfernen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </li>`;
    })
    .join("");

  state.queue.forEach(async (item) => {
    const url = typeof getTrackUrl === "function" ? getTrackUrl(item.track) : item.track.file;
    const sec = await getTrackDuration(url, item.track);
    if (sec == null) return;
    list
      .querySelectorAll(`.q-duration[data-file="${CSS.escape(item.track.file)}"]`)
      .forEach((el) => {
        el.textContent = formatTime(sec);
      });
  });

  bindQueueItemEvents(list);
  // NO scrollIntoView here — only when opening the panel
}

function bindQueueItemEvents(list) {
  // Click row → play / toggle
  list.querySelectorAll(".queue-item").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (row.dataset.suppressClick === "1") {
          delete row.dataset.suppressClick;
        return;
      }
      if (
        e.target.closest(".q-drag") ||
        e.target.closest(".q-remove") ||
        e.target.closest(".track-actions")
      ) {
        return;
      }
      const i = +row.dataset.index;
      if (i === state.queueIndex) {
        togglePlay();
      } else {
        state.queueIndex = i;
        if (state.loopMode === "count") {
          state.loopsRemaining = settings.loopTimes;
        } else {
          state.loopsRemaining = 0;
        }
        playCurrent();
      }
      renderQueue();
    });

    // Right-click → same context menu as game list
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const item = state.queue[+row.dataset.index];
      if (!item) return;
      const game = LIBRARY.find((g) => g.id === item.gameId);
      if (!game) return;
      showContextMenu(e.clientX, e.clientY, {
        game,
        track: item.track,
        fromQueue: true,
      });
    });

        // Long-press → context menu (mobile)
    let lpTimer = null;
    let lpMoved = false;
    const LP_MS = 480;

    row.addEventListener(
      "pointerdown",
      (e) => {
        // PC: use right-click / ⋮ only — no long-press on mouse
        if (e.pointerType === "mouse") return;
        if (e.button != null && e.button !== 0) return;
        if (
          e.target.closest(".q-drag") ||
          e.target.closest(".q-remove") ||
          e.target.closest(".track-actions")
        ) {
          return;
        }
        lpMoved = false;
        const x = e.clientX;
        const y = e.clientY;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (lpMoved) return;
          const item = state.queue[+row.dataset.index];
          if (!item) return;
          const game = LIBRARY.find((g) => g.id === item.gameId);
          if (!game) return;
          showContextMenu(x, y, {
            game,
            track: item.track,
            fromQueue: true,
          });
          row.dataset.suppressClick = "1";
        }, 480);
      },
      { passive: true }
    );

    row.addEventListener(
      "pointermove",
      (e) => {
        if (!lpTimer) return;
        // cancel if finger moved (scrolling / drag intent)
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) {
          lpMoved = true;
          clearTimeout(lpTimer);
          lpTimer = null;
        }
      },
      { passive: true }
    );

    const cancelLp = () => {
      if (lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    };
    row.addEventListener("pointerup", cancelLp);
    row.addEventListener("pointercancel", cancelLp);
    row.addEventListener("lostpointercapture", cancelLp);
  });

  // ⋮ button (toggle)
  list.querySelectorAll(".track-actions").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const row = btn.closest(".queue-item");
      const item = state.queue[+row.dataset.index];
      if (!item) return;
      const game = LIBRARY.find((g) => g.id === item.gameId);
      if (!game) return;
      const rect = btn.getBoundingClientRect();
      showContextMenu(
        rect.left,
        rect.bottom + 4,
        { game, track: item.track, fromQueue: true },
        btn
      );
    });
  });

  // Remove
  list.querySelectorAll(".q-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromQueue(+btn.dataset.remove);
    });
  });

  // Pointer drag (desktop + mobile)
  bindQueuePointerDrag(list);
}

function bindQueuePointerDrag(list) {
  let dragFrom = -1;
  let draggingEl = null;
  let ghost = null;
  let startY = 0;
  let moved = false;
  let lastClientY = 0;
  let lastClientX = 0;
  let dropIndex = -1; // insert-before index in state.queue
  let lastDropIndex = -2;
  let scrollRaf = null;
  let slotEl = null;

  function makeGhost(row) {
    const item = state.queue[+row.dataset.index];
    if (!item) return null;
    const game = LIBRARY.find((g) => g.id === item.gameId);
    const el = document.createElement("div");
    el.className = "queue-drag-ghost";
    el.innerHTML = `
      <img src="${game?.cover || PLACEHOLDER}" alt="">
      <div>
        <div class="ghost-title">${escapeHtml(item.track.title)}</div>
        <div class="ghost-sub">${escapeHtml(game?.short || "")}</div>
      </div>
      <span class="ghost-sub">${row.querySelector(".q-duration")?.textContent || ""}</span>
    `;
    document.body.appendChild(el);
    return el;
  }

  function moveGhost(clientX, clientY) {
    if (!ghost) return;
    ghost.style.left = `${clientX}px`;
    ghost.style.top = `${clientY}px`;
  }

  function ensureSlot() {
    if (slotEl && slotEl.parentNode === list) return slotEl;
    slotEl = document.createElement("li");
    slotEl.className = "queue-drop-slot";
    slotEl.setAttribute("aria-hidden", "true");
    return slotEl;
  }

  function clearGapVisual() {
    list.querySelectorAll(".queue-item").forEach((el) => {
      el.classList.remove("drag-gap-before", "drag-gap-after", "drag-over");
    });
    if (slotEl && slotEl.parentNode) {
      slotEl.classList.remove("active");
      slotEl.remove();
    }
  }

  /** dropIndex = index in state.queue to insert BEFORE (0..length) */
  function computeDropIndex(clientY) {
    const rows = [...list.querySelectorAll(".queue-item:not(.dragging)")];
    if (!rows.length) return 0;

    const first = rows[0].getBoundingClientRect();
    if (clientY < first.top + first.height * 0.4) {
      return +rows[0].dataset.index;
    }

    const last = rows[rows.length - 1].getBoundingClientRect();
    if (clientY > last.bottom - last.height * 0.4) {
      return +rows[rows.length - 1].dataset.index + 1;
    }

    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        const mid = r.top + r.height / 2;
        return clientY < mid ? +row.dataset.index : +row.dataset.index + 1;
      }
    }

    // nearest
    let best = rows[0];
    let bestDist = Infinity;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      const cy = (r.top + r.bottom) / 2;
      const d = Math.abs(clientY - cy);
      if (d < bestDist) {
        bestDist = d;
        best = row;
      }
    }
    const r = best.getBoundingClientRect();
    return clientY < r.top + r.height / 2
      ? +best.dataset.index
      : +best.dataset.index + 1;
  }

  function placeSlot(insertBeforeIndex) {
    // Only touch DOM when the index actually changes → no jitter
    if (insertBeforeIndex === lastDropIndex) return;
    lastDropIndex = insertBeforeIndex;
    dropIndex = insertBeforeIndex;

    clearGapVisual();
    const slot = ensureSlot();
    slot.classList.add("active");

    const rows = [...list.querySelectorAll(".queue-item:not(.dragging)")];
    // find first row whose data-index >= insertBeforeIndex
    let anchor = null;
    for (const row of rows) {
      if (+row.dataset.index >= insertBeforeIndex) {
        anchor = row;
        break;
      }
    }
    if (anchor) {
      list.insertBefore(slot, anchor);
    } else {
      list.appendChild(slot);
    }
  }

  function stopAutoScroll() {
    if (scrollRaf) {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = null;
    }
  }

  function startAutoScroll() {
    stopAutoScroll();
    const tick = () => {
      if (dragFrom < 0) {
        stopAutoScroll();
        return;
      }
      const scrolled = autoScrollQueue(lastClientY);
      // only recompute drop target after scroll moved the list
      if (scrolled) {
        placeSlot(computeDropIndex(lastClientY));
      }
      scrollRaf = requestAnimationFrame(tick);
    };
    scrollRaf = requestAnimationFrame(tick);
  }

  function clearDrag() {
    stopAutoScroll();
    clearGapVisual();
    list.querySelectorAll(".queue-item").forEach((el) => {
      el.classList.remove("dragging");
    });
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    dragFrom = -1;
    queueDragFrom = -1;
    queueDragging = false;
    draggingEl = null;
    moved = false;
    dropIndex = -1;
    lastDropIndex = -2;
  }

  list.querySelectorAll(".q-drag").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      const row = handle.closest(".queue-item");
      if (!row) return;

      hideContextMenu?.();
      contextMenu?.classList.add("hidden");

      dragFrom = +row.dataset.index;
      queueDragFrom = dragFrom;
      queueDragging = true;
      draggingEl = row;
      startY = e.clientY;
      lastClientY = e.clientY;
      lastClientX = e.clientX;
      moved = false;
      dropIndex = -1;
      lastDropIndex = -2;
      row.classList.add("dragging");

      ghost = makeGhost(row);
      moveGhost(e.clientX, e.clientY);
      startAutoScroll();

      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (dragFrom < 0 || !draggingEl) return;
      if (Math.abs(e.clientY - startY) > 4) moved = true;

      lastClientX = e.clientX;
      lastClientY = e.clientY;
      moveGhost(e.clientX, e.clientY);
      placeSlot(computeDropIndex(e.clientY));
    });

    handle.addEventListener("pointerup", (e) => {
      if (dragFrom < 0) return;

      const from = dragFrom;
      let to = -1;

      if (moved) {
        placeSlot(computeDropIndex(e.clientY));
        to = dropIndex;
      }

      // freeze scroll so removing the slot doesn't jump the list
      const savedScroll = list.scrollTop;

      clearDrag();

      if (to >= 0 && to !== from && to !== from + 1) {
        let insertAt = to;
        if (from < to) insertAt = to - 1;
        reorderQueue(from, insertAt, true);
      } else {
        renderQueue();
      }

      // restore after DOM rebuild
      list.scrollTop = savedScroll;
      requestAnimationFrame(() => {
        list.scrollTop = savedScroll;
      });
    });

    handle.addEventListener("pointercancel", () => {
      clearDrag();
      renderQueue();
    });
  });
}

function autoScrollQueue(clientY) {
  const list = $("#queue-list");
  if (!list) return false;
  const rect = list.getBoundingClientRect();
  const edge = 48;
  const maxStep = 14;
  let delta = 0;

  if (clientY < rect.top + edge) {
    const t = 1 - (clientY - rect.top) / edge;
    delta = -Math.max(3, Math.round(maxStep * Math.min(1, Math.max(0, t))));
  } else if (clientY > rect.bottom - edge) {
    const t = 1 - (rect.bottom - clientY) / edge;
    delta = Math.max(3, Math.round(maxStep * Math.min(1, Math.max(0, t))));
  }

  if (!delta) return false;
  const before = list.scrollTop;
  list.scrollTop += delta;
  return list.scrollTop !== before;
}


function reorderQueue(from, to, flash = false) {
  if (from === to || from < 0 || to < 0) {
    renderQueue();
    return;
  }
  const list = $("#queue-list");
  const savedScroll = list ? list.scrollTop : 0;

  const item = state.queue.splice(from, 1)[0];
  state.queue.splice(to, 0, item);

  if (state.queueIndex === from) state.queueIndex = to;
  else if (from < state.queueIndex && to >= state.queueIndex) state.queueIndex--;
  else if (from > state.queueIndex && to <= state.queueIndex) state.queueIndex++;

  if (state.shuffle) {
    unshuffledQueue = cloneQueue(state.queue);
  }

  renderQueue();

  if (list) {
    list.scrollTop = savedScroll;
    requestAnimationFrame(() => {
      list.scrollTop = savedScroll;
    });
  }

  if (flash) {
    requestAnimationFrame(() => {
      const row = document.querySelector(
        `#queue-list .queue-item[data-index="${to}"]`
      );
      if (!row) return;
      row.classList.remove("drop-flash");
      void row.offsetWidth;
      row.classList.add("drop-flash");
      row.addEventListener(
        "animationend",
        () => row.classList.remove("drop-flash"),
        { once: true }
      );
    });
  }
}

function removeFromQueue(index) {
  if (index < 0 || index >= state.queue.length) return;

  const wasCurrent = index === state.queueIndex;
  state.queue.splice(index, 1);

  if (state.queue.length === 0) {
    resetPlayerToIdle();
    return;
  }

  if (wasCurrent) {
    state.queueIndex = Math.min(index, state.queue.length - 1);
    playCurrent();
  } else if (index < state.queueIndex) {
    state.queueIndex--;
  }

  // Keep saved order in sync while shuffled
  if (state.shuffle) {
    unshuffledQueue = cloneQueue(state.queue);
  }

  renderQueue();
}


function bindQueuePanel() {
  $("#btn-queue")?.addEventListener("click", () => {
    const panel = $("#queue-panel");
    const opening = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (opening) {
      renderQueue();
      requestAnimationFrame(() => {
        const current = $("#queue-list .queue-item.current");
        current?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  });

  $("#queue-close")?.addEventListener("click", () => {
    $("#queue-panel").classList.add("hidden");
  });

  $("#queue-clear")?.addEventListener("click", () => {
    if (!state.queue.length) return;
    openClearQueueConfirm();
  });
}

function openClearQueueConfirm() {
  const overlay = $("#confirm-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
}

function closeClearQueueConfirm() {
  const overlay = $("#confirm-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
}

function bindClearQueueConfirm() {
  const overlay = $("#confirm-overlay");
  if (!overlay || overlay.dataset.bound) return;
  overlay.dataset.bound = "1";

  $("#confirm-cancel")?.addEventListener("click", () => closeClearQueueConfirm());
  $("#confirm-ok")?.addEventListener("click", () => {
    closeClearQueueConfirm();
    state.queue = [];
    state.queueIndex = -1;
    unshuffledQueue = null;
    resetPlayerToIdle();
    renderQueue();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeClearQueueConfirm();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
      closeClearQueueConfirm();
    }
  });
}

function bindFullscreen() {
  $("#btn-fullscreen")?.addEventListener("click", () => toggleFullscreen());
  $("#btn-minimize")?.addEventListener("click", () => toggleFullscreen());
}

function setupGameTrackSearch() {
  const input = document.getElementById("game-track-search");
  if (!input) {
    console.warn("[Noma] #game-track-search missing");
    return;
  }

  // fresh node → no stacked handlers
  const clean = input.cloneNode(true);
  clean.value = "";
  input.replaceWith(clean);

  const emptyEl = document.getElementById("track-search-empty");
  if (emptyEl) emptyEl.classList.add("hidden");

  clean.addEventListener("input", () => {
    const q = clean.value.trim().toLowerCase();

    document.querySelectorAll("#track-list .track-row").forEach((row) => {
      const name =
        row.querySelector(".track-name")?.textContent?.toLowerCase() || "";
      const match = !q || name.includes(q);
      row.hidden = !match;
      row.classList.toggle("track-row-hidden", !match);
      if (!match) row.style.opacity = "1";
    });

    // empty state
    if (emptyEl) {
      if (!q) {
        emptyEl.classList.add("hidden");
      } else {
        const visible = document.querySelectorAll(
          "#track-list .track-row:not([hidden]):not(.track-row-hidden)"
        );
        emptyEl.classList.toggle("hidden", visible.length > 0);
      }
    }

    requestAnimationFrame(updateTrackFade);
  });
}

function bindGameHeaderToggle() {
  const btn = $("#game-header-toggle");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", () => {
  const sticky = document.querySelector(".game-sticky-top");
  const detail = $("#game-detail");
  const titleEl = $("#game-title");
  if (!sticky || !detail) return;

  const collapsed = sticky.classList.toggle("is-collapsed");
  detail.classList.toggle("header-collapsed", collapsed);
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");

  if (titleEl) {
    titleEl.textContent = collapsed
      ? (titleEl.dataset.short || titleEl.dataset.full || titleEl.textContent)
      : (titleEl.dataset.full || titleEl.textContent);
  }

  // keep center alignment during size tween, then settle
  sticky.classList.add("is-animating-header");
  window.clearTimeout(sticky._headerAnimTimer);
  sticky._headerAnimTimer = window.setTimeout(() => {
    sticky.classList.remove("is-animating-header");
  }, 450);

  const start = performance.now();
  const tick = () => {
    updateTrackFade();
    if (performance.now() - start < 480) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
}


function updateTrackFade() {
  const scroller = document.querySelector(".track-list-scroll");
  const stickyHeader = document.querySelector(".game-sticky-top");
  if (!scroller || !stickyHeader) return;

  const rows = scroller.querySelectorAll(
    ".track-row:not(.track-row-hidden):not([hidden])"
  );
  if (!rows.length) return;

  const bar = stickyHeader.querySelector(".game-sticky-bar");
  const headerBlock =
    stickyHeader.querySelector(".game-header") || stickyHeader;
  const barBottom = bar?.getBoundingClientRect().bottom ?? 0;
  const headerBottom = headerBlock.getBoundingClientRect().bottom;
  const clipLine = Math.max(barBottom, headerBottom);

  const GAP = 0;
  const FADE = 12;
  const HIDE = 1; // Safari subpixel: treat ≤1px under header as fully hidden

  if (scroller.scrollTop < 3) {
    for (const row of rows) {
      row.style.transition = "none";
      row.style.opacity = "1";
      row.style.pointerEvents = "auto";
    }
    return;
  }

  for (const row of rows) {
    const top = row.getBoundingClientRect().top;
    const dist = top - (clipLine + GAP);

    if (dist >= FADE) {
      row.style.transition = "none";
      row.style.opacity = "1";
      row.style.pointerEvents = "auto";
    } else if (dist <= HIDE) {
      row.style.transition = "none";
      row.style.opacity = "0";
      row.style.pointerEvents = "none";
    } else {
      row.style.transition = "none"; // no soft fade lag on Safari
      row.style.opacity = String(dist / FADE);
      row.style.pointerEvents = "auto";
    }
  }
}

function bindTrackSearch() {
  // change the selector if your input id/class is different
  const input =
    $("#track-search") ||
    $(".game-search") ||
    document.querySelector('input[type="search"]');

  if (!input) {
    console.warn("[Noma] search input not found");
    return;
  }

  input.value = "";
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    trackListEl.querySelectorAll(".track-row").forEach((row) => {
      const name =
        row.querySelector(".track-name")?.textContent?.toLowerCase() || "";
      const match = !q || name.includes(q);
      row.classList.toggle("track-row-hidden", !match);
      if (!match) row.style.opacity = "1";
    });
    requestAnimationFrame(updateTrackFade);
  };
}

function bindTrackListFade() {
  const scroller = document.querySelector(".track-list-scroll");
  if (!scroller) return;

  if (scroller.dataset.fadeBound === "1") {
    updateTrackFade();
    return;
  }
  scroller.dataset.fadeBound = "1";

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      updateTrackFade();
      // Safari: second frame after momentum/layout settles
      requestAnimationFrame(() => {
        updateTrackFade();
        ticking = false;
      });
    });
  };

  scroller.addEventListener("scroll", onScroll, { passive: true });
  // fires when finger/momentum stops (Safari 16.4+)
  scroller.addEventListener("scrollend", () => updateTrackFade(), { passive: true });
  window.addEventListener("resize", updateTrackFade, { passive: true });
  updateTrackFade();
}

let contextMenuAnchor = null;
let suppressDocClickUntil = 0;

function hideContextMenu() {
  contextMenu?.classList.add("hidden");
  contextMenuAnchor = null;
  contextTrack = null;
}

function showContextMenu(x, y, payload, anchorEl = null) {
  if (
    anchorEl &&
    contextMenuAnchor === anchorEl &&
    contextMenu &&
    !contextMenu.classList.contains("hidden")
  ) {
    hideContextMenu();
    return;
  }

  contextTrack = payload;
  contextMenuAnchor = anchorEl || null;

  // Header: cover + title + subtitle
  const isAlbum = !!payload?.album;
  const game = payload?.game;
  const track = payload?.track;
  const coverEl = $("#ctx-cover");
  const titleEl = $("#ctx-title");
  const subEl = $("#ctx-sub");
  if (coverEl) coverEl.src = game?.cover || PLACEHOLDER;
  if (isAlbum) {
    if (titleEl) titleEl.textContent = game?.short || game?.title || "";
    if (subEl) subEl.textContent = game?.composer || `${game?.tracks?.length || 0} Titel`;
  } else {
    if (titleEl) titleEl.textContent = track?.title || "";
    if (subEl) {
      subEl.textContent = [game?.short || game?.title, game?.composer]
        .filter(Boolean)
        .join(" · ");
    }
  }

  // Album-only action visibility
  contextMenu?.querySelectorAll(".ctx-album-only").forEach((btn) => {
    btn.classList.toggle("hidden", !isAlbum);
  });
  // For album menu, relabel the two shared actions
  const playNextBtn = contextMenu?.querySelector('[data-action="play-next"]');
  const addEndBtn = contextMenu?.querySelector('[data-action="add-end"]');
  if (playNextBtn) {
    playNextBtn.lastChild.textContent = isAlbum
      ? " Album als Nächstes"
      : " Als Nächstes spielen";
  }
  if (addEndBtn) {
    addEndBtn.lastChild.textContent = isAlbum
      ? " Album ans Ende"
      : " Ans Ende der Queue";
  }

  contextMenu.classList.remove("hidden");
  const menuW = contextMenu.offsetWidth || 260;
  const menuH = contextMenu.offsetHeight || 160;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - menuW - 8)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - menuH - 8)}px`;

  suppressDocClickUntil = performance.now() + 450;
}

function bindContextMenu() {
  contextMenu?.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!contextTrack) return;
      const { game, track, album } = contextTrack;
      const action = btn.dataset.action;

      if (album && game) {
        if (action === "play-next") addAlbumPlayNext(game);
        if (action === "add-end") addAlbumToEnd(game);
        if (action === "shuffle-into") shuffleAlbumIntoQueue(game);
      } else if (game && track) {
        if (action === "play-next") addPlayNext(game, track);
        if (action === "add-end") addToEnd(game, track);
      }
      hideContextMenu();
    });
  });

  document.addEventListener("click", (e) => {
    if (performance.now() < suppressDocClickUntil) return;
    if (e.target.closest("#context-menu")) return;
    if (e.target.closest(".track-actions")) return;
    if (e.target.closest(".track-actions") || e.target.closest("#album-menu-btn")) return;
    hideContextMenu();
  });

  const closeOnScroll = () => {
    if (contextMenu && !contextMenu.classList.contains("hidden")) {
      hideContextMenu();
    }
  };
  $("#queue-list")?.addEventListener("scroll", closeOnScroll, { passive: true });
  document
    .querySelector(".track-list-scroll")
    ?.addEventListener("scroll", closeOnScroll, { passive: true });
  document
    .querySelector(".content")
    ?.addEventListener("scroll", closeOnScroll, { passive: true });
  window.addEventListener("scroll", closeOnScroll, { passive: true, capture: true });
}

function bindPlayerChrome() {
  $("#btn-play")?.addEventListener("click", () => togglePlay());
  $("#btn-prev")?.addEventListener("click", prevTrack);
  $("#btn-next")?.addEventListener("click", nextTrack);
  $("#btn-loop")?.addEventListener("click", toggleLoop);
  $("#btn-shuffle")?.addEventListener("click", toggleShuffle);

  $("#fs-back")?.addEventListener("click", () => {
    if (!$("#fullscreen-player")?.classList.contains("hidden")) {
      toggleFullscreen();
    }
  });

  const bar = $("#progress-bar");
  if (!bar) return;

  function ratioFromClientX(clientX) {
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function currentDuration() {
    if (useMediaEl && mediaEl) {
      return mediaEl.duration || state.duration || 0;
    }
    return decodedBuffer?.duration || 0;
  }

  function paintSeek(ratio) {
    const duration = currentDuration();
    if (!duration) return 0;
    const seekTo = ratio * duration;
    $("#progress-fill").style.width = `${ratio * 100}%`;
    $("#time-current").textContent = formatTime(seekTo);
    return seekTo;
  }

  bar.addEventListener("pointerdown", (e) => {
    if (transitioning) return;
    if (!decodedBuffer && !(useMediaEl && mediaEl)) return;
    scrubbing = true;
    document.body.classList.add("is-scrubbing");
    try {
      bar.setPointerCapture(e.pointerId);
    } catch (_) {}
    paintSeek(ratioFromClientX(e.clientX));
    e.preventDefault();
  });

  window.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    paintSeek(ratioFromClientX(e.clientX));
  });

  window.addEventListener("pointerup", (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    document.body.classList.remove("is-scrubbing");

    if (typeof cancelTransition === "function") cancelTransition(true);
    lastLoopCycle = -1;

    const duration = currentDuration();
    if (!duration) return;

    const seekTo = paintSeek(ratioFromClientX(e.clientX));
    const safeEnd = Math.max(0, duration - 0.05);
    const pos = Math.min(seekTo, safeEnd);

    if (useMediaEl && mediaEl) {
      const cur = activeMedia() || mediaEl;
      cur.currentTime = pos;
      pauseOffset = pos;
      if (mediaA && mediaB) {
        const other = standbyMedia();
        if (other) {
          other.currentTime = mediaForceFullLoop ? 0 : mediaLoopStart;
          other.volume = 0;
        }
      }
      if (state.playing) {
        cur.play().catch(() => {});
        if (mediaA && mediaB) bindStreamProgress();
        else updateMediaProgress();
      }
      return;
    }

    if (!decodedBuffer) return;
    if (state.playing) {
      playBuffer(decodedBuffer, pos);
    } else {
      pauseOffset = pos;
    }
  });

  window.addEventListener("pointercancel", () => {
    scrubbing = false;
    document.body.classList.remove("is-scrubbing");
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let settingsReturn = null; // { type: "games"|"playlists"|"game", gameId? }

function openSettings() {
  // remember where we were
  if (!gameDetail.classList.contains("hidden") && state.currentGame) {
    settingsReturn = { type: "game", gameId: state.currentGame.id };
  } else if ($("#tab-playlists")?.classList.contains("active")) {
    settingsReturn = { type: "playlists" };
  } else {
    settingsReturn = { type: "games" };
  }

  // hide main panels, show settings
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  gameDetail.classList.add("hidden");
  gameDetail.classList.remove("active");
  $("#settings-view")?.classList.remove("hidden");
  document.body.classList.add("settings-open");

  syncSettingsForm();
}

function closeSettings() {
  $("#settings-view")?.classList.add("hidden");
  document.body.classList.remove("settings-open");

  if (settingsReturn?.type === "game" && settingsReturn.gameId) {
    openGame(settingsReturn.gameId);
  } else if (settingsReturn?.type === "playlists") {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-playlists")?.classList.add("active");
  } else {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-games")?.classList.add("active");
  }
  settingsReturn = null;
}

function bindSettings() {
  $("#btn-settings")?.addEventListener("click", openSettings);
  $("#settings-back")?.addEventListener("click", closeSettings);

  $("#setting-loop-times")?.addEventListener("change", (e) => {
    settings.loopTimes = clampInt(e.target.value, 1, 99, DEFAULT_SETTINGS.loopTimes);
    e.target.value = String(settings.loopTimes);
    saveSettings();
    if (state.loopMode === "count" && !state.playing) {
      state.loopsRemaining = settings.loopTimes;
      updatePlayerUI();
    }
  });

  $("#setting-loop-times")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^\d]/g, "").slice(0, 2);
  });

  const transWrap = $("#setting-transition-wrap");
  const transBtn = $("#setting-transition-btn");
  const transMenu = $("#setting-transition-menu");

  transBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!transWrap || !transMenu) return;
    const open = transWrap.classList.toggle("open");
    transMenu.classList.toggle("hidden", !open);
    transBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  transMenu?.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = Number(li.dataset.value);
      settings.transitionSec = [0, 5, 10].includes(v) ? v : DEFAULT_SETTINGS.transitionSec;
      saveSettings();
      syncSettingsForm();
      transWrap?.classList.remove("open");
      transMenu?.classList.add("hidden");
      transBtn?.setAttribute("aria-expanded", "false");
    });
  });

  document.addEventListener("click", (e) => {
    if (!transWrap) return;
    if (e.target.closest("#setting-transition-wrap")) return;
    transWrap.classList.remove("open");
    transMenu?.classList.add("hidden");
    transBtn?.setAttribute("aria-expanded", "false");
  });

$("#setting-queue-loop")?.addEventListener("change", (e) => {
    settings.queueLoop = !!e.target.checked;
    saveSettings();
  });

  $("#settings-reset")?.addEventListener("click", () => {
    const keepVolume = masterVolume;
    settings = {
      loopTimes: DEFAULT_SETTINGS.loopTimes,
      transitionSec: DEFAULT_SETTINGS.transitionSec,
      volume: keepVolume,
      queueLoop: DEFAULT_SETTINGS.queueLoop,
    };
    saveSettings();
    syncSettingsForm();
    if (state.loopMode === "count") {
      state.loopsRemaining = settings.loopTimes;
      updatePlayerUI();
    }
  });
}

function syncSettingsForm() {
  const loopInput = $("#setting-loop-times");
  if (loopInput) loopInput.value = String(settings.loopTimes);

  const qLoop = $("#setting-queue-loop");
  if (qLoop) qLoop.checked = !!settings.queueLoop;

  const label = $("#setting-transition-label");
  if (label) label.textContent = `${settings.transitionSec} s`;

  $("#setting-transition-menu")?.querySelectorAll("li").forEach((li) => {
    li.setAttribute(
      "aria-selected",
      li.dataset.value === String(settings.transitionSec) ? "true" : "false"
    );
  });
}

function formatDurationForJson(sec) {
  // keep a bit of precision, strip ugly float noise
  return Math.round(sec * 1000) / 1000;
}

function applyIpadStandaloneClass() {
  const isIPad =
    /iPad/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true; // older iOS

  document.documentElement.classList.toggle("ipad-standalone", isIPad && isStandalone);
}

// call it
applyIpadStandaloneClass();

async function runDurationScan() {
  if (!LIBRARY.length) {
    console.warn("[Noma DEV] LIBRARY is empty");
    return;
  }

  console.log("%c[Noma DEV] Scanning durations…", "color:#7c9cff;font-weight:bold");
  const lines = [];
  const byId = {};

  for (const game of LIBRARY) {
    for (const track of game.tracks || []) {
      const url = getTrackUrl(track);
      try {
        const sec = await getTrackDuration(url, {
          // force re-read from file, ignore existing duration
          ...track,
          duration: undefined,
        });
        if (sec == null || !Number.isFinite(sec)) {
          console.warn("[Noma DEV] failed:", track.id, url);
          continue;
        }
        const d = formatDurationForJson(sec);
        byId[track.id] = d;
        lines.push(`    "duration": ${d},  // ${track.id} — ${track.title}`);
        console.log(`${track.id}: ${d}s`);
      } catch (err) {
        console.warn("[Noma DEV] error:", track.id, err);
      }
    }
  }

  console.log("%c[Noma DEV] Paste helpers", "color:#7c9cff;font-weight:bold");
  console.log("— One line per track (search id in games.json and add duration):");
  console.log(lines.join("\n"));

  console.log("— Map by id:");
  console.log(JSON.stringify(byId, null, 2));

  console.log("— Full tracks with duration merged (copy into games.json tracks arrays carefully):");
  const merged = LIBRARY.map((g) => ({
    ...g,
    tracks: (g.tracks || []).map((t) => ({
      ...t,
      duration: byId[t.id] ?? t.duration,
    })),
  }));
  console.log(JSON.stringify(merged, null, 2));

  console.log("%c[Noma DEV] Done.", "color:#7c9cff;font-weight:bold");
}

function mountDurationDevTool() {
  if (!DEV_DURATION_TOOL) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "dev-duration-scan";
  btn.textContent = "DEV: Scan durations";
  btn.title = "Logs JSON-ready durations to the console";
  Object.assign(btn.style, {
    position: "fixed",
    right: "12px",
    bottom: "110px",
    zIndex: "9999",
    padding: "10px 12px",
    borderRadius: "10px",
    border: "1px solid rgba(124,156,255,0.5)",
    background: "rgba(20,20,24,0.95)",
    color: "#7c9cff",
    font: "600 12px system-ui,sans-serif",
    cursor: "pointer",
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Scanning…";
    try {
      await runDurationScan();
      btn.textContent = "Done — see console";
    } catch (e) {
      console.error(e);
      btn.textContent = "Error — see console";
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "DEV: Scan durations";
    }, 2000);
  });
  document.body.appendChild(btn);
}

function formatSleepCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function remainingTrackSec() {
  if (transitioning && audioCtx) {
    const sec = getTransitionSec();
    return Math.max(0, sec - (audioCtx.currentTime - transitionStartedAt));
  }
  const dur =
    state.duration ||
    decodedBuffer?.duration ||
    (mediaEl && mediaEl.duration) ||
    0;
  const pos = getPlaybackPosition();
  return Math.max(0, dur - pos);
}

/** Ms until playback of this song fully ends (incl. soft-end transition). */
function estimateMsUntilSongEnd() {
  if (transitioning && audioCtx) {
    const sec = getTransitionSec();
    const left = Math.max(0, sec - (audioCtx.currentTime - transitionStartedAt));
    return left * 1000;
  }

  const dur =
    state.duration ||
    decodedBuffer?.duration ||
    (mediaEl && mediaEl.duration) ||
    0;
  const pos = getPlaybackPosition();
  let rem = Math.max(0, dur - pos);

  // Soft-end: after first full playthrough, fade still runs before next track
  const loopStart = typeof getLoopStartSec === "function" ? getLoopStartSec() : 0;
  const willSoftEnd =
    !useMediaEl &&
    (state.loopMode === "off" || state.loopMode === "count") &&
    (loopStart > 0 || forceFullLoop) &&
    lastLoopCycle < 0 &&
    !transitioning;

  if (willSoftEnd) {
    rem += Math.max(0, getTransitionSec());
  }

  return rem * 1000;
}

function updateSleepEndLabel() {
  const el = $("#sleep-end-label");
  if (!el) return;
  if (state.queueIndex < 0) {
    el.textContent = "";
    return;
  }
  const ms = estimateMsUntilSongEnd();
  el.textContent = `(${formatTime(ms / 1000)})`;
}

function positionSleepPanel() {
  const panel = $("#sleep-panel");
  const btn = $("#btn-sleep");
  if (!panel || !btn || panel.classList.contains("hidden")) return;

  // ensure panel is not trapped inside .app stacking context
  if (panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }

  const r = btn.getBoundingClientRect();
  const pad = 8;
  const pw = panel.offsetWidth || 260;
  const ph = panel.offsetHeight || 200;

  let left = r.right - pw;
  let top = r.bottom + pad;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  if (top + ph > window.innerHeight - 8) {
    top = Math.max(8, r.top - ph - pad);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function updateSleepUI() {
  const panel = $("#sleep-panel");
  const active = $("#sleep-active");
  const btn = $("#btn-sleep");
  const cd = $("#sleep-countdown");
  const on = !!sleepMode;

  btn?.classList.toggle("active", on);
  btn?.classList.toggle("hidden", on);
  active?.classList.toggle("hidden", !on);

  if (!on) {
    // still refresh end label if menu open
    if (panel && !panel.classList.contains("hidden")) {
      updateSleepEndLabel();
      positionSleepPanel();
    }
    return;
  }

if (sleepMode === "end") {
    if (cd) cd.textContent = formatTime(estimateMsUntilSongEnd() / 1000);
  } else if (cd) {
    cd.textContent = formatSleepCountdown(sleepEndsAt - Date.now());
  }
}


function clearSleepTick() {
  if (sleepTickId) {
    clearInterval(sleepTickId);
    sleepTickId = null;
  }
}

function cancelSleepTimer() {
  clearSleepTick();
  sleepMode = null;
  sleepEndsAt = 0;
  updateSleepUI();
}

function fireSleepTimer() {
  cancelSleepTimer();
  // Stop playback / clear player
  try {
    if (state.playing) {
      // force stop without toggling resume path oddly
      stopSource();
      state.playing = false;
      document.body.classList.remove("is-playing");
    }
    resetPlayerToIdle();
  } catch (_) {}

  // Try close (usually blocked for normal tabs / installed PWAs)
  try {
    window.close();
  } catch (_) {}
}

function startSleepTick() {
  clearSleepTick();
  sleepTickId = setInterval(() => {
    if (!sleepMode) {
      clearSleepTick();
      return;
    }
    if (sleepMode === "duration") {
      const left = sleepEndsAt - Date.now();
      if (left <= 0) {
        fireSleepTimer();
        return;
      }
    } else if (sleepMode === "end") {
      // handled on natural track end + remaining display
      if (!state.playing && state.queueIndex < 0) {
        fireSleepTimer();
        return;
      }
    }
    updateSleepUI();
  }, 250);
  updateSleepUI();
}

function startSleepDuration(minutes) {
  const ms = Math.max(0.1, Number(minutes)) * 60 * 1000;
  sleepMode = "duration";
  sleepEndsAt = Date.now() + ms;
  $("#sleep-panel")?.classList.add("hidden");
  $("#btn-sleep")?.setAttribute("aria-expanded", "false");
  startSleepTick();
}

function startSleepEndOfSong() {
  if (state.queueIndex < 0) {
    alert("Kein Song läuft.");
    return;
  }
  // Stay in "end" mode — fire only when this song actually ends (no early next track)
  sleepMode = "end";
  sleepEndsAt = 0;
  $("#sleep-panel")?.classList.add("hidden");
  $("#btn-sleep")?.setAttribute("aria-expanded", "false");
  startSleepTick();
}

function addSleepMinutes(mins) {
  if (sleepMode === "end") {
    // convert to duration from remaining + extra
    const remMs = remainingTrackSec() * 1000;
    sleepMode = "duration";
    sleepEndsAt = Date.now() + remMs + mins * 60 * 1000;
  } else if (sleepMode === "duration") {
    sleepEndsAt += mins * 60 * 1000;
  } else {
    return;
  }
  updateSleepUI();
}

function bindSleepTimer() {
  const btn = $("#btn-sleep");
  const panel = $("#sleep-panel");

  // hoist panel under body once
  if (panel && panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }

  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (sleepMode) return;
    const opening = panel?.classList.contains("hidden");
    if (opening) {
      updateSleepEndLabel();
      panel.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => {
        positionSleepPanel();
        updateSleepEndLabel();
      });
      // live-sync remaining while menu is open
      if (!sleepTickId) {
        sleepTickId = setInterval(() => {
          if (!panel.classList.contains("hidden") && !sleepMode) {
            updateSleepEndLabel();
          }
        }, 250);
      }
    } else {
      panel.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  panel?.addEventListener("click", (e) => e.stopPropagation());
  panel?.addEventListener("pointerdown", (e) => e.stopPropagation());

  panel?.querySelectorAll("[data-sleep-min]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      startSleepDuration(Number(b.dataset.sleepMin));
    });
  });

  panel?.querySelector('[data-sleep="end"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    startSleepEndOfSong();
  });

  const customInput = $("#sleep-custom-input");
  const customGo = $("#sleep-custom-go");

  function submitCustom() {
    const raw = customInput?.value ?? "";
    const n = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) {
      customInput?.focus();
      return;
    }
    startSleepDuration(n);
    if (customInput) customInput.value = "";
  }

  customGo?.addEventListener("click", (e) => {
    e.stopPropagation();
    submitCustom();
  });
  customInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submitCustom();
    }
  });
  customInput?.addEventListener("click", (e) => e.stopPropagation());

  $("#sleep-add5")?.addEventListener("click", (e) => {
    e.stopPropagation();
    addSleepMinutes(5);
  });
  $("#sleep-cancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    cancelSleepTimer();
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".sleep-wrap") || e.target.closest("#sleep-panel")) return;
    panel?.classList.add("hidden");
    btn?.setAttribute("aria-expanded", "false");
  });

  window.addEventListener("resize", () => positionSleepPanel(), { passive: true });
}

init();