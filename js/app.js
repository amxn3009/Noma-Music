const LIBRARY = [
  {
    id: "oot",
    title: "The Legend of Zelda: Ocarina of Time",
    short: "Ocarina of Time",
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
  loopMode: "off",
  loopCount: 1,
  loopsDone: 0,
  duration: 0,
  currentTime: 0,
};

const PLACEHOLDER = "Assets/MusicPlayer/PlaceholderImage.jpg"

const $ = (sel) => document.querySelector(sel);
const gamesGrid = $("#games-grid");
const gameDetail = $("#game-detail");
const tabGames = $("#tab-games");
const tabPlaylists = $("#tab-playlists");
const trackListEl = $("#track-list");
const bgLayer = $("#bg-layer");
const contextMenu = $("#context-menu");

let contextTrack = null;

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

  trackListEl.innerHTML = game.tracks
    .map(
      (t, i) => `
    <div class="track-row" data-track-id="${t.id}" data-index="${i}">
      <span class="track-num">${i + 1}</span>
      <span class="track-name">${escapeHtml(t.title)}</span>
      <span class="track-actions">⋮</span>
    </div>
  `
    )
    .join("");

  trackListEl.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("track-actions")) return;
      const track = game.tracks[+row.dataset.index];
      playFromGame(game, track);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const track = game.tracks[+row.dataset.index];
      showContextMenu(e.clientX, e.clientY, { game, track, fromQueue: false });
    });
  });

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

function playCurrent() {
  const item = state.queue[state.queueIndex];
  if (!item) return;

  const game = LIBRARY.find((g) => g.id === item.gameId);
  const track = item.track;

  $("#now-cover").src = game?.cover || "";
  $("#now-title").textContent = track.title;
  $("#now-game").textContent = game?.short || "";
  $("#fs-cover").src = game?.cover || "";
  $("#fs-title").textContent = track.title;
  $("#fs-game").textContent = game?.short || "";
  bgLayer.style.backgroundImage = game?.cover ? `url("${game.cover}")` : "none";

  bgLayer.style.backgroundImage = game?.cover ? `url("${game.cover}")` : "none";
  document.body.classList.add("is-playing");

  markPlayingTrack(track.id);

  console.log("[Noma] Would play:", track.file);
  state.playing = true;
  state.duration = 0;
  state.currentTime = 0;
  updatePlayerUI();

  alert(
    `Player-UI ist bereit.\n\nNächster Schritt: BFSTM-Decoder.\n\nDatei:\n${track.file}`
  );
  state.playing = false;
  document.body.classList.remove("is-playing");
  updatePlayerUI();
}

function markPlayingTrack(trackId) {
  document.querySelectorAll(".track-row").forEach((row) => {
    row.classList.toggle("playing", row.dataset.trackId === trackId);
  });
}

function togglePlay() {
  if (state.queueIndex < 0 && state.queue.length === 0) return;
  state.playing = !state.playing;
  document.body.classList.toggle("is-playing", state.playing);
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
  $("#btn-loop").classList.toggle("active", state.loopMode !== "off");
  $("#btn-shuffle").classList.toggle("active", state.shuffle);
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
  $("#btn-queue").addEventListener("click", () => {
    const panel = $("#queue-panel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) renderQueue();
  });
  $("#queue-close").addEventListener("click", () => {
    $("#queue-panel").classList.add("hidden");
  });
}

function bindFullscreen() {
  const btnFs = $("#btn-fullscreen");
  const btnMin = $("#btn-minimize");

  btnFs.addEventListener("click", () => {
    $("#fullscreen-player").classList.remove("hidden");
    document.body.classList.add("fs-open");
    btnFs.classList.add("hidden");
    btnMin.classList.remove("hidden");
  });

  btnMin.addEventListener("click", () => {
    $("#fullscreen-player").classList.add("hidden");
    document.body.classList.remove("fs-open");
    btnMin.classList.add("hidden");
    btnFs.classList.remove("hidden");
  });
}

function showContextMenu(x, y, payload) {
  contextTrack = payload;
  contextMenu.classList.remove("hidden");
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
}

function bindContextMenu() {
  contextMenu.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!contextTrack) return;
      const { game, track } = contextTrack;
      const action = btn.dataset.action;
      if (action === "play-next") addPlayNext(game, track);
      if (action === "add-end") addToEnd(game, track);
      contextMenu.classList.add("hidden");
    });
  });
  document.addEventListener("click", () => contextMenu.classList.add("hidden"));
}

function bindPlayerChrome() {
  $("#btn-play").addEventListener("click", togglePlay);
  $("#btn-prev").addEventListener("click", prevTrack);
  $("#btn-next").addEventListener("click", nextTrack);
  $("#btn-loop").addEventListener("click", toggleLoop);
  $("#btn-shuffle").addEventListener("click", toggleShuffle);

  const bar = $("#progress-bar");
  bar.addEventListener("click", (e) => {
    const rect = bar.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    $("#progress-fill").style.width = `${ratio * 100}%`;
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