import { Bfstm } from './bfstm.js';

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

let transitioning = false;
let transitionStartedAt = 0; // audioCtx.currentTime
let transitionProgress = 0; // seconds into the fade when paused
let lastLoopCycle = -1; // -1 = still in first playthrough (before any wrap)
let forceFullLoop = false; // true when track has LoopFromStoE
let scrubbing = false;

const PLACEHOLDER = "Assets/MusicPlayer/PlaceholderImage.jpg";

const $ = (sel) => document.querySelector(sel);
const gamesGrid = $("#games-grid");
const gameDetail = $("#game-detail");
const tabGames = $("#tab-games");
const tabPlaylists = $("#tab-playlists");
const trackListEl = $("#track-list");
const bgLayer = $("#bg-layer");
const contextMenu = $("#context-menu");

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
function getTrackUrl(track) {
  if (!track) return "";
  if (isIOS() && track.fileIos) return track.fileIos;
  return track.file;
}
function isWebAudioFile(url) {
  return /\.(opus|m4a|mp3|wav|ogg)($|\?)/i.test(url || "");
}
async function resumeAudio() {
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}
async function decodeWebAudio(url) {
  const ctx = await resumeAudio();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return ctx.decodeAudioData(buf.slice(0));
}

function resetPlayerToIdle() {
  stopSource();
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

  document.body.classList.remove("is-playing", "is-transitioning");

  $("#now-cover").src = PLACEHOLDER;
  $("#now-title").textContent = "Nichts läuft";
  $("#now-game").textContent = "Keinen Song ausgewählt";

  $("#fs-cover").src = PLACEHOLDER;
  $("#fs-title").textContent = "Nichts läuft";
  $("#fs-game").textContent = "Keinen Song ausgewählt";

  if (bgLayer) bgLayer.style.backgroundImage = `url("${PLACEHOLDER}")`;

  const fill = $("#progress-fill");
  if (fill) fill.style.width = "0%";
  const tCur = $("#time-current");
  if (tCur) tCur.textContent = "0:00";
  const tTot = $("#time-total");
  if (tTot) tTot.textContent = "0:00";

  markPlayingTrack(null);
  updatePlayerUI();
  renderQueue();
}

function isIOS() {
  const ua = navigator.userAgent || "";
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ may report as Mac
  const iPadOs =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOs;
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
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// at start of playCurrent / togglePlay when starting sound:
async function resumeAudio() {
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

const durationCache = new Map(); // url → seconds

<<<<<<< HEAD
=======
async function decodeWebAudio(url) {
  const ctx = await resumeAudio();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
  return audioBuffer;
}

function isOpusUrl(url) {
  return /\.opus($|\?)/i.test(url || "");
}

>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
async function getTrackDuration(url, track) {
  if (track && Number.isFinite(track.duration) && track.duration > 0) {
    durationCache.set(url, track.duration);
    return track.duration;
  }
  if (durationCache.has(url)) return durationCache.get(url);

<<<<<<< HEAD
  if (isWebAudioFile(url)) {
    try {
      const audioBuffer = await decodeWebAudio(url);
=======
  // Opus/WAV: decode once for length (only if no JSON duration)
  if (isOpusUrl(url) || /\.(wav|m4a|mp3|ogg)($|\?)/i.test(url || "")) {
    try {
      const ctx = ensureAudioContext();
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const buf = await res.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
      durationCache.set(url, audioBuffer.duration);
      return audioBuffer.duration;
    } catch (err) {
      console.warn("[Noma] duration failed:", url, err);
      return null;
    }
  }

<<<<<<< HEAD
=======
  // BFSTM fallback
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
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

function stopSource() {
  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch (_) {}
    currentSource.disconnect();
    currentSource = null;
  }
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getLoopStartSec() {
  if (forceFullLoop) return 0;
  return loopStartSample > 0 ? loopStartSample / sampleRate : 0;
}

/** Actual playback position in seconds (handles intro + seamless loop). */
function getPlaybackPosition() {
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

  // With loop: first playthrough goes 0 → duration, then wraps into [loopStart, duration)
  if (elapsed < duration) {
    return Math.min(Math.max(0, elapsed), duration);
  }
  const loopLen = Math.max(0.001, duration - loopStart);
  const afterEnd = elapsed - duration;
  return loopStart + (afterEnd % loopLen);
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
  }
}

function playBuffer(audioBuffer, offsetSeconds = 0) {
  stopSource();
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
  currentGain.gain.value = masterVolume;
  currentSource.connect(currentGain);
  currentGain.connect(ctx.destination);

  const wantInfiniteLoop = state.loopMode === "one";
  // Soft end / count: BFSTM loop points OR full start→end loop
  const wantSoftEnd =
    (state.loopMode === "off" || state.loopMode === "count") &&
    (loopStart > 0 || forceFullLoop) &&
    !transitioning;

  if (wantInfiniteLoop || wantSoftEnd) {
    currentSource.loop = true;
    if (forceFullLoop) {
      // entire file repeats
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
    // no loop points / hard end
    nextTrack(true);
  };

  pauseOffset = offset;
  startTime = ctx.currentTime;
  currentSource.start(0, offset);

  state.playing = true;
  document.body.classList.add("is-playing");
  updatePlayerUI();
  markPlayingTrack(getCurrentTrackId());
  updateProgressUI();
}

function startTransition() {
  if (transitioning || !audioCtx || !currentGain) return;

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
  // Hard-mute before tearing down so nothing spikes for a frame
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
  stopSource();

  // Small delay so the silent frame is committed (helps mobile)
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

  if (!currentGain || !audioCtx) return;

  const now = audioCtx.currentTime;

  if (transitioning) {
    // Keep the fade to 0, but scale it to the new volume
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
  settings.volume = masterVolume;
  saveSettings();
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
  const fs = $("#fullscreen-player");
  const btnFs = $("#btn-fullscreen");
  const btnMin = $("#btn-minimize");
  if (!fs) return;

  const open = fs.classList.contains("hidden");
  if (open) {
    // Leave settings if open, then go fullscreen
    if (!$("#settings-view")?.classList.contains("hidden")) {
      closeSettings();
    }
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

async function decodeBfstm(url) {
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

  return {
    audioBuffer,
    loopStartSample: meta.loopFlag ? meta.loopStartSample : 0,
    sampleRate: meta.sampleRate,
    loopFlag: !!meta.loopFlag,
  };
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
  bindQueuePanel();
  bindFullscreen();
  bindContextMenu();
  updatePlayerUI();
  bindVolume();
  bindHotkeys();
  loadSettings();
  masterVolume = settings.volume ?? 1;
  const volSlider = $("#volume-slider");
  if (volSlider) volSlider.value = String(masterVolume);
  bindSettings();
  $("#now-cover").src = PLACEHOLDER;
  $("#fs-cover").src = PLACEHOLDER;
  $("#now-title").textContent = "Nichts läuft";
  $("#now-game").textContent = "Keinen Song ausgewählt";
  bgLayer.style.backgroundImage = `url("${PLACEHOLDER}")`;
  document.addEventListener("dragstart", (e) => {
    if (e.target instanceof HTMLImageElement) {
      e.preventDefault();
    }
  });
  mountDurationDevTool();
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
  $("#game-track-count").textContent = `${game.tracks.length} Titel`;

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
<<<<<<< HEAD
    const url = typeof getTrackUrl === "function" ? getTrackUrl(t) : t.file;
=======
    const url = getTrackUrl(t); // iOS → fileIos, else file
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
    const sec = await getTrackDuration(url, t);
    if (sec == null) return;
    const el = trackListEl.querySelector(
      `.track-duration[data-file="${CSS.escape(t.file)}"]`
    );
    if (el) el.textContent = formatTime(sec);
  });

  trackListEl.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".track-actions")) {
        e.preventDefault();
        e.stopPropagation();
        const track = game.tracks[+row.dataset.index];
        const rect = e.target.closest(".track-actions").getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 4, {
          game,
          track,
          fromQueue: false,
        });
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
  });

  const currentId = getCurrentTrackId();
  if (currentId) markPlayingTrack(currentId);

  $("#play-all-btn").onclick = () => {
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
  cancelTransition(false);

  const item = state.queue[state.queueIndex];
  if (!item) return;

  const game = LIBRARY.find((g) => g.id === item.gameId);
  const track = item.track;

<<<<<<< HEAD
  if (state.loopMode === "count") {
    state.loopsRemaining =
      Number(settings.loopTimes) || DEFAULT_SETTINGS.loopTimes;
=======
  // ── TEMP TEST: unlock audio on this user gesture ──
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
  }

  // ... your existing UI updates (cover, title, etc.) ...
  $("#now-cover").src = game?.cover || PLACEHOLDER;
  $("#now-title").textContent = track.title;
  $("#now-game").textContent = game?.short || "";
  $("#fs-cover").src = game?.cover || PLACEHOLDER;
  $("#fs-title").textContent = track.title;
  $("#fs-game").textContent = game?.short || "";
  bgLayer.style.backgroundImage = game?.cover ? `url("${game.cover}")` : "none";
  document.body.classList.add("is-playing");
  markPlayingTrack(track.id);

  stopSource();
  state.playing = false;
  pauseOffset = 0;
  updatePlayerUI();

<<<<<<< HEAD
  const url = typeof getTrackUrl === "function" ? getTrackUrl(track) : track.file;

  try {
    if (typeof resumeAudio === "function") {
      await resumeAudio();
    } else {
      ensureAudioContext();
    }

    // Opus / m4a / wav / …
    if (typeof isWebAudioFile === "function" && isWebAudioFile(url)) {
=======
     try {
    const url = getTrackUrl(track); // ← this is the iOS switch
    await resumeAudio();

    if (isWebAudioFile(url)) {
      // Opus / m4a / wav / …
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
      const audioBuffer = await decodeWebAudio(url);
      decodedBuffer = audioBuffer;
      sampleRate = audioBuffer.sampleRate;

      forceFullLoop = !!track.LoopFromStoE;
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
      if (!$("#queue-panel")?.classList.contains("hidden")) renderQueue();
      return;
    }

<<<<<<< HEAD
    // BFSTM
=======
    // Still .bfstm
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
    const decoded = await decodeBfstm(url);
    decodedBuffer = decoded.audioBuffer;
    loopStartSample = decoded.loopStartSample;
    sampleRate = decoded.sampleRate;
    forceFullLoop = !!track.LoopFromStoE;

<<<<<<< HEAD
    if (
      !forceFullLoop &&
      Number.isFinite(track.loopStart) &&
      track.loopStart > 0
    ) {
=======
    if (!forceFullLoop && Number.isFinite(track.loopStart) && track.loopStart > 0) {
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
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
    console.error("[Noma] decode/play failed:", err);
    alert(`Konnte Track nicht abspielen:\n${track.title}\n\n${err.message}`);
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


function togglePlay() {
  if (state.queueIndex < 0 && state.queue.length === 0) return;

  if (state.playing) {
    if (transitioning && audioCtx) {
      // How far into the fade we are
      transitionProgress = Math.max(0, audioCtx.currentTime - transitionStartedAt);
      // Real song position (not the 5s transition clock)
      pauseOffset = getPlaybackPosition();

      if (currentGain) {
        const now = audioCtx.currentTime;
        currentGain.gain.cancelScheduledValues(now);
        currentGain.gain.setValueAtTime(currentGain.gain.value, now);
      }
      stopSource();
      state.playing = false;
      document.body.classList.remove("is-playing");
      markPlayingTrack(getCurrentTrackId());
      updatePlayerUI();
      return;
    }

    pauseOffset = getPlaybackPosition();
    stopSource();
    state.playing = false;
    document.body.classList.remove("is-playing");
    markPlayingTrack(getCurrentTrackId());
  } else if (transitioning && decodedBuffer) {
    // Resume from the real pause point, continue the same fade
    const sec = getTransitionSec();
    const already = Math.min(sec, Math.max(0, transitionProgress));
    const remaining = Math.max(0.05, sec - already);

    playBuffer(decodedBuffer, pauseOffset); // ← was getLoopStartSec() before

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
  } else if (decodedBuffer) {
    playBuffer(decodedBuffer, pauseOffset);
  } else {
    playCurrent();
  }
  updatePlayerUI();
}

function nextTrack(fromNaturalEnd = false) {
  if (state.queue.length === 0) return;

  // Skip during transition → go straight to next
  if (transitioning) {
    cancelTransition(false);
    stopSource();
  }

  // Queue is already reordered when shuffle was enabled
  state.queueIndex = (state.queueIndex + 1) % state.queue.length;
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
  const dur = decodedBuffer?.duration ?? 0;

  // Restart current if past threshold OR already on first track
  if (state.queueIndex === 0 || (dur > RESTART_THRESHOLD && pos > RESTART_THRESHOLD)) {
    pauseOffset = 0;
    if (state.playing && decodedBuffer) {
      playBuffer(decodedBuffer, 0);
    } else {
      $("#progress-fill").style.width = "0%";
      $("#time-current").textContent = "0:00";
    }
    return;
  }

  state.queueIndex -= 1;
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

  // During outro: only update mode/UI, keep the fade going
  if (transitioning) return;

  if (decodedBuffer) {
    const pos = getPlaybackPosition();
    if (state.playing) {
      playBuffer(decodedBuffer, pos);
    }
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

function renderQueue() {
  const list = $("#queue-list");
  if (!list) return;

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
        <img class="q-cover" src="${game?.cover || PLACEHOLDER}" alt="">
        <span class="q-num">
          <span class="num">${i + 1}</span>
          <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="q-hover-play" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </span>
        </span>
        <div class="q-meta">
          <span class="q-title">${escapeHtml(item.track.title)}</span>
          <span class="q-game muted">${escapeHtml(game?.short || "")}</span>
        </div>
        <span class="q-duration" data-file="${escapeHtml(file)}">–:––</span>
        <span class="track-actions q-actions" data-action="menu">⋮</span>
        <button class="q-remove" type="button" title="Entfernen" data-remove="${i}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </li>`;
    })
    .join("");

  state.queue.forEach(async (item) => {
<<<<<<< HEAD
    const url =
      typeof getTrackUrl === "function" ? getTrackUrl(item.track) : item.track.file;
=======
    const url = getTrackUrl(item.track);
>>>>>>> 448f7a703f53b6f5ad0fc319ad4e873fde36843f
    const sec = await getTrackDuration(url, item.track);
    if (sec == null) return;
    list
      .querySelectorAll(`.q-duration[data-file="${CSS.escape(item.track.file)}"]`)
      .forEach((el) => {
        el.textContent = formatTime(sec);
      });
  });

  bindQueueItemEvents(list);
}

function bindQueueItemEvents(list) {
  // Click row → play / toggle
  list.querySelectorAll(".queue-item").forEach((row) => {
    row.addEventListener("click", (e) => {
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
  });

  // ⋮ button
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
      showContextMenu(rect.left, rect.bottom + 4, {
        game,
        track: item.track,
        fromQueue: true,
      });
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

  function clearDrag() {
    list.querySelectorAll(".queue-item").forEach((el) => {
      el.classList.remove("dragging", "drag-over");
    });
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    dragFrom = -1;
    draggingEl = null;
    moved = false;
  }

  list.querySelectorAll(".q-drag").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      const row = handle.closest(".queue-item");
      if (!row) return;

      contextMenu?.classList.add("hidden");
      dragFrom = +row.dataset.index;
      draggingEl = row;
      startY = e.clientY;
      moved = false;
      row.classList.add("dragging");

      ghost = makeGhost(row);
      moveGhost(e.clientX, e.clientY);

      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (dragFrom < 0 || !draggingEl) return;
      if (Math.abs(e.clientY - startY) > 4) moved = true;

      moveGhost(e.clientX, e.clientY);
      autoScrollQueue(e.clientY);

      list.querySelectorAll(".queue-item").forEach((el) => el.classList.remove("drag-over"));
      // Ignore the ghost under the cursor
      if (ghost) ghost.style.visibility = "hidden";
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (ghost) ghost.style.visibility = "visible";
      const over = el?.closest?.(".queue-item");
      if (over && over !== draggingEl) over.classList.add("drag-over");
    });

    handle.addEventListener("pointerup", (e) => {
      if (dragFrom < 0) return;

      if (moved) {
        if (ghost) ghost.style.visibility = "hidden";
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (ghost) ghost.style.visibility = "visible";
        const over = el?.closest?.(".queue-item");
        if (over) {
          const to = +over.dataset.index;
          if (to !== dragFrom && to >= 0) reorderQueue(dragFrom, to);
        }
      }

      clearDrag();
    });

    handle.addEventListener("pointercancel", () => {
      clearDrag();
    });
  });
}

function reorderQueue(from, to) {
  const item = state.queue.splice(from, 1)[0];
  state.queue.splice(to, 0, item);

  if (state.queueIndex === from) state.queueIndex = to;
  else if (from < state.queueIndex && to >= state.queueIndex) state.queueIndex--;
  else if (from > state.queueIndex && to <= state.queueIndex) state.queueIndex++;

  // This order is now the truth (also while shuffled)
  if (state.shuffle) {
    unshuffledQueue = cloneQueue(state.queue);
  }

  renderQueue();
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

function autoScrollQueue(clientY) {
  const panel = $("#queue-panel");
  const list = $("#queue-list");
  if (!panel || !list) return;
  const rect = list.getBoundingClientRect();
  const edge = 40;
  if (clientY < rect.top + edge) list.scrollTop -= 12;
  else if (clientY > rect.bottom - edge) list.scrollTop += 12;
}

function bindQueuePanel() {
  $("#btn-queue")?.addEventListener("click", () => {
    const panel = $("#queue-panel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) renderQueue();
  });
  $("#queue-close")?.addEventListener("click", () => {
    $("#queue-panel").classList.add("hidden");
  });
}

function bindFullscreen() {
  $("#btn-fullscreen")?.addEventListener("click", () => toggleFullscreen());
  $("#btn-minimize")?.addEventListener("click", () => toggleFullscreen());
}

function showContextMenu(x, y, payload) {
  contextTrack = payload;
  contextMenu.classList.remove("hidden");
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
}

function bindContextMenu() {
  contextMenu?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!contextTrack) return;
      const { game, track } = contextTrack;
      const action = btn.dataset.action;
      if (action === "play-next") addPlayNext(game, track);
      if (action === "add-end") addToEnd(game, track);
      contextMenu.classList.add("hidden");
    });
  });

  // Delay so the opening click doesn’t immediately close it
  document.addEventListener("click", (e) => {
    if (e.target.closest("#context-menu") || e.target.closest(".track-actions")) {
      return;
    }
    contextMenu?.classList.add("hidden");
  });
}

function bindPlayerChrome() {
  $("#btn-play")?.addEventListener("click", togglePlay);
  $("#btn-prev")?.addEventListener("click", prevTrack);
  $("#btn-next")?.addEventListener("click", nextTrack);
  $("#btn-loop")?.addEventListener("click", toggleLoop);
  $("#btn-shuffle")?.addEventListener("click", toggleShuffle);

  const bar = $("#progress-bar");
  if (!bar) return;

  function ratioFromClientX(clientX) {
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function paintSeek(ratio) {
    if (!decodedBuffer) return 0;
    const seekTo = ratio * decodedBuffer.duration;
    $("#progress-fill").style.width = `${ratio * 100}%`;
    $("#time-current").textContent = formatTime(seekTo);
    return seekTo;
  }

  bar.addEventListener("pointerdown", (e) => {
    if (!decodedBuffer || transitioning) return;
    scrubbing = true;
    document.body.classList.add("is-scrubbing");
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    paintSeek(ratioFromClientX(e.clientX));
    e.preventDefault();
  });

  window.addEventListener("pointermove", (e) => {
    if (!scrubbing || !decodedBuffer) return;
    paintSeek(ratioFromClientX(e.clientX));
  });

  window.addEventListener("pointerup", (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    document.body.classList.remove("is-scrubbing");

    if (!decodedBuffer) return;

    // cancel any transition logic that might have been pending
    if (typeof cancelTransition === "function") cancelTransition(true);
    lastLoopCycle = -1;

    const seekTo = paintSeek(ratioFromClientX(e.clientX));
    // stay a bit before the true end so we don't instantly fire onended / transition
    const safeEnd = Math.max(0, decodedBuffer.duration - 0.05);
    const pos = Math.min(seekTo, safeEnd);

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

  $("#settings-reset")?.addEventListener("click", () => {
    const keepVolume = masterVolume;
    settings = {
      loopTimes: DEFAULT_SETTINGS.loopTimes,
      transitionSec: DEFAULT_SETTINGS.transitionSec,
      volume: keepVolume,
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

init();