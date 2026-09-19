import { Bfstm } from './bfstm.js';

const LIBRARY = [
  {
    id: "oot",
    title: "The Legend of Zelda: Ocarina of Time",
    short: "Ocarina of Time",
    composer: "Koji Kondo",
    cover: "Assets/Games/OOT/AlbumCover/AlbumCover_OOT.jpg",
    tracks: [
      {
        id: "oot-title",
        title: "Title Theme",
        file: "Assets/Games/OOT/Tracks/Title Theme.bfstm",
      },
    ],
  },
];

const state = {
  currentGame: null,
  queue: [],
  queueIndex: -1,
  playing: false,
  shuffle: false,
  loopMode: "off", // "off" | "one" | "count"
  loopCount: 1,
  loopsDone: 0,
  duration: 0,
  currentTime: 0,
};

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

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
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

  const elapsed = getPlaybackPosition();
  const duration = decodedBuffer.duration;

  state.currentTime = elapsed;
  state.duration = duration;

  const ratio = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 0;

  const fill = $("#progress-fill");
  if (fill) fill.style.width = `${ratio * 100}%`;
  const tCur = $("#time-current");
  if (tCur) tCur.textContent = formatTime(elapsed);
  const tTot = $("#time-total");
  if (tTot) tTot.textContent = formatTime(duration);

  const fsFill = $("#fs-progress-fill");
  if (fsFill) fsFill.style.width = `${ratio * 100}%`;
  const fsCur = $("#fs-time-current");
  if (fsCur) fsCur.textContent = formatTime(elapsed);
  const fsTot = $("#fs-time-total");
  if (fsTot) fsTot.textContent = formatTime(duration);

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

  currentSource = ctx.createBufferSource();
  currentSource.buffer = audioBuffer;
  currentGain = ctx.createGain();
  currentSource.connect(currentGain);
  currentGain.connect(ctx.destination);

  if (state.loopMode === "one") {
    currentSource.loop = true;
    if (loopStart > 0) {
      currentSource.loopStart = loopStart;
      currentSource.loopEnd = duration;
    }
    // If offset is past duration, map into loop region
    if (offset >= duration && loopStart > 0) {
      const loopLen = duration - loopStart;
      offset = loopStart + ((offset - duration) % loopLen);
    }
  } else {
    currentSource.loop = false;
    offset = Math.min(offset, Math.max(0, duration - 0.01));
  }

  currentSource.onended = () => {
    if (!state.playing) return;
    nextTrack();
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

function init() {
  renderGames();
  bindTabs();
  bindPlayerChrome();
  bindQueuePanel();
  bindFullscreen();
  bindContextMenu();
  updatePlayerUI();
  $("#now-cover").src = PLACEHOLDER;
  $("#fs-cover").src = PLACEHOLDER;
  bgLayer.style.backgroundImage = `url("${PLACEHOLDER}")`;
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
      <span class="track-actions" data-action="menu">⋮</span>
    </div>
  `
    )
    .join("");

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
    state.loopsDone = 0;
    playCurrent();
  };
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      gameDetail.classList.add("hidden");
      gameDetail.classList.remove("active");
      const panel = $(`#tab-${tab.dataset.tab}`);
      if (panel) panel.classList.add("active");
    });
  });

  $("#back-to-games").addEventListener("click", () => {
    gameDetail.classList.add("hidden");
    gameDetail.classList.remove("active");
    tabGames.classList.add("active");
    document.querySelector('.tab[data-tab="games"]').classList.add("active");
  });
}

function playFromGame(game, track) {
  const idx = game.tracks.findIndex((t) => t.id === track.id);
  state.queue = game.tracks.slice(idx).map((t) => ({ gameId: game.id, track: t }));
  state.queueIndex = 0;
  state.loopsDone = 0;
  playCurrent();
}

async function playCurrent() {
  const item = state.queue[state.queueIndex];
  if (!item) return;

  const game = LIBRARY.find((g) => g.id === item.gameId);
  const track = item.track;

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
  document.querySelectorAll(".track-row").forEach((row) => {
    const isCurrent = trackId && row.dataset.trackId === trackId;
    row.classList.toggle("playing", isCurrent);
    row.classList.toggle("audio-on", isCurrent && state.playing);
  });
}


function togglePlay() {
  if (state.queueIndex < 0 && state.queue.length === 0) return;

  if (state.playing) {
    // Pause: freeze at the true current position
    pauseOffset = getPlaybackPosition();
    stopSource();
    state.playing = false;
    document.body.classList.remove("is-playing");
    markPlayingTrack(getCurrentTrackId()); // keeps .playing, removes .audio-on
  } else if (decodedBuffer) {
    // Resume from exact position (not loop start)
    playBuffer(decodedBuffer, pauseOffset);
  } else {
    playCurrent();
  }
  updatePlayerUI();
}

function nextTrack() {
  if (state.queue.length === 0) return;
  if (state.shuffle) {
    state.queueIndex = Math.floor(Math.random() * state.queue.length);
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  }
  state.loopsDone = 0;
  playCurrent();
}

function prevTrack() {
  if (state.queue.length === 0) return;
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  state.loopsDone = 0;
  playCurrent();
}

function toggleLoop() {
  const modes = ["off", "one", "count"];
  const i = modes.indexOf(state.loopMode);
  state.loopMode = modes[(i + 1) % modes.length];
  updatePlayerUI();
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
  list.innerHTML = state.queue
    .map((item, i) => {
      const game = LIBRARY.find((g) => g.id === item.gameId);
      return `
      <li class="queue-item ${i === state.queueIndex ? "current" : ""}">
        <span>${escapeHtml(item.track.title)}</span>
        <span class="muted" style="margin-left:auto;font-size:0.75rem">${escapeHtml(game?.short || "")}</span>
      </li>`;
    })
    .join("");
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
  bar?.addEventListener("click", (e) => {
    if (!decodedBuffer) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const seekTo = ratio * decodedBuffer.duration;
    if (state.playing) {
      playBuffer(decodedBuffer, seekTo);
    } else {
      pauseOffset = seekTo;
      $("#progress-fill").style.width = `${ratio * 100}%`;
      $("#time-current").textContent = formatTime(seekTo);
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init();