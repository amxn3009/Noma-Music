import { Bfstm } from './bfstm.js';

let LIBRARY = [];

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
  loopTimes: 3,       // 1–99
  transitionSec: 5,   // 0 | 5 | 10
};

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    settings.loopTimes = clampInt(parsed.loopTimes, 1, 99, 3);
    settings.transitionSec = [0, 5, 10].includes(parsed.transitionSec)
      ? parsed.transitionSec
      : 5;
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
let lastLoopCycle = -1; // -1 = still in first playthrough (before any wrap)
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

function resetPlayerToIdle() {
  stopSource();
  if (typeof cancelTransition === "function") cancelTransition(false);
  transitioning = false;
  lastLoopCycle = -1;
  decodedBuffer = null;
  pauseOffset = 0;
  loopStartSample = 0;
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

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

const durationCache = new Map(); // url → seconds

async function getTrackDuration(url) {
  if (durationCache.has(url)) return durationCache.get(url);
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

  // Detect loop wraps via cycle index (stable; no multi-fire per frame)
  if (
    (state.loopMode === "off" || state.loopMode === "count") &&
    state.playing &&
    loopStart > 0 &&
    currentSource &&
    currentSource.loop &&
    !transitioning &&
    audioCtx
  ) {
    const absoluteElapsed = pauseOffset + (audioCtx.currentTime - startTime);

    if (absoluteElapsed < duration) {
      // Still in the intro / first pass
      lastLoopCycle = -1;
    } else {
      const loopLen = Math.max(0.001, duration - loopStart);
      // 0 = first time we crossed the end, 1 = second wrap, ...
      const cycle = Math.floor((absoluteElapsed - duration) / loopLen);

      if (cycle > lastLoopCycle) {
        lastLoopCycle = cycle;

        if (state.loopMode === "off") {
          // First wrap → outro (same as before)
          startTransition();
        } else if (state.loopMode === "count") {
          if (state.loopsRemaining <= 1) {
            state.loopsRemaining = 0;
            updatePlayerUI();
            startTransition();
          } else {
            state.loopsRemaining -= 1;
            updatePlayerUI();
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
  const loopStart = getLoopStartSec();
  let offset = Math.max(0, offsetSeconds);

  // cancel any ongoing transition when starting fresh
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
  // off / count: keep hardware loop until we decide to fade out
  const wantSoftEnd =
    (state.loopMode === "off" || state.loopMode === "count") &&
    loopStart > 0 &&
    !transitioning;

  if (wantInfiniteLoop || wantSoftEnd) {
    currentSource.loop = true;
    if (loopStart > 0) {
      currentSource.loopStart = loopStart;
      currentSource.loopEnd = duration;
    }
    if (offset >= duration && loopStart > 0) {
      const loopLen = duration - loopStart;
      offset = loopStart + ((offset - duration) % loopLen);
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
  cancelTransition(false);
  nextTrack(true); // force advance, no new transition on same tick
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
        nextTrack();
        handled = true;
        break;
      case "ArrowRight":
        e.preventDefault();
        prevTrack();
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
      channelData[i] = src[i] / 32768;
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

  // Composer
  const composerName = $("#game-composer-name");
  if (composerName) {
    composerName.textContent = game.composer || "";
  }
  const composerEl = $("#game-composer");
  if (composerEl) {
    composerEl.style.display = game.composer ? "" : "none";
  }

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

  // Load durations in the background
  game.tracks.forEach(async (t) => {
    const sec = await getTrackDuration(t.file);
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

  // ← outside the forEach
  const currentId = getCurrentTrackId();
  if (currentId) {
    markPlayingTrack(currentId);
  }

  $("#play-all-btn").onclick = () => {
    state.queue = game.tracks.map((t) => ({ gameId: game.id, track: t }));
    state.queueIndex = 0;
    state.shuffle = false;
      if (state.loopMode === "count") {
    state.loopsRemaining = settings.loopTimes;
  } else {
    state.loopsRemaining = 0;
  }
    playCurrent();
    renderQueue();
  };

  $("#shuffle-all-btn").onclick = () => {
    const items = game.tracks.map((t) => ({ gameId: game.id, track: t }));
    // Fisher–Yates
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
  const idx = game.tracks.findIndex((t) => t.id === track.id);
  state.queue = game.tracks.map((t) => ({ gameId: game.id, track: t }));
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

  if (state.loopMode === "count") {
    state.loopsRemaining = Number(settings.loopTimes) || 3;
  }

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

  try {
    const decoded = await decodeBfstm(track.file);
    decodedBuffer = decoded.audioBuffer;
    loopStartSample = decoded.loopStartSample;
    sampleRate = decoded.sampleRate;

    state.duration = decodedBuffer.duration;
    state.currentTime = 0;

    playBuffer(decodedBuffer, 0);
    // end of playCurrent success path, and inside markPlayingTrack:
    if (!$("#queue-panel")?.classList.contains("hidden")) renderQueue();
  } catch (err) {
    console.error("[Noma] BFSTM decode/play failed:", err);
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
    // freeze transition clock via pauseOffset style for normal pos
    if (transitioning && audioCtx) {
      // keep transitioning true; just stop the source clock
      // gain ramp is scheduled on AudioParam — pause by suspending ctx is heavy;
      // simpler: store how far into the 5s we are
      const t = audioCtx.currentTime - transitionStartedAt;
      pauseOffset = t; // reuse as transition progress when paused
      if (currentGain) {
        currentGain.gain.cancelScheduledValues(audioCtx.currentTime);
        // hold current gain level
        const g = currentGain.gain.value;
        currentGain.gain.setValueAtTime(g, audioCtx.currentTime);
      }
      stopSource(); // stops buffer; we'll resume transition on play
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
    // resume fade from remaining time
    const already = pauseOffset; // seconds into the 5s
    const remaining = Math.max(0.05, getTransitionSec() - already);
    playBuffer(decodedBuffer, getLoopStartSec()); // continue near loop region
    // re-apply partial fade
    if (currentGain && audioCtx) {
      const now = audioCtx.currentTime;
      const startGain = masterVolume * (1 - already / getTransitionSec());
      currentGain.gain.cancelScheduledValues(now);
      currentGain.gain.setValueAtTime(startGain, now);
      currentGain.gain.linearRampToValueAtTime(0, now + remaining);
      transitionStartedAt = now - already;
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

  if (state.shuffle) {
    state.queueIndex = Math.floor(Math.random() * state.queue.length);
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  }
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
    state.loopsRemaining = settings.loopTimes;
  } else {
    state.loopsRemaining = 0;
  }

  updatePlayerUI();

  if (decodedBuffer) {
    const pos = getPlaybackPosition();
    if (state.playing) {
      playBuffer(decodedBuffer, pos);
    }
  }
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  updatePlayerUI();
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
  const item = { gameId: game.id, track };
  if (state.queueIndex < 0) {
    state.queue = [item];
    state.queueIndex = 0;
    playCurrent();
    return;
  }
  state.queue.splice(state.queueIndex + 1, 0, item);
  renderQueue();
}

function addToEnd(game, track) {
  state.queue.push({ gameId: game.id, track });
  if (state.queueIndex < 0) {
    state.queueIndex = 0;
    playCurrent();
  }
  renderQueue();
}

function renderQueue() {
  const list = $("#queue-list");
  if (!list) return;

  const currentId = getCurrentTrackId();

  list.innerHTML = state.queue
    .map((item, i) => {
      const game = LIBRARY.find((g) => g.id === item.gameId);
      const isCurrent = i === state.queueIndex;
      const file = item.track.file;
      return `
      <li class="queue-item ${isCurrent ? "current" : ""} ${isCurrent && state.playing ? "audio-on" : ""}"
          data-index="${i}" draggable="false">
        <span class="q-drag" title="Ziehen" draggable="true" data-drag-handle="1">
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
        <button class="q-remove" type="button" title="Entfernen" data-remove="${i}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </li>`;
    })
    .join("");

  // durations
  state.queue.forEach(async (item) => {
    const sec = await getTrackDuration(item.track.file);
    if (sec == null) return;
    list.querySelectorAll(`.q-duration[data-file="${CSS.escape(item.track.file)}"]`)
      .forEach((el) => { el.textContent = formatTime(sec); });
  });

  bindQueueItemEvents(list);
}

function bindQueueItemEvents(list) {
  list.querySelectorAll(".queue-item").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".q-drag") || e.target.closest(".q-remove")) return;
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
  });

  list.querySelectorAll(".q-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromQueue(+btn.dataset.remove);
    });
  });

  // Drag only from handle
  let dragFrom = -1;
  list.querySelectorAll(".q-drag").forEach((handle) => {
    handle.addEventListener("dragstart", (e) => {
      dragFrom = +handle.closest(".queue-item").dataset.index;
      e.dataTransfer.effectAllowed = "move";
      handle.closest(".queue-item")?.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => {
      list.querySelectorAll(".queue-item").forEach((el) => el.classList.remove("dragging", "drag-over"));
      dragFrom = -1;
    });
  });

  list.querySelectorAll(".queue-item").forEach((row) => {
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drag-over");
      autoScrollQueue(e.clientY);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const to = +row.dataset.index;
      if (dragFrom < 0 || dragFrom === to) return;
      reorderQueue(dragFrom, to);
    });
  });
}

function reorderQueue(from, to) {
  const item = state.queue.splice(from, 1)[0];
  state.queue.splice(to, 0, item);
  if (state.queueIndex === from) state.queueIndex = to;
  else if (from < state.queueIndex && to >= state.queueIndex) state.queueIndex--;
  else if (from > state.queueIndex && to <= state.queueIndex) state.queueIndex++;
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
  const btnFs = $("#btn-fullscreen");
  const btnMin = $("#btn-minimize");

  btnFs?.addEventListener("click", () => {
    $("#fullscreen-player").classList.remove("hidden");
    document.body.classList.add("fs-open");
    btnFs.classList.add("hidden");
    btnMin?.classList.remove("hidden");
  });

  btnMin?.addEventListener("click", () => {
    $("#fullscreen-player").classList.add("hidden");
    document.body.classList.remove("fs-open");
    btnMin.classList.add("hidden");
    btnFs?.classList.remove("hidden");
  });
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

  // sync form
  const loopInput = $("#setting-loop-times");
  const transSelect = $("#setting-transition");
  if (loopInput) loopInput.value = String(settings.loopTimes);
  if (transSelect) transSelect.value = String(settings.transitionSec);
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
    settings.loopTimes = clampInt(e.target.value, 1, 99, 3);
    e.target.value = String(settings.loopTimes);
    saveSettings();
    // if currently in count mode and not mid-song countdown preference: refresh badge default
    if (state.loopMode === "count" && !state.playing) {
      state.loopsRemaining = settings.loopTimes;
      updatePlayerUI();
    }
  });

  $("#setting-loop-times")?.addEventListener("input", (e) => {
    // strip non-digits while typing
    e.target.value = e.target.value.replace(/[^\d]/g, "").slice(0, 2);
  });

  $("#setting-transition")?.addEventListener("change", (e) => {
    const v = Number(e.target.value);
    settings.transitionSec = [0, 5, 10].includes(v) ? v : 5;
    saveSettings();
  });

  $("#settings-reset")?.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    const loopInput = $("#setting-loop-times");
    const transSelect = $("#setting-transition");
    if (loopInput) loopInput.value = String(settings.loopTimes);
    if (transSelect) transSelect.value = String(settings.transitionSec);
    if (state.loopMode === "count") {
      state.loopsRemaining = settings.loopTimes;
      updatePlayerUI();
    }
  });
}

init();