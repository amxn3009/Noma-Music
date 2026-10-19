import { Bfstm } from './bfstm.js';
import { Kawarp } from 'https://cdn.jsdelivr.net/npm/@kawarp/core@1.3.1/+esm';

/** Bump this every time you deploy so Settings shows you’re on the build you think. */
const APP_VERSION = "19.10.26, fixed loop menu, Added ctxt menu Toasts, enhanced queue UX, and polished nav. #2";

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
  loopStepPlus: 1,    // 1-20 — loops added by loop menu "+"
  loopStepMinus: 1,   // 1-20 — loops removed by loop menu "−"
  transitionSec: 10,   // 0 | 5 | 10
  volume: 0.5,          // 0-1
  normalizeVolume: true, // quieter tracks boosted toward same level
  queueLoop: true,      // after last track: restart queue vs stop
  bgMode: "kawarp", // "kawarp" | "css" — switch later in settings
  autoCollapseAlbum: true, // collapse album header when scrolling down
};

const CONSOLE_META = {
  switch2: {
    id: "switch2",
    label: "Nintendo Switch 2",
    logo: "Assets/Filter/Console/Nintendo_Switch2_Logo.png",
  },
  ps5: {
    id: "ps5",
    label: "PlayStation 5",
    logo: "Assets/Filter/Console/PS5_Logo.png",
  },
  switch: {
    id: "switch",
    label: "Nintendo Switch",
    logo: "Assets/Filter/Console/Nintendo_Switch_Logo.png",
  },
  wiiu: {
    id: "wiiu",
    label: "Wii U",
    logo: "Assets/Filter/Console/WiiU_Logo.webp",
  },
  wii: {
    id: "wii",
    label: "Wii",
    logo: "Assets/Filter/Console/Wii_Logo.png",
  },
  gamecube: {
    id: "gamecube",
    label: "GameCube",
    logo: "Assets/Filter/Console/GameCube_Logo.png",
  },
  n64: {
    id: "n64",
    label: "Nintendo 64",
    logo: "Assets/Filter/Console/Nintendo64_Logo.webp",
  },
};

const FRANCHISE_META = {
    mario: {
    id: "mario",
    label: "Super Mario",
    logo: "Assets/Filter/Franchise/SuperMario_Logo.png",
  },
  zelda: {
    id: "zelda",
    label: "The Legend of Zelda",
    logo: "Assets/Filter/Franchise/Zelda_Logo.webp",
  },
};

let gamesViewMode = "console"; // "console" | "franchise"
let gamesNavLocked = false;
const albumViewMemory = new Map(); // gameId -> { scrollTop, query }
let searchReturn = null; // { type: "games"|"game"|"playlists"|"category", ... }
let globalSearchOpen = false;
let gamesLocalQuery = "";

const gsPrefs = {
  hideGames: false,
  filter: "all", // all | game | franchise | console | composer
  sort: "relevance", // relevance | az | length | year
  dir: "desc", // desc default
};

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    settings.loopTimes = clampInt(parsed.loopTimes, 1, 99, 2);
    settings.loopStepPlus = clampInt(parsed.loopStepPlus, 1, 20, DEFAULT_SETTINGS.loopStepPlus);
    settings.loopStepMinus = clampInt(parsed.loopStepMinus, 1, 20, DEFAULT_SETTINGS.loopStepMinus);
    settings.transitionSec = [0, 5, 10].includes(parsed.transitionSec)
      ? parsed.transitionSec
      : 10;
    const vol = Number(parsed.volume);
    settings.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 0.5;
    settings.queueLoop =
      typeof parsed.queueLoop === "boolean"
        ? parsed.queueLoop
        : DEFAULT_SETTINGS.queueLoop;
    settings.normalizeVolume =
      typeof parsed.normalizeVolume === "boolean"
        ? parsed.normalizeVolume
        : DEFAULT_SETTINGS.normalizeVolume;
    settings.bgMode =
      parsed.bgMode === "css" || parsed.bgMode === "kawarp"
        ? parsed.bgMode
        : DEFAULT_SETTINGS.bgMode;
    settings.autoCollapseAlbum =
      typeof parsed.autoCollapseAlbum === "boolean"
        ? parsed.autoCollapseAlbum
        : DEFAULT_SETTINGS.autoCollapseAlbum;
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function withGamesNavLock(fn, ms = 420) {
  if (gamesNavLocked) return;
  gamesNavLocked = true;
  try {
    fn();
  } finally {
    setTimeout(() => {
      gamesNavLocked = false;
    }, ms);
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getTransitionSec() {
  return settings.transitionSec;
}

function isMobileLike() {
  return isIOS() || /Android/i.test(navigator.userAgent || "") ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 900);
}

const RESTART_THRESHOLD = 10; // seconds
// iOS 27 is picky about short gain ramps → audible clicks on start
const CLICK_RAMP = isIOS() || isMobileLike?.() ? 0.09 : 0.04;

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

// Fullscreen queue: true = prefer expanded in FS; false = prefer small floating
let fsQueuePreferOpen = true;
let queuePanelCloseTimer = null;
let queueOpenOutsideFs = false; // was floating open when entering FS?

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

/**
 * HTMLAudio silent anchor for iOS Media Session (lock screen play/pause).
 * Pure Web Audio alone does NOT drive session controls on iOS.
 * Uses a generated silent WAV (zeros) — not silence.m4a (that file’s loop seams clicked).
 */
let silentShieldEl = null;
let bgSessionKeepAliveId = null;

/** 1s pure-zero WAV as blob: URL — valid for iOS Media Session, no m4a loop clicks, cheap to build once. */
let _silentWavUrl = null;
function silentWavUri() {
  if (_silentWavUrl) return _silentWavUrl;
  const sampleRate = 44100;
  const numSamples = sampleRate; // 1 second of zeros
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, dataSize, true);
  // PCM samples left as 0
  _silentWavUrl = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  return _silentWavUrl;
}

function getSilentShieldEl() {
  if (!silentShieldEl) {
    silentShieldEl = new Audio();
    silentShieldEl.preload = "auto";
    silentShieldEl.loop = true;
    silentShieldEl.volume = 0.001;
    silentShieldEl.setAttribute("playsinline", "");
    silentShieldEl.setAttribute("webkit-playsinline", "");
  }
  return silentShieldEl;
}

async function startSilentShield() {
  if (!isIOS()) return;
  ensurePlaybackAudioSession();
  const el = getSilentShieldEl();
  try {
    const url = silentWavUri();
    if (el.src !== url) {
      el.src = url;
      el.loop = true;
    }
    el.volume = 0.001;
    if (el.paused) await el.play();
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
      startSilentShield();
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
    stopSilentShield();
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
  fsQueuePreferOpen = false;
  setFsQueueOpen(false);
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
const DECODE_CACHE_MAX = isIOS() ? 6 : 10;
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
  // JSON / local duration always wins and overwrites cache
  const fromJson = track != null ? Number(track.duration) : NaN;
  if (Number.isFinite(fromJson) && fromJson > 0) {
    if (url) durationCache.set(url, fromJson);
    return fromJson;
  }
  if (url && durationCache.has(url)) return durationCache.get(url);

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
    currentGain.gain.setValueAtTime(effectiveVolume(), now);
    if (fadeSec <= 0) {
      currentGain.gain.setValueAtTime(0, softEndFadeAt);
    } else {
      currentGain.gain.setValueAtTime(effectiveVolume(), softEndFadeAt);
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

/** Bottom player: short on mobile only. Fullscreen: fullscreenName → title → short. */
function gameNameForPlayer(game) {
  if (!game) return "";
  const mobile =
    window.matchMedia("(max-width: 720px), (hover: none) and (pointer: coarse)").matches;
  if (mobile) return game.short || game.title || "";
  return game.title || game.short || "";
}

function gameNameForFullscreen(game) {
  if (!game) return "";
  return game.fullscreenName || game.title || game.short || "";
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
   setTrackGainForPlay(track, null);
  // then mediaEl.volume = effectiveVolume();
    mediaEl.volume = effectiveVolume();
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
    next.volume = effectiveVolume();
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
  setTrackGainForPlay(track, null);
  mediaA.volume = effectiveVolume();
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
  setTrackGainForPlay(
    state.queue[state.queueIndex]?.track,
    audioBuffer
  );

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
  const vol = effectiveVolume();

  // Smooth open only — do NOT cancelScheduledValues mid-ramp later (iOS 27 clicks)
  currentGain.gain.cancelScheduledValues(now);
  currentGain.gain.setValueAtTime(0, now);
  currentGain.gain.linearRampToValueAtTime(vol, now + CLICK_RAMP);

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

  // iOS 27 can fire onended immediately after a bad start → rapid track skipping
  const sourceGen = playGen;
  const startedWall = performance.now();
  currentSource.onended = () => {
    if (!state.playing || transitioning) return;
    if (sourceGen !== playGen) return;
    if (performance.now() - startedWall < 500) return;
    nextTrack(true);
  };

  pauseOffset = offset;
  startTime = ctx.currentTime;
  currentSource.start(0, offset);

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
      Math.max(0.05, duration - offset) + loopsAfterFirst * loopLen;

    softEndFadeAt = startTime + timeToFadeStart;
    softEndFadeSec = fadeSec;

    // Schedule only the future outro — leave fade-in alone
    if (fadeSec <= 0) {
      currentGain.gain.setValueAtTime(0, softEndFadeAt);
    } else {
      currentGain.gain.setValueAtTime(vol, softEndFadeAt);
      currentGain.gain.linearRampToValueAtTime(0, softEndFadeAt + fadeSec);
    }

    softEndStartTimer = setTimeout(() => {
      softEndStartTimer = null;
      if (!state.playing || !currentGain) return;
      if (sourceGen !== playGen) return;
      transitioning = true;
      transitionStartedAt = softEndFadeAt;
      document.body.classList.add("is-transitioning");
      lastLoopCycle = Math.max(0, lastLoopCycle);
      updateProgressUI();
    }, timeToFadeStart * 1000);

    softEndTimer = setTimeout(() => {
      softEndTimer = null;
      if (!state.playing) return;
      if (sourceGen !== playGen) return;
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
      currentGain.gain.setValueAtTime(effectiveVolume(), now);
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

const VOLUME_RAMP = 0.05; // ~40ms — soft step, no click

function setVolume(value) {
  masterVolume = Math.min(1, Math.max(0, value));

  const slider = $("#volume-slider");
  if (slider && Number(slider.value) !== masterVolume) {
    slider.value = masterVolume;
  }

  const wrap = $("#volume-wrap");
  const muted = masterVolume <= 0.001;
  wrap?.classList.toggle("is-muted", muted);

  const level = effectiveVolume();
  settings.volume = masterVolume;
  saveSettings();

  // HTMLAudio: short stepped ramp (can't use AudioParam)
  const rampMedia = (el, target) => {
    if (!el) return;
    const from = Number(el.volume) || 0;
    if (Math.abs(from - target) < 0.001) {
      el.volume = target;
      return;
    }
    const steps = 6;
    let i = 0;
    const tick = () => {
      i++;
      el.volume = from + (target - from) * (i / steps);
      if (i < steps) requestAnimationFrame(tick);
      else el.volume = target;
    };
    requestAnimationFrame(tick);
  };

  if (mediaA) rampMedia(mediaA, mediaActive === "A" ? level : 0);
  if (mediaB) rampMedia(mediaB, mediaActive === "B" ? level : 0);
  if (mediaEl && !mediaA) rampMedia(mediaEl, level);

  if (!currentGain || !audioCtx) return;

  const now = audioCtx.currentTime;
  const g = currentGain.gain;

  if (transitioning) {
    const elapsed = Math.max(0, now - transitionStartedAt);
    const progress = Math.min(1, elapsed / getTransitionSec());
    const remaining = Math.max(0.05, getTransitionSec() - elapsed);
    const levelNow = level * (1 - progress);

    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(levelNow, now + VOLUME_RAMP);
    g.linearRampToValueAtTime(0, now + remaining);
  } else {
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(level, now + VOLUME_RAMP);

    // Re-arm soft-end after the volume ramp
    if (
      state.playing &&
      softEndFadeAt > now + VOLUME_RAMP &&
      softEndFadeSec >= 0 &&
      !bufferCtxSuspended
    ) {
      if (softEndFadeSec <= 0) {
        g.setValueAtTime(0, softEndFadeAt);
      } else {
        g.setValueAtTime(level, softEndFadeAt);
        g.linearRampToValueAtTime(0, softEndFadeAt + softEndFadeSec);
      }
    }
  }
}

let trackGain = 1; // per-track multiplier (peak normalize or JSON)

function effectiveVolume() {
  return Math.min(1, Math.max(0, masterVolume * trackGain));
}

/** Peak-based gain so quieter songs sit near the same level (buffer path). */
function computePeakGain(audioBuffer) {
  if (!audioBuffer) return 1;
  let peak = 0;
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  if (!(peak > 0.001)) return 1;
  // target ~0.9 peak; never boost above 4×
  return Math.min(4, 0.9 / peak);
}

function setTrackGainForPlay(track, audioBuffer) {
  if (!settings.normalizeVolume) {
    trackGain = 1;
    return;
  }
  // Optional per-track override in games.json: "volume": 0.5–2
  const jsonVol = Number(track?.volume);
  if (Number.isFinite(jsonVol) && jsonVol > 0) {
    trackGain = Math.min(4, Math.max(0.05, jsonVol));
    return;
  }
  if (audioBuffer) {
    trackGain = computePeakGain(audioBuffer);
    return;
  }
  trackGain = 1;
}

function bindVolume() {
  const wrap = $("#volume-wrap");
  const slider = $("#volume-slider");
  if (!wrap || !slider) return;

  slider.value = masterVolume;

  slider.addEventListener("input", () => {
    setVolume(Number(slider.value));
  });

  function onVolumeWheel(e) {
    // only vertical scroll — don’t fight horizontal trackpads
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    e.preventDefault();
    const step = e.deltaMode === 1 ? 0.08 : 0.05; // line vs pixel
    const delta = e.deltaY > 0 ? -step : step;
    setVolume(masterVolume + delta);
    showVolumeSlider();
  }

  wrap.addEventListener("wheel", onVolumeWheel, { passive: false });

  // Bottom player: cover + title + game
  document
    .querySelector(".player-left")
    ?.addEventListener("wheel", onVolumeWheel, { passive: false });

  // Fullscreen: cover + song + game name
  ["#fs-cover", "#fs-title", "#fs-game"].forEach((sel) => {
    $(sel)?.addEventListener("wheel", onVolumeWheel, { passive: false });
  });
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
      case "ShiftLeft":
      case "ShiftRight":
        e.preventDefault();
        if (document.body.classList.contains("fs-open")) {
          // same as FS queue arrow: expand ↔ small floating
          toggleFsQueueMode();
        } else {
          toggleGameHeaderCollapse();
        }
        handled = true;
        break;
      case "Escape":
        e.preventDefault();
        // Settings wins over search / category / game back
        if (!$("#settings-view")?.classList.contains("hidden")) {
          closeSettings();
          handled = true;
          break;
        }
        if (globalSearchOpen) {
          closeGlobalSearch();
          handled = true;
          break;
        }
        if (document.body.classList.contains("games-cat-open")) {
          closeCategoryFullscreen();
          handled = true;
          break;
        }
        if (!$("#fullscreen-player")?.classList.contains("hidden")) {
          toggleFullscreen();
          handled = true;
          break;
        }
        if (state.currentGame && gameDetail.classList.contains("active")) {
          $("#back-to-games")?.click();
          handled = true;
          break;
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
  closeSleepPanel();
  if (typeof hideContextMenu === "function") hideContextMenu();
  if (typeof closeLoopMenu === "function") closeLoopMenu();

  const fs = $("#fullscreen-player");
  const btnFs = $("#btn-fullscreen");
  const btnMin = $("#btn-minimize");
  if (!fs) return;

  const open = fs.classList.contains("hidden");
  if (open) {
    if (!$("#settings-view")?.classList.contains("hidden")) {
      closeSettings();
    }

    const item = state.queue[state.queueIndex];
    const game = item ? LIBRARY.find((g) => g.id === item.gameId) : null;
    const track = item?.track;

    const nowTitle =
      track?.title || $("#now-title")?.textContent?.trim() || "Nichts läuft";
    const nowGame = game
      ? gameNameForFullscreen(game)
      : $("#now-game")?.textContent?.trim() || "Keinen Song ausgewählt";
    const nowCover = $("#now-cover")?.getAttribute("src") || PLACEHOLDER;

    const fsTitle = $("#fs-title");
    const fsGame = $("#fs-game");
    const fsCover = $("#fs-cover");
    if (fsTitle) fsTitle.textContent = nowTitle;
    if (fsGame) fsGame.textContent = nowGame;
    if (fsCover) fsCover.src = nowCover;

    // Snapshot: was the normal queue open outside FS?
    queueOpenOutsideFs = isQueuePanelOpen();

    fs.classList.remove("hidden", "is-closing");
    document.body.classList.add("fs-open");
    document.body.classList.remove("fs-leaving", "fs-closing-layout");

    // Only auto-open a queue in FS if it was open in the player bar
    if (queueOpenOutsideFs && state.queue.length > 0 && state.queueIndex >= 0) {
      if (fsQueuePreferOpen) {
        // Expanded: hide floating without re-anim, show expanded
        closeQueuePanel({ animate: false });
        setFsQueueOpen(true);
      } else {
        // Prefer small: floating already open in same place → no open animation
        setFsQueueOpen(false);
        // leave panel as-is (already open)
      }
    } else {
      // Was closed outside → stay closed in FS
      setFsQueueOpen(false);
      closeQueuePanel({ animate: false });
    }

    btnFs?.classList.add("hidden");
    btnMin?.classList.remove("hidden");
  } else {
    if (fs.classList.contains("is-closing")) return;

    const hadExpanded = isFsExpandedOpen();
    const hadFloating = isQueuePanelOpen();
    const anyQueueOpen = hadExpanded || hadFloating;

    // Remember mode for next FS open
    if (hadExpanded) fsQueuePreferOpen = true;
    else if (hadFloating) fsQueuePreferOpen = false;

    fs.classList.add("is-closing");

    // Freeze expanded layout so stage doesn't slide to center mid-exit
    if (hadExpanded) {
      document.body.classList.add("fs-closing-layout");
    }
    document.body.classList.remove("fs-queue-open");
    document.body.classList.remove("fs-open");
    document.body.classList.add("fs-leaving");

    const fsQ = $("#fs-queue");
    if (fsQ) fsQ.setAttribute("aria-hidden", "true");

    // Outside FS: expanded doesn't exist — open normal floating if any was open
    closeQueuePanel({ animate: false });

    btnMin?.classList.add("hidden");
    btnFs?.classList.remove("hidden");

    // Open floating immediately (no delay) if any queue was open in FS
    if (anyQueueOpen && state.queue.length > 0) {
      openQueuePanel();
    }

    setTimeout(() => {
      fs.classList.add("hidden");
      fs.classList.remove("is-closing");
      document.body.classList.remove("fs-leaving", "fs-closing-layout");
    }, 340);
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

  // If queue panel is open, keep the playing row in view after reorder
  const panel = $("#queue-panel");
  if (panel && !panel.classList.contains("hidden")) {
    requestAnimationFrame(() => {
      const current = $("#queue-list .queue-item.current");
      current?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  if (document.body.classList.contains("fs-queue-open")) {
    requestAnimationFrame(() => {
      $("#fs-queue-list .queue-item.current")?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
  }
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
  // Native BFSTM rate — Web Audio resamples; manual 48k resample was the slowdown
  const audioBuffer = ctx.createBuffer(
    meta.numberChannels,
    meta.totalSamples,
    meta.sampleRate
  );

  const scale = 0.98 / 32768;
  for (let c = 0; c < meta.numberChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    const src = channels[c];
    const n = src.length;
    // tight loop — avoids repeated / 32768
    for (let i = 0; i < n; i++) {
      channelData[i] = src[i] * scale;
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

let prefetchTimer = null;
let prefetchRunning = false;

/** Only warm the *next* track, deferred, one at a time — aggressive prefetch was jamming iPad. */
function prefetchNearbyBfstm() {
  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
  }
  // Wait until current song is decoding/playing so we don't fight the main load
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    void runPrefetchNext();
  }, 1200);
}

async function runPrefetchNext() {
  if (prefetchRunning) return;
  const i = state.queueIndex + 1;
  if (i < 0 || i >= state.queue.length) return;
  const t = state.queue[i]?.track;
  const url = t?.url || t?.file || t?.src;
  if (!url || isWebAudioFile(url)) return;
  if (decodeCacheGet(url)?.audioBuffer) return;

  prefetchRunning = true;
  try {
    await decodeBfstm(url);
  } catch (_) {
    /* ignore */
  } finally {
    prefetchRunning = false;
  }
}

// ─── App UI ────────────────────────────────────────────────────

async function init() {
  try {
      const res = await fetch(`/Assets/games.json?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(res.status);
    LIBRARY = await res.json();
  } catch (err) {
    console.error("[Noma] Failed to load games.json:", err);
    LIBRARY = [];
  }
  renderGames();
  bindGamesViewToggle();
  bindGlobalSearchUI();
  bindGamesLocalSearch();
  bindTabs();
  bindPlayerChrome();
  bindMediaSession();
  bindQueuePanel();
  bindClearQueueConfirm();
  bindFullscreen();
  bindContextMenu();
  bindLoopMenu();
  bindGameHeaderToggle();
  bindVolume();
  bindHotkeys();
  bindPressMinHold();
  loadSettings();
  updatePlayerUI();
  masterVolume = settings.volume ?? 1;
  const volSlider = $("#volume-slider");
  if (volSlider) volSlider.value = String(masterVolume);
  $("#volume-wrap")?.classList.toggle("is-muted", masterVolume <= 0.001);
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
      if (state.queueIndex < 0) {
        clearMediaSessionHard(); // nothing loaded: wipe the lock screen entry
      } else {
        bindMediaSession(); // paused with a song loaded: keys must still resume it
        updateMediaSession();
      }
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

function gameCardHtml(g) {
  const n = g.tracks?.length || 0;
  return `
    <article class="game-card" data-id="${escapeHtml(g.id)}">
      <div class="game-card-art">
        <img src="${escapeHtml(g.cover)}" alt="${escapeHtml(g.title)}" loading="lazy" draggable="false">
        <span class="game-card-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
      <div class="card-body">
        <h3>${escapeHtml(g.short || g.title)}</h3>
        <p class="game-card-meta">${n} Titel${g.composer ? ` · ${escapeHtml(g.composer)}` : ""}</p>
      </div>
    </article>
  `;
}

function groupGamesBy(mode) {
  const metaMap = mode === "franchise" ? FRANCHISE_META : CONSOLE_META;
  const field = mode === "franchise" ? "franchise" : "console";
  const buckets = new Map();

  for (const g of LIBRARY) {
    const key = (g[field] || "").toLowerCase();
    if (!key || !metaMap[key]) continue; // skip unknown / missing
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(g);
  }

  // stable order = order of keys in meta maps
  const rows = [];
  for (const key of Object.keys(metaMap)) {
    const games = buckets.get(key);
    if (!games || !games.length) continue; // empty category → hide
    rows.push({ key, meta: metaMap[key], games });
  }
  return rows;
}

function animateGamesRowsEnter(browse) {
  if (!browse) return;
  const rows = browse.querySelectorAll(".games-row");
  rows.forEach((row, i) => {
    row.classList.remove("is-entering", "is-leaving");
    row.style.animationDelay = `${i * 40}ms`;
    void row.offsetWidth;
    row.classList.add("is-entering");
    const clear = () => {
      row.classList.remove("is-entering");
      row.style.animationDelay = "";
    };
    row.addEventListener("animationend", clear, { once: true });
    setTimeout(clear, 450 + i * 40);
  });
}

function fadeOutGamesBrowse(browse, then) {
  if (!browse) {
    then?.();
    return;
  }
  const rows = [...browse.querySelectorAll(".games-row, .games-cat-inline")];
  if (!rows.length) {
    then?.();
    return;
  }
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    then?.();
  };
  rows.forEach((el) => el.classList.add("is-leaving"));
  rows[0].addEventListener("animationend", done, { once: true });
  setTimeout(done, 240);
}

function bindGameCardInteractions(root) {
  if (!root) return;
  root.querySelectorAll(".game-card").forEach((card) => {
    if (card.dataset.ctxBound === "1") return;
    card.dataset.ctxBound = "1";

    card.addEventListener("click", (e) => {
      if (card.dataset.suppressClick === "1") {
        delete card.dataset.suppressClick;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (
        typeof suppressNextClickUntil === "number" &&
        performance.now() < suppressNextClickUntil
      ) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      openGame(card.dataset.id);
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const game = LIBRARY.find((g) => g.id === card.dataset.id);
      if (!game) return;
      showContextMenu(e.clientX, e.clientY, { game, album: true });
    });

    let lpTimer = null;
    let lpMoved = false;
    card.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "mouse") return;
        lpMoved = false;
        const x = e.clientX;
        const y = e.clientY;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (lpMoved) return;
          const game = LIBRARY.find((g) => g.id === card.dataset.id);
          if (!game) return;
          card.dataset.suppressClick = "1";
          if (typeof armClickSuppress === "function") armClickSuppress(600);
          showContextMenu(x, y, { game, album: true });
        }, 480);
      },
      { passive: true }
    );
    card.addEventListener(
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
      clearTimeout(lpTimer);
      lpTimer = null;
    };
    card.addEventListener("pointerup", cancelLp);
    card.addEventListener("pointercancel", cancelLp);
  });
}

/** Vertical wheel over a horizontal row → scroll the games page */
function bindGamesRowWheel(scrollEl) {
  if (!scrollEl || scrollEl.dataset.wheelBound === "1") return;
  scrollEl.dataset.wheelBound = "1";
  scrollEl.addEventListener(
    "wheel",
    (e) => {
      // Prefer vertical page scroll when the gesture is mostly vertical
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      const parent =
        scrollEl.closest("#games-browse") ||
        scrollEl.closest(".games-cat-scroll") ||
        $("#games-browse");
      if (!parent) return;
      parent.scrollTop += e.deltaY;
      e.preventDefault();
    },
    { passive: false }
  );
}

function renderGames(opts = {}) {
  const browse = $("#games-browse");
  if (!browse) return;

  const rows = groupGamesBy(gamesViewMode);
  if (!rows.length) {
    browse.innerHTML = `<p class="muted">Keine Spiele für diese Ansicht.</p>`;
    return;
  }

  browse.innerHTML = rows
    .map((row) => {
      const cards = row.games.map(gameCardHtml).join("");
      return `
      <section class="games-row" data-cat="${escapeHtml(row.key)}" data-mode="${gamesViewMode}">
        <div class="games-row-head">
          <div class="games-row-title">
            <img class="games-row-logo" src="${escapeHtml(row.meta.logo)}" alt="" draggable="false">
            <h2>${escapeHtml(row.meta.label)}</h2>
            <button type="button" class="games-row-expand" data-cat="${escapeHtml(row.key)}" title="Alle anzeigen" aria-label="Kategorie erweitern">
              <img src="Assets/Common/Back1.png" alt="" class="games-row-expand-icon">
            </button>
          </div>
        </div>
        <div class="games-row-scroll">
          <div class="games-row-track">
            ${cards}
          </div>
        </div>
      </section>`;
    })
    .join("");

  bindGameCardInteractions(browse);

  browse.querySelectorAll(".games-row-scroll").forEach((el) => {
    const needsX = el.scrollWidth > el.clientWidth + 2;
    el.classList.toggle("needs-x-scroll", needsX);
  });

  // was: only .games-row-expand
  browse.querySelectorAll(".games-row-title").forEach((title) => {
    const cat =
      title.querySelector("[data-cat]")?.dataset.cat ||
      title.closest(".games-row")?.dataset.cat;
    if (!cat) return;

    title.addEventListener("click", (e) => {
      e.preventDefault();
      openCategoryFullscreen(cat, gamesViewMode);
    });
  });

  markPlayingGameCards();

  if (opts.animate) {
    animateGamesRowsEnter(browse);
  }

   // was: bindPressMinHold(gamesGrid);
  bindPressMinHold(browse);
  applyGamesLocalFilter();
}

function markPlayingGameCards() {
  const item = state.queue[state.queueIndex];
  const gameId = item?.gameId || null;

  document.querySelectorAll(".game-card").forEach((card) => {
    const on = !!(gameId && card.dataset.id === gameId);
    card.classList.toggle("playing", on);

    const eqBars = card.querySelectorAll(".game-card-eq i");
    if (!on) {
      card.classList.remove("audio-on");
      eqBars.forEach((bar) => {
        bar.style.transition = "";
        bar.style.transform = "";
        bar.style.animation = "";
      });
      return;
    }

    if (state.playing) {
      eqBars.forEach((bar) => {
        bar.style.transition = "";
        bar.style.transform = "";
        bar.style.animation = "";
      });
      card.classList.add("audio-on");
    } else {
      // smooth → resting size (same as track list)
      eqBars.forEach((bar) => {
        const current = getComputedStyle(bar).transform;
        bar.style.animation = "none";
        bar.style.transform =
          current === "none" ? "scaleY(0.35)" : current;
        requestAnimationFrame(() => {
          bar.style.transition =
            "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)";
          bar.style.transform = "scaleY(0.35)";
        });
      });
      card.classList.remove("audio-on");
    }
  });
}

function openCategoryFullscreen(catKey, mode, opts = {}) {
  if (gamesNavLocked && !opts.instant) return;
  if (!opts.instant) {
    gamesNavLocked = true;
    setTimeout(() => {
      gamesNavLocked = false;
    }, 450);
  }
  const metaMap = mode === "franchise" ? FRANCHISE_META : CONSOLE_META;
  const meta = metaMap[catKey];
  if (!meta) return;
  const field = mode === "franchise" ? "franchise" : "console";
  const games = LIBRARY.filter((g) => (g[field] || "").toLowerCase() === catKey);
  if (!games.length) return;

  const browse = $("#games-browse");
  if (!browse) return;

  const inject = () => {
    browse.dataset.catOpen = catKey;
    browse.dataset.catMode = mode;
    document.body.classList.add("games-cat-open");

    browse.innerHTML = `
      <div class="games-cat-inline">
        <div class="games-cat-chrome">
          <button type="button" class="back-btn" id="games-cat-back">
            <img src="Assets/Common/Back1.png" alt="" class="back-icon">
            Zurück
          </button>
          <div class="games-cat-chrome-row">
            <div class="games-cat-fs-title">
              <img src="${escapeHtml(meta.logo)}" alt="" class="games-row-logo" draggable="false">
              <h2>${escapeHtml(meta.label)}</h2>
            </div>
            <div class="games-cat-search-wrap games-local-search-wrap">
              <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
              </svg>
              <input
                id="games-cat-search"
                class="games-local-search-input"
                type="search"
                placeholder="Hier Suchen..."
                autocomplete="off"
                spellcheck="false"
                value="${escapeHtml(gamesLocalQuery)}"
              >
              <button type="button" id="games-cat-search-clear" class="search-clear-btn ${gamesLocalQuery ? "" : "hidden"}" title="Löschen">✕</button>
            </div>
          </div>
        </div>
        <div class="games-cat-scroll">
          <div class="games-cat-fs-grid">
            ${games.map(gameCardHtml).join("")}
          </div>
          <p id="games-filter-empty" class="games-filter-empty hidden">Keine Treffer.</p>
        </div>
      </div>
    `;

    $("#games-cat-back")?.addEventListener("click", closeCategoryFullscreen);
    bindGameCardInteractions(browse);

    // Category-local search (same filter as main page)
    const catInput = $("#games-cat-search");
    const catClear = $("#games-cat-search-clear");
    const mainInput = $("#games-local-search");
    const mainClear = $("#games-local-search-clear");

   catInput?.addEventListener("input", () => {
      gamesLocalQuery = catInput.value.trim();
      catClear?.classList.toggle("hidden", !gamesLocalQuery);
      if (mainInput && mainInput.value !== catInput.value) {
        mainInput.value = catInput.value;
      }
      mainClear?.classList.toggle("hidden", !gamesLocalQuery);
      applyGamesLocalFilter();
    });

    catClear?.addEventListener("click", () => {
      if (catInput) catInput.value = "";
      gamesLocalQuery = "";
      catClear.classList.add("hidden");
      if (mainInput) mainInput.value = "";
      mainClear?.classList.add("hidden");
      applyGamesLocalFilter();
      catInput?.focus();
    });

    markPlayingGameCards();
    bindPressMinHold(browse);
    applyGamesLocalFilter();
  };

  if (opts.instant) {
    inject();
    return;
  }

  const top = document.querySelector(".games-page-top");
  let finished = false;
  const go = () => {
    if (finished) return;
    finished = true;
    inject();
  };

  if (top && !top.classList.contains("is-leaving")) {
    top.classList.remove("is-entering");
    top.classList.add("is-leaving");
    top.addEventListener(
      "animationend",
      (e) => {
        if (e.target !== top) return;
        top.classList.remove("is-leaving");
      },
      { once: true }
    );
  }

  fadeOutGamesBrowse(browse, go);
  setTimeout(go, 260);
}

function closeCategoryFullscreen() {
  if (!document.body.classList.contains("games-cat-open")) return;
  if (gamesNavLocked) return;
  gamesNavLocked = true;
  setTimeout(() => {
    gamesNavLocked = false;
  }, 450);

  const browse = $("#games-browse");
  const panel = browse?.querySelector(".games-cat-inline");
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;

    document.body.classList.remove("games-cat-open");
    if (browse) {
      delete browse.dataset.catOpen;
      delete browse.dataset.catMode;
    }

    // Sync main “Hier Suchen…” + ✕ with whatever was typed in the category
    const mainInput = $("#games-local-search");
    const mainClear = $("#games-local-search-clear");
    if (mainInput) mainInput.value = gamesLocalQuery || "";
    mainClear?.classList.toggle("hidden", !(gamesLocalQuery || "").trim());

    renderGames({ animate: true });

    // Heading + Konsole/Franchise fade in
    const top = document.querySelector(".games-page-top");
    if (top) {
      top.classList.remove("is-entering", "is-leaving");
      void top.offsetWidth;
      top.classList.add("is-entering");
      const clearTop = () => top.classList.remove("is-entering");
      top.addEventListener("animationend", clearTop, { once: true });
      setTimeout(clearTop, 400);
    }
  };

  if (!panel) {
    finish();
    return;
  }

  panel.classList.add("is-leaving");
  panel.addEventListener(
    "animationend",
    (e) => {
      if (e.target !== panel) return;
      finish();
    },
    { once: true }
  );
  setTimeout(finish, 300);
}

function bindGamesViewToggle() {
  document.querySelectorAll(".games-view-btn").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const next = btn.dataset.gamesView === "franchise" ? "franchise" : "console";
      if (next === gamesViewMode) return;
      if (gamesNavLocked) return;

      gamesNavLocked = true;
      setTimeout(() => {
        gamesNavLocked = false;
      }, 480);

      document.querySelectorAll(".games-view-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      gamesViewMode = next;

      if (document.body.classList.contains("games-cat-open")) {
        document.body.classList.remove("games-cat-open");
        const browse = $("#games-browse");
        if (browse) {
          delete browse.dataset.catOpen;
          delete browse.dataset.catMode;
        }
      }

      const browse = $("#games-browse");
      fadeOutGamesBrowse(browse, () => {
        renderGames({ animate: true });
      });
    });
  });
}

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function albumTotalSec(game) {
  return (game.tracks || []).reduce((a, t) => {
    const d = Number(t.duration);
    return a + (Number.isFinite(d) && d > 0 ? d : 0);
  }, 0);
}

function openGlobalSearch(clearInput = true) {
  if (globalSearchOpen) {
    if (clearInput) {
      const input = $("#global-search-input");
      if (input) input.value = "";
      runGlobalSearch("");
    }
    return;
  }

  searchReturn = {
    type: document.body.classList.contains("games-cat-open")
      ? "category"
      : gameDetail?.classList.contains("active")
        ? "game"
        : document.querySelector('.tab[data-tab="playlists"]')?.classList.contains("active")
          ? "playlists"
          : "games",
    gameId: state.currentGame?.id || null,
    catKey: $("#games-browse")?.dataset.catOpen || null,
    catMode: $("#games-browse")?.dataset.catMode || null,
  };

  globalSearchOpen = true;
  document.body.classList.add("search-open", "search-mode");

  gameDetail?.classList.add("hidden");
  gameDetail?.classList.remove("active");
  if (document.body.classList.contains("games-cat-open")) {
    document.body.classList.remove("games-cat-open");
  }

  // Show search UI on games panel without forcing the tab highlight
  gameDetail?.classList.add("hidden");
  gameDetail?.classList.remove("active");
  $("#tab-playlists")?.classList.remove("active");
  $("#tab-games")?.classList.add("active");
  // do NOT touch .tab active classes

  const title = $("#games-page-title");
  if (title) title.textContent = "Suche";

  $("#gs-toolbar")?.classList.remove("hidden");
  syncGsToolbar();

  const input = $("#global-search-input");
  if (clearInput && input) {
    input.value = "";
    $("#global-search-clear")?.classList.add("hidden");
  }
  // Only focus when the user intentionally opens/types search — not when restoring after leaving a game
  if (clearInput && input && document.activeElement !== input) {
    requestAnimationFrame(() => input.focus());
  }

  runGlobalSearch(input?.value || "");
}

function closeGlobalSearch() {
  globalSearchOpen = false;
  document.body.classList.remove("search-open", "search-mode");
  $("#global-search-results")?.classList.add("hidden");
  if ($("#global-search-results")) $("#global-search-results").innerHTML = "";

  // keep the topbar search bar visible always
  const input = $("#global-search-input");
  if (input) {
    input.value = "";
    input.blur();
  }
  $("#global-search-clear")?.classList.add("hidden");

  const title = $("#games-page-title");
  if (title) title.textContent = "Spiele";

  $("#gs-toolbar")?.classList.add("hidden");
  $("#gs-filter-panel")?.classList.add("hidden");
  $("#gs-sort-panel")?.classList.add("hidden");

  const ret = searchReturn;
  searchReturn = null;

  if (ret?.type === "game" && ret.gameId) {
    openGame(ret.gameId);
    } else if (ret?.type === "category" && ret.catKey) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    $("#tab-games")?.classList.add("active");
    gameDetail?.classList.add("hidden");
    gameDetail?.classList.remove("active");
    // Open category immediately — no fade through main browse (avoids flash)
    openCategoryFullscreen(ret.catKey, ret.catMode || gamesViewMode, {
      instant: true,
    });
  } else if (ret?.type === "playlists") {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-playlists")?.classList.add("active");
  } else {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-games")?.classList.add("active");
    gameDetail?.classList.add("hidden");
    gameDetail?.classList.remove("active");
    renderGames({ animate: true });
  }
}

function runGlobalSearch(raw) {
  const box = $("#global-search-results");
  if (!box) return;
  const q = norm(raw);
  $("#global-search-clear")?.classList.toggle("hidden", !String(raw || "").trim());

  if (!q) {
    box.innerHTML = `<p class="muted gs-empty">Suche etwas, um Spiele und Songs zu finden.</p>`;
    box.classList.remove("hidden");
    return;
  }

  const fieldHit = (g, t) => {
    const consoleLabel = CONSOLE_META[g.console]?.label || "";
    const franchiseLabel = FRANCHISE_META[g.franchise]?.label || "";
    const f = gsPrefs.filter;
    if (f === "game")
      return norm(g.title).includes(q) || norm(g.short).includes(q);
    if (f === "franchise") return norm(franchiseLabel).includes(q) || norm(g.franchise).includes(q);
    if (f === "console") return norm(consoleLabel).includes(q) || norm(g.console).includes(q);
    if (f === "composer") return norm(g.composer).includes(q);
    // all
    return (
      norm(g.title).includes(q) ||
      norm(g.short).includes(q) ||
      norm(g.composer).includes(q) ||
      norm(consoleLabel).includes(q) ||
      norm(franchiseLabel).includes(q) ||
      (t && norm(t.title).includes(q))
    );
  };

  let gamesHit = LIBRARY.filter((g) => fieldHit(g, null));
  let tracksHit = [];
  for (const g of LIBRARY) {
    for (const t of g.tracks || []) {
      if (gsPrefs.filter === "all") {
        if (norm(t.title).includes(q) || fieldHit(g, t)) tracksHit.push({ game: g, track: t, score: norm(t.title).includes(q) ? 2 : 1 });
      } else if (gsPrefs.filter === "game") {
        if (fieldHit(g, null) && norm(t.title).length >= 0) {
          // show tracks of matching games only when filter is game + query matches game
          if (fieldHit(g, null)) tracksHit.push({ game: g, track: t, score: 1 });
        }
      } else {
        if (fieldHit(g, t)) tracksHit.push({ game: g, track: t, score: 1 });
      }
    }
  }
  // de-dupe tracks when filter=game floods
  if (gsPrefs.filter === "game") {
    tracksHit = tracksHit.filter(({ game }) => fieldHit(game, null));
  }

  const dirMul = gsPrefs.dir === "asc" ? 1 : -1;
  const yearOf = (g) => Number(g.year ?? g.releaseYear) || 0;
  const lenOf = (g) => albumTotalSec(g) || 0;
  const tLen = (t) => (Number.isFinite(t.duration) ? t.duration : 0);

  const sortGames = (arr) => {
    const a = [...arr];
    if (gsPrefs.sort === "az") {
      a.sort((x, y) => dirMul * norm(x.title).localeCompare(norm(y.title)));
    } else if (gsPrefs.sort === "length") {
      a.sort((x, y) => dirMul * (lenOf(x) - lenOf(y)));
    } else if (gsPrefs.sort === "year") {
      a.sort((x, y) => dirMul * (yearOf(x) - yearOf(y)));
    } else {
      // relevance: earlier includes of title first
      a.sort((x, y) => {
        const sx = norm(x.title).indexOf(q);
        const sy = norm(y.title).indexOf(q);
        const rx = sx < 0 ? 999 : sx;
        const ry = sy < 0 ? 999 : sy;
        return rx - ry || norm(x.title).localeCompare(norm(y.title));
      });
      if (gsPrefs.dir === "asc") a.reverse();
    }
    return a;
  };

  const sortTracks = (arr) => {
    const a = [...arr];
    if (gsPrefs.sort === "az") {
      a.sort((x, y) => dirMul * norm(x.track.title).localeCompare(norm(y.track.title)));
    } else if (gsPrefs.sort === "length") {
      a.sort((x, y) => dirMul * (tLen(x.track) - tLen(y.track)));
    } else if (gsPrefs.sort === "year") {
      a.sort((x, y) => dirMul * (yearOf(x.game) - yearOf(y.game)));
    } else {
      a.sort((x, y) => (y.score || 0) - (x.score || 0) || norm(x.track.title).localeCompare(norm(y.track.title)));
      if (gsPrefs.dir === "asc") a.reverse();
    }
    return a;
  };

  gamesHit = sortGames(gamesHit);
  tracksHit = sortTracks(tracksHit);

  const showGames = !gsPrefs.hideGames && gamesHit.length;

  const gameRows = gamesHit
    .map((g) => {
      const total = albumTotalSec(g);
      const isPlaying =
        state.queue[state.queueIndex]?.gameId === g.id && state.queueIndex >= 0;
      return `
      <div class="gs-row gs-row-game ${isPlaying ? "playing" : ""} ${
        state.playing && isPlaying ? "audio-on" : ""
      }" data-kind="game" data-game-id="${g.id}">
        <img class="gs-cover" src="${escapeHtml(g.cover || PLACEHOLDER)}" alt="" draggable="false">
       <span class="gs-indicator" aria-hidden="true">
          <span class="eq"><i></i><i></i><i></i><i></i><i></i></span>
        </span>
        <div class="gs-meta">
          <div class="gs-title">${escapeHtml(g.title)}</div>
          <div class="gs-sub">${escapeHtml(g.composer || "")}</div>
        </div>
        <span class="gs-duration">${total ? formatAlbumDuration(total) : ""}</span>
        <button type="button" class="ctrl-btn gs-menu" data-action="menu" title="Mehr">⋮</button>
      </div>`;
    })
    .join("");

  const trackRows = tracksHit
    .map(({ game, track }) => {
      const isCurrent = state.queue[state.queueIndex]?.track?.id === track.id;
      const dur =
        Number.isFinite(track.duration) && track.duration > 0
          ? formatTime(track.duration)
          : "–:––";
      return `
      <div class="gs-row gs-row-track ${isCurrent ? "playing" : ""} ${
        state.playing && isCurrent ? "audio-on" : ""
      }" data-kind="track" data-game-id="${game.id}" data-track-id="${track.id}">
        <img class="gs-cover" src="${escapeHtml(game.cover || PLACEHOLDER)}" alt="" draggable="false">
        <span class="gs-indicator" aria-hidden="true">
          <span class="eq"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="hover-play"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
        </span>
        <div class="gs-meta">
          <div class="gs-title">${escapeHtml(track.title)}</div>
          <div class="gs-sub">${escapeHtml(game.title)}</div>
        </div>
        <span class="gs-duration">${dur}</span>
        <button type="button" class="ctrl-btn gs-menu" data-action="menu" title="Mehr">⋮</button>
      </div>`;
    })
    .join("");

  box.innerHTML = `
    ${
      showGames
        ? `<div class="gs-section"><h3 class="gs-section-title">Spiele</h3><div class="gs-game-list">${gameRows}</div></div>`
        : ""
    }
    ${
      tracksHit.length
        ? `<div class="gs-section"><h3 class="gs-section-title">Songs</h3><div class="gs-track-list">${trackRows}</div></div>`
        : ""
    }
    ${
      !showGames && !tracksHit.length
        ? `<p class="muted gs-empty">Keine Treffer.</p>`
        : ""
    }
  `;
  box.classList.remove("hidden");
  bindGlobalSearchResults(box);
}

function bindGlobalSearchResults(box) {
  box.querySelectorAll(".gs-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (row.dataset.suppressClick === "1") {
        delete row.dataset.suppressClick;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (performance.now() < suppressNextClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest(".gs-menu")) return;
      const kind = row.dataset.kind;
      const gameId = row.dataset.gameId;
      if (kind === "game") {
        const q = $("#global-search-input")?.value?.trim() || "";
        searchReturn = q ? { type: "search", query: q } : null;
        globalSearchOpen = false;
        document.body.classList.remove("search-open", "search-mode");
        $("#global-search-results")?.classList.add("hidden");
        openGame(gameId);
      } else if (kind === "track") {
        const game = LIBRARY.find((g) => g.id === gameId);
        const track = game?.tracks?.find((t) => t.id === row.dataset.trackId);
        if (game && track) {
          // same as selecting in album: reset queue to full album, play this track
          playFromGame?.(game, track);
        }
      }
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openSearchContextMenu(row, e.clientX, e.clientY);
    });
  });

  box.querySelectorAll(".gs-menu").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = btn.closest(".gs-row");
      const r = btn.getBoundingClientRect();
      openSearchContextMenu(row, r.left, r.bottom);
    });
  });

  // long-press mobile
  box.querySelectorAll(".gs-row").forEach((row) => {
    let lpTimer = null;
    let lpMoved = false;
    row.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      lpMoved = false;
      const x = e.clientX;
      const y = e.clientY;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        if (lpMoved) return;
        row.dataset.suppressClick = "1";
        armClickSuppress(600);
        openSearchContextMenu(row, x, y);
      }, 480);
    });
    row.addEventListener("pointermove", (e) => {
      if (!lpTimer) return;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) {
        lpMoved = true;
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    });
    const cancelLp = () => {
      clearTimeout(lpTimer);
      lpTimer = null;
    };
    row.addEventListener("pointerup", cancelLp);
    row.addEventListener("pointercancel", cancelLp);
  });
}

function openSearchContextMenu(row, x, y) {
  if (!row) return;
  const gameId = row.dataset.gameId;
  const trackId = row.dataset.trackId || null;
  const game = LIBRARY.find((g) => g.id === gameId);
  if (!game) return;

  const track = trackId
    ? (game.tracks || []).find((t) => t.id === trackId)
    : null;

  // Use existing showContextMenu so header + actions stay consistent
  showContextMenu(
    x,
    y,
    track
      ? { game, track, fromQueue: false }
      : { game, album: true }
  );
}

function bindGlobalSearchUI() {
  const input = $("#global-search-input");

  input?.addEventListener("focus", () => {
    if (!globalSearchOpen) openGlobalSearch(false);
  });
  input?.addEventListener("input", (e) => {
    if (!globalSearchOpen) openGlobalSearch(false);
    runGlobalSearch(e.target.value);
  });

  $("#global-search-clear")?.addEventListener("click", () => {
    if (input) {
      input.value = "";
      input.focus();
      runGlobalSearch("");
    }
  });
  $("#global-search-back")?.addEventListener("click", closeGlobalSearch);

  function syncGsToolbar() {
    const hide = $("#gs-hide-games");
    if (hide) hide.checked = !!gsPrefs.hideGames;
    document.querySelectorAll("[data-gs-filter]").forEach((b) => {
      b.classList.toggle("active", b.dataset.gsFilter === gsPrefs.filter);
    });
    document.querySelectorAll("[data-gs-sort]").forEach((b) => {
      b.classList.toggle("active", b.dataset.gsSort === gsPrefs.sort);
    });
    document.querySelectorAll("[data-gs-dir]").forEach((b) => {
      b.classList.toggle("active", b.dataset.gsDir === gsPrefs.dir);
    });
  }
  window.syncGsToolbar = syncGsToolbar;

  function closeGsPanel(panel) {
    if (!panel || panel.classList.contains("hidden") || panel.classList.contains("is-closing"))
      return;
    panel.classList.add("is-closing");
    panel.setAttribute("aria-hidden", "true");
    const done = () => {
      panel.classList.add("hidden");
      panel.classList.remove("is-closing");
      panel.removeEventListener("animationend", done);
    };
    panel.addEventListener("animationend", done);
    setTimeout(done, 220);
  }

  function openGsPanel(panel) {
    if (!panel) return;
    panel.classList.remove("is-closing", "hidden");
    panel.setAttribute("aria-hidden", "false");
    // restart open animation
    panel.style.animation = "none";
    void panel.offsetWidth;
    panel.style.animation = "";
  }

  function toggleGsPanel(which) {
    const filterP = $("#gs-filter-panel");
    const sortP = $("#gs-sort-panel");
    // Close other popovers
    if (typeof hideContextMenu === "function") hideContextMenu();
    if (typeof closeSleepPanel === "function") closeSleepPanel();
    if (typeof closeLoopMenu === "function") closeLoopMenu();

    if (which === "filter") {
      if (sortP && !sortP.classList.contains("hidden")) closeGsPanel(sortP);
      if (filterP?.classList.contains("hidden")) openGsPanel(filterP);
      else closeGsPanel(filterP);
    } else {
      if (filterP && !filterP.classList.contains("hidden")) closeGsPanel(filterP);
      if (sortP?.classList.contains("hidden")) openGsPanel(sortP);
      else closeGsPanel(sortP);
    }
    syncGsToolbar();
  }

  $("#gs-filter-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGsPanel("filter");
  });
  $("#gs-sort-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGsPanel("sort");
  });

  $("#gs-hide-games")?.addEventListener("change", (e) => {
    gsPrefs.hideGames = !!e.target.checked;
    runGlobalSearch($("#global-search-input")?.value || "");
  });
  document.querySelectorAll("[data-gs-filter]").forEach((b) => {
    b.addEventListener("click", () => {
      gsPrefs.filter = b.dataset.gsFilter;
      syncGsToolbar();
      runGlobalSearch($("#global-search-input")?.value || "");
    });
  });
  document.querySelectorAll("[data-gs-sort]").forEach((b) => {
    b.addEventListener("click", () => {
      gsPrefs.sort = b.dataset.gsSort;
      syncGsToolbar();
      runGlobalSearch($("#global-search-input")?.value || "");
    });
  });
  document.querySelectorAll("[data-gs-dir]").forEach((b) => {
    b.addEventListener("click", () => {
      gsPrefs.dir = b.dataset.gsDir;
      syncGsToolbar();
      runGlobalSearch($("#global-search-input")?.value || "");
    });
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#gs-toolbar, #gs-filter-panel, #gs-sort-panel")) return;
    closeGsPanel($("#gs-filter-panel"));
    closeGsPanel($("#gs-sort-panel"));
  });

  // press animation on filter/sort buttons
  bindPressMinHold(document.getElementById("gs-toolbar") || document);
  bindPressMinHold(document.getElementById("gs-filter-panel") || document);
  bindPressMinHold(document.getElementById("gs-sort-panel") || document);
}

function bindGamesLocalSearch() {
  const input = $("#games-local-search");
  const clearBtn = $("#games-local-search-clear");
  if (!input) return;
  if (input.dataset.bound === "1") return;
  input.dataset.bound = "1";

  input.addEventListener("input", () => {
    gamesLocalQuery = input.value.trim();
    clearBtn?.classList.toggle("hidden", !gamesLocalQuery);
    // keep category field in sync if open
    const catInput = $("#games-cat-search");
    const catClear = $("#games-cat-search-clear");
    if (catInput && catInput.value !== input.value) catInput.value = input.value;
    catClear?.classList.toggle("hidden", !gamesLocalQuery);
    applyGamesLocalFilter();
  });

  clearBtn?.addEventListener("click", () => {
    input.value = "";
    gamesLocalQuery = "";
    clearBtn.classList.add("hidden");
    const catInput = $("#games-cat-search");
    const catClear = $("#games-cat-search-clear");
    if (catInput) catInput.value = "";
    catClear?.classList.add("hidden");
    applyGamesLocalFilter();
    input.focus();
  });
}

function applyGamesLocalFilter() {
  const browse = $("#games-browse");
  if (!browse) return;
  const q = norm(gamesLocalQuery);

  // Category expanded view
  if (browse.dataset.catOpen) {
    let visible = 0;
    browse.querySelectorAll(".game-card").forEach((card) => {
      const game = LIBRARY.find((g) => g.id === card.dataset.id);
      if (!game) return;
      const hit =
        !q ||
        norm(game.title).includes(q) ||
        norm(game.short).includes(q) ||
        norm(game.composer).includes(q);
      card.classList.toggle("hidden", !hit);
      if (hit) visible++;
    });
    let empty = browse.querySelector("#games-filter-empty");
    if (!empty) {
      empty = document.createElement("p");
      empty.id = "games-filter-empty";
      empty.className = "games-filter-empty";
      browse.querySelector(".games-cat-scroll")?.appendChild(empty);
    }
    empty.textContent = "Keine Treffer.";
    empty.classList.toggle("hidden", !q || visible > 0);
    return;
  }

  // Main grouped rows
  let anyVisible = false;
  browse.querySelectorAll(".games-row").forEach((row) => {
    const catKey = row.dataset.cat;
    const mode = row.dataset.mode || gamesViewMode;
    const meta =
      mode === "franchise" ? FRANCHISE_META[catKey] : CONSOLE_META[catKey];
    const catHit =
      !!q &&
      (norm(meta?.label).includes(q) || norm(catKey).includes(q));

    let anyGame = false;
    row.querySelectorAll(".game-card").forEach((card) => {
      const game = LIBRARY.find((g) => g.id === card.dataset.id);
      if (!game) return;
      const gameHit =
        !q ||
        catHit ||
        norm(game.title).includes(q) ||
        norm(game.short).includes(q) ||
        norm(game.composer).includes(q);
      card.classList.toggle("hidden", !gameHit);
      if (gameHit) anyGame = true;
    });

    if (q && !catHit) {
      row.querySelectorAll(".game-card").forEach((card) => {
        const game = LIBRARY.find((g) => g.id === card.dataset.id);
        if (!game) return;
        const exactish =
          norm(game.title).includes(q) || norm(game.short).includes(q);
        if (!exactish) card.classList.add("hidden");
      });
      anyGame = [...row.querySelectorAll(".game-card")].some(
        (c) => !c.classList.contains("hidden")
      );
    }

    const showRow = !q || catHit || anyGame;
    row.classList.toggle("hidden", !showRow);
    if (showRow) anyVisible = true;
  });

  let empty = browse.querySelector("#games-browse-empty");
  if (!empty) {
    empty = document.createElement("p");
    empty.id = "games-browse-empty";
    empty.className = "games-filter-empty";
    browse.appendChild(empty);
  }
  empty.textContent = "Keine Treffer.";
  empty.classList.toggle("hidden", !q || anyVisible);
}

function openGame(id) {
  const game = LIBRARY.find((g) => g.id === id);
  if (!game) return;
  // Keep global search query so “back” can restore results
  const gsInput = $("#global-search-input");
  const savedSearch = gsInput?.value?.trim() || "";
  if (globalSearchOpen && savedSearch) {
    searchReturn = {
      type: "search",
      query: savedSearch,
    };
  } else if (document.body.classList.contains("games-cat-open")) {
    // Opened from a console/franchise category → back returns there
    const browse = $("#games-browse");
    searchReturn = {
      type: "category",
      catKey: browse?.dataset.catOpen || null,
      catMode: browse?.dataset.catMode || gamesViewMode,
    };
  }
    // Remember previous album (scroll + its own search), not a global one
  if (state.currentGame && state.currentGame.id !== id) {
    saveAlbumViewState();
  }
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
      <span class="track-duration" data-track-id="${escapeHtml(t.id)}">${
        Number.isFinite(Number(t.duration)) && Number(t.duration) > 0
          ? formatTime(Number(t.duration))
          : "–:––"
      }</span>
      <span class="track-actions" data-action="menu">⋮</span>
    </div>
  `
    )
    .join("");

  // Fill missing durations from file (JSON already shown above)
  game.tracks.forEach(async (t) => {
    if (Number.isFinite(Number(t.duration)) && Number(t.duration) > 0) return;
    const url = typeof getTrackUrl === "function" ? getTrackUrl(t) : t.file;
    const sec = await getTrackDuration(url, t);
    if (sec == null) return;
    const el = trackListEl.querySelector(
      `.track-duration[data-track-id="${CSS.escape(t.id)}"]`
    );
    if (el) el.textContent = formatTime(sec);
  });

  bindTrackListFade();
  bindGameHeaderToggle();
  requestAnimationFrame(updateTrackFade);

  trackListEl.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (row.dataset.suppressClick === "1") {
        delete row.dataset.suppressClick;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (performance.now() < suppressNextClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
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

    bindPressMinHold(document.querySelector(".game-sticky-top") || document);

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
  restoreAlbumViewState();
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
    if (state.currentGame) saveAlbumViewState(state.currentGame.id);
    state.currentGame = null;
    gameDetail.classList.add("hidden");
    gameDetail.classList.remove("active");
    tabGames.classList.add("active");
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    $("#tab-games")?.classList.add("active");

    // Restore previous global search instead of wiping it
    if (searchReturn?.type === "search" && searchReturn.query) {
      const q = searchReturn.query;
      searchReturn = null;
      openGlobalSearch(false); // false = don't clear, don't focus
      const input = $("#global-search-input");
      if (input) {
        input.value = q;
        input.blur(); // stay out of the field
        $("#global-search-clear")?.classList.toggle("hidden", !q.trim());
        runGlobalSearch(q);
      }
      return;
    }

    // Restore category (console / franchise) you opened the game from
    if (searchReturn?.type === "category" && searchReturn.catKey) {
      const key = searchReturn.catKey;
      const mode = searchReturn.catMode || gamesViewMode;
      searchReturn = null;
      openCategoryFullscreen(key, mode, { instant: true });
      return;
    }

    renderGames({ animate: true });
  });
}

function playFromGame(game, track) {
  unlockMediaElement().catch(() => {});

  const albumItems = game.tracks.map((t) => ({
    gameId: game.id,
    track: t,
    insert: null,
  }));
  const idx = Math.max(
    0,
    game.tracks.findIndex((t) => t.id === track.id)
  );

  // Always keep album order as the unshuffle baseline
  unshuffledQueue = cloneQueue(albumItems);

  if (state.shuffle) {
    // Current song first, rest of THIS game shuffled after it
    const current = albumItems[idx];
    const rest = albumItems.filter((_, i) => i !== idx);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.queue = [current, ...rest];
    state.queueIndex = 0;
  } else {
    unshuffledQueue = null;
    state.queue = albumItems;
    state.queueIndex = idx;
  }

  if (state.loopMode === "count") {
    state.loopsRemaining = settings.loopTimes;
  } else {
    state.loopsRemaining = 0;
  }
  playCurrent();
  renderQueue();
  updatePlayerUI();
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
  $("#now-game").textContent = gameNameForPlayer(game);
  $("#fs-cover").src = game?.cover || PLACEHOLDER;
  $("#fs-title").textContent = track.title;
  $("#fs-game").textContent = gameNameForFullscreen(game);
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
    prefetchNearbyBfstm();
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

  markPlayingGameCards();

  // Global search rows: update in place (keeps smooth EQ pause)
  document.querySelectorAll("#global-search-results .gs-row").forEach((row) => {
    const kind = row.dataset.kind;
    let isCurrent = false;
    if (kind === "track") {
      isCurrent = !!(trackId && row.dataset.trackId === trackId);
    } else if (kind === "game") {
      isCurrent =
        state.queueIndex >= 0 &&
        state.queue[state.queueIndex]?.gameId === row.dataset.gameId;
    }
    row.classList.toggle("playing", isCurrent);
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
      syncKawarpPlayback();
      try {
        if ("mediaSession" in navigator) {
          navigator.mediaSession.playbackState = "paused";
        }
      } catch (_) {}
      updateMediaSession();
      bindMediaSession();
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
      syncKawarpPlayback();
      try {
        if ("mediaSession" in navigator) {
          navigator.mediaSession.playbackState = "paused";
        }
      } catch (_) {}
      updateMediaSession();
      bindMediaSession();
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
    clearBgSessionKeepAlive();
    stopSilentShield();
    markPlayingTrack(getCurrentTrackId());
    updatePlayerUI();
    syncKawarpPlayback();
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
      }
    } catch (_) {}
    updateMediaSession();
    bindMediaSession(); // re-attach play/pause after pause (iOS drops handlers)

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
      const target = effectiveVolume();
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
    startSilentShield(); // Media Session + mute-switch anchor
    playBuffer(decodedBuffer, pauseOffset);
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "playing";
      }
    } catch (_) {}
    updateMediaSession();
    bindMediaSession();

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
    currentGain.gain.setValueAtTime(effectiveVolume(), now);
    if (fadeSec <= 0) {
      currentGain.gain.setValueAtTime(0, softEndFadeAt);
    } else {
      currentGain.gain.setValueAtTime(effectiveVolume(), softEndFadeAt);
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

function toggleQueueLoop() {
  settings.queueLoop = !settings.queueLoop;
  saveSettings();
  updatePlayerUI();
  showToast(settings.queueLoop ? "Queue-Wiederholung an" : "Queue-Wiederholung aus");
}

// ── Loop count quick menu (right-click / long-press on #btn-loop in count mode) ──
let loopMenuCloseTimer = null;

function updateLoopMenuLabels() {
  const plus = $("#loop-menu-plus-label");
  const minus = $("#loop-menu-minus-label");
  const p = settings.loopStepPlus || 1;
  const m = settings.loopStepMinus || 1;
  if (plus) plus.textContent = `${p} Loop${p === 1 ? "" : "s"}`;
  if (minus) minus.textContent = `${m} Loop${m === 1 ? "" : "s"}`;
}

function closeLoopMenu() {
  const menu = $("#loop-menu");
  if (!menu || menu.classList.contains("hidden") || menu.classList.contains("is-closing")) return;
  menu.classList.add("is-closing");
  menu.setAttribute("aria-hidden", "true");
  clearTimeout(loopMenuCloseTimer);
  loopMenuCloseTimer = setTimeout(() => {
    menu.classList.add("hidden");
    menu.classList.remove("is-closing");
  }, 190);
}

function adjustLoopsRemaining(delta) {
  if (state.loopMode !== "count") return;
  const next = Math.min(99, Math.max(0, (state.loopsRemaining || 0) + delta));
  state.loopsRemaining = next;
  updatePlayerUI();

  // Soft-end was scheduled with the old count — rebuild from current position
  // (works while playing; while paused the next playBuffer will use the new count)
  if (transitioning) return;
  if (!decodedBuffer || !currentSource || useMediaEl) return;

  const duration = decodedBuffer.duration;
  const loopStart = getLoopStartSec();
  const wantSoftEnd =
    (loopStart > 0 || forceFullLoop) &&
    state.playing &&
    audioCtx &&
    currentGain &&
    !bufferCtxSuspended;

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
  // Invalidate any leftover pause remain times so resume doesn't restore the old schedule
  softEndRemainMs = 0;
  softEndStartRemainMs = 0;

  if (!wantSoftEnd) return;

  const offset = getPlaybackPosition();
  const fadeSec = getTransitionSec();
  const loopsAfterFirst = Math.max(0, state.loopsRemaining);
  const loopLen = forceFullLoop
    ? Math.max(0.001, duration)
    : Math.max(0.001, duration - loopStart);
  const timeToFadeStart =
    Math.max(0.01, duration - offset) + loopsAfterFirst * loopLen;

  softEndFadeAt = audioCtx.currentTime + timeToFadeStart;
  softEndFadeSec = fadeSec;

  const vol = effectiveVolume();
  if (fadeSec <= 0) {
    currentGain.gain.setValueAtTime(0, softEndFadeAt);
  } else {
    currentGain.gain.setValueAtTime(vol, softEndFadeAt);
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

function showLoopMenu(x, y) {
  if (state.loopMode !== "count") return;
  const menu = $("#loop-menu");
  const btn = $("#btn-loop");
  if (!menu) return;

  // Only one menu on screen
  if (typeof hideContextMenu === "function") hideContextMenu();
  if (typeof closeSleepPanel === "function") closeSleepPanel();
  $("#gs-filter-panel")?.classList.add("hidden");
  $("#gs-filter-panel")?.classList.remove("is-closing");
  $("#gs-sort-panel")?.classList.add("hidden");
  $("#gs-sort-panel")?.classList.remove("is-closing");

  updateLoopMenuLabels();

  clearTimeout(loopMenuCloseTimer);
  menu.classList.remove("is-closing", "hidden");
  menu.setAttribute("aria-hidden", "false");
  menu.style.animation = "none";
  void menu.offsetWidth;
  menu.style.animation = "";

  const menuW = menu.offsetWidth || 200;
  const menuH = menu.offsetHeight || 120;
  const pad = 8;

  let left;
  let top;
  if (btn) {
    const r = btn.getBoundingClientRect();
    // Sit above the button, shifted a bit further right
    left = r.left + 28;
    top = r.top - menuH - pad;
    if (top < pad) {
      top = r.bottom + pad;
    }
  } else {
    left = x;
    top = y - menuH - pad;
    if (top < pad) top = y + pad;
  }

  left = Math.max(pad, Math.min(left, window.innerWidth - menuW - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - menuH - pad));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  armClickSuppress?.(500);
}

function bindLoopMenu() {
  const btn = $("#btn-loop");
  const menu = $("#loop-menu");
  if (!btn || !menu || btn.dataset.loopMenuBound === "1") return;
  btn.dataset.loopMenuBound = "1";

  menu.querySelectorAll("[data-loop-delta]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.loopMode !== "count") {
        closeLoopMenu();
        return;
      }
      const which = b.dataset.loopDelta;
      if (which === "plus") {
        adjustLoopsRemaining(settings.loopStepPlus || 1);
      } else if (which === "minus") {
        adjustLoopsRemaining(-(settings.loopStepMinus || 1));
      }
      // keep menu open
    });
  });

  // Desktop right-click
  btn.addEventListener("contextmenu", (e) => {
    if (state.loopMode !== "count") return;
    e.preventDefault();
    e.stopPropagation();
    showLoopMenu(e.clientX, e.clientY);
  });

  // Mobile long-press
  let lpTimer = null;
  let lpMoved = false;
  btn.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse") return;
      if (state.loopMode !== "count") return;
      lpMoved = false;
      const x = e.clientX;
      const y = e.clientY;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        if (lpMoved) return;
        showLoopMenu(x, y);
        armClickSuppress?.(600);
      }, 480);
    },
    { passive: true }
  );
  btn.addEventListener(
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
  const clearLp = () => {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  };
  btn.addEventListener("pointerup", clearLp, { passive: true });
  btn.addEventListener("pointercancel", clearLp, { passive: true });
  btn.addEventListener("pointerleave", clearLp, { passive: true });

  // Outside click closes (same pattern as context menu)
  document.addEventListener("click", (e) => {
    if (performance.now() < (typeof suppressDocClickUntil !== "undefined" ? suppressDocClickUntil : 0))
      return;
    if (e.target.closest("#loop-menu")) return;
    if (e.target.closest("#btn-loop")) return;
    closeLoopMenu();
  });

  bindPressMinHold(menu);
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

  const qLoopOn = !!settings.queueLoop;
  const qLoopBtns = [
    document.getElementById("queue-loop-btn"),
    document.getElementById("fs-queue-loop-btn"),
  ];
  qLoopBtns.forEach((b) => {
    if (!b) return;
    b.classList.toggle("active", qLoopOn);
    b.setAttribute("aria-pressed", qLoopOn ? "true" : "false");
  });

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
      artist: game?.short || game?.title || "Noma Music",
      album: game?.title || game?.short || "Noma Music",
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
  const lists = [$("#queue-list"), $("#fs-queue-list")].filter(Boolean);
  if (!lists.length) return;

  // While dragging: only refresh "current" / EQ classes — never destroy the DOM
  if (queueDragging) {
    lists.forEach((list) => {
      list.querySelectorAll(".queue-item").forEach((row) => {
        const i = +row.dataset.index;
        const isCurrent = i === state.queueIndex;
        row.classList.toggle("current", isCurrent);
        row.classList.toggle("audio-on", isCurrent && state.playing);
      });
    });
    return;
  }

  function queueRowHtml(item, i, useLongGameName) {
    const game = LIBRARY.find((g) => g.id === item.gameId);
    const isCurrent = i === state.queueIndex;
    const gameLabel = useLongGameName
      ? game?.title || game?.short || ""
      : game?.short || game?.title || "";
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
          <div class="q-game muted">${escapeHtml(gameLabel)}</div>
        </div>
        <span class="q-duration" data-track-id="${escapeHtml(item.track.id)}">${
          Number.isFinite(Number(item.track.duration)) && Number(item.track.duration) > 0
            ? formatTime(Number(item.track.duration))
            : "–:––"
        }</span>
        <span class="track-actions q-actions" data-action="menu">⋮</span>
        <button class="q-remove" type="button" data-remove="${i}" title="Entfernen" aria-label="Entfernen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </li>`;
  }

  lists.forEach((list) => {
    const useLong = list.id === "fs-queue-list";
    list.innerHTML = state.queue
      .map((item, i) => queueRowHtml(item, i, useLong))
      .join("");
  });

  // Duration fill on all lists
  state.queue.forEach(async (item) => {
    if (Number.isFinite(Number(item.track.duration)) && Number(item.track.duration) > 0) return;
    const url = typeof getTrackUrl === "function" ? getTrackUrl(item.track) : item.track.file;
    const sec = await getTrackDuration(url, item.track);
    if (sec == null) return;
    document
      .querySelectorAll(`.q-duration[data-track-id="${CSS.escape(item.track.id)}"]`)
      .forEach((el) => {
        el.textContent = formatTime(sec);
      });
  });

  lists.forEach((list) => bindQueueItemEvents(list));
  // NO scrollIntoView here — only when opening the panel / fs queue
}

function bindQueueItemEvents(list) {
  if (!list) return;

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

    row.addEventListener(
      "pointerdown",
      (e) => {
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
      // Same position as current item → no visual gap (still allow drop back)
      if (insertBeforeIndex === dragFrom || insertBeforeIndex === dragFrom + 1) {
        clearGapVisual();
        dropIndex = insertBeforeIndex;
        lastDropIndex = insertBeforeIndex;
        return;
      }
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
      const scrolled = autoScrollQueue(lastClientY, list);
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
    // remove ALL ghosts (stale ones from lost pointer events)
    document.querySelectorAll(".queue-drag-ghost").forEach((g) => g.remove());
    ghost = null;
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

      document.querySelectorAll(".queue-drag-ghost").forEach((g) => g.remove());
      ghost = null;
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

    handle.addEventListener("lostpointercapture", () => {
      if (dragFrom < 0) return;
      clearDrag();
      renderQueue();
    });
  });
}

function autoScrollQueue(clientY, listEl) {
  const list = listEl || $("#queue-list") || $("#fs-queue-list");
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
      document
        .querySelectorAll(
          `#queue-list .queue-item[data-index="${to}"], #fs-queue-list .queue-item[data-index="${to}"]`
        )
        .forEach((row) => {
          row.classList.remove("drop-flash");
          void row.offsetWidth;
          row.classList.add("drop-flash");
          row.addEventListener(
            "animationend",
            () => row.classList.remove("drop-flash"),
            { once: true }
          );
        });
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


function isQueuePanelOpen() {
  const panel = $("#queue-panel");
  return (
    panel &&
    !panel.classList.contains("hidden") &&
    !panel.classList.contains("is-closing")
  );
}

function isFsExpandedOpen() {
  return document.body.classList.contains("fs-queue-open");
}

function openQueuePanel({ animate = true } = {}) {
  const panel = $("#queue-panel");
  if (!panel) return;

  if (isFsExpandedOpen()) {
    renderQueue();
    requestAnimationFrame(() => {
      $("#fs-queue-list .queue-item.current")?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
    return;
  }

  // Already open → only refresh, no second open animation
  if (isQueuePanelOpen()) {
    renderQueue();
    return;
  }

  clearTimeout(queuePanelCloseTimer);
  panel.classList.remove("hidden", "is-closing");

  if (animate) {
    panel.style.animation = "none";
    void panel.offsetWidth;
    panel.style.animation = "";
  } else {
    // Instant show (collapse from expanded / FS enter with small prefer)
    panel.style.animation = "none";
  }

  renderQueue();
  requestAnimationFrame(() => {
    const list = $("#queue-list");
    const cur = list?.querySelector(".queue-item.current");
    if (cur && list) {
      // instant scroll — smooth scroll fights animations on iPad
      const top =
        cur.offsetTop - list.clientHeight / 2 + cur.clientHeight / 2;
      list.scrollTop = Math.max(0, top);
    }
  });
}

function closeQueuePanel({ animate = true } = {}) {
  const panel = $("#queue-panel");
  if (!panel || panel.classList.contains("hidden")) return;

  clearTimeout(queuePanelCloseTimer);

  if (!animate) {
    panel.classList.add("hidden");
    panel.classList.remove("is-closing");
    return;
  }

  panel.classList.add("is-closing");
  queuePanelCloseTimer = setTimeout(() => {
    panel.classList.add("hidden");
    panel.classList.remove("is-closing");
  }, 280);
}

/** Fully close any queue UI (floating + expanded). Saves preference. */
function closeAnyQueue({ remember = true } = {}) {
  if (remember) {
    // last mode: expanded vs floating vs closed
    if (isFsExpandedOpen()) {
      fsQueuePreferOpen = true; // expanded was the active UI
    } else if (isQueuePanelOpen()) {
      fsQueuePreferOpen = false; // floating was active
    }
    // if both closed, leave fsQueuePreferOpen as-is
  }

  document.body.classList.remove("fs-queue-open");
  const fsQ = $("#fs-queue");
  if (fsQ) fsQ.setAttribute("aria-hidden", "true");

  const expandBtn = $("#queue-fs-expand");
  if (expandBtn) {
    expandBtn.setAttribute("aria-expanded", "false");
    expandBtn.title = "Große Warteschlange";
  }

  closeQueuePanel({ animate: true });
}

function setFsQueueOpen(open) {
  if (open && (state.queue.length === 0 || state.queueIndex < 0)) {
    open = false;
  }

  const wasOpen = document.body.classList.contains("fs-queue-open");
  document.body.classList.toggle("fs-queue-open", !!open);

  const expandBtn = $("#queue-fs-expand");
  if (expandBtn) {
    expandBtn.setAttribute("aria-expanded", open ? "true" : "false");
    expandBtn.title = open ? "Kleine Warteschlange" : "Große Warteschlange";
  }
  const fsQ = $("#fs-queue");
  if (fsQ) fsQ.setAttribute("aria-hidden", open ? "false" : "true");

  if (open) {
    // Expanded on → hide floating without delay/flash
    closeQueuePanel({ animate: false });
    renderQueue();
    requestAnimationFrame(() => {
      $("#fs-queue-list .queue-item.current")?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
  } else if (wasOpen) {
    // Caller decides: arrow → open floating; X → stay closed
  }
}

/** Arrow on expanded bar / floating header: expand ↔ collapse-to-small */
function toggleFsQueueMode() {
  if (!document.body.classList.contains("fs-open")) return;
  if (state.queue.length === 0 || state.queueIndex < 0) {
    fsQueuePreferOpen = true;
    setFsQueueOpen(false);
    closeQueuePanel({ animate: false });
    return;
  }

  const willExpand = !document.body.classList.contains("fs-queue-open");
  if (willExpand) {
    fsQueuePreferOpen = true;
    setFsQueueOpen(true);
  } else {
    // Collapse → small: no second open animation (same place / less work on iPad)
    fsQueuePreferOpen = false;
    setFsQueueOpen(false);
    openQueuePanel({ animate: false });
  }
}

function bindQueuePanel() {
  $("#btn-queue")?.addEventListener("click", () => {
    const inFs = document.body.classList.contains("fs-open");

    if (inFs) {
      // Fully close whatever is open
      if (isFsExpandedOpen() || isQueuePanelOpen()) {
        if (isFsExpandedOpen()) fsQueuePreferOpen = true;
        else fsQueuePreferOpen = false;
        setFsQueueOpen(false);
        closeQueuePanel({ animate: true });
        return;
      }
      // Open last preferred mode
      if (fsQueuePreferOpen) {
        setFsQueueOpen(true);
      } else {
        openQueuePanel();
      }
      return;
    }

    // Outside FS: only floating
    if (isQueuePanelOpen()) {
      closeQueuePanel();
    } else {
      openQueuePanel();
    }
  });

  $("#queue-close")?.addEventListener("click", () => {
    closeQueuePanel();
    if (document.body.classList.contains("fs-open")) {
      fsQueuePreferOpen = false;
    }
  });

  $("#queue-clear")?.addEventListener("click", () => {
    if (!state.queue.length) return;
    openClearQueueConfirm();
  });

  $("#queue-loop-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleQueueLoop();
  });
  $("#fs-queue-loop-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleQueueLoop();
  });

  // Expanded: X = close expanded only (prefer stays big → next ☰ opens expanded)
  $("#fs-queue-close")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fsQueuePreferOpen = true;
    setFsQueueOpen(false);
    closeQueuePanel({ animate: false });
  });

  // Expanded: arrow = collapse to small
  $("#fs-queue-collapse")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFsQueueMode();
  });

  $("#fs-queue-clear")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.queue.length) return;
    openClearQueueConfirm();
  });

  // Floating header arrow: expand / collapse-to-small
  $("#queue-fs-expand")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFsQueueMode();
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
  $("#fs-back")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!$("#fullscreen-player")?.classList.contains("hidden")) {
      toggleFullscreen();
    }
  });
}

function saveAlbumViewState() {
  const game = state.currentGame;
  if (!game) return;
  const scroll = $("#track-list-scroll");
  const input = $("#game-track-search");
  albumViewMemory.set(game.id, {
    scrollTop: scroll?.scrollTop ?? 0,
    query: input?.value ?? "",
  });
}

function restoreAlbumViewState() {
  const game = state.currentGame;
  if (!game) return;
  const mem = albumViewMemory.get(game.id);
  const input = $("#game-track-search");
  const scroll = $("#track-list-scroll");
  if (input) {
    input.value = mem?.query ?? "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const clearBtn = $("#game-track-search-clear");
  if (clearBtn) clearBtn.classList.toggle("hidden", !(mem?.query || "").trim());
  requestAnimationFrame(() => {
    if (scroll && mem) scroll.scrollTop = mem.scrollTop || 0;
  });
}

function setupGameTrackSearch() {
  const input = document.getElementById("game-track-search");
  if (!input) return;

  const clean = input.cloneNode(true);
  // restore per-album query — do NOT force empty
  const mem = state.currentGame ? albumViewMemory.get(state.currentGame.id) : null;
  clean.value = mem?.query ?? "";
  input.replaceWith(clean);

  const emptyEl = document.getElementById("track-search-empty");
  const clearBtn = document.getElementById("game-track-search-clear");

  function applyFilter() {
    const q = clean.value.trim().toLowerCase();
    if (clearBtn) clearBtn.classList.toggle("hidden", !q);
    let visible = 0;
    document.querySelectorAll("#track-list .track-row").forEach((row) => {
      const name = (row.querySelector(".track-name")?.textContent || "").toLowerCase();
      const show = !q || name.includes(q);
      row.classList.toggle("hidden", !show);
      if (show) visible++;
    });
    if (emptyEl) emptyEl.classList.toggle("hidden", visible > 0 || !q);
  }

  clean.addEventListener("input", applyFilter);
  clearBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    clean.value = "";
    applyFilter();
    clean.focus();
  });
  applyFilter();
}

function toggleGameHeaderCollapse() {
  if (!state.currentGame || !gameDetail?.classList.contains("active")) return;
  if (gameDetail.classList.contains("hidden")) return;

  const sticky = document.querySelector(".game-sticky-top");
  const detail = $("#game-detail");
  const titleEl = $("#game-title");
  const btn = $("#game-header-toggle");
  if (!sticky || !detail) return;

  const collapsed = sticky.classList.toggle("is-collapsed");
  detail.classList.toggle("header-collapsed", collapsed);
  btn?.setAttribute("aria-expanded", collapsed ? "false" : "true");

  if (titleEl) {
    titleEl.textContent = collapsed
      ? titleEl.dataset.short || titleEl.dataset.full || titleEl.textContent
      : titleEl.dataset.full || titleEl.textContent;
  }

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
}

function bindGameHeaderToggle() {
  const btn = $("#game-header-toggle");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => toggleGameHeaderCollapse());
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

function bindTrackListFade() {
  const scroller = document.querySelector(".track-list-scroll");
  if (!scroller) return;

  if (scroller.dataset.fadeBound === "1") {
    updateTrackFade();
    return;
  }
  scroller.dataset.fadeBound = "1";

  const COLLAPSE_AT = 72;
  const EXPAND_AT = 2;
  /** Approximate expanded→collapsed height drop (cover + meta + labels). */
  const HEADER_COLLAPSE_DELTA = 140;
  let lastY = 0;
  let ignoreUntil = 0;
  let ignoreDir = 0; // +1 ignore further collapse, -1 ignore further expand
  let ticking = false;
  /** True while a finger/stylus is actively on the scroller (not during fling). */
  let pointerDown = false;
  /**
   * When non-null, force scroller.scrollTop to this value on every scroll frame.
   * Used after a fling-triggered collapse so residual inertia cannot shoot the list down
   * while the header height is animating.
   */
  let pinScrollY = null;
  let pinUntil = 0;

  scroller.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointerDown = true;
      // User took control again — release any pin
      pinScrollY = null;
      pinUntil = 0;
    },
    { passive: true }
  );
  const clearPointer = () => {
    pointerDown = false;
  };
  scroller.addEventListener("pointerup", clearPointer, { passive: true });
  scroller.addEventListener("pointercancel", clearPointer, { passive: true });
  scroller.addEventListener("pointerleave", clearPointer, { passive: true });

  /** Hard-stop inertia and keep the list at targetY for ~durationMs. */
  const pinScroll = (targetY, durationMs = 520) => {
    const y = Math.max(0, targetY);
    pinScrollY = y;
    pinUntil = performance.now() + durationMs;

    // Immediate stop (overflow toggle + webkit scrolling off)
    const prevWebkit = scroller.style.webkitOverflowScrolling;
    scroller.style.overflowY = "hidden";
    scroller.style.webkitOverflowScrolling = "auto";
    scroller.scrollTop = y;
    void scroller.offsetHeight;
    scroller.style.overflowY = "";
    scroller.style.webkitOverflowScrolling = prevWebkit || "";

    // Keep re-asserting for a few frames (WebKit often restarts inertia once)
    const reassert = (n) => {
      if (pinScrollY == null) return;
      scroller.scrollTop = pinScrollY;
      if (n > 0) requestAnimationFrame(() => reassert(n - 1));
    };
    requestAnimationFrame(() => reassert(4));
  };

  const tryExpandIfAtTop = () => {
    if (!settings.autoCollapseAlbum) return;
    if (!state.currentGame || !gameDetail?.classList.contains("active")) return;
    const sticky = document.querySelector(".game-sticky-top");
    if (!sticky) return;
    if (!sticky.classList.contains("is-collapsed")) return;
    if (sticky.classList.contains("is-animating-header")) return;
    if (performance.now() < ignoreUntil && ignoreDir < 0) return;
    if (scroller.scrollTop > EXPAND_AT) return;

    toggleGameHeaderCollapse();
    pinScroll(0, 480);
    ignoreUntil = performance.now() + 500;
    ignoreDir = -1;
    lastY = 0;
  };

  const onScroll = () => {
    // While pinned, force position every scroll event (catches late inertia ticks)
    if (pinScrollY != null) {
      if (performance.now() < pinUntil) {
        if (Math.abs(scroller.scrollTop - pinScrollY) > 0.5) {
          scroller.scrollTop = pinScrollY;
        }
        lastY = pinScrollY;
        updateTrackFade();
        return;
      }
      pinScrollY = null;
      pinUntil = 0;
    }

    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;

      // Pin may have been set between scroll and rAF
      if (pinScrollY != null && performance.now() < pinUntil) {
        scroller.scrollTop = pinScrollY;
        lastY = pinScrollY;
        updateTrackFade();
        return;
      }

      updateTrackFade();

      if (!settings.autoCollapseAlbum) {
        lastY = scroller.scrollTop;
        return;
      }
      if (!state.currentGame || !gameDetail?.classList.contains("active")) {
        lastY = scroller.scrollTop;
        return;
      }

      const sticky = document.querySelector(".game-sticky-top");
      if (!sticky) {
        lastY = scroller.scrollTop;
        return;
      }

      const y = scroller.scrollTop;
      const goingDown = y > lastY + 0.5;
      const goingUp = y < lastY - 0.5;
      const collapsed = sticky.classList.contains("is-collapsed");
      const animating = sticky.classList.contains("is-animating-header");
      const locked =
        performance.now() < ignoreUntil &&
        ((ignoreDir > 0 && goingDown) || (ignoreDir < 0 && goingUp));

      if (!animating && !locked) {
        if (!collapsed && y >= COLLAPSE_AT && goingDown) {
          const y0 = y;
          const targetY = Math.max(COLLAPSE_AT, y0 - HEADER_COLLAPSE_DELTA);
          toggleGameHeaderCollapse();

          if (pointerDown) {
            // Finger still down — user is driving the scroll
            scroller.scrollTop = targetY;
          } else {
            // Fling / released: pin for the whole header animation so residual
            // momentum cannot shoot the list down while height changes.
            pinScroll(targetY, 520);
          }

          ignoreUntil = performance.now() + 500;
          ignoreDir = 1;
          lastY = targetY;
          return;
        }

        if (collapsed && y <= EXPAND_AT) {
          toggleGameHeaderCollapse();
          pinScroll(0, 480);
          ignoreUntil = performance.now() + 500;
          ignoreDir = -1;
          lastY = 0;
          return;
        }
      }

      lastY = y;
    });
  };

  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener(
    "scrollend",
    () => {
      updateTrackFade();
      // Clear pin once native scroll has fully settled
      if (pinScrollY != null && performance.now() >= pinUntil) {
        pinScrollY = null;
        pinUntil = 0;
      }
      tryExpandIfAtTop();
    },
    { passive: true }
  );
  window.addEventListener("resize", updateTrackFade, { passive: true });
  updateTrackFade();
}

let contextMenuAnchor = null;
let suppressDocClickUntil = 0;
/** After long-press opens the menu, ignore the following synthetic click */
let suppressNextClickUntil = 0;

function armClickSuppress(ms = 600) {
  suppressNextClickUntil = performance.now() + ms;
  suppressDocClickUntil = Math.max(suppressDocClickUntil, suppressNextClickUntil);
}

let toastTimer = null;
/**
 * @param {string|object} message
 *   string → simple text toast
 *   { title, sub?, cover?, action? } → player-style toast with cover
 */
function showToast(message) {
  let el = document.getElementById("noma-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "noma-toast";
    el.className = "noma-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }

  // Reset content while hidden so the next open can animate from the start state
  el.classList.remove("is-visible");

  if (message && typeof message === "object") {
    const cover = message.cover || PLACEHOLDER;
    const title = message.title || "";
    const sub = message.sub || message.action || "";
    el.innerHTML = `
      <img class="noma-toast-cover" src="${escapeHtml(cover)}" alt="" draggable="false">
      <div class="noma-toast-text">
        <div class="noma-toast-title">${escapeHtml(title)}</div>
        ${sub ? `<div class="noma-toast-sub">${escapeHtml(sub)}</div>` : ""}
      </div>
    `;
    el.classList.add("has-cover");
  } else {
    el.textContent = String(message ?? "");
    el.classList.remove("has-cover");
  }

  // Force a paint of the hidden state, then show → transition always runs
  // (needed on first create and when reopening quickly)
  void el.offsetWidth;
  requestAnimationFrame(() => {
    el.classList.add("is-visible");
  });

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("is-visible");
  }, 2400);
}

let contextMenuCloseTimer = null;

function hideContextMenu() {
  contextMenuAnchor = null;
  contextTrack = null;
  document.body.classList.remove("context-menu-open");
  if (
    !contextMenu ||
    contextMenu.classList.contains("hidden") ||
    contextMenu.classList.contains("is-closing")
  ) {
    return;
  }
  contextMenu.classList.add("is-closing");
  clearTimeout(contextMenuCloseTimer);
  contextMenuCloseTimer = setTimeout(() => {
    contextMenu.classList.add("hidden");
    contextMenu.classList.remove("is-closing");
  }, 190);
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
    // Close other dropdowns so only one menu is open
  $("#gs-filter-panel")?.classList.add("hidden");
  $("#gs-filter-panel")?.classList.remove("is-closing");
  $("#gs-sort-panel")?.classList.add("hidden");
  $("#gs-sort-panel")?.classList.remove("is-closing");
  if (typeof closeSleepPanel === "function") closeSleepPanel();
  if (typeof closeLoopMenu === "function") closeLoopMenu();
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

  // Album-only / track-only action visibility
  contextMenu?.querySelectorAll(".ctx-album-only").forEach((btn) => {
    btn.classList.toggle("hidden", !isAlbum);
  });
  const alreadyInThisAlbum =
    !isAlbum &&
    !!game &&
    state.currentGame?.id === game.id &&
    gameDetail?.classList.contains("active") &&
    !gameDetail.classList.contains("hidden");

  contextMenu?.querySelectorAll(".ctx-track-only").forEach((btn) => {
    // hide all track-only on album menus; hide open-album when already in this album
    if (btn.dataset.action === "open-album") {
      btn.classList.toggle("hidden", isAlbum || alreadyInThisAlbum);
    } else {
      btn.classList.toggle("hidden", isAlbum);
    }
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

  clearTimeout(contextMenuCloseTimer);
  contextMenu.classList.remove("is-closing");
  contextMenu.classList.remove("hidden");
  // restart the open animation (also when it is re-opened somewhere else)
  contextMenu.style.animation = "none";
  void contextMenu.offsetWidth;
  contextMenu.style.animation = "";
  const menuW = contextMenu.offsetWidth || 260;
  const menuH = contextMenu.offsetHeight || 160;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - menuW - 8)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - menuH - 8)}px`;

  armClickSuppress(600);
  document.body.classList.add("context-menu-open");
}

function bindContextMenu() {
      contextMenu?.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!contextTrack) return;
      const { game, track, album } = contextTrack;
      const action = btn.dataset.action;

      const cover = game?.cover || PLACEHOLDER;
      const albumName = game?.fullscreenName || game?.short || game?.title || "Album";
      const trackName = track?.title || "";

      if (album && game) {
        if (action === "play-next") {
          addAlbumPlayNext(game);
          hideContextMenu();
          showToast({
            cover,
            title: albumName,
            sub: "Album wird als Nächstes abgespielt.",
          });
          return;
        }
        if (action === "add-end") {
          addAlbumToEnd(game);
          hideContextMenu();
          showToast({
            cover,
            title: albumName,
            sub: "Album ans Ende der Queue sortiert.",
          });
          return;
        }
        if (action === "shuffle-into") {
          shuffleAlbumIntoQueue(game);
          hideContextMenu();
          showToast({
            cover,
            title: albumName,
            sub: "Album In die Queue gemischt.",
          });
          return;
        }
      } else if (game && track) {
        if (action === "play-next") {
          addPlayNext(game, track);
          hideContextMenu();
          showToast({
            cover,
            title: trackName,
            sub: `Song wird als Nächstes abgespielt.`,
          });
          return;
        }
        if (action === "add-end") {
          addToEnd(game, track);
          hideContextMenu();
          showToast({
            cover,
            title: trackName,
            sub: `Song ans Ende der Queue sortiert.`,
          });
          return;
        }
        if (action === "open-album") {
          hideContextMenu();
          if (!$("#fullscreen-player")?.classList.contains("hidden")) {
            toggleFullscreen();
          }
          if (globalSearchOpen) {
            const q = $("#global-search-input")?.value?.trim() || "";
            if (q) searchReturn = { type: "search", query: q };
            globalSearchOpen = false;
            document.body.classList.remove("search-open", "search-mode");
            $("#global-search-results")?.classList.add("hidden");
          }
          openGame(game.id);
          return;
        }
      }
    });
  });


  // Capture: kill the ghost click that fires after a long-press opens the menu
  document.addEventListener(
    "click",
    (e) => {
      if (performance.now() >= suppressNextClickUntil) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  document.addEventListener("click", (e) => {
    if (performance.now() < suppressDocClickUntil) return;
    if (e.target.closest("#context-menu")) return;
    if (e.target.closest(".track-actions")) return;
    if (e.target.closest("#album-menu-btn")) return;
    // player-left / fs now-playing use click for fullscreen — don't special-case them here
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

  // ── Now-playing (bottom bar + fullscreen) ──
  function openNowPlayingContext(x, y) {
    if (state.queueIndex < 0 || !state.queue.length) return;
    const item = state.queue[state.queueIndex];
    if (!item) return;
    const game = LIBRARY.find((g) => g.id === item.gameId);
    if (!game) return;
    showContextMenu(x, y, { game, track: item.track, fromQueue: true });
  }

  function bindNowPlayingTarget(el) {
    if (!el || el.dataset.ctxBound === "1") return;
    el.dataset.ctxBound = "1";

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openNowPlayingContext(e.clientX, e.clientY);
    });

    const isFsArt =
      el.id === "fs-cover" || el.id === "fs-title" || el.id === "fs-game";
    const isPlayerLeft =
      el.id === "player-left" || el.classList?.contains("player-left");

    if (isFsArt || isPlayerLeft) {
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        if (el.dataset.suppressClick === "1") {
          delete el.dataset.suppressClick;
          return;
        }
        if (performance.now() < suppressDocClickUntil) return;
        if (isFsArt) {
          e.preventDefault();
          togglePlay();
        } else if (isPlayerLeft) {
          e.preventDefault();
          if ($("#fullscreen-player")?.classList.contains("hidden")) {
            toggleFullscreen();
          }
        }
      });
    }

    let lpTimer = null;
    let lpMoved = false;
    el.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "mouse") return;
        lpMoved = false;
        const x = e.clientX;
        const y = e.clientY;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (lpMoved) return;
          openNowPlayingContext(x, y);
          el.dataset.suppressClick = "1";
          suppressDocClickUntil = performance.now() + 600;
        }, 480);
      },
      { passive: true }
    );
    el.addEventListener(
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
      clearTimeout(lpTimer);
      lpTimer = null;
    };
    el.addEventListener("pointerup", cancelLp);
    el.addEventListener("pointercancel", cancelLp);
  }

  bindNowPlayingTarget($("#player-left"));
  bindNowPlayingTarget($("#fs-cover"));
  bindNowPlayingTarget($("#fs-title"));
  bindNowPlayingTarget($("#fs-game"));
}

const PRESS_MIN_MS_MOUSE = 120; // lower on mouse
const PRESS_MIN_MS_TOUCH = 160; // higher on touchscreen

function pressMinMs(e) {
  // pointerType: "touch" | "pen" | "mouse"
  if (e?.pointerType === "touch" || e?.pointerType === "pen") {
    return PRESS_MIN_MS_TOUCH;
  }
  // fallback: coarse pointer (phones/tablets without reliable pointerType)
  if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
    return PRESS_MIN_MS_TOUCH;
  }
  return PRESS_MIN_MS_MOUSE;
}

function bindPressMinHold(root = document) {
    const selector =
    ".ctrl-btn, .play-btn, #btn-play, .primary-btn, .tab, .back-btn, .settings-btn, .circle-btn, .header-toggle-btn, .fs-back-btn, .confirm-btn, .game-card, .games-view-btn, .games-row-title, #play-all-btn, #shuffle-all-btn, #album-menu-btn, #settings-reset-btn, .gs-tool-btn, .gs-chip, .context-menu button, #loop-menu button, [data-loop-delta]";

  root.querySelectorAll(selector).forEach((btn) => {
    if (btn.dataset.pressBound === "1") return;
    btn.dataset.pressBound = "1";

    let downAt = 0;
    let minHold = PRESS_MIN_MS_MOUSE;
    let clearTimer = null;
    let pointerId = null;

    const clear = () => {
      const elapsed = performance.now() - downAt;
      const wait = Math.max(0, minHold - elapsed);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        btn.classList.remove("is-pressed");
        pointerId = null;
      }, wait);
    };

    btn.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button != null && e.button !== 0) return;
        clearTimeout(clearTimer);
        downAt = performance.now();
        minHold = pressMinMs(e);
        pointerId = e.pointerId;
        btn.classList.add("is-pressed");
        try {
          btn.setPointerCapture(e.pointerId);
        } catch (_) {}
      },
      { passive: true }
    );

    // Only end press on up/cancel — NOT pointerleave
    // (play button swaps icons → would kill is-pressed instantly)
    btn.addEventListener(
      "pointerup",
      (e) => {
        if (pointerId != null && e.pointerId !== pointerId) return;
        try {
          btn.releasePointerCapture?.(e.pointerId);
        } catch (_) {}
        clear();
      },
      { passive: true }
    );

    btn.addEventListener(
      "pointercancel",
      (e) => {
        if (pointerId != null && e.pointerId !== pointerId) return;
        clear();
      },
      { passive: true }
    );

    btn.addEventListener(
      "lostpointercapture",
      () => {
        if (btn.classList.contains("is-pressed")) clear();
      },
      { passive: true }
    );
  });
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
  clearTimeout(settingsCloseTimer);
  $("#settings-view")?.classList.remove("is-closing");
  $("#settings-view")?.classList.remove("hidden");
  document.body.classList.add("settings-open");

  syncSettingsForm();
}

let settingsCloseTimer = null;

function closeSettings() {
  const view = $("#settings-view");
  if (!view || view.classList.contains("hidden") || view.classList.contains("is-closing")) return;

  // settings fade out on top while the page underneath already comes back
  view.classList.add("is-closing");
  clearTimeout(settingsCloseTimer);
  settingsCloseTimer = setTimeout(() => {
    view.classList.add("hidden");
    view.classList.remove("is-closing");
    document.body.classList.remove("settings-open");
  }, 290);

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

    const bindLoopStep = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", (e) => {
      settings[key] = clampInt(e.target.value, 1, 20, DEFAULT_SETTINGS[key]);
      e.target.value = String(settings[key]);
      saveSettings();
      updateLoopMenuLabels();
    });
    el.addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/[^\d]/g, "").slice(0, 2);
    });
  };
  bindLoopStep("#setting-loop-step-plus", "loopStepPlus");
  bindLoopStep("#setting-loop-step-minus", "loopStepMinus");

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

    $("#setting-normalize-volume")?.addEventListener("change", (e) => {
    settings.normalizeVolume = !!e.target.checked;
    saveSettings();
    // apply immediately if something is playing
    if (decodedBuffer && state.playing) {
      setTrackGainForPlay(state.queue[state.queueIndex]?.track, decodedBuffer);
      setVolume(masterVolume);
    } else if (useMediaEl) {
      setTrackGainForPlay(state.queue[state.queueIndex]?.track, null);
      setVolume(masterVolume);
    }
  });

  $("#setting-auto-collapse")?.addEventListener("change", (e) => {
    settings.autoCollapseAlbum = !!e.target.checked;
    saveSettings();
  });

  $("#settings-reset")?.addEventListener("click", () => {
    const keepVolume = masterVolume;
    settings = {
      ...DEFAULT_SETTINGS,
      volume: keepVolume,
    };
    saveSettings();
    syncSettingsForm();
    if (state.loopMode === "count") {
      state.loopsRemaining = settings.loopTimes;
      updatePlayerUI();
    }
  });

  const verEl = $("#settings-version");
  if (verEl) verEl.textContent = `Version ${APP_VERSION}`;
}

function syncSettingsForm() {
  const loopInput = $("#setting-loop-times");
  if (loopInput) loopInput.value = String(settings.loopTimes);

  const stepPlus = $("#setting-loop-step-plus");
  if (stepPlus) stepPlus.value = String(settings.loopStepPlus);
  const stepMinus = $("#setting-loop-step-minus");
  if (stepMinus) stepMinus.value = String(settings.loopStepMinus);

  const label = $("#setting-transition-label");
  if (label) label.textContent = `${settings.transitionSec} s`;


  const norm = $("#setting-normalize-volume");
  if (norm) norm.checked = !!settings.normalizeVolume;

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
  document.documentElement.classList.toggle("ios-standalone", isIOS() && isStandalone);
}

// call it
applyIpadStandaloneClass();

async function runDurationScan() {
  // Only the game you currently have open
  const game = state.currentGame;
  if (!game) {
    console.warn(
      "%c[Noma DEV] Open a game first, then scan.",
      "color:#ff8a8a;font-weight:bold"
    );
    alert("DEV: Öffne zuerst ein Spiel (Album), dann scannen.");
    return;
  }

  const tracks = game.tracks || [];
  if (!tracks.length) {
    console.warn("[Noma DEV] No tracks in", game.id);
    return;
  }

  console.log(
    `%c[Noma DEV] Scanning durations for: ${game.short || game.title} (${game.id})`,
    "color:#7c9cff;font-weight:bold"
  );

  const lines = [];
  const byId = {};

  for (const track of tracks) {
    const url = getTrackUrl(track);
    try {
      const sec = await getTrackDuration(url, {
        ...track,
        duration: undefined, // force re-read from file
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

  console.log("%c[Noma DEV] Paste helpers", "color:#7c9cff;font-weight:bold");
  console.log("— One line per track (paste into this game’s tracks in games.json):");
  console.log(lines.join("\n"));

  console.log("— Map by id:");
  console.log(JSON.stringify(byId, null, 2));

  console.log("— This game’s tracks with duration merged:");
  const mergedTracks = tracks.map((t) => ({
    ...t,
    duration: byId[t.id] ?? t.duration,
  }));
  console.log(JSON.stringify(mergedTracks, null, 2));

  console.log("%c[Noma DEV] Done.", "color:#7c9cff;font-weight:bold");
}

function mountDurationDevTool() {
  if (!DEV_DURATION_TOOL) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "dev-duration-scan";
  btn.textContent = "DEV: Scan open game";
  btn.title = "Scan durations for the currently open album only";
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
      btn.textContent = "DEV: Scan open game";
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

let sleepPanelCloseTimer = null;

function closeSleepPanel() {
  const panel = $("#sleep-panel");
  $("#btn-sleep")?.setAttribute("aria-expanded", "false");
  if (!panel || panel.classList.contains("hidden") || panel.classList.contains("is-closing")) return;
  panel.classList.add("is-closing");
  clearTimeout(sleepPanelCloseTimer);
  sleepPanelCloseTimer = setTimeout(() => {
    panel.classList.add("hidden");
    panel.classList.remove("is-closing");
  }, 200);
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
  closeSleepPanel();
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
  closeSleepPanel();
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
    const opening =
      panel?.classList.contains("hidden") || panel?.classList.contains("is-closing");
    if (opening) {
      if (typeof hideContextMenu === "function") hideContextMenu();
      if (typeof closeLoopMenu === "function") closeLoopMenu();
      $("#gs-filter-panel")?.classList.add("hidden");
      $("#gs-filter-panel")?.classList.remove("is-closing");
      $("#gs-sort-panel")?.classList.add("hidden");
      $("#gs-sort-panel")?.classList.remove("is-closing");
      clearTimeout(sleepPanelCloseTimer);
      panel.classList.remove("is-closing");
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
      closeSleepPanel();
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
    if (typeof closeLoopMenu === "function") closeLoopMenu();
    closeSleepPanel();
  });

  window.addEventListener("resize", () => positionSleepPanel(), { passive: true });
}

init();