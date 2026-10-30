import { Bfstm } from './bfstm.js';
import { Kawarp } from 'https://cdn.jsdelivr.net/npm/@kawarp/core@1.3.1/+esm';
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://wzllacffejidrxyaebhc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_m-5kLd5u8UOezLAMxanf4g_-zwRZMYO"; // from Project Settings → API

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes("PASTE_")
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

/** Bump this every time you deploy so Settings shows you’re on the build you think. */
const APP_VERSION = "30.10.26, css changes, changed ios cache size + mobile fix #2";

let LIBRARY = [];

const DEV_DURATION_TOOL = false; // true only when scanning

const state = {
  currentGame: null,
  currentPlaylist: null,
  playingPlaylistId: null, // which playlist “owns” current playback
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
    quickAddEnabled: false,
    quickAddPlaylistId: "favorites",
};

const LIBRARY_KEY = "noma-library-v1";
const FAVORITES_ID = "favorites";

const DEFAULT_LIBRARY = {
  version: 1,
  playlists: [
    {
      id: FAVORITES_ID,
      name: "Lieblingssongs",
      type: "favorites",
      pinned: true,
      pinLocked: true,
      coverMode: "auto",
      coverSrc: null,
      tracks: [],
      createdAt: 0,
      updatedAt: 0,
      lastPlayedAt: 0,
    },
  ],
  libraryAlbums: [],
};

let userLib = structuredClone
  ? structuredClone(DEFAULT_LIBRARY)
  : JSON.parse(JSON.stringify(DEFAULT_LIBRARY));

const libPrefs = {
  filter: "playlists", // playlists | games | all
  sort: "recent", // recent | added | az
  dir: "desc",
  view: "grid", // grid | list
  query: "",
};

function loadUserLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) {
      saveUserLibrary();
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.playlists)) {
      saveUserLibrary();
      return;
    }
    userLib.version = 1;
    userLib.playlists = parsed.playlists;
    userLib.libraryAlbums = Array.isArray(parsed.libraryAlbums)
      ? parsed.libraryAlbums
      : [];
    userLib.libraryAlbums = (userLib.libraryAlbums || []).filter((gid) =>
    LIBRARY.some((g) => g.id === gid)
    );
    // Ensure favorites exists
    if (!userLib.playlists.some((p) => p.id === FAVORITES_ID)) {
      userLib.playlists.unshift({ ...DEFAULT_LIBRARY.playlists[0] });
    }
  } catch (_) {
    saveUserLibrary();
  }
}

function saveUserLibrary() {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(userLib));
  } catch (_) {}
  if (typeof scheduleCloudSync === "function") scheduleCloudSync();
}

/* ═══════════════ Supabase auth + cloud sync ═══════════════ */
const PROFILE_KEY = "noma-profile-v1";
const SYNC_META_KEY = "noma-sync-meta-v1";

const DEFAULT_PROFILE = { displayName: "" };

function loadProfile() {
  try {
    return { ...DEFAULT_PROFILE, ...(JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") || {}) };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}
function saveProfile(patch) {
  const next = { ...loadProfile(), ...patch };
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

function loadSyncMeta() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_META_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function saveSyncMeta(patch) {
  const next = { ...loadSyncMeta(), ...patch };
  try {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

function getDeviceId() {
  let id = loadSyncMeta().deviceId;
  if (!id) {
    id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    saveSyncMeta({ deviceId: id });
  }
  return id;
}

/** Settings blob for cloud — never includes volume */
function settingsForSync() {
  const s = { ...(typeof settings !== "undefined" ? settings : {}) };
  delete s.volume;
  return s;
}

/** Apply remote settings but keep local volume */
function applySyncedSettings(remoteSettings) {
  if (!remoteSettings || typeof remoteSettings !== "object") return;
  const localVol =
    typeof settings !== "undefined" && typeof settings.volume === "number"
      ? settings.volume
      : undefined;
  Object.assign(settings, remoteSettings);
  if (localVol !== undefined) settings.volume = localVol;
  if (typeof saveSettings === "function") saveSettings();
  else {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }
  if (typeof syncSettingsForm === "function") syncSettingsForm();
}

function applySyncedLibrary(remoteLib) {
  if (!remoteLib || !Array.isArray(remoteLib.playlists)) return;
  userLib.version = remoteLib.version || 1;
  userLib.playlists = remoteLib.playlists;
  userLib.libraryAlbums = Array.isArray(remoteLib.libraryAlbums)
    ? remoteLib.libraryAlbums
    : [];
  if (!userLib.playlists.some((p) => p.id === FAVORITES_ID)) {
    userLib.playlists.unshift({ ...DEFAULT_LIBRARY.playlists[0] });
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(userLib));
  } catch {}
  if (typeof renderLibrary === "function") renderLibrary({ animate: false });
  if (remoteLib.listenStats) {
    saveListenStats(remoteLib.listenStats);
  }
}

function applySyncedProfile(remoteProfile) {
  if (!remoteProfile || typeof remoteProfile !== "object") return;
  saveProfile(remoteProfile);
  const input = $("#profile-display-name");
  if (input && remoteProfile.displayName != null) {
    input.value = remoteProfile.displayName;
  }
  if (typeof updateProfileAvatar === "function") {
    updateProfileAvatar(remoteProfile.displayName || "");
  }
}

function formatSyncTime(ts) {
  if (!ts) return "—";
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function setProfileSyncUI({ status, hint, last } = {}) {
  const st = $("#profile-sync-status");
  const hi = $("#profile-sync-hint");
  const la = $("#profile-sync-last");
  if (st && status != null) st.textContent = status;
  if (hi && hint != null) hi.textContent = hint;
  if (la && last != null) la.textContent = last;
}

async function getAuthUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user || null;
}

function updateAuthPanels(user) {
  const guest = $("#profile-auth-guest");
  const authed = $("#profile-auth-user");
  if (!guest || !authed) return;
  if (user) {
    guest.classList.add("hidden");
    authed.classList.remove("hidden");
    const em = $("#profile-user-email");
    if (em) em.textContent = user.email || user.id;
  } else {
    guest.classList.remove("hidden");
    authed.classList.add("hidden");
    setProfileSyncUI({
      status: "Lokal",
      hint: "Melde dich an, um Bibliothek & Einstellungen zu syncen",
      last: "—",
    });
  }
}

/** Push local → cloud */
async function pushCloudSync() {
  if (!supabase) throw new Error("Supabase nicht konfiguriert");
  const user = await getAuthUser();
  if (!user) throw new Error("Nicht angemeldet");

  const row = {
    user_id: user.id,
    library: {
      version: userLib.version || 1,
      playlists: userLib.playlists,
      libraryAlbums: userLib.libraryAlbums || [],
      listenStats: loadListenStats(),
    },
    settings: settingsForSync(),
    profile: loadProfile(),
    device_id: getDeviceId(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("user_sync").upsert(row, {
    onConflict: "user_id",
  });
  if (error) throw error;

  saveSyncMeta({ lastPushAt: Date.now(), lastCloudUpdatedAt: row.updated_at });
  return row.updated_at;
}

/** Pull cloud → local (keeps volume) */
async function pullCloudSync() {
  if (!supabase) throw new Error("Supabase nicht konfiguriert");
  const user = await getAuthUser();
  if (!user) throw new Error("Nicht angemeldet");

  const { data, error } = await supabase
    .from("user_sync")
    .select("library, settings, profile, updated_at, device_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  applySyncedLibrary(data.library);
  applySyncedSettings(data.settings);
  applySyncedProfile(data.profile);

  saveSyncMeta({
    lastPullAt: Date.now(),
    lastCloudUpdatedAt: data.updated_at,
  });
  return data;
}

/**
 * Smart sync:
 * - no cloud row → push
 * - cloud newer than last local pull/push → pull
 * - else → push local
 */
async function syncNow() {
  if (!supabase) {
    showToast?.("Supabase nicht konfiguriert");
    return;
  }
  const user = await getAuthUser();
  if (!user) {
    showToast?.("Bitte zuerst anmelden");
    return;
  }

  setProfileSyncUI({ status: "Sync…", hint: "Bitte warten" });
  const btn = $("#profile-sync-now");
  btn?.classList.add("is-busy");
  btn && (btn.disabled = true);

  try {
    const { data, error } = await supabase
      .from("user_sync")
      .select("updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    const meta = loadSyncMeta();
    const cloudUpdated = data?.updated_at ? new Date(data.updated_at).getTime() : 0;
    const localMark = Math.max(meta.lastPushAt || 0, meta.lastPullAt || 0, meta.localDirtyAt || 0);

    if (!data) {
      await pushCloudSync();
      setProfileSyncUI({
        status: "Hochgeladen",
        hint: "Erster Cloud-Stand angelegt",
        last: formatSyncTime(Date.now()),
      });
      showToast?.("Cloud-Sync: hochgeladen");
    } else if (cloudUpdated > localMark + 500) {
      await pullCloudSync();
      setProfileSyncUI({
        status: "Aktualisiert",
        hint: "Cloud → Gerät",
        last: formatSyncTime(Date.now()),
      });
      showToast?.("Cloud-Sync: heruntergeladen");
    } else {
      await pushCloudSync();
      setProfileSyncUI({
        status: "Gespeichert",
        hint: "Gerät → Cloud",
        last: formatSyncTime(Date.now()),
      });
      showToast?.("Cloud-Sync: gespeichert");
    }
    saveSyncMeta({ localDirtyAt: 0 });

    if (
      typeof syncProfileForm === "function" &&
      !$("#profile-view")?.classList.contains("hidden")
    ) {
      syncProfileForm();
    }
  } catch (err) {
    console.warn("[Noma sync]", err);
    setProfileSyncUI({
      status: "Fehler",
      hint: err?.message || "Sync fehlgeschlagen",
    });
    showToast?.("Sync fehlgeschlagen");
    // refresh profile UI if that screen is open
    if (
      typeof syncProfileForm === "function" &&
      !$("#profile-view")?.classList.contains("hidden")
    ) {
      syncProfileForm();
    }
  } finally {
    btn?.classList.remove("is-busy");
    if (btn) btn.disabled = false;
  }
}

let _syncDebounce = null;
function scheduleCloudSync() {
  if (!supabase) return;
  saveSyncMeta({ localDirtyAt: Date.now() });
  clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(async () => {
    const user = await getAuthUser();
    if (!user) return;
    try {
      await pushCloudSync();
      setProfileSyncUI({
        status: "Gespeichert",
        hint: "Automatisch synchronisiert",
        last: formatSyncTime(Date.now()),
      });
      if (
        typeof syncProfileForm === "function" &&
        !$("#profile-view")?.classList.contains("hidden")
      ) {
        syncProfileForm();
      }
    } catch (e) {
      console.warn("[Noma auto-sync]", e);
    }
  }, 2000);
}

async function initCloudAuth() {
  if (!supabase) return;

  const { data } = await supabase.auth.getSession();
  updateAuthPanels(data?.session?.user || null);

  // After login: pull if cloud ahead, else push
  if (data?.session?.user) {
    try {
      await syncNow();
    } catch {}
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    updateAuthPanels(session?.user || null);
    if (event === "SIGNED_IN" && session?.user) {
      try {
        await syncNow();
      } catch {}
    }
  });
}

function bindProfileAuth() {
    $("#profile-password-toggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = $("#profile-password");
    const btn = $("#profile-password-toggle");
    if (!input || !btn) return;

    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", show ? "true" : "false");
    btn.title = show ? "Passwort verbergen" : "Passwort anzeigen";
    btn.setAttribute("aria-label", show ? "Passwort verbergen" : "Passwort anzeigen");
    btn.querySelector(".pw-eye")?.classList.toggle("hidden", show);
    btn.querySelector(".pw-eye-off")?.classList.toggle("hidden", !show);
  });

  $("#profile-signin-btn")?.addEventListener("click", async () => {
    const email = ($("#profile-email")?.value || "").trim();
    const password = $("#profile-password")?.value || "";
    const errEl = $("#profile-auth-error");
    if (errEl) errEl.textContent = "";
    if (!email || password.length < 6) {
      if (errEl) errEl.textContent = "E-Mail und Passwort (min. 6) nötig.";
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (errEl) errEl.textContent = error.message;
      return;
    }
    showToast?.("Angemeldet");
    if ($("#profile-password")) $("#profile-password").value = "";
  });

  $("#profile-signup-btn")?.addEventListener("click", async () => {
    const email = ($("#profile-email")?.value || "").trim();
    const password = $("#profile-password")?.value || "";
    const errEl = $("#profile-auth-error");
    if (errEl) errEl.textContent = "";
    if (!email || password.length < 6) {
      if (errEl) errEl.textContent = "E-Mail und Passwort (min. 6) nötig.";
      return;
    }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      if (errEl) errEl.textContent = error.message;
      return;
    }
    // If confirm-email is ON, session may be null
    if (!data.session) {
      if (errEl) errEl.textContent = "Konto erstellt – bitte E-Mail bestätigen, dann anmelden.";
      showToast?.("Bitte E-Mail bestätigen");
      return;
    }
    showToast?.("Konto erstellt");
    if ($("#profile-password")) $("#profile-password").value = "";
  });

  $("#profile-signout-btn")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
    showToast?.("Abgemeldet");
    setProfileSyncUI({ status: "Lokal", hint: "Nicht angemeldet", last: "—" });
    // repaint stats/covers (handles missing cloud playlists cleanly)
    if (typeof syncProfileForm === "function") syncProfileForm();
    updateAuthPanels?.(null);
  });

  $("#profile-sync-now")?.addEventListener("click", () => syncNow());
}

function uid() {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getPlaylist(id) {
  return userLib.playlists.find((p) => p.id === id) || null;
}

function playlistCoverSrc(pl) {
  if (!pl) return PLACEHOLDER;
  if (pl.id === FAVORITES_ID) {
    return "Assets/PlaylistCovers/FavSongsCover.png";
  }
  if (pl.coverMode === "preset" || pl.coverMode === "game") {
    if (pl.coverSrc) return pl.coverSrc;
  }
  // auto: mosaic only if >3 distinct games, else first track's game cover
  const covers = [];
  const seen = new Set();
  for (const ref of pl.tracks || []) {
    if (seen.has(ref.gameId)) continue;
    const g = LIBRARY.find((x) => x.id === ref.gameId);
    if (g?.cover) {
      covers.push(g.cover);
      seen.add(ref.gameId);
    }
  }
  if (!covers.length) return PLACEHOLDER;
  if (covers.length > 3) return covers.slice(0, 4); // mosaic array
  return covers[0]; // single cover
}

/** Apply cover to an <img> OR mosaic container */
function applyCoverToEl(el, pl) {
  if (!el) return;
  const src = playlistCoverSrc(pl);
  if (Array.isArray(src)) {
    if (el.tagName === "IMG") {
      // replace img with mosaic div of same size
      const mosaic = document.createElement("div");
      // keep game-cover-lg / size classes AND force pl-cover-mosaic
      const base = String(el.className || "")
        .replace(/\bpl-card-cover\b/g, "")
        .trim();
      mosaic.className = [base, "pl-cover-mosaic"].filter(Boolean).join(" ");
      if (el.id) mosaic.id = el.id;
      mosaic.innerHTML = src
        .map((u) => `<img src="${escapeHtml(u)}" alt="" draggable="false">`)
        .join("");
      el.replaceWith(mosaic);
      return mosaic;
    }
    el.classList.add("pl-cover-mosaic");
    el.innerHTML = src
      .map((u) => `<img src="${escapeHtml(u)}" alt="" draggable="false">`)
      .join("");
    if (el.tagName === "IMG") el.removeAttribute("src");
    return el;
  }
  // single url
  if (el.tagName === "IMG") {
    el.src = src || PLACEHOLDER;
    return el;
  }
  // was mosaic div → back to img if needed
  if (el.classList.contains("pl-cover-mosaic") && el.id === "game-cover") {
    const img = document.createElement("img");
    img.id = "game-cover";
    img.className = "game-cover-lg";
    img.alt = "";
    img.src = src || PLACEHOLDER;
    el.replaceWith(img);
    return img;
  }
  return el;
}

function playlistCoverHtml(pl, className = "pl-card-cover") {
  const src = playlistCoverSrc(pl);
  if (Array.isArray(src)) {
    return `<div class="pl-cover-mosaic ${className === "pl-card-cover" ? "" : className}">${src
      .map((u) => `<img src="${escapeHtml(u)}" alt="" draggable="false">`)
      .join("")}</div>`;
  }
  return `<img class="${className}" src="${escapeHtml(src || PLACEHOLDER)}" alt="" draggable="false">`;
}

const MAX_PLAYLISTS = 100;
const MAX_TRACKS_PER_PLAYLIST = 1000;

function createPlaylist(name = "Neue Playlist") {
  const count = (userLib.playlists || []).length;
  if (count >= MAX_PLAYLISTS) {
    showToast?.(`Maximal ${MAX_PLAYLISTS} Playlists`);
    return null;
  }
  const now = Date.now();
  const pl = {
    id: uid(),
    name,
    type: "user",
    pinned: false,
    pinLocked: false,
    coverMode: "auto",
    coverSrc: null,
    tracks: [],
    createdAt: now,
    updatedAt: now,
    lastPlayedAt: 0,
  };
  userLib.playlists.push(pl);
  saveUserLibrary();
  return pl;
}

function sanitizeFilename(name) {
  return String(name || "playlist")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "playlist";
}

/** Download a portable playlist JSON file */
function exportPlaylistToFile(pl) {
  if (!pl) return;
  const payload = {
    format: "noma-playlist-v1",
    exportedAt: Date.now(),
    playlist: {
      name: pl.name,
      coverMode: pl.coverMode || "auto",
      coverSrc: pl.coverSrc ?? null,
      useTrackLoops: !!pl.useTrackLoops,
      tracks: (pl.tracks || []).map((t) => {
        const entry = {
          gameId: t.gameId,
          trackId: t.trackId,
        };
        // Preserve ×-loop amounts (0 is valid = play once)
        if (t.loops !== undefined && t.loops !== null && t.loops !== "") {
          const n = Math.min(99, Math.max(0, Math.floor(Number(t.loops))));
          if (Number.isFinite(n)) entry.loops = n;
        }
        return entry;
      }),
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(pl.name)}.noma.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast?.(`„${pl.name}“ exportiert`);
}

/** Import from a noma-playlist-v1 (or loose) JSON file → new playlist */
async function importPlaylistFromFile(file) {
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast?.("Ungültige Datei");
    return null;
  }

  const src =
    data?.format === "noma-playlist-v1" && data.playlist
      ? data.playlist
      : data?.tracks
        ? data
        : null;
  if (!src || !Array.isArray(src.tracks)) {
    showToast?.("Keine gültige Noma-Playlist");
    return null;
  }

  const name = (src.name || file.name.replace(/\.noma\.json$/i, "").replace(/\.json$/i, "") || "Import").slice(0, 80);
  const pl = createPlaylist(name);
  if (!pl) return null;

  // optional cover
  if (src.coverMode) pl.coverMode = src.coverMode;
  if (src.coverSrc != null) pl.coverSrc = src.coverSrc;

  // ×-loop mode for the whole playlist
  if (src.useTrackLoops != null) {
    pl.useTrackLoops = !!src.useTrackLoops;
  }

  let kept = 0;
  let skipped = 0;
  for (const t of src.tracks) {
    const gameId = t.gameId;
    const trackId = t.trackId || t.id;
    if (!gameId || !trackId) {
      skipped++;
      continue;
    }
    const game = LIBRARY.find((g) => g.id === gameId);
    const track = game?.tracks?.find((x) => x.id === trackId);
    if (!game || !track) {
      skipped++;
      continue;
    }
    const ref = { gameId, trackId };
    // Restore per-track × loops (0 allowed)
    if (t.loops !== undefined && t.loops !== null && t.loops !== "") {
      const n = Math.min(99, Math.max(0, Math.floor(Number(t.loops))));
      if (Number.isFinite(n)) ref.loops = n;
    }
    pl.tracks.push(ref);
    kept++;
  }
  pl.updatedAt = Date.now();
  saveUserLibrary();
  renderLibrary?.({ animate: true });

  const skipMsg = skipped ? ` · ${skipped} übersprungen` : "";
  showToast?.(`„${pl.name}“ importiert (${kept} Songs${skipMsg})`);
  return pl;
}

function closeLibCreatePanel() {
  const panel = $("#lib-create-panel");
  const btn = $("#lib-create-btn");
  if (!panel || panel.classList.contains("hidden") || panel.classList.contains("is-closing")) {
    return;
  }
  panel.classList.add("is-closing");
  panel.setAttribute("aria-hidden", "true");
  btn?.setAttribute("aria-expanded", "false");
  const done = () => {
    panel.classList.add("hidden");
    panel.classList.remove("is-closing");
    panel.removeEventListener("animationend", done);
  };
  panel.addEventListener("animationend", done);
  // fallback if animation missing / reduced-motion
  setTimeout(done, 220);
}

function positionLibCreatePanel() {
  const panel = $("#lib-create-panel");
  const btn = $("#lib-create-btn");
  if (!panel || !btn || panel.classList.contains("hidden")) return;

  // fixed so nothing in the library header can clip it
  panel.style.position = "fixed";
  panel.style.right = "auto";

  const r = btn.getBoundingClientRect();
  const pad = 8;
  const prev = panel.style.visibility;
  panel.style.visibility = "hidden";
  panel.classList.remove("hidden");
  const pw = panel.offsetWidth || 220;
  const ph = panel.offsetHeight || 120;
  panel.style.visibility = prev || "";

  let left = r.left;
  let top = r.bottom + 6;

  if (left + pw > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - pw - pad);
  }
  if (left < pad) left = pad;

  // flip above if not enough room below
  if (top + ph > window.innerHeight - pad && r.top > ph + pad) {
    top = r.top - ph - 6;
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}


function toggleLibCreatePanel() {
  const panel = $("#lib-create-panel");
  const btn = $("#lib-create-btn");
  if (!panel) return;
  const willOpen = panel.classList.contains("hidden");
  $("#lib-sort-panel")?.classList.add("hidden");
  if (willOpen) {
    panel.classList.remove("is-closing");
    panel.classList.remove("hidden");
    panel.setAttribute("aria-hidden", "false");
    btn?.setAttribute("aria-expanded", "true");
    positionLibCreatePanel();
  } else {
    closeLibCreatePanel();
  }
}

window.addEventListener("resize", () => positionLibCreatePanel(), { passive: true });
document.addEventListener(
  "scroll",
  () => {
    if (!$("#lib-create-panel")?.classList.contains("hidden")) positionLibCreatePanel();
  },
  { passive: true, capture: true }
);

function togglePinPlaylist(id) {
  const pl = getPlaylist(id);
  if (!pl || pl.pinLocked) return;
  pl.pinned = !pl.pinned;
  pl.updatedAt = Date.now();
  saveUserLibrary();
}

function isAlbumInLibrary(gameId) {
  return userLib.libraryAlbums.includes(gameId);
}

function toggleAlbumInLibrary(gameId) {
  const i = userLib.libraryAlbums.indexOf(gameId);
  if (i >= 0) userLib.libraryAlbums.splice(i, 1);
  else userLib.libraryAlbums.push(gameId);
  saveUserLibrary();
  return isAlbumInLibrary(gameId);
}

function isTrackInPlaylist(plId, gameId, trackId) {
  const pl = getPlaylist(plId);
  if (!pl) return false;
  return (pl.tracks || []).some((t) => t.gameId === gameId && t.trackId === trackId);
}

function isInFavorites(gameId, trackId) {
  return isTrackInPlaylist(FAVORITES_ID, gameId, trackId);
}


function setTrackInPlaylist(plId, gameId, trackId, on) {
  const pl = getPlaylist(plId);
  if (!pl) return false;
  const idx = (pl.tracks || []).findIndex(
    (t) => t.gameId === gameId && t.trackId === trackId
  );
  if (on && idx < 0) {
    if ((pl.tracks || []).length >= MAX_TRACKS_PER_PLAYLIST) {
      showToast?.(`Maximal ${MAX_TRACKS_PER_PLAYLIST} Titel pro Playlist`);
      return false;
    }
    pl.tracks.push({ gameId, trackId });
  }
  if (!on && idx >= 0) pl.tracks.splice(idx, 1);
  pl.updatedAt = Date.now();
  saveUserLibrary();

  // If this is the playlist currently driving playback, mirror into queue
  if (on && state.playingPlaylistId === plId) {
    insertIntoPlayingPlaylistQueue(plId, gameId, trackId);
  } else if (!on && state.playingPlaylistId === plId) {
    resyncQueueAfterPlaylistChange(plId);
  }
  return true;
}

/** Insert a newly-added playlist track into the live queue at playlist order. */
function insertIntoPlayingPlaylistQueue(plId, gameId, trackId) {
  if (state.playingPlaylistId !== plId) return;
  if (state.queueIndex < 0 || !state.queue.length) return;
  if (state.queue.some((i) => i.gameId === gameId && i.track?.id === trackId)) return;

  const pl = getPlaylist(plId);
  const game = LIBRARY.find((g) => g.id === gameId);
  const track = game?.tracks?.find((t) => t.id === trackId);
  if (!pl || !track) return;

  const order = pl.tracks || [];
  const newOrd = order.findIndex((t) => t.gameId === gameId && t.trackId === trackId);
  if (newOrd < 0) return;

  let insertAt = state.queue.length;
  for (let i = 0; i < state.queue.length; i++) {
    const q = state.queue[i];
    const qOrd = order.findIndex(
      (t) => t.gameId === q.gameId && t.trackId === q.track?.id
    );
    // skip items not from this playlist (user-added foreign songs)
    if (qOrd < 0) continue;
    if (qOrd >= newOrd) {
      insertAt = i;
      break;
    }
  }

  const item = { gameId, track, insert: null };
  state.queue.splice(insertAt, 0, item);
  if (insertAt <= state.queueIndex) state.queueIndex++;

  if (state.shuffle && unshuffledQueue) {
    const uAt = Math.min(insertAt, unshuffledQueue.length);
    unshuffledQueue.splice(uAt, 0, { ...item });
  }

  renderQueue();
  updatePlayerUI();
}

function setPlayingPlaylist(plId) {
  state.playingPlaylistId = plId || null;
  markPlayingLibraryCards();
}

function clearPlayingPlaylist() {
  state.playingPlaylistId = null;
  markPlayingLibraryCards();
}

/** After playlist track list changes: keep live queue in sync / skip if current was removed. */
function resyncQueueAfterPlaylistChange(plId) {
  if (state.playingPlaylistId !== plId) return;
  const pl = getPlaylist(plId);
  if (!pl || !(pl.tracks || []).length) {
    resetPlayerToIdle();
    return;
  }
  const items = resolvePlaylistTracks(pl).map((it) => ({
    gameId: it.gameId,
    track: it.track,
    insert: null,
  }));
  if (!items.length) {
    resetPlayerToIdle();
    return;
  }

  const cur = state.queue[state.queueIndex];
  const curId = cur?.track?.id;
  const curGame = cur?.gameId;
  const stillThere = items.findIndex(
    (q) => q.track?.id === curId && q.gameId === curGame
  );

  state.queue = items;
  unshuffledQueue = null;

  if (stillThere >= 0) {
    // Same song still in playlist — only refresh chrome
    state.queueIndex = stillThere;
    renderQueue();
    updatePlayerUI();
    markPlayingTrack?.(curId);
    return;
  }

  // Current track was removed → play the track now at this slot (or clamp)
  state.queueIndex = Math.min(
    Math.max(0, state.queueIndex),
    state.queue.length - 1
  );
  playCurrent();
  renderQueue();
  updatePlayerUI();
}

function markPlayingLibraryCards() {
  const pid = state.playingPlaylistId;
  const gid =
    !pid && state.queue[state.queueIndex]
      ? state.queue[state.queueIndex].gameId
      : null;

  const paintEq = (el, on) => {
    el.classList.toggle("is-playing", !!on);
    const bars = el.querySelectorAll(".pl-card-eq i, .pl-list-eq i");
    if (!on) {
      el.classList.remove("audio-on");
      bars.forEach((bar) => {
        bar.style.transition = "";
        bar.style.transform = "";
        bar.style.animation = "";
      });
      return;
    }
    if (state.playing) {
      bars.forEach((bar) => {
        bar.style.transition = "";
        bar.style.transform = "";
        bar.style.animation = "";
      });
      el.classList.add("audio-on");
    } else {
      // same smooth pause as markPlayingGameCards / track rows
      bars.forEach((bar) => {
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
      el.classList.remove("audio-on");
    }
  };

  document.querySelectorAll("#lib-browse [data-kind='playlist']").forEach((el) => {
    paintEq(el, !!(pid && el.dataset.plId === pid));
  });
  document.querySelectorAll("#lib-browse [data-kind='game']").forEach((el) => {
    paintEq(el, !!( !pid && gid && el.dataset.gameId === gid ));
  });
}

function toggleFavorite(gameId, trackId) {
  const on = !isInFavorites(gameId, trackId);
  setTrackInPlaylist(FAVORITES_ID, gameId, trackId, on);
  return on;
}

/** True if track is in at least one playlist */
function isTrackInAnyPlaylist(gameId, trackId) {
  return userLib.playlists.some((p) => isTrackInPlaylist(p.id, gameId, trackId));
}

const FAV_PLUS_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
const FAV_CHECK_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

function paintFavButton(btn, on) {
  if (!btn) return;
  btn.classList.toggle("is-fav", !!on);
  btn.innerHTML = on ? FAV_CHECK_SVG : FAV_PLUS_SVG;
  btn.setAttribute("aria-label", on ? "In Playlist" : "Zur Playlist");
}

/** Refresh + buttons on open album + search after playlist changes */
function syncTrackPlusButtons(gameId, trackId) {
  const on = isTrackInAnyPlaylist(gameId, trackId);
  document
    .querySelectorAll(
      `.track-fav-btn[data-fav-track="${CSS.escape(trackId)}"], .gs-fav-btn[data-game-id="${CSS.escape(gameId)}"][data-track-id="${CSS.escape(trackId)}"]`
    )
    .forEach((btn) => paintFavButton(btn, on));
}

/** Runtime-only target when quickAdd is OFF. Settings.quickAddPlaylistId is never auto-changed. */
let sessionQuickAddId = FAVORITES_ID;

function getEffectiveQuickTarget() {
  if (settings.quickAddEnabled && settings.quickAddPlaylistId) {
    return settings.quickAddPlaylistId;
  }
  return sessionQuickAddId || FAVORITES_ID;
}

/**
 * + click:
 * - quickAdd ON  → add to settings.quickAddPlaylistId; if already in it → open menu
 * - quickAdd OFF → add to sessionQuickAddId (default Lieblingssongs);
 *   if already in it → open menu. Menu with exactly one selection updates session only.
 */
function handleTrackPlusClick(gameId, trackId) {
  if (!gameId || !trackId) return;

  const game = LIBRARY.find((g) => g.id === gameId);
  const track = game?.tracks?.find((t) => t.id === trackId);
  const inAny = isTrackInAnyPlaylist(gameId, trackId);
  // + inside a playlist always wins over settings quick-add
  const targetId = window.__forcePlaylistSelectId || getEffectiveQuickTarget();

  // Already in any playlist → open menu (never auto-remove on +)
  // Exception: forced target or quickAdd ON and not yet in the goal → add to goal
  if (inAny) {
    if (
      (window.__forcePlaylistSelectId || settings.quickAddEnabled) &&
      !isTrackInPlaylist(targetId, gameId, trackId)
    ) {
      setTrackInPlaylist(targetId, gameId, trackId, true);
      const pl = getPlaylist(targetId);
      showToast?.({
        title: track?.title || "Song",
        sub: `Zu „${pl?.name || "Lieblingssongs"}“ hinzugefügt`,
        cover: game?.cover || PLACEHOLDER,
      });
      syncTrackPlusButtons(gameId, trackId);
      if (typeof renderLibrary === "function") renderLibrary({ animate: false });
      return;
    }
    openAddToPlaylistMenu(gameId, trackId);
    return;
  }

  // No checkmark → quick-add to effective target
  setTrackInPlaylist(targetId, gameId, trackId, true);
  const pl = getPlaylist(targetId);
  showToast?.({
    title: track?.title || "Song",
    sub: `Zu „${pl?.name || "Lieblingssongs"}“ hinzugefügt`,
    cover: game?.cover || PLACEHOLDER,
  });
  syncTrackPlusButtons(gameId, trackId);
  // Do NOT rebuild playlist detail while global search is open (that closes search)
  if (!globalSearchOpen && state.currentPlaylist) {
    if (targetId === state.currentPlaylist.id) {
      refreshOpenPlaylistDetail({
        flashTrackId: trackId,
        flashType: isTrackInPlaylist(targetId, gameId, trackId) ? "add" : "remove",
      });
    } else {
      refreshOpenPlaylistDetail();
    }
  }
  if (typeof renderLibrary === "function") renderLibrary({ animate: false });
}

function toastAlbumLib(game, added) {
  const title = game?.title || game?.name || "Album";
  const cover = game?.cover || game?.image || "";
  showToast?.({
    title,
    sub: added ? "Zur Bibliothek hinzugefügt" : "Aus Bibliothek entfernt",
    cover,
  });
}

window.__PLAYLIST_PRESETS = [
  "Nachthimmel mit Mond und Bäumen.jpg",   // ← your file names here
];

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
  mariokart: {
    id: "mariokart",
    label: "Mario Kart",
    logo: "Assets/Filter/Franchise/MarioKart_Logo.png",
  },
  marioparty: {
    id: "marioparty",
    label: "Mario Party",
    logo: "Assets/Filter/Franchise/MarioParty_Logo.png",
  },
  donkeykong: {
    id: "donkeykong",
    label: "Donkey Kong",
    logo: "Assets/Filter/Franchise/DonkeyKong_Logo.png",
  },
  zelda: {
    id: "zelda",
    label: "The Legend of Zelda",
    logo: "Assets/Filter/Franchise/Zelda_Logo.webp",
  },
  kirby: {
    id: "kirby",
    label: "Kirby",
    logo: "Assets/Filter/Franchise/Kirby_Logo.png",
  },
  astrobot: {
    id: "astrobot",
    label: "Astro Bot",
    logo: "Assets/Filter/Franchise/AstroBot_Logo.png",
  },
};

let gamesViewMode = "console"; // "console" | "franchise"
let gamesNavLocked = false;
let libNavLocked = false;
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
    settings.quickAddEnabled =
      typeof parsed.quickAddEnabled === "boolean"
        ? parsed.quickAddEnabled
        : DEFAULT_SETTINGS.quickAddEnabled;
    settings.quickAddPlaylistId =
      typeof parsed.quickAddPlaylistId === "string" && parsed.quickAddPlaylistId
        ? parsed.quickAddPlaylistId
        : DEFAULT_SETTINGS.quickAddPlaylistId;
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (typeof scheduleCloudSync === "function") scheduleCloudSync();
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
  clearPlayingPlaylist();

  document.body.classList.remove("is-playing", "is-transitioning");

  $("#now-cover").src = PLACEHOLDER;
  setMarqueeText($("#now-title"), "Nichts läuft");
  $("#now-game").textContent = "Keinen Song ausgewählt";

  $("#fs-cover").src = PLACEHOLDER;
  const _fsT = $("#fs-title");
  if (_fsT) _fsT.textContent = "Nichts läuft";
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
const DECODE_CACHE_MAX = isIOS() ? 4 : 10;
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
  if (!state.playing || transitioning) return;

  const now = audioCtx.currentTime;
  const fadeSec = Math.max(0, softEndFadeSec);
  const fadeAt = softEndFadeAt;
  const fadeEnd = fadeAt + fadeSec;

  // Already past the end on the audio clock → finish now
  if (now >= fadeEnd) {
    if (state.loopMode === "count") {
      state.loopsRemaining = 0;
      updatePlayerUI();
    }
    finishTransition();
    return;
  }

  // Mid-fade on the audio clock → snap into transitioning, arm finish only
  if (now >= fadeAt) {
    transitioning = true;
    transitionStartedAt = fadeAt;
    document.body.classList.add("is-transitioning");
    if (state.loopMode === "count") {
      state.loopsRemaining = 0;
      updatePlayerUI();
    }
    if (currentGain) {
      const left = Math.max(0.05, fadeEnd - now);
      currentGain.gain.cancelScheduledValues(now);
      currentGain.gain.setValueAtTime(currentGain.gain.value, now);
      currentGain.gain.linearRampToValueAtTime(0, now + left);
    }
    clearSoftEndTimeoutsOnly();
    softEndTimer = setTimeout(() => {
      softEndTimer = null;
      if (!state.playing) return;
      // Re-check audio clock in case context stalled again
      if (audioCtx && audioCtx.currentTime < softEndFadeAt + softEndFadeSec - 0.05) {
        rescheduleSoftEndAfterResume();
        return;
      }
      finishTransition();
    }, (fadeEnd - now) * 1000 + 40);
    updateProgressUI();
    return;
  }

  // Still before fade — re-arm both timers from audio clock
  const timeToFadeStart = fadeAt - now;
  clearSoftEndTimeoutsOnly();

  if (currentGain) {
    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(effectiveVolume(), now);
    if (fadeSec <= 0) {
      currentGain.gain.setValueAtTime(0, fadeAt);
    } else {
      currentGain.gain.setValueAtTime(effectiveVolume(), fadeAt);
      currentGain.gain.linearRampToValueAtTime(0, fadeEnd);
    }
  }

  softEndStartTimer = setTimeout(() => {
    softEndStartTimer = null;
    if (!state.playing || !currentGain) return;
    // Context lagged behind wall clock → reschedule instead of faking a fade
    if (audioCtx && audioCtx.currentTime < softEndFadeAt - 0.05) {
      rescheduleSoftEndAfterResume();
      return;
    }
    transitioning = true;
    transitionStartedAt = softEndFadeAt;
    document.body.classList.add("is-transitioning");
    lastLoopCycle = Math.max(0, lastLoopCycle);
    if (state.loopMode === "count") {
      state.loopsRemaining = 0;
      updatePlayerUI();
    }
    updateProgressUI();
  }, timeToFadeStart * 1000);

  softEndTimer = setTimeout(() => {
    softEndTimer = null;
    if (!state.playing) return;
    if (audioCtx && audioCtx.currentTime < softEndFadeAt + softEndFadeSec - 0.05) {
      rescheduleSoftEndAfterResume();
      return;
    }
    finishTransition();
  }, (timeToFadeStart + fadeSec) * 1000 + 40);
}

/** Clear only the wall-clock timers — keep softEndFadeAt / softEndFadeSec. */
function clearSoftEndTimeoutsOnly() {
  if (softEndTimer) {
    clearTimeout(softEndTimer);
    softEndTimer = null;
  }
  if (softEndStartTimer) {
    clearTimeout(softEndStartTimer);
    softEndStartTimer = null;
  }
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
  const gainVal =
    currentGain && Number.isFinite(currentGain.gain.value)
      ? currentGain.gain.value
      : 1;

  // Already fully faded (audio clock or gain) → advance now, no bar
  if (state.playing && (now >= fadeEnd || gainVal < 0.03)) {
    if (state.loopMode === "count") {
      state.loopsRemaining = 0;
      updatePlayerUI();
    }
    finishTransition();
    return;
  }

  if (now >= softEndFadeAt && now < fadeEnd) {
    transitioning = true;
    transitionStartedAt = softEndFadeAt;
    document.body.classList.add("is-transitioning");
    if (state.loopMode === "count") {
      state.loopsRemaining = 0;
      updatePlayerUI();
    }
    if (state.playing) updateProgressUI();
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

/* ── Listening stats ───────────────────────────────────────── */
const LISTEN_STATS_KEY = "noma-listen-stats-v1";

function loadListenStats() {
  try {
    const raw = JSON.parse(localStorage.getItem(LISTEN_STATS_KEY) || "{}") || {};
    return {
      totalSec: Number(raw.totalSec) || 0,
      weeks: raw.weeks && typeof raw.weeks === "object" ? raw.weeks : {},
      tracks: raw.tracks && typeof raw.tracks === "object" ? raw.tracks : {},
      games: raw.games && typeof raw.games === "object" ? raw.games : {},
      playlists: raw.playlists && typeof raw.playlists === "object" ? raw.playlists : {},
    };
  } catch {
    return { totalSec: 0, weeks: {}, tracks: {}, games: {}, playlists: {} };
  }
}

function saveListenStats(stats) {
  try {
    localStorage.setItem(LISTEN_STATS_KEY, JSON.stringify(stats));
  } catch {}
}

/** Like album duration, but supports days for long totals: "2d 3h 12min" */
function formatListenDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0min";
  const total = Math.floor(sec);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}min`);
  return parts.join(" ");
}

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const listenClock = {
  lastTs: 0,
  trackKey: null,
  gameId: null,
  playlistId: null,
  playCounted: false,
};

function listenTrackKey(gameId, trackId) {
  return `${gameId}::${trackId}`;
}

function beginListenSession() {
  const item = state.queue[state.queueIndex];
  if (!item?.track) {
    listenClock.lastTs = 0;
    listenClock.trackKey = null;
    return;
  }
  listenClock.lastTs = Date.now();
  listenClock.trackKey = listenTrackKey(item.gameId, item.track.id);
  listenClock.gameId = item.gameId;
  listenClock.playlistId = state.playingPlaylistId || null;
  listenClock.playCounted = false;
  startListenHeartbeat();
}

function flushListenTime(opts = {}) {
  // opts.force — run even if UI/RAF was dead (wake from background)
  if (!listenClock.lastTs || !listenClock.trackKey) return;
  if (!state.playing && !opts.force) return;

  const now = Date.now();
  let delta = (now - listenClock.lastTs) / 1000;
  listenClock.lastTs = now;

  if (!Number.isFinite(delta) || delta <= 0) return;

  // Only ignore absurd clock jumps (e.g. device left for days). Normal bg listening is fully counted.
  const MAX_CHUNK = 12 * 3600; // 12 hours
  if (delta > MAX_CHUNK) delta = MAX_CHUNK;

  const stats = loadListenStats();
  stats.totalSec = (stats.totalSec || 0) + delta;

  const wk = isoWeekKey();
  stats.weeks[wk] = (stats.weeks[wk] || 0) + delta;

  const tk = listenClock.trackKey;
  if (!stats.tracks[tk]) {
    stats.tracks[tk] = { sec: 0, plays: 0, gameId: listenClock.gameId };
  }
  stats.tracks[tk].sec += delta;
  stats.tracks[tk].gameId = listenClock.gameId;

  const gid = listenClock.gameId;
  if (gid) {
    if (!stats.games[gid]) stats.games[gid] = { sec: 0, plays: 0 };
    stats.games[gid].sec += delta;
  }

  const pid = listenClock.playlistId;
  if (pid) {
    if (!stats.playlists[pid]) stats.playlists[pid] = { sec: 0, plays: 0 };
    stats.playlists[pid].sec += delta;
  }

  if (!listenClock.playCounted && (stats.tracks[tk].sec || 0) >= 5) {
    listenClock.playCounted = true;
    stats.tracks[tk].plays = (stats.tracks[tk].plays || 0) + 1;
    if (gid) stats.games[gid].plays = (stats.games[gid].plays || 0) + 1;
    if (pid) stats.playlists[pid].plays = (stats.playlists[pid].plays || 0) + 1;
  }

  saveListenStats(stats);
}

/** Heartbeat while playing — survives heavy RAF throttling better than UI alone */
let listenHeartbeat = null;
function startListenHeartbeat() {
  stopListenHeartbeat();
  listenHeartbeat = setInterval(() => {
    if (state.playing && listenClock.trackKey) {
      flushListenTime({ force: true });
    }
  }, 10000);
}
function stopListenHeartbeat() {
  if (listenHeartbeat) {
    clearInterval(listenHeartbeat);
    listenHeartbeat = null;
  }
}

function endListenSession() {
  flushListenTime({ force: true });
  listenClock.lastTs = 0;
  stopListenHeartbeat();
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
  if (state.playing && listenClock.trackKey) flushListenTime();
  // Do NOT clear lastTs here — endListenSession / pause paths own that
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
            state.loopsRemaining -= 1;
            updatePlayerUI();
          } else {
            // Last end → outro (startTransition also zeros the badge)
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
      if (audioCtx && audioCtx.currentTime < softEndFadeAt - 0.05) {
        rescheduleSoftEndAfterResume();
        return;
      }
      transitioning = true;
      transitionStartedAt = softEndFadeAt;
      document.body.classList.add("is-transitioning");
      lastLoopCycle = Math.max(0, lastLoopCycle);
      if (state.loopMode === "count") {
        state.loopsRemaining = 0;
        updatePlayerUI();
      }
      updateProgressUI();
    }, timeToFadeStart * 1000);

    softEndTimer = setTimeout(() => {
      softEndTimer = null;
      if (!state.playing) return;
      if (sourceGen !== playGen) return;
      if (audioCtx && audioCtx.currentTime < softEndFadeAt + softEndFadeSec - 0.05) {
        rescheduleSoftEndAfterResume();
        return;
      }
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
  // Outro = this track is done — never leave a stale loop badge
  if (state.loopMode === "count") {
    state.loopsRemaining = 0;
    updatePlayerUI();
  }

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
        // Confirm dialogs first
        if (!$("#confirm-overlay")?.classList.contains("hidden")) {
          closeConfirmOverlay?.() || closeClearQueueConfirm?.();
          handled = true;
          break;
        }
        if (!$("#pl-meta-overlay")?.classList.contains("hidden") && $("#pl-meta-overlay")) {
          $("#pl-meta-overlay").classList.add("hidden");
          handled = true;
          break;
        }
        if (!$("#add-to-pl-overlay")?.classList.contains("hidden")) {
          closeAddToPlMenu?.();
          handled = true;
          break;
        }
        // Settings wins over search / category / game back
        if (!$("#settings-view")?.classList.contains("hidden")) {
          closeSettings();
          handled = true;
          break;
        }
        if (!$("#profile-view")?.classList.contains("hidden")) {
          closeProfile();
          handled = true;
          break;
        }
        if (plEdit.active) {
          exitPlaylistEditMode(true);
          handled = true;
          break;
        }
        if (state.currentPlaylist && gameDetail?.classList.contains("active")) {
          $("#back-to-games")?.click();
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
    if (!$("#profile-view")?.classList.contains("hidden")) {
      closeProfile();
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
  loadUserLibrary(); // BEFORE renderLibrary
  bindProfileAuth();
  initCloudAuth();
  bindLibraryUI();
  bindAddToPlaylistUI()
  renderLibrary({ animate: false });
  bindPlaylistEditChrome()
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
  setMarqueeText($("#now-title"), "Nichts läuft");
  $("#now-game").textContent = "Keinen Song ausgewählt";
  const _fsT = $("#fs-title"); 
  if (_fsT) _fsT.textContent = "Nichts läuft";
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
      // Do NOT freeze soft-end timers — on iOS the gain ramp keeps running in
      // background; if we clear timeouts, finishTransition only runs on return
      // (late transition bar + delayed next track).
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
      // Listening stats: stamp / flush on hide (before return)
      if (state.playing && listenClock.trackKey) {
        flushListenTime({ force: true });
        listenClock.lastTs = Date.now();
      }
      return;
    }

    // ── Foreground ──
    clearBgSessionKeepAlive();
    ensurePlaybackAudioSession();
    // Resume audio context first so currentTime is live again
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    syncSoftEndFromClock();
    // Only re-arm if soft-end is still in the future (not already finished)
    if (
      state.playing &&
      !useMediaEl &&
      softEndFadeAt > 0 &&
      !transitioning &&
      audioCtx &&
      audioCtx.currentTime < softEndFadeAt - 0.05
    ) {
      rescheduleSoftEndAfterResume();
    }
    if (transitioning && state.loopMode === "count" && state.loopsRemaining !== 0) {
      state.loopsRemaining = 0;
      updatePlayerUI();
    }

    // Listening stats: credit whole background stretch on show
    if (state.playing && listenClock.trackKey) {
      flushListenTime({ force: true });
      listenClock.lastTs = Date.now();
      startListenHeartbeat();
    }

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
  if (Array.isArray(userLib.libraryAlbums) && LIBRARY.length) {
    const before = userLib.libraryAlbums.length;
    userLib.libraryAlbums = userLib.libraryAlbums.filter((gid) =>
      LIBRARY.some((g) => g.id === gid)
    );
    if (userLib.libraryAlbums.length !== before) saveUserLibrary();
  }
}

function gameCardHtml(g) {
  const n = g.tracks?.length || 0;
  return `
    <article class="game-card" data-id="${escapeHtml(g.id)}">
      <div class="game-card-art">
        <img src="${escapeHtml(g.cover)}" alt="${escapeHtml(g.title)}" loading="lazy" draggable="false">
        <span class="game-card-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <div class="card-hover-actions">
          <button type="button" class="card-hover-menu" data-menu-game="${escapeHtml(g.id)}" title="Mehr" aria-label="Mehr">⋮</button>
          <button type="button" class="card-hover-play" data-play-game="${escapeHtml(g.id)}" title="Alles abspielen" aria-label="Alles abspielen">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>
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
      if (e.target.closest(
        ".card-hover-actions, .card-hover-play, .card-hover-menu, [data-play-game], [data-menu-game]"
      )) {
        return;
      }
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
        if (e.target.closest(".card-hover-play, .card-hover-menu, .card-hover-actions")) return;
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

    const playBtn = card.querySelector("[data-play-game]");
    const menuBtn = card.querySelector("[data-menu-game]");
    playBtn?.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        card.dataset.suppressClick = "1";
        if (typeof armClickSuppress === "function") armClickSuppress(400);
        const game = LIBRARY.find((x) => x.id === card.dataset.id);
        if (!game) return;
        unlockMediaElement().catch(() => {});
        state.queue = (game.tracks || []).map((t) => ({
          gameId: game.id,
          track: t,
          insert: null,
        }));
        state.queueIndex = 0;
        playCurrent();
        renderQueue();
        updatePlayerUI();
      },
      true
    );
    menuBtn?.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        card.dataset.suppressClick = "1";
        if (typeof armClickSuppress === "function") armClickSuppress(400);
        const game = LIBRARY.find((x) => x.id === card.dataset.id);
        if (!game) return;
        const r = menuBtn.getBoundingClientRect();
        showContextMenu(r.left, r.bottom + 4, { game, album: true }, menuBtn);
      },
      true
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
  if (needsX) bindScrollFadeX(el);
  else {
    el.style.removeProperty("--fade-left");
    el.style.removeProperty("--fade-right");
    el.style.removeProperty("-webkit-mask-image");
    el.style.removeProperty("mask-image");
  }
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

function renderPlaylistCoverHTML(pl) {
  const src = playlistCoverSrc(pl);
  if (Array.isArray(src)) {
    if (src.length === 1) {
      return `<img class="pl-card-cover" src="${escapeHtml(src[0])}" alt="">`;
    }
    const cells = [0, 1, 2, 3]
      .map((i) => {
        const u = src[i] || src[src.length - 1] || PLACEHOLDER;
        return `<img src="${escapeHtml(u)}" alt="">`;
      })
      .join("");
    return `<div class="pl-cover-mosaic">${cells}</div>`;
  }
  return `<img class="pl-card-cover" src="${escapeHtml(src)}" alt="">`;
}

function sortedLibraryItems() {
  const q = (libPrefs.query || "").trim().toLowerCase();
  let items = [];

  if (libPrefs.filter === "playlists" || libPrefs.filter === "all") {
    for (const pl of userLib.playlists) {
      if (q && !pl.name.toLowerCase().includes(q)) continue;
      items.push({ kind: "playlist", pl });
    }
  }
  if (libPrefs.filter === "games" || libPrefs.filter === "all") {
    for (const gid of userLib.libraryAlbums) {
      const g = LIBRARY.find((x) => x.id === gid);
      if (!g) continue;
      if (q && !(g.title || "").toLowerCase().includes(q) && !(g.short || "").toLowerCase().includes(q))
        continue;
      items.push({ kind: "game", game: g });
    }
  }

  const dir = libPrefs.dir === "asc" ? 1 : -1;
  items.sort((a, b) => {
    // Lieblingssongs always first
    const aFav = a.kind === "playlist" && a.pl.id === FAVORITES_ID ? 1 : 0;
    const bFav = b.kind === "playlist" && b.pl.id === FAVORITES_ID ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;

    // other pinned playlists next
    const ap = a.kind === "playlist" && a.pl.pinned ? 1 : 0;
    const bp = b.kind === "playlist" && b.pl.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;

    const ta =
      a.kind === "playlist"
        ? libPrefs.sort === "az"
          ? a.pl.name
          : libPrefs.sort === "added"
            ? a.pl.createdAt
            : a.pl.lastPlayedAt || a.pl.updatedAt
        : libPrefs.sort === "az"
          ? a.game.title
          : 0;
    const tb =
      b.kind === "playlist"
        ? libPrefs.sort === "az"
          ? b.pl.name
          : libPrefs.sort === "added"
            ? b.pl.createdAt
            : b.pl.lastPlayedAt || b.pl.updatedAt
        : libPrefs.sort === "az"
          ? b.game.title
          : 0;

    if (typeof ta === "string") {
      return ta.localeCompare(tb, "de") * (libPrefs.dir === "asc" ? 1 : -1);
    }
    return (ta - tb) * dir;
  });
  return items;
}

function syncLibToolbar() {
  document.querySelectorAll("[data-lib-filter]").forEach((b) => {
    b.classList.toggle("active", b.dataset.libFilter === libPrefs.filter);
  });
  document.querySelectorAll("[data-lib-sort]").forEach((b) => {
    b.classList.toggle("active", b.dataset.libSort === libPrefs.sort);
  });
  document.querySelectorAll("[data-lib-dir]").forEach((b) => {
    b.classList.toggle("active", b.dataset.libDir === libPrefs.dir);
  });
  $("#lib-view-icon-grid")?.classList.toggle("hidden", libPrefs.view !== "grid");
  $("#lib-view-icon-list")?.classList.toggle("hidden", libPrefs.view !== "list");
}

function renderLibrary({ animate = true } = {}) {
  const browse = $("#lib-browse");
  if (!browse) return;

  const paint = () => {
    browse.classList.toggle("lib-view-grid", libPrefs.view === "grid");
    browse.classList.toggle("lib-view-list", libPrefs.view === "list");
    syncLibToolbar();

    const items = sortedLibraryItems();
    if (!items.length) {
      browse.innerHTML = `<p class="muted games-filter-empty">Keine Einträge.</p>`;
      return;
    }

        if (libPrefs.view === "list") {
      browse.innerHTML = items
        .map((it) => {
          if (it.kind === "playlist") {
            const pl = it.pl;
            const resolved = resolvePlaylistTracks(pl);
            const n = resolved.length;
            const totalSec = resolved.reduce(
              (s, x) => s + (Number.isFinite(Number(x.track?.duration)) ? Number(x.track.duration) : 0),
              0
            );
            const dur = formatAlbumDuration(totalSec);
            const sub = dur ? `${n} Titel · ${dur}` : `${n} Titel`;
            const pin = pl.pinned
              ? `<span class="pl-pin-inline" title="Angepinnt" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>`
              : "";
            return `<div class="pl-list-row" data-pl-id="${escapeHtml(pl.id)}" data-kind="playlist">
              ${playlistCoverHtml(pl, "pl-list-cover")}
              <div class="pl-list-meta">
                <div class="pl-card-title">${escapeHtml(pl.name)}${pin}</div>
                <div class="pl-card-sub">${sub}</div>
              </div>
              <span class="pl-list-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
              <button type="button" class="pl-list-menu" data-pl-menu="${escapeHtml(pl.id)}" aria-label="Menü">⋮</button>
            </div>`;
          }
          const g = it.game;
          const n = g.tracks?.length || 0;
          const totalSec = (g.tracks || []).reduce(
            (s, t) => s + (Number.isFinite(Number(t.duration)) ? Number(t.duration) : 0),
            0
          );
          const dur = formatAlbumDuration(totalSec);
          const sub = dur ? `Album · ${n} Titel · ${dur}` : `Album · ${n} Titel`;
          return `<div class="pl-list-row" data-game-id="${escapeHtml(g.id)}" data-kind="game">
            <img class="pl-list-cover" src="${escapeHtml(g.cover || PLACEHOLDER)}" alt="" draggable="false">
            <div class="pl-list-meta">
              <div class="pl-card-title">${escapeHtml(g.title)}</div>
              <div class="pl-card-sub">${sub}</div>
            </div>
            <span class="pl-list-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
            <button type="button" class="pl-list-menu" data-menu-game="${escapeHtml(g.id)}" aria-label="Menü">⋮</button>
          </div>`;
        })
        .join("");
    } else {
      browse.innerHTML = items
        .map((it) => {
          if (it.kind === "playlist") {
            const pl = it.pl;
            const resolved = resolvePlaylistTracks(pl);
            const n = resolved.length;
            const totalSec = resolved.reduce(
              (s, x) => s + (Number.isFinite(Number(x.track?.duration)) ? Number(x.track.duration) : 0),
              0
            );
            const dur = formatAlbumDuration(totalSec);
            const sub = dur ? `${n} Titel · ${dur}` : `${n} Titel`;
            return `<div class="pl-card" data-pl-id="${escapeHtml(pl.id)}" data-kind="playlist" role="button" tabindex="0">
              <div class="pl-card-cover-wrap">
                ${renderPlaylistCoverHTML(pl)}
                ${pl.pinned ? `<span class="pl-pin" title="Angepinnt"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>` : ""}
                <span class="pl-card-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
                <div class="card-hover-actions">
                  <button type="button" class="card-hover-menu" data-pl-menu="${escapeHtml(pl.id)}" title="Mehr" aria-label="Mehr">⋮</button>
                  <button type="button" class="card-hover-play" data-play-pl="${escapeHtml(pl.id)}" title="Abspielen" aria-label="Abspielen">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                </div>
              </div>
              <div class="pl-card-title">${escapeHtml(pl.name)}</div>
              <div class="pl-card-sub">${sub}</div>
            </div>`;
          }
          const g = it.game;
          const n = g.tracks?.length || 0;
          const totalSec = (g.tracks || []).reduce(
            (s, t) => s + (Number.isFinite(Number(t.duration)) ? Number(t.duration) : 0),
            0
          );
          const dur = formatAlbumDuration(totalSec);
          const sub = dur ? `Album · ${n} Titel · ${dur}` : `Album · ${n} Titel`;
          return `<div class="pl-card" data-game-id="${escapeHtml(g.id)}" data-kind="game" role="button" tabindex="0">
            <div class="pl-card-cover-wrap">
               <img class="pl-card-cover" src="${escapeHtml(g.cover || PLACEHOLDER)}" alt="" draggable="false">
               <span class="pl-card-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
              <div class="card-hover-actions">
                <button type="button" class="card-hover-menu" data-menu-game="${escapeHtml(g.id)}" title="Mehr" aria-label="Mehr">⋮</button>
                <button type="button" class="card-hover-play" data-play-game="${escapeHtml(g.id)}" title="Alles abspielen" aria-label="Alles abspielen">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </div>
            </div>
            <div class="pl-card-title">${escapeHtml(g.title)}</div>
            <div class="pl-card-sub">${sub}</div>
          </div>`;
        })
        .join("");
    }

    browse.querySelectorAll("[data-kind='playlist']").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (el.dataset.suppressClick === "1") {
          delete el.dataset.suppressClick;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.target.closest(".card-hover-actions, [data-pl-menu], .pl-list-menu, .card-hover-play, .card-hover-menu")) return;
        openPlaylistDetail(el.dataset.plId);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showPlaylistContextMenu(e.clientX, e.clientY, el.dataset.plId);
      });
      // long-press → context menu (mobile)
      let lpTimer = null, lpMoved = false;
      el.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        if (e.target.closest("button, .card-hover-actions")) return;
        lpMoved = false;
        const x = e.clientX, y = e.clientY;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (lpMoved) return;
          el.dataset.suppressClick = "1";
          armClickSuppress?.(600);
          showPlaylistContextMenu(x, y, el.dataset.plId);
        }, 480);
      }, { passive: true });
      el.addEventListener("pointermove", (e) => {
        if (!lpTimer) return;
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) {
          lpMoved = true;
          clearTimeout(lpTimer);
          lpTimer = null;
        }
      }, { passive: true });
      const cancelLp = () => { clearTimeout(lpTimer); lpTimer = null; };
      el.addEventListener("pointerup", cancelLp);
      el.addEventListener("pointercancel", cancelLp);
    });

    browse.querySelectorAll("[data-kind='game']").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".card-hover-actions, .pl-list-menu, [data-menu-game], .card-hover-play, .card-hover-menu")) return;
        searchReturn = { type: "library" };
        openGame(el.dataset.gameId);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const game = LIBRARY.find((g) => g.id === el.dataset.gameId);
        if (!game) return;
        showContextMenu(e.clientX, e.clientY, { game, album: true });
      });
      // long-press
      let lpTimer = null, lpMoved = false;
      el.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        if (e.target.closest("button, .card-hover-actions")) return;
        lpMoved = false;
        const x = e.clientX, y = e.clientY;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (lpMoved) return;
          const game = LIBRARY.find((g) => g.id === el.dataset.gameId);
          if (!game) return;
          el.dataset.suppressClick = "1";
          armClickSuppress?.(600);
          showContextMenu(x, y, { game, album: true });
        }, 480);
      }, { passive: true });
      el.addEventListener("pointermove", (e) => {
        if (!lpTimer) return;
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) {
          lpMoved = true;
          clearTimeout(lpTimer);
          lpTimer = null;
        }
      }, { passive: true });
      const cancelLp = () => { clearTimeout(lpTimer); lpTimer = null; };
      el.addEventListener("pointerup", cancelLp);
      el.addEventListener("pointercancel", cancelLp);
    });

    browse.querySelectorAll("[data-play-pl]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pl = getPlaylist(btn.getAttribute("data-play-pl"));
        if (!pl) return;
        const items = resolvePlaylistTracks(pl);
        if (!items.length) {
          showToast?.("Playlist ist leer");
          return;
        }
        unlockMediaElement().catch(() => {});
        state.queue = items.map((it) => ({
          gameId: it.gameId,
          track: it.track,
          insert: null,
        }));
        state.queueIndex = 0;
        state.shuffle = false;
        pl.lastPlayedAt = Date.now();
        saveUserLibrary();
        setPlayingPlaylist(pl.id);
        playCurrent();
        renderQueue();
        updatePlayerUI();
      });
    });
    browse.querySelectorAll("[data-play-game]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const game = LIBRARY.find((x) => x.id === btn.getAttribute("data-play-game"));
        if (!game) return;
        unlockMediaElement().catch(() => {});
        state.queue = (game.tracks || []).map((t) => ({ gameId: game.id, track: t, insert: null }));
        state.queueIndex = 0;
        clearPlayingPlaylist();
        playCurrent();
        renderQueue();
        updatePlayerUI();
      });
    });
    browse.querySelectorAll("[data-pl-menu]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = btn.getBoundingClientRect();
        showPlaylistContextMenu(r.left, r.bottom + 4, btn.getAttribute("data-pl-menu"));
      });
    });
    browse.querySelectorAll("[data-menu-game]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const game = LIBRARY.find((x) => x.id === btn.getAttribute("data-menu-game"));
        if (!game) return;
        const r = btn.getBoundingClientRect();
        showContextMenu(r.left, r.bottom + 4, { game, album: true }, btn);
      });
    });

    if (typeof bindPressMinHold === "function") {
      bindPressMinHold(browse);
      markPlayingLibraryCards();
    }
  };

  if (animate) {
    if (libNavLocked) {
      paint();
      return;
    }
    libNavLocked = true;
    browse.classList.remove("is-entering");
    browse.classList.add("is-leaving");
    const go = () => {
      browse.classList.remove("is-leaving");
      paint();
      browse.classList.add("is-entering");
      setTimeout(() => {
        browse.classList.remove("is-entering");
        libNavLocked = false;
      }, 400);
    };
    setTimeout(go, 180);
  } else {
    paint();
  }

  bindAllScrollFades();
}

function resolvePlaylistTracks(pl) {
  const items = [];
  for (const ref of pl.tracks || []) {
    const g = LIBRARY.find((x) => x.id === ref.gameId);
    const t = g?.tracks?.find((x) => x.id === ref.trackId);
    if (g && t) items.push({ gameId: g.id, game: g, track: t });
  }
  return items;
}

/** Per-track X-loop count for a playlist ref (null = use settings.loopTimes). */
function getPlaylistTrackLoops(pl, gameId, trackId) {
  if (!pl) return null;
  const ref = (pl.tracks || []).find(
    (t) => t.gameId === gameId && t.trackId === trackId
  );
  if (!ref || ref.loops === undefined || ref.loops === null || ref.loops === "") {
    return null; // use settings default
  }
  const n = Number(ref.loops);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(99, Math.max(0, Math.floor(n))); // 0 = play once, no re-loop
}

function setPlaylistTrackLoops(pl, gameId, trackId, value) {
  if (!pl) return;
  const ref = (pl.tracks || []).find(
    (t) => t.gameId === gameId && t.trackId === trackId
  );
  if (!ref) return;
  if (value == null || value === "") {
    delete ref.loops;
  } else {
    ref.loops = clampInt(value, 0, 99, 0); // 0 allowed
  }
  pl.updatedAt = Date.now();
}

/** Effective X-count when starting a track (playlist override or settings). */
function resolveLoopsForQueueItem(item) {
  const fallback = Number(settings.loopTimes) || DEFAULT_SETTINGS.loopTimes;
  if (!item || !state.playingPlaylistId) return fallback;
  const pl = getPlaylist(state.playingPlaylistId);
  if (!pl?.useTrackLoops) return fallback;
  const n = getPlaylistTrackLoops(pl, item.gameId, item.track?.id);
  return n != null ? n : fallback;
}

function openPlaylistDetail(id) {
  const pl = getPlaylist(id);
  if (!pl) return;

  const items = resolvePlaylistTracks(pl);

  state.currentPlaylist = pl;
  state.currentGame = null;

  // show detail panel (same shell as album)
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  tabGames?.classList.remove("active");
  tabPlaylists?.classList.remove("active");
  gameDetail.classList.remove("hidden");
  gameDetail.classList.add("active");
  gameDetail.classList.add("is-playlist-detail");

  // Header
  const coverSrc = playlistCoverSrc(pl);
  const coverUrl = Array.isArray(coverSrc) ? coverSrc[0] || PLACEHOLDER : coverSrc || PLACEHOLDER;
  const coverEl = $("#game-cover");
  if (coverEl) coverEl.src = coverUrl;

  const titleEl = $("#game-title");
  if (titleEl) {
    titleEl.dataset.full = pl.name || "Playlist";
    titleEl.dataset.short = pl.name || "Playlist";
    titleEl.textContent = pl.name || "Playlist";
    titleEl.contentEditable = "false";
    titleEl.classList.remove("pl-title-editing");
    titleEl.style.outline = "";
  }

  // Hide album-only controls
  const libBtn = $("#album-lib-btn");
  if (libBtn) libBtn.style.display = "none";
  const composerEl = $("#game-composer");
  if (composerEl) composerEl.style.display = "none";
  const labelEl = document.querySelector(".game-label");
  if (labelEl) labelEl.textContent = "Playlist";

  // Header cover (mosaic-aware)
  // Header cover (mosaic-aware)
  const coverHost = $("#game-cover");
  if (coverHost) applyCoverToEl(coverHost, pl);

  // Clean any leftover edit chrome state
  document.body.classList.remove("pl-editing");
  document.querySelectorAll(".pl-cover-edit-hit").forEach((n) => n.remove());

  // ── + Songs (create FIRST) ──
  let addSongsChip = document.getElementById("pl-add-songs-chip");
  if (!addSongsChip) {
    addSongsChip = document.createElement("button");
    addSongsChip.type = "button";
    addSongsChip.id = "pl-add-songs-chip";
    addSongsChip.className = "circle-btn";
    addSongsChip.title = "Songs hinzufügen";
    addSongsChip.setAttribute("aria-label", "Songs hinzufügen");
    addSongsChip.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
  }
  addSongsChip.classList.toggle("hidden", pl.id === FAVORITES_ID);
  addSongsChip.onclick = () => {
    if (plEdit.active) exitPlaylistEditMode(true);
    searchReturn = { type: "playlist", playlistId: pl.id, stayInSearch: true };
    sessionQuickAddId = pl.id;
    window.__forcePlaylistSelectId = pl.id; // always add into THIS playlist
    openGlobalSearch(true);
    const input = $("#global-search-input");
    if (input) {
      try {
        input.focus({ preventScroll: true });
      } catch (_) {
        input.focus();
      }
    }
  };

  // ── Edit chrome (create SECOND) ──
  let editChrome = document.getElementById("pl-edit-chrome");
  if (!editChrome) {
    editChrome = document.createElement("div");
    editChrome.id = "pl-edit-chrome";
    editChrome.className = "pl-edit-chrome";
    editChrome.innerHTML = `
      <button type="button" id="pl-edit-btn" class="circle-btn" title="Bearbeiten" aria-label="Bearbeiten">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>
      </button>
      <span id="pl-edit-mode-icon" class="pl-edit-mode-icon hidden" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>
      </span>
      <button type="button" id="pl-edit-cancel" class="circle-btn pl-edit-cancel hidden" title="Abbrechen" aria-label="Abbrechen">
        <span style="color:#ff6b6b;font-size:20px;line-height:1;font-weight:700">×</span>
      </button>
      <button type="button" id="pl-edit-save" class="circle-btn pl-edit-save hidden" title="Fertig">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
      </button>
    `;
  }
  editChrome.classList.remove("hidden");
  // openGame hides these — always restore when opening a playlist
  $("#pl-edit-chrome")?.classList.remove("hidden");
  $("#pl-edit-btn")?.classList.remove("hidden");
  $("#pl-edit-cancel")?.classList.add("hidden");
  $("#pl-edit-save")?.classList.add("hidden");
  $("#pl-edit-mode-icon")?.classList.add("hidden");
  // Favorites can edit tracks / loops (name+cover still blocked in meta modal)

  // ── + / edit between shuffle and ⋯ ──
  const albumMenu = $("#album-menu-btn");
  const bar = albumMenu?.parentElement;
  if (bar && albumMenu) {
    bar.insertBefore(addSongsChip, albumMenu);
    bar.insertBefore(editChrome, albumMenu);
  }
  document.getElementById("pl-left-actions")?.remove();

  // Clean any leftover edit chrome state
  document.body.classList.remove("pl-editing");
  document.querySelectorAll(".pl-cover-edit-hit").forEach((n) => n.remove());


  const totalSec = items.reduce(
    (s, it) => s + (Number.isFinite(Number(it.track.duration)) ? Number(it.track.duration) : 0),
    0
  );
  const countEl = $("#game-track-count");
  if (countEl) {
    const dur = formatAlbumDuration(totalSec);
    countEl.textContent = dur
      ? `${items.length} Titel · ${dur}`
      : `${items.length} Titel`;
  }

  // Track list — larger rows with cover + game name
  if (!trackListEl) return;
    trackListEl.classList.add("is-playlist");
  trackListEl.innerHTML = items
    .map((it, i) => {
      const t = it.track;
      const g = it.game;
      const dur =
        Number.isFinite(Number(t.duration)) && Number(t.duration) > 0
          ? formatTime(Number(t.duration))
          : "–:––";
      const gameLabel = g.title || g.short || "";
      return `
    <div class="track-row" data-track-id="${escapeHtml(t.id)}" data-game-id="${escapeHtml(g.id)}" data-index="${i}">
      <span class="track-num">
        <span class="num">${i + 1}</span>
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="hover-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </span>
      <img class="pl-track-cover" src="${escapeHtml(g.cover || PLACEHOLDER)}" alt="" draggable="false">
      <div class="track-meta">
        <span class="track-name">${escapeHtml(t.title)}</span>
        <span class="track-sub">${escapeHtml(gameLabel)}</span>
      </div>
      <span class="track-duration" data-track-id="${escapeHtml(t.id)}">${dur}</span>
      <button type="button" class="track-fav-btn" data-fav-track="${escapeHtml(t.id)}" data-game-id="${escapeHtml(g.id)}" aria-label="Zur Playlist">
        ${isTrackInAnyPlaylist(g.id, t.id) ? FAV_CHECK_SVG : FAV_PLUS_SVG}
      </button>
      <span class="track-actions" data-action="menu">⋮</span>
    </div>`;
    })
    .join("");

  if (!items.length) {
    const canAdd = pl.id !== FAVORITES_ID; // or always allow
    trackListEl.innerHTML = `
      <div class="pl-empty">
        <p class="muted">Keine Songs in dieser Playlist.</p>
        ${
          canAdd
            ? `<button type="button" class="primary-btn" id="pl-add-songs-btn">Songs hinzufügen</button>`
            : ""
        }
      </div>`;
    $("#pl-add-songs-btn")?.addEventListener("click", () => {
      searchReturn = { type: "playlist", playlistId: pl.id, stayInSearch: true };
      sessionQuickAddId = pl.id;
      window.__forcePlaylistSelectId = pl.id;
      openGlobalSearch(true);
      const input = $("#global-search-input");
      if (input) {
        try {
          input.focus({ preventScroll: true });
        } catch (_) {
          input.focus();
        }
      }
    });
  }

  // + buttons
  trackListEl.querySelectorAll(".track-fav-btn").forEach((btn) => {
    const gameId = btn.dataset.gameId;
    const trackId = btn.dataset.favTrack;
    paintFavButton(btn, isTrackInAnyPlaylist(gameId, trackId));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleTrackPlusClick(gameId, trackId);
    });
  });

  // row interactions
  trackListEl.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, input, label, .pl-edit-drag, .q-drag, .pl-track-loops")) return;
      if (row.dataset.suppressClick === "1") {
        delete row.dataset.suppressClick;
        return;
      }
      const idx = +row.dataset.index;
      const it = items[idx];
      if (!it) return;
      playFromPlaylist(pl, items, idx);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const it = items[+row.dataset.index];
      if (!it) return;
      showContextMenu(e.clientX, e.clientY, {
        game: it.game,
        track: it.track,
        fromPlaylistId: pl.id,
        fromQueue: false,
      });
    });
    // long-press menu (mobile)
    let lpTimer = null, lpMoved = false;
    row.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      if (e.target.closest("button, input, label, .pl-edit-drag, .q-drag")) return;
      lpMoved = false;
      const x = e.clientX, y = e.clientY;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        if (lpMoved) return;
        const it = items[+row.dataset.index];
        if (!it) return;
        row.dataset.suppressClick = "1";
        armClickSuppress?.(600);
        showContextMenu(x, y, {
          game: it.game,
          track: it.track,
          fromPlaylistId: pl.id,
          fromQueue: false,
        });
      }, 480);
    }, { passive: true });
    row.addEventListener("pointermove", (e) => {
      if (!lpTimer) return;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) {
        lpMoved = true;
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    }, { passive: true });
    const cancelLp = () => { clearTimeout(lpTimer); lpTimer = null; };
    row.addEventListener("pointerup", cancelLp);
    row.addEventListener("pointercancel", cancelLp);
  });

  // Show current playing row EQ immediately
  const curId = getCurrentTrackId?.();
  if (curId && typeof markPlayingTrack === "function") markPlayingTrack(curId);

  // Play all / shuffle
  const playAllBtn = $("#play-all-btn");
  if (playAllBtn) {
    playAllBtn.onclick = () => {
      if (!items.length) return;
      unlockMediaElement().catch(() => {});
      unshuffledQueue = null;
      state.queue = items.map((it) => ({
        gameId: it.gameId,
        track: it.track,
        insert: null,
      }));
      state.queueIndex = 0;
      state.shuffle = false;
      if (state.loopMode === "count") {
        state.loopsRemaining = resolveLoopsForQueueItem(state.queue[state.queueIndex]);
      } else {
        state.loopsRemaining = 0;
      }
      pl.lastPlayedAt = Date.now();
      saveUserLibrary();
      setPlayingPlaylist(pl.id);
      playCurrent();
      renderQueue();
      updatePlayerUI();
    };
  }

  const shuffleAllBtn = $("#shuffle-all-btn");
  if (shuffleAllBtn) {
    shuffleAllBtn.onclick = () => {
      if (!items.length) return;
      unlockMediaElement().catch(() => {});
      const q = items.map((it) => ({
        gameId: it.gameId,
        track: it.track,
        insert: null,
      }));
      unshuffledQueue = cloneQueue(q);
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j], q[i]];
      }
      state.queue = q;
      state.queueIndex = 0;
      state.shuffle = true;
      if (state.loopMode === "count") {
        state.loopsRemaining = resolveLoopsForQueueItem(state.queue[state.queueIndex]);
      } else {
        state.loopsRemaining = 0;
      }
      pl.lastPlayedAt = Date.now();
      saveUserLibrary();
      setPlayingPlaylist(pl.id);
      playCurrent();
      renderQueue();
      updatePlayerUI();
    };
  }

   // Per-track X-loops toggle (playlist only)
  let plLoopsBtn = document.getElementById("pl-loops-btn");
  if (!plLoopsBtn) {
    plLoopsBtn = document.createElement("button");
    plLoopsBtn.type = "button";
    plLoopsBtn.id = "pl-loops-btn";
    plLoopsBtn.className = "circle-btn pl-loops-btn";
    plLoopsBtn.title = "Song-Loops (X)";
    plLoopsBtn.setAttribute("aria-label", "Song-Loops");
    plLoopsBtn.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
      </svg>
      <span class="loop-badge pl-loops-btn-badge">×</span>`;
  }
  plLoopsBtn.classList.toggle("is-active", !!pl.useTrackLoops);
  plLoopsBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    pl.useTrackLoops = !pl.useTrackLoops;
    pl.updatedAt = Date.now();
    saveUserLibrary();
    plLoopsBtn.classList.toggle("is-active", !!pl.useTrackLoops);
    // On or off: if this playlist is driving count-mode, refresh remaining now
    if (state.loopMode === "count" && state.playingPlaylistId === pl.id) {
      state.loopsRemaining = resolveLoopsForQueueItem(state.queue[state.queueIndex]);
      updatePlayerUI();
    }
  };
  const shuffleBtn = $("#shuffle-all-btn");
  const actions = document.querySelector(".game-play-actions");
  if (actions && shuffleBtn && plLoopsBtn.parentElement !== actions) {
    actions.insertBefore(plLoopsBtn, shuffleBtn.nextSibling);
  }
  plLoopsBtn.classList.remove("hidden");

  // Album menu → pin playlist
  const albumBtn = $("#album-menu-btn");
  if (albumBtn) {
    albumBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = albumBtn.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 6, { playlist: pl, album: false }, albumBtn);
    };
  }

  setupGameTrackSearch();
  bindTrackListFade();
  bindAllScrollFades?.();
  const currentId = getCurrentTrackId();
  if (currentId) markPlayingTrack(currentId);
}

function refreshOpenPlaylistDetail({ flashTrackId = null, flashType = null } = {}) {
  if (!state.currentPlaylist) return;
  const pl = getPlaylist(state.currentPlaylist.id);
  if (!pl) return;
  state.currentPlaylist = pl;

  // Re-open detail UI but keep scroll
  const scroller = $("#track-list-scroll");
  const y = scroller?.scrollTop ?? 0;
  openPlaylistDetail(pl.id);
  requestAnimationFrame(() => {
    if (scroller) scroller.scrollTop = y;
    if (flashTrackId && flashType) {
      const row = trackListEl?.querySelector(
        `.track-row[data-track-id="${CSS.escape(flashTrackId)}"]`
      );
      if (!row) return;
      row.classList.remove("pl-flash-add", "pl-flash-remove");
      void row.offsetWidth;
      row.classList.add(flashType === "add" ? "pl-flash-add" : "pl-flash-remove");
      if (flashType === "remove") {
        row.addEventListener(
          "animationend",
          () => {
            // list already refreshed by openPlaylistDetail; no-op if gone
          },
          { once: true }
        );
      }
    }
  });
}

function playFromPlaylist(pl, items, index) {
  unlockMediaElement().catch(() => {});
  const queueItems = items.map((it) => ({
    gameId: it.gameId,
    track: it.track,
    insert: null,
  }));
  unshuffledQueue = cloneQueue(queueItems);

  if (state.shuffle) {
    const current = queueItems[index];
    const rest = queueItems.filter((_, i) => i !== index);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.queue = [current, ...rest];
    state.queueIndex = 0;
  } else {
    unshuffledQueue = null;
    state.queue = queueItems;
    state.queueIndex = Math.max(0, index);
  }

  if (state.loopMode === "count") state.loopsRemaining = settings.loopTimes;
  else state.loopsRemaining = 0;

  if (pl) {
    pl.lastPlayedAt = Date.now();
    saveUserLibrary();
    setPlayingPlaylist(pl.id);
  }
  playCurrent();
  renderQueue();
  updatePlayerUI();
}

function showPlaylistContextMenu(x, y, plId, anchorEl = null) {
  const pl = getPlaylist(plId);
  if (!pl) return;
  showContextMenu(x, y, { playlist: pl, album: false }, anchorEl);
}

function playlistQueueItems(pl) {
  return resolvePlaylistTracks(pl).map((it) => ({
    gameId: it.gameId,
    track: it.track,
    insert: null,
  }));
}

function addPlaylistPlayNext(pl) {
  const items = playlistQueueItems(pl);
  if (!items.length) return;
  if (state.queueIndex < 0 || !state.queue.length) {
    state.queue = items;
    state.queueIndex = 0;
    playCurrent();
  } else {
    state.queue.splice(state.queueIndex + 1, 0, ...items);
  }
    if (state.shuffle && unshuffledQueue) {
    unshuffledQueue.push(...items.map((x) => ({ ...x })));
  }
  renderQueue();
  updatePlayerUI();
}

function addPlaylistToEnd(pl) {
  const items = playlistQueueItems(pl);
  if (!items.length) return;
  if (!state.queue.length) {
    state.queue = items;
    state.queueIndex = 0;
    playCurrent();
  } else {
    state.queue.push(...items);
  }
    if (state.shuffle && unshuffledQueue) {
    unshuffledQueue.push(...items.map((x) => ({ ...x })));
  }
  renderQueue();
  updatePlayerUI();
}

function shufflePlaylistIntoQueue(pl) {
  const items = playlistQueueItems(pl);
  if (!items.length) return;
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
    unshuffledQueue.push(...items.map((x) => ({ ...x })));
  }
  renderQueue();
  updatePlayerUI();
}

function openDeletePlaylistConfirm(plId) {
  const pl = getPlaylist(plId);
  if (!pl || pl.id === FAVORITES_ID || pl.pinLocked) {
    showToast?.("Diese Playlist kann nicht gelöscht werden");
    return;
  }
  const overlay = $("#confirm-overlay");
  const title = $("#confirm-title");
  const body = overlay?.querySelector(".confirm-text");
  const ok = $("#confirm-ok");
  const cancel = $("#confirm-cancel");
  if (title) title.textContent = "Playlist löschen?";
  if (body) body.textContent = `Willst du wirklich „${pl.name}“ löschen?`;
  if (ok) ok.textContent = "Löschen";
  openConfirmOverlay();

  const cleanup = () => {
    closeConfirmOverlay(() => {
      if (ok) ok.textContent = "Leeren";
      if (title) title.textContent = "Warteschlange leeren?";
      if (body) {
        body.textContent =
          "Alle Songs werden entfernt und die Wiedergabe gestoppt.";
      }
      ok?.removeEventListener("click", onOk);
      cancel?.removeEventListener("click", onCancel);
    });
  };

  const onOk = () => {
    const wasPlayingPl = state.playingPlaylistId === plId;
    userLib.playlists = userLib.playlists.filter((p) => p.id !== plId);
    saveUserLibrary();
    cleanup();

    // Stop audio + reset play button, progress, kawarp, media session
    if (wasPlayingPl) {
      resetPlayerToIdle();
    }

    if (state.currentPlaylist?.id === plId) {
      state.currentPlaylist = null;
      gameDetail.classList.add("hidden");
      gameDetail.classList.remove("active", "is-playlist-detail");
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      $("#tab-playlists")?.classList.add("active");
    }
    renderLibrary({ animate: true });
    showToast?.("Playlist gelöscht");
    ok?.removeEventListener("click", onOk);
    cancel?.removeEventListener("click", onCancel);
  };
  const onCancel = () => {
    cleanup();
    ok?.removeEventListener("click", onOk);
    cancel?.removeEventListener("click", onCancel);
  };
  ok?.addEventListener("click", onOk);
  cancel?.addEventListener("click", onCancel);
}

function openClearPlaylistLoopsConfirm(plId) {
  const pl = getPlaylist(plId);
  if (!pl) return;

  const overlay = $("#confirm-overlay");
  const title = $("#confirm-title");
  const body = overlay?.querySelector(".confirm-text");
  const ok = $("#confirm-ok");
  const cancel = $("#confirm-cancel");
  if (!overlay || !ok) return;

  if (title) title.textContent = "Song-Loops löschen?";
  if (body) {
    body.textContent = `Willst du wirklich alle Song-Loops in „${pl.name}“ zurücksetzen?`;
  }
  ok.textContent = "Zurücksetzen";

  openConfirmOverlay();

  const cleanup = () => {
    closeConfirmOverlay(() => {
      ok.textContent = "Leeren";
      if (title) title.textContent = "Warteschlange leeren?";
      if (body) {
        body.textContent =
          "Alle Songs werden entfernt und die Wiedergabe gestoppt.";
      }
      ok.removeEventListener("click", onOk);
      cancel?.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
    });
  };

  const onOk = () => {
    const live = getPlaylist(plId);
    if (live) {
      for (const ref of live.tracks || []) delete ref.loops;
      live.updatedAt = Date.now();
      saveUserLibrary();
      // Stay in edit mode — rebuild rows so inputs bind again
      if (plEdit.active && state.currentPlaylist?.id === plId) {
        state.currentPlaylist = live;
        renderPlaylistEditUI();
      }
      showToast?.("Alle Song-Loops gelöscht");
    }
    cleanup();
  };

  const onCancel = () => cleanup();
  const onBackdrop = (e) => {
    if (e.target === overlay) cleanup();
  };
  // Capture phase so ESC hits this before other handlers
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  };

  ok.addEventListener("click", onOk);
  cancel?.addEventListener("click", onCancel);
  overlay.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKey, true);
}

/** Add all tracks of an album or playlist into chosen playlists (reuse add-to-pl UI). */
let addCollectionTarget = null; // { type: "album"|"playlist", game?, playlist? }

function openAddCollectionToPlaylistMenu(target) {
  addCollectionTarget = target;
  // Preselect nothing; on Done, push every track into selected playlists
  addToPlTarget = { gameId: "__collection__", trackId: "__collection__" };
  addToPlSelected = new Set();
  if (window.__forcePlaylistSelectId) {
    addToPlSelected.add(window.__forcePlaylistSelectId);
  }
  const search = $("#add-to-pl-search");
  if (search) search.value = "";
  const title = $("#add-to-pl-title");
  if (title) {
    title.textContent =
      target.type === "playlist"
        ? "Playlist zu Playlist hinzufügen"
        : "Album zu Playlist hinzufügen";
  }
  renderAddToPlList();
  const ov = document.getElementById("add-to-pl-overlay");
  if (ov?.parentElement !== document.body) document.body.appendChild(ov);
  closeAllPopovers();
  ov?.classList.remove("hidden");
  ov?.setAttribute("aria-hidden", "false");
}

let plEdit = {
  active: false,
  snapshot: null, // { name, coverMode, coverSrc, tracks: [...] }
  multi: false,
};

function bindPlaylistEditChrome() {
  // Delegation: button is created later inside openPlaylistDetail
  if (document.body.dataset.plEditBound === "1") return;
  document.body.dataset.plEditBound = "1";

  document.addEventListener("click", (e) => {
    const editBtn = e.target.closest("#pl-edit-btn");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();
      enterPlaylistEditMode();
      return;
    }
    const cancelBtn = e.target.closest("#pl-edit-cancel");
    if (cancelBtn) {
      e.preventDefault();
      e.stopPropagation();
      exitPlaylistEditMode(true);
      return;
    }
    const saveBtn = e.target.closest("#pl-edit-save");
    if (saveBtn) {
      e.preventDefault();
      e.stopPropagation();
      const pl = state.currentPlaylist && getPlaylist(state.currentPlaylist.id);
      if (pl) {
        pl.updatedAt = Date.now();
        saveUserLibrary();
      }
      exitPlaylistEditMode(false);
    }
  });
}

function enterPlaylistEditMode() {
  const pl = state.currentPlaylist && getPlaylist(state.currentPlaylist.id);
  if (!pl) return;
  plEdit.active = true;
  plEdit.selected = new Set();
  plEdit.multi = false;
  document.getElementById("pl-multi-btn")?.classList.remove("is-active");
  plEdit.snapshot = {
    name: pl.name,
    coverMode: pl.coverMode,
    coverSrc: pl.coverSrc,
    tracks: structuredClone(pl.tracks || []),
  };
  document.body.classList.add("pl-editing");

    // Always collapse header in edit mode
  const sticky = document.querySelector(".game-sticky-top");
  if (sticky && !sticky.classList.contains("is-collapsed")) {
    toggleGameHeaderCollapse(true);
  }

  $("#pl-edit-btn")?.classList.add("hidden");
  $("#pl-add-songs-chip")?.classList.add("hidden");
  $("#pl-edit-mode-icon")?.classList.add("hidden");

  const popIn = (el) => {
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.remove("chip-enter");
    void el.offsetWidth;
    el.classList.add("chip-enter");
    const done = () => {
      el.classList.remove("chip-enter");
      el.removeEventListener("animationend", done);
    };
    el.addEventListener("animationend", done);
    setTimeout(done, 320);
  };
  popIn(document.getElementById("pl-edit-cancel"));
  popIn(document.getElementById("pl-edit-save"));

  // Put edit chrome exactly where play / shuffle / ⋯ live
  const actions = document.querySelector(".game-play-actions");
  const chrome = document.getElementById("pl-edit-chrome");
  if (actions && chrome) {
    actions.appendChild(chrome);
    chrome.classList.remove("hidden");
  }
  // hide leftover host from older builds
  document.getElementById("pl-edit-by-cover")?.classList.add("hidden");

  // Cover hit via wrapper so it always tracks size (img + mosaic)
  document.querySelectorAll(".pl-cover-edit-hit, .pl-cover-hit-wrap").forEach((n) => {
    if (n.classList.contains("pl-cover-hit-wrap")) {
      const img = n.querySelector("#game-cover, .game-cover-lg, .pl-cover-mosaic");
      if (img && n.parentNode) n.parentNode.insertBefore(img, n);
    }
    if (n.classList.contains("pl-cover-edit-hit")) n.remove();
  });
  // unwrap leftover empty wraps
  document.querySelectorAll(".pl-cover-hit-wrap").forEach((n) => {
    if (!n.querySelector("#game-cover") && n.parentNode) {
      while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
      n.remove();
    }
  });

  if (typeof bindPressMinHold === "function") {
    ["pl-edit-save", "pl-edit-cancel", "pl-multi-btn", "pl-clear-loops-btn", "pl-multi-trash"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) delete el.dataset.pressBound;
    });
    bindPressMinHold(document.getElementById("pl-edit-chrome") || document);
  }

  let coverEl = document.getElementById("game-cover");
  if (pl.id !== FAVORITES_ID && coverEl) {
    // Measure BEFORE wrapping so size doesn’t jump
    const rect = coverEl.getBoundingClientRect();
    let wrap = coverEl.closest(".pl-cover-hit-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "pl-cover-hit-wrap";
      // Lock current visual size for one frame, then release to CSS transitions
      if (rect.width > 0 && rect.height > 0) {
        wrap.style.width = `${rect.width}px`;
        wrap.style.height = `${rect.height}px`;
      }
      coverEl.parentNode.insertBefore(wrap, coverEl);
      wrap.appendChild(coverEl);
      requestAnimationFrame(() => {
        wrap.style.width = "";
        wrap.style.height = "";
      });
    }
    coverEl.classList.add("pl-cover-editable");
    coverEl.querySelectorAll("img").forEach((img) => {
      img.style.pointerEvents = "none";
    });
    // Remove old hit if re-entering
    wrap.querySelectorAll(".pl-cover-edit-hit").forEach((n) => n.remove());
    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = "pl-cover-edit-hit";
    hit.title = "Name & Cover";
    hit.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>`;
    // Start invisible → fade in (avoids snap flash)
    hit.style.opacity = "0";
    hit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPlaylistEditMetaModal(pl);
    });
    wrap.appendChild(hit);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        hit.style.opacity = "";
      });
    });
  }

  ensureMultiSelectChrome();
  // multi wrap must be visible
  document.getElementById("pl-multi-wrap")?.classList.remove("hidden");
  document.getElementById("pl-multi-wrap")?.classList.remove("hidden");
  document.getElementById("pl-multi-btn")?.classList.remove("hidden");
  document.getElementById("pl-clear-loops-btn")?.classList.remove("hidden");
  const multiBtn = document.getElementById("pl-multi-btn");
  if (multiBtn) {
    multiBtn.classList.remove("chip-enter");
    void multiBtn.offsetWidth;
    multiBtn.classList.add("chip-enter");
  }
  const trash = document.getElementById("pl-multi-trash");
  if (trash && !trash.classList.contains("hidden")) {
    trash.classList.remove("chip-enter");
    void trash.offsetWidth;
    trash.classList.add("chip-enter");
  }
  renderPlaylistEditUI();
}

function exitPlaylistEditMode(discard) {
  const wasActive = !!plEdit.active;
  const pl = state.currentPlaylist && getPlaylist(state.currentPlaylist.id);
  if (discard && pl && plEdit.snapshot) {
    pl.name = plEdit.snapshot.name;
    pl.coverMode = plEdit.snapshot.coverMode;
    pl.coverSrc = plEdit.snapshot.coverSrc;
    pl.tracks = plEdit.snapshot.tracks;
    saveUserLibrary();
  }
  plEdit.active = false;
  plEdit.snapshot = null;
  plEdit.multi = false;

  // Toast for every cancel / save exit (only if edit was actually open)
  if (wasActive) {
    if (discard) {
      showToast?.("Bearbeitung abgebrochen");
    } else {
      showToast?.({
        title: pl?.name || "Playlist",
        sub: "Änderungen gespeichert",
        cover: pl && typeof playlistThumbUrl === "function" ? playlistThumbUrl(pl) : undefined,
      });
    }
  }
  document.body.classList.remove("pl-editing");
  document.querySelectorAll(".pl-cover-edit-hit").forEach((n) => n.remove());
  document.querySelectorAll(".pl-cover-hit-wrap").forEach((wrap) => {
    const parent = wrap.parentNode;
    if (!parent) return;
    while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
    wrap.remove();
  });
  $("#game-cover")?.classList.remove("pl-cover-editable");
  document.getElementById("pl-edit-by-cover")?.classList.add("hidden");
  window.__plPlaceCoverHit = null;
  const titleEl = $("#game-title");
  if (titleEl) {
    titleEl.contentEditable = "false";
    titleEl.classList.remove("pl-title-editing");
    titleEl.removeAttribute("contenteditable");
  }
  $("#pl-edit-mode-icon")?.classList.add("hidden");
  $("#pl-edit-cancel")?.classList.add("hidden");
  $("#pl-edit-save")?.classList.add("hidden");
  $("#pl-multi-wrap")?.classList.add("hidden");
  const editBtn = $("#pl-edit-btn");
  const addChip = $("#pl-add-songs-chip");
  // Only show playlist chrome when we still are on a (non-favorites) playlist.
  // `pl?.id !== FAVORITES_ID` is TRUE when pl is null → that was re-showing + on games.
  if (pl && pl.id !== FAVORITES_ID) {
    editBtn?.classList.remove("hidden");
    addChip?.classList.remove("hidden");
    editBtn?.classList.remove("chip-enter");
    addChip?.classList.remove("chip-enter");
    void editBtn?.offsetWidth;
    editBtn?.classList.add("chip-enter");
    addChip?.classList.add("chip-enter");
  } else {
    editBtn?.classList.add("hidden");
    addChip?.classList.add("hidden");
  }
  // move chrome back into action bar (next to ⋯)
  const albumMenu = $("#album-menu-btn");
  const bar = albumMenu?.parentElement;
  const chrome = document.getElementById("pl-edit-chrome");
  if (bar && albumMenu && chrome) {
    bar.insertBefore(chrome, albumMenu);
    if (addChip) bar.insertBefore(addChip, chrome);
  }
  // soft restore — keep collapse state / scroll, no header jump
  if (pl) {
    const scroller = document.querySelector(".track-list-scroll");
    const y = scroller?.scrollTop ?? 0;
    // re-render normal track list
    state.currentPlaylist = getPlaylist(pl.id) || pl;
    // Rebuild queue from playlist so order/loops match after edit
    if (state.playingPlaylistId === pl.id) {
      const items = resolvePlaylistTracks(pl);
      const curId = state.queue[state.queueIndex]?.track?.id;
      const curGame = state.queue[state.queueIndex]?.gameId;
      state.queue = items.map((it) => ({
        gameId: it.gameId,
        track: it.track,
        insert: null,
      }));
      let idx = state.queue.findIndex(
        (q) => q.track?.id === curId && q.gameId === curGame
      );
      if (idx < 0) idx = 0;
      state.queueIndex = Math.min(idx, Math.max(0, state.queue.length - 1));
      unshuffledQueue = null;
      renderQueue?.();
      updatePlayerUI?.();
    }
    openPlaylistDetail(pl.id);
    requestAnimationFrame(() => {
      const sticky = document.querySelector(".game-sticky-top");
      const sc = document.querySelector(".track-list-scroll") || scroller;
      if (sc) sc.scrollTop = y;
      if (sticky) {
        // Same rule as normal scroll: near top → expanded, scrolled down → collapsed
        const nearTop = (sc?.scrollTop ?? y) <= 8;
        if (nearTop) {
          sticky.classList.remove("is-collapsed");
          const titleEl = $("#game-title");
          if (titleEl) titleEl.textContent = titleEl.dataset.full || titleEl.textContent;
          $("#game-header-toggle")?.setAttribute("aria-expanded", "true");
        } else {
          sticky.classList.add("is-collapsed");
          const titleEl = $("#game-title");
          if (titleEl) titleEl.textContent = titleEl.dataset.short || titleEl.textContent;
          $("#game-header-toggle")?.setAttribute("aria-expanded", "false");
        }
      }
    });
  }
}

function cancelEditIfNeeded() {
  if (plEdit.active) exitPlaylistEditMode(true);
}

/** Modal: name + cover mode */
function openPlaylistEditMetaModal(pl) {
  if (pl.id === FAVORITES_ID) return;
  let ov = document.getElementById("pl-meta-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "pl-meta-overlay";
    ov.className = "add-to-pl-overlay";
    ov.innerHTML = `
      <div class="add-to-pl-panel" style="max-width:420px">
        <div class="add-to-pl-sticky-top">
          <h3>Playlist bearbeiten</h3>
          <label class="muted" style="display:block;margin:8px 0 4px">Name</label>
          <input id="pl-meta-name" type="text" autocomplete="off" spellcheck="false"
            style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:inherit">
          <p class="muted" style="margin:14px 0 8px">Cover</p>
          <div id="pl-meta-modes" style="display:flex;flex-direction:column;gap:8px"></div>
        </div>
        <div class="add-to-pl-sticky-bottom">
          <button type="button" id="pl-meta-cancel" class="confirm-btn confirm-cancel">Abbrechen</button>
          <button type="button" id="pl-meta-save" class="confirm-btn confirm-ok">Fertig</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  }
  const nameInput = ov.querySelector("#pl-meta-name");
  nameInput.value = pl.name || "";
  const modes = ov.querySelector("#pl-meta-modes");
  const current = pl.coverMode || "auto";
  modes.innerHTML = [
    { id: "auto", label: "Mosaik / Auto" },
    { id: "game", label: "Spiel-Album…" },
    { id: "preset", label: "Preset…" },
  ]
    .map(
      (m) =>
        `<button type="button" class="lib-create-chip pl-meta-mode ${current === m.id ? "active" : ""}" data-mode="${m.id}" style="justify-content:flex-start">${m.label}</button>`
    )
    .join("");

  let pendingMode = pl.coverMode || "auto";
  let pendingSrc = pl.coverSrc;

  function modeLabel() {
    if (pendingMode === "auto") return "Mosaik / Auto";
    if (pendingMode === "game") {
      const g = LIBRARY.find((x) => x.cover === pendingSrc);
      return g ? `Spiel: ${g.title}` : "Spiel-Album";
    }
    if (pendingMode === "preset") {
      const name = String(pendingSrc || "").split("/").pop() || "Preset";
      return `Preset: ${name.replace(/\.[^.]+$/, "")}`;
    }
    return "";
  }

  function paintModes() {
    const modes = [
      { id: "auto", label: "Mosaik / Auto" },
      { id: "game", label: "Spiel-Album…" },
      { id: "preset", label: "Preset…" },
    ];
    const preview =
      pendingMode === "auto"
        ? ""
        : pendingSrc
          ? `<div class="pl-meta-preview">${
            pendingMode === "auto"
              ? playlistThumbHtml(pl, "pl-thumb-mosaic")
              : `<img src="${escapeHtml(pendingSrc || playlistThumbUrl(pl))}" alt="">`
          }<span>${escapeHtml(modeLabel())}</span></div>`
          : "";
    modesEl.innerHTML =
      modes
        .map(
          (m) =>
            `<button type="button" class="pl-meta-mode ${pendingMode === m.id ? "is-active" : ""}" data-mode="${m.id}">${m.label}</button>`
        )
        .join("") + preview;

    modesEl.querySelectorAll(".pl-meta-mode").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const mode = btn.dataset.mode;
        if (mode === "auto") {
          pendingMode = "auto";
          pendingSrc = null;
          paintModes();
          return;
        }
        if (mode === "game") {
          const pick = await openCoverPickList({
            title: "Spiel-Album wählen",
            items: LIBRARY.map((g) => ({
              id: g.id,
              label: g.title,
              cover: g.cover,
            })),
            searchable: true,
          });
          if (!pick) return;
          pendingMode = "game";
          pendingSrc = pick.cover;
          paintModes();
          return;
        }
        if (mode === "preset") {
          const known = ["FavSongsCover.png"];
          const files = (window.__PLAYLIST_PRESETS || []).filter((f) => !known.includes(f));
          const items = files.map((f) => ({
            id: f,
            label: f.replace(/\.[^.]+$/, ""),
            cover: `Assets/PlaylistCovers/${f}`,
          }));
          if (!items.length) {
            showToast?.("Keine Presets in Assets/PlaylistCovers");
            return;
          }
          const pick = await openCoverPickList({
            title: "Preset wählen",
            items,
            searchable: true,
          });
          if (!pick) return;
          pendingMode = "preset";
          pendingSrc = pick.cover;
          paintModes();
        }
      });
    });
  }
  const modesEl = ov.querySelector("#pl-meta-modes");
  paintModes();
  const close = () => ov.classList.add("hidden");
  ov.querySelector("#pl-meta-cancel").onclick = close;
  ov.querySelector("#pl-meta-save").onclick = () => {
    const name = (nameInput.value || "").trim() || pl.name;
    pl.name = name;
    pl.coverMode = pendingMode;
    pl.coverSrc = pendingSrc;
    pl.updatedAt = Date.now();
    saveUserLibrary();
    const t = $("#game-title");
    if (t) t.textContent = pl.name;
    applyCoverToEl(document.getElementById("game-cover"), pl);
    close();
  };
  ov.onclick = null; // only Abbrechen / Fertig close it
  ov.classList.remove("hidden");
}

function openCoverPickList({ title, items, searchable }) {
  return new Promise((resolve) => {
    let ov = document.getElementById("pl-cover-pick-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "pl-cover-pick-overlay";
      ov.className = "add-to-pl-overlay";
      ov.innerHTML = `
        <div class="add-to-pl-panel">
          <div class="add-to-pl-sticky-top">
            <h3 id="pl-cover-pick-title"></h3>
            <div class="add-to-pl-search-wrap">
              <input id="pl-cover-pick-search" type="search" placeholder="Suchen…" autocomplete="off">
            </div>
          </div>
          <ul id="pl-cover-pick-list" class="add-to-pl-list"></ul>
          <div class="add-to-pl-sticky-bottom">
            <button type="button" id="pl-cover-pick-cancel" class="confirm-btn confirm-cancel">Abbrechen</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
    }
    ov.querySelector("#pl-cover-pick-title").textContent = title;
    const list = ov.querySelector("#pl-cover-pick-list");
    const search = ov.querySelector("#pl-cover-pick-search");
    search.value = "";
    search.style.display = searchable ? "" : "none";

    const paint = () => {
      const q = (search.value || "").trim().toLowerCase();
      const filtered = items.filter((it) => !q || it.label.toLowerCase().includes(q));
      list.innerHTML = filtered
        .map(
          (it) => `<li>
          <button type="button" class="add-to-pl-item" data-id="${escapeHtml(it.id)}">
            <img src="${escapeHtml(it.cover || PLACEHOLDER)}" alt="">
            <span class="add-to-pl-name">${escapeHtml(it.label)}</span>
          </button>
        </li>`
        )
        .join("");
      list.querySelectorAll(".add-to-pl-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          const it = items.find((x) => x.id === btn.dataset.id);
          ov.classList.add("hidden");
          resolve(it || null);
        });
      });
    };
    paint();
    search.oninput = paint;
    ov.querySelector("#pl-cover-pick-cancel").onclick = () => {
      ov.classList.add("hidden");
      resolve(null);
    };
    ov.onclick = (e) => {
      if (e.target === ov) {
        ov.classList.add("hidden");
        resolve(null);
      }
    };
    ov.classList.remove("hidden");
  });
}

function renderPlaylistEditUI() {
  const pl = state.currentPlaylist && getPlaylist(state.currentPlaylist.id);
  if (!pl) return;
  if (!plEdit.selected) plEdit.selected = new Set();

  const items = resolvePlaylistTracks(pl);
  trackListEl.classList.add("is-playlist", "is-editing");
  trackListEl.innerHTML = items
    .map((it, i) => {
      const t = it.track;
      const g = it.game;
      const gameLabel = g.title || g.short || "";
      const dur =
        Number.isFinite(Number(t.duration)) && Number(t.duration) > 0
          ? formatTime(Number(t.duration))
          : "–:––";
      const key = `${g.id}::${t.id}`;
      const sel = plEdit.selected.has(key) ? "is-selected" : "";
      const ref = (pl.tracks || [])[i];
      const hasLoops = ref && ref.loops !== undefined && ref.loops !== null && ref.loops !== "";
      const loopsVal = hasLoops
        ? String(Math.min(99, Math.max(0, Math.floor(Number(ref.loops)))))
        : "";
      const playingId = getCurrentTrackId?.();
      const isPlaying = playingId && t.id === playingId;
      const audioOn = isPlaying && state.playing;
      return `
    <div class="track-row ${sel}${isPlaying ? " playing" : ""}${audioOn ? " audio-on" : ""}" data-track-id="${escapeHtml(t.id)}" data-game-id="${escapeHtml(g.id)}" data-index="${i}" data-key="${escapeHtml(key)}">
      <span class="pl-edit-drag q-drag" title="Ziehen" data-drag-handle="1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5h2v2H9V5zm0 6h2v2H9v-2zm0 6h2v2H9v-2zm4-12h2v2h-2V5zm0 6h2v2h-2v-2zm0 6h2v2h-2v-2z"/></svg>
      </span>
      <span class="track-num">
        <span class="num">${i + 1}</span>
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </span>
      <img class="pl-track-cover" src="${escapeHtml(g.cover || PLACEHOLDER)}" alt="" draggable="false">
      <div class="track-meta">
        <span class="track-name">${escapeHtml(t.title)}</span>
        <span class="track-sub">${escapeHtml(gameLabel)}</span>
      </div>
      <label class="pl-track-loops" title="Loops für diesen Song (X-Modus, 0 = einmal)">
        <span class="pl-track-loops-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
          </svg>
          <span class="pl-track-loops-badge">×</span>
        </span>
        <input
          type="number"
          class="settings-number pl-track-loops-input"
          min="0"
          max="99"
          step="1"
          inputmode="numeric"
          placeholder="${settings.loopTimes}"
          value="${loopsVal}"
          data-game-id="${escapeHtml(g.id)}"
          data-track-id="${escapeHtml(t.id)}"
          aria-label="Loops"
        >
      </label>
      <span class="track-duration">${dur}</span>
      ${
        plEdit.multi
          ? `<button type="button" class="pl-ms-check ${plEdit.selected.has(key) ? "is-selected" : ""}" data-ms="${escapeHtml(key)}" aria-label="Auswählen"></button>`
          : `<button type="button" class="pl-row-trash" data-index="${i}" title="Entfernen" aria-label="Entfernen">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>`
      }
    </div>`;
    })
    .join("");

  // pop trash ↔ checkboxes
  requestAnimationFrame(() => {
    trackListEl.querySelectorAll(".pl-row-trash, .pl-ms-check").forEach((el) => {
      el.classList.remove("chip-enter");
      void el.offsetWidth;
      el.classList.add("chip-enter");
    });
  });

  trackListEl.querySelectorAll(".pl-ms-check").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const k = btn.getAttribute("data-ms");
      if (plEdit.selected.has(k)) plEdit.selected.delete(k);
      else plEdit.selected.add(k);
      btn.classList.toggle("is-selected", plEdit.selected.has(k));
      btn.closest(".track-row")?.classList.toggle("is-selected", plEdit.selected.has(k));
      syncMultiTrash();
    });
  });

  trackListEl.querySelectorAll(".pl-row-trash").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = +btn.dataset.index;
      pl.tracks.splice(idx, 1);
      pl.updatedAt = Date.now();
      saveUserLibrary();
      renderPlaylistEditUI();
      resyncQueueAfterPlaylistChange(pl.id);
    });
  });

  trackListEl.querySelectorAll(".pl-track-loops-input").forEach((inp) => {
    const commit = () => {
      // Always resolve current playlist — stale `pl` after clear broke writes
      const live =
        (state.currentPlaylist && getPlaylist(state.currentPlaylist.id)) || pl;
      if (!live) return;

      const gameId = inp.dataset.gameId;
      const trackId = inp.dataset.trackId;
      const raw = String(inp.value || "").replace(/[^\d]/g, "").slice(0, 2);

      if (!raw) {
        inp.value = "";
        setPlaylistTrackLoops(live, gameId, trackId, null);
        saveUserLibrary();
        return;
      }
      const n = clampInt(raw, 0, 99, settings.loopTimes);
      inp.value = String(n);
      setPlaylistTrackLoops(live, gameId, trackId, n);
      // Keep playlist-level X-loops enabled when user sets a value
      if (!live.useTrackLoops) {
        live.useTrackLoops = true;
        document.getElementById("pl-loops-btn")?.classList.add("is-active");
      }
      live.updatedAt = Date.now();
      saveUserLibrary();
    };
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("pointerdown", (e) => e.stopPropagation());
    inp.addEventListener("change", commit);
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        inp.blur();
      }
    });
  });

  // Row body: multi → toggle select; else → play
  trackListEl.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, input, label, .pl-edit-drag, .q-drag, .pl-track-loops")) {
        return;
      }
      if (row.dataset.suppressClick === "1") {
        delete row.dataset.suppressClick;
        return;
      }
      const key = row.dataset.key;
      if (plEdit.multi) {
        if (plEdit.selected.has(key)) plEdit.selected.delete(key);
        else plEdit.selected.add(key);
        row.classList.toggle("is-selected", plEdit.selected.has(key));
        row.querySelector(".pl-ms-check")?.classList.toggle(
          "is-selected",
          plEdit.selected.has(key)
        );
        syncMultiTrash();
        return;
      }
      const idx = +row.dataset.index;
      const it = items[idx];
      if (!it) return;
      playFromPlaylist(pl, items, idx);
    });
  });

  // Keep playing indicator / EQ in sync after re-render
  const curId = typeof getCurrentTrackId === "function" ? getCurrentTrackId() : null;
  if (curId && typeof markPlayingTrack === "function") markPlayingTrack(curId);

  bindPlaylistTrackDrag(pl);
  ensureMultiSelectChrome();
  syncMultiTrash();
}

function ensureMultiSelectChrome() {
  let ms = document.getElementById("pl-multi-wrap");
  if (!ms) {
    ms = document.createElement("div");
    ms.id = "pl-multi-wrap";
    ms.className = "pl-multi-wrap";
    ms.innerHTML = `
      <button type="button" id="pl-clear-loops-btn" class="circle-btn pl-clear-loops-btn" title="Alle Song-Loops zurücksetzen" aria-label="Alle Song-Loops zurücksetzen">
        <span class="pl-track-loops-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
          <span class="pl-track-loops-badge pl-clear-loops-x">×</span>
        </span>
      </button>
      <button type="button" id="pl-multi-btn" class="circle-btn" title="Mehrfachauswahl" aria-label="Mehrfachauswahl">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 7h4v2H4V7zm6 0h10v2H10V7zM4 11h4v2H4v-2zm6 0h10v2H10v-2zM4 15h4v2H4v-2zm6 0h10v2H10v-2z"/></svg>
      </button>
      <label id="pl-multi-loops" class="pl-track-loops pl-multi-loops hidden" title="Loops für Auswahl">
        <span class="pl-track-loops-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
          <span class="pl-track-loops-badge">×</span>
        </span>
        <input type="number" id="pl-multi-loops-input" class="settings-number pl-track-loops-input" min="0" max="99" step="1" inputmode="numeric" placeholder="0–99" aria-label="Loops für Auswahl">
      </label>
      <button type="button" id="pl-multi-trash" class="circle-btn pl-edit-cancel hidden" title="Auswahl löschen" aria-label="Auswahl löschen">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>`;
    const chrome = document.getElementById("pl-edit-chrome");
    chrome?.appendChild(ms);

    document.getElementById("pl-clear-loops-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const pl = state.currentPlaylist && getPlaylist(state.currentPlaylist.id);
      if (!pl) return;
      openClearPlaylistLoopsConfirm(pl.id);
    });
    document.getElementById("pl-multi-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      plEdit.multi = !plEdit.multi;
      if (!plEdit.multi) plEdit.selected = new Set();
      document.getElementById("pl-multi-btn")?.classList.toggle("is-active", plEdit.multi);
      renderPlaylistEditUI();
      syncMultiTrash();
    });

    document.getElementById("pl-multi-trash")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const pl = state.currentPlaylist && getPlaylist(state.currentPlaylist.id);
      if (!pl || !plEdit.selected?.size) return;
      pl.tracks = (pl.tracks || []).filter(
        (ref) => !plEdit.selected.has(`${ref.gameId}::${ref.trackId}`)
      );
      pl.updatedAt = Date.now();
      saveUserLibrary();
      plEdit.selected = new Set();
      renderPlaylistEditUI();
      syncMultiTrash();
      resyncQueueAfterPlaylistChange(pl.id);
    });

    const bulk = document.getElementById("pl-multi-loops-input");
    const commitBulk = () => {
      const pl = state.currentPlaylist && getPlaylist(state.currentPlaylist.id);
      if (!pl || !plEdit.selected?.size) return;
      const raw = String(bulk.value || "").replace(/[^\d]/g, "").slice(0, 2);
      if (raw === "") return;
      const n = clampInt(raw, 0, 99, 0);
      bulk.value = String(n);
      for (const key of plEdit.selected) {
        const [gameId, trackId] = key.split("::");
        setPlaylistTrackLoops(pl, gameId, trackId, n);
      }
      saveUserLibrary();
      renderPlaylistEditUI();
    };
    bulk?.addEventListener("click", (e) => e.stopPropagation());
    bulk?.addEventListener("change", commitBulk);
    bulk?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitBulk();
        bulk.blur();
      }
    });
  }
  ms.classList.remove("hidden");
  // openGame may have left these with .hidden — always clear when entering edit
  document.getElementById("pl-multi-btn")?.classList.remove("hidden");
  document.getElementById("pl-clear-loops-btn")?.classList.remove("hidden");
  document.getElementById("pl-multi-btn")?.classList.toggle("is-active", !!plEdit.multi);
  syncMultiTrash();
  // Re-bind press (created after first global bindPressMinHold)
  if (typeof bindPressMinHold === "function") {
    [
      "pl-multi-btn",
      "pl-multi-trash",
      "pl-clear-loops-btn",
      "pl-edit-save",
      "pl-edit-cancel",
      "pl-edit-btn",
      "pl-add-songs-chip",
      "pl-loops-btn",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) delete el.dataset.pressBound;
    });
    bindPressMinHold(document.getElementById("pl-edit-chrome") || document);
    bindPressMinHold(ms);
  }
}
function popChip(el) {
  if (!el) return;
  el.classList.remove("hidden", "chip-out");
  el.classList.remove("chip-enter");
  void el.offsetWidth;
  el.classList.add("chip-enter");
}

function hideChip(el) {
  if (!el || el.classList.contains("hidden")) return;
  el.classList.remove("chip-enter");
  el.classList.add("chip-out");
  const done = () => {
    el.classList.add("hidden");
    el.classList.remove("chip-out");
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
  // fallback if animationend doesn’t fire
  setTimeout(done, 280);
}

function syncMultiTrash() {
  const trash = document.getElementById("pl-multi-trash");
  const loopsWrap = document.getElementById("pl-multi-loops");
  const n = plEdit.selected?.size || 0;
  const show = !!(plEdit.multi && n > 0);

  if (show) {
    if (trash?.classList.contains("hidden")) popChip(trash);
    if (loopsWrap?.classList.contains("hidden")) popChip(loopsWrap);
  } else {
    hideChip(trash);
    hideChip(loopsWrap);
  }
}

/** Queue-like pointer drag with ghost + drop gap */
function bindPlaylistTrackDrag(pl) {
  const list = trackListEl;
  const scroller = document.querySelector(".track-list-scroll") || list;
  if (!list) return;

  let dragIndices = [];
  let dragFrom = -1;
  let ghost = null;
  let dropIndex = -1;
  let lastDropIndex = -2;
  let lastY = 0;
  let scrollRaf = null;
  let slotEl = null;

  function selectedIndices() {
    if (!plEdit.multi || !plEdit.selected?.size) return [];
    return [...list.querySelectorAll(".track-row")]
      .map((r) => (plEdit.selected.has(r.dataset.key) ? +r.dataset.index : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
  }

  function ensureSlot() {
    if (slotEl && slotEl.isConnected) return slotEl;
    slotEl = document.createElement("div");
    slotEl.className = "queue-drop-slot";
    slotEl.setAttribute("aria-hidden", "true");
    return slotEl;
  }

  function removeSlot() {
    if (slotEl?.parentNode) slotEl.parentNode.removeChild(slotEl);
    slotEl = null;
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
      const r = scroller.getBoundingClientRect();
      const edge = 56;
      let d = 0;
      if (lastY < r.top + edge) d = -12;
      else if (lastY > r.bottom - edge) d = 12;
      if (d) {
        scroller.scrollTop += d;
        placeSlot(computeDropIndex(lastY));
      }
      scrollRaf = requestAnimationFrame(tick);
    };
    scrollRaf = requestAnimationFrame(tick);
  }

  function computeDropIndex(clientY) {
    const rows = [...list.querySelectorAll(".track-row:not(.dragging)")];
    if (!rows.length) return 0;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return +row.dataset.index;
    }
    return +rows[rows.length - 1].dataset.index + 1;
  }

  function placeSlot(insertBeforeIndex) {
    // identical guard to queue → no flicker
    if (insertBeforeIndex === lastDropIndex) return;

    const min = Math.min(...dragIndices);
    const max = Math.max(...dragIndices);
    if (insertBeforeIndex >= min && insertBeforeIndex <= max + 1) {
      removeSlot();
      dropIndex = insertBeforeIndex;
      lastDropIndex = insertBeforeIndex;
      return;
    }

    lastDropIndex = insertBeforeIndex;
    dropIndex = insertBeforeIndex;

    const slot = ensureSlot();
    slot.classList.add("active");

    const rows = [...list.querySelectorAll(".track-row:not(.dragging)")];
    let anchor = null;
    for (const row of rows) {
      if (+row.dataset.index >= insertBeforeIndex) {
        anchor = row;
        break;
      }
    }
    const next = anchor || null;
    // already in the right place → zero DOM writes
    if (slot.parentNode === list && slot.nextSibling === next) return;

    if (next) list.insertBefore(slot, next);
    else list.appendChild(slot);
  }

  function onMove(e) {
    if (dragFrom < 0) return;
    lastY = e.clientY;
    if (ghost) {
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
    }
    placeSlot(computeDropIndex(e.clientY));
  }

  function onUp() {
    if (dragFrom < 0) {
      document.querySelectorAll(".queue-drag-ghost").forEach((g) => g.remove());
      return;
    }
    const froms = [...dragIndices].sort((a, b) => a - b);
    let to = dropIndex;
    document.querySelectorAll(".queue-drag-ghost").forEach((g) => g.remove());
    ghost = null;
    stopAutoScroll();
    removeSlot();
    list.querySelectorAll(".track-row").forEach((r) => r.classList.remove("dragging"));
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    dragFrom = -1;
    dragIndices = [];
    lastDropIndex = -2;

    if (to < 0) return;
    const moving = froms.map((i) => pl.tracks[i]);
    for (let i = froms.length - 1; i >= 0; i--) pl.tracks.splice(froms[i], 1);
    const removedBefore = froms.filter((i) => i < to).length;
    to = Math.max(0, to - removedBefore);
    pl.tracks.splice(to, 0, ...moving);
    plEdit.selected = new Set();
    renderPlaylistEditUI();
    requestAnimationFrame(() => {
      for (let i = 0; i < moving.length; i++) {
        const row = trackListEl?.querySelector(`.track-row[data-index="${to + i}"]`);
        if (!row) continue;
        row.classList.remove("drop-flash");
        void row.offsetWidth;
        row.classList.add("drop-flash");
      }
    });
  }

  list.querySelectorAll(".pl-edit-drag, .track-row .q-drag").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      document.querySelectorAll(".queue-drag-ghost").forEach((g) => g.remove());
      ghost = null;
      e.preventDefault();
      e.stopPropagation();
      const row = handle.closest(".track-row");
      if (!row) return;
      const idx = +row.dataset.index;
      const sel = selectedIndices();
      dragIndices = sel.length && sel.includes(idx) ? sel : [idx];
      dragFrom = idx;
      dropIndex = idx;
      lastDropIndex = -2;
      lastY = e.clientY;
      dragIndices.forEach((i) => {
        list.querySelector(`.track-row[data-index="${i}"]`)?.classList.add("dragging");
      });

      const t = row.querySelector(".track-name")?.textContent || "";
      const sub = row.querySelector(".track-sub")?.textContent || "";
      const cover = row.querySelector(".pl-track-cover")?.src || PLACEHOLDER;
      const extra = dragIndices.length > 1 ? ` · ${dragIndices.length}` : "";
      ghost = document.createElement("div");
      ghost.className = "queue-drag-ghost";
      ghost.innerHTML = `
        <img src="${cover}" alt="">
        <div class="ghost-meta">
          <div class="ghost-title">${escapeHtml(t)}${extra}</div>
          <div class="ghost-sub">${escapeHtml(sub)}</div>
        </div>`;
      document.body.appendChild(ghost);
      onMove(e);
      startAutoScroll();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  });
}

function openPlaylistCoverPicker(pl) {
  const games = [];
  const seen = new Set();
  for (const ref of pl.tracks || []) {
    if (seen.has(ref.gameId)) continue;
    const g = LIBRARY.find((x) => x.id === ref.gameId);
    if (g?.cover) {
      games.push(g);
      seen.add(ref.gameId);
    }
  }
  // Simple prompt UI — reuse add-to-pl overlay shell or a small custom panel
  const picks = [
    { mode: "auto", label: "Automatisch (Mosaik)", src: null },
    ...games.map((g) => ({ mode: "game", label: g.title, src: g.cover })),
  ];
  // For a quick version without new HTML:
  const choice = window.prompt(
    "Cover: 0 = Auto/Mosaik\n" +
      picks
        .slice(1)
        .map((p, i) => `${i + 1} = ${p.label}`)
        .join("\n"),
    "0"
  );
  const n = Number(choice);
  if (!Number.isFinite(n) || n < 0 || n >= picks.length) return;
  const pick = picks[n];
  pl.coverMode = pick.mode === "auto" ? "auto" : "game";
  pl.coverSrc = pick.src;
  const coverEl = $("#game-cover");
  if (coverEl) {
    const src = playlistCoverSrc(pl);
    coverEl.src = Array.isArray(src) ? src[0] || PLACEHOLDER : src;
  }
}

/** Close every floating menu except optional keep (e.g. "add-to-pl"). */
function closeAllPopovers(except) {
  if (except !== "context" && typeof hideContextMenu === "function") hideContextMenu();
  if (except !== "sleep" && typeof closeSleepPanel === "function") closeSleepPanel();
  if (except !== "loop" && typeof closeLoopMenu === "function") closeLoopMenu();

  if (except !== "gs") {
    const fp = $("#gs-filter-panel");
    const sp = $("#gs-sort-panel");
    if (fp) {
      fp.classList.add("hidden");
      fp.classList.remove("is-closing");
    }
    if (sp) {
      sp.classList.add("hidden");
      sp.classList.remove("is-closing");
    }
  }

  if (except !== "lib-sort") {
    const lp = $("#lib-sort-panel");
    if (lp) {
      lp.classList.add("hidden");
      lp.classList.remove("is-closing");
    }
  }
}

function bindLibraryUI() {
  $("#lib-create-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLibCreatePanel();
  });

  $("#lib-create-panel")?.addEventListener("click", (e) => {
    const opt = e.target.closest("[data-lib-create]");
    if (!opt) return;
    e.stopPropagation();
    const mode = opt.getAttribute("data-lib-create");
    closeLibCreatePanel();
    if (mode === "new") {
      const pl = createPlaylist();
      if (!pl) return;
      renderLibrary({ animate: true });
      showToast?.(`„${pl.name}“ erstellt`);
    } else if (mode === "import") {
      $("#lib-import-file")?.click();
    }
  });

  $("#lib-import-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await importPlaylistFromFile(file);
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".lib-create-wrap")) return;
    closeLibCreatePanel();
  });

  const search = $("#lib-local-search");
  const clear = $("#lib-local-search-clear");
  search?.addEventListener("input", () => {
    libPrefs.query = search.value || "";
    clear?.classList.toggle("hidden", !libPrefs.query);
    renderLibrary({ animate: false });
  });
  clear?.addEventListener("click", () => {
    if (search) search.value = "";
    libPrefs.query = "";
    clear.classList.add("hidden");
    renderLibrary({ animate: false });
  });

const sortBtn = $("#lib-sort-btn");
  const sortPanel = $("#lib-sort-panel");

  function closeLibSortPanel() {
    if (!sortPanel || sortPanel.classList.contains("hidden")) return;
    sortPanel.classList.add("is-closing");
    setTimeout(() => {
      sortPanel.classList.add("hidden");
      sortPanel.classList.remove("is-closing");
    }, 180);
  }

  let ignoreViewClickUntil = 0;

  sortBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = sortPanel && !sortPanel.classList.contains("hidden");
    if (open) {
      closeLibSortPanel();
    } else {
      closeAllPopovers("lib-sort");
      sortPanel?.classList.remove("hidden", "is-closing");
    }
    // Opening/closing the panel sits over the view button on iPad — block ghost clicks
    ignoreViewClickUntil = performance.now() + 400;
    syncLibToolbar();
  });

  // Panel itself: stop pointer events from falling through to view btn
  sortPanel?.addEventListener(
    "pointerdown",
    (e) => {
      e.stopPropagation();
      ignoreViewClickUntil = performance.now() + 400;
    },
    { passive: true }
  );

  sortPanel?.querySelectorAll("[data-lib-sort]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ignoreViewClickUntil = performance.now() + 400;
      libPrefs.sort = b.dataset.libSort;
      syncLibToolbar();
      // animate:false avoids layout thrash while panel is open
      renderLibrary({ animate: false });
    });
  });
  sortPanel?.querySelectorAll("[data-lib-dir]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ignoreViewClickUntil = performance.now() + 400;
      libPrefs.dir = b.dataset.libDir;
      syncLibToolbar();
      renderLibrary({ animate: false });
    });
  });

  $("#lib-view-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    // Ignore only real ghost clicks right after a chip/sort-btn press — not intentional view taps
    if (performance.now() < ignoreViewClickUntil) return;
    // Sort menu open → close it, then still toggle the view
    if (sortPanel && !sortPanel.classList.contains("hidden")) {
      closeLibSortPanel();
    }
    libPrefs.view = libPrefs.view === "grid" ? "list" : "grid";
    syncLibToolbar();
    renderLibrary({ animate: true });
  });

  document.querySelectorAll("[data-lib-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (libPrefs.filter === btn.dataset.libFilter) return;
      if (libNavLocked) return;
      libPrefs.filter = btn.dataset.libFilter;
      syncLibToolbar();
      renderLibrary({ animate: true });
    });
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#lib-sort-btn") || e.target.closest("#lib-sort-panel")) return;
    closeLibSortPanel();
  });

  $("#btn-profile")?.addEventListener("click", openProfile);

  document.querySelectorAll('.tab[data-tab="playlists"]').forEach((tab) => {
    tab.addEventListener("click", () => {
      setTimeout(() => renderLibrary({ animate: false }), 0);
    });
  });

  syncLibToolbar();
}

let addToPlTarget = null; // { gameId, trackId }
let addToPlSelected = new Set();

function openAddToPlaylistMenu(gameId, trackId) {
  if (!gameId || !trackId) {
    console.warn("[Noma] openAddToPlaylistMenu: missing ids", gameId, trackId);
    return;
  }
  addToPlTarget = { gameId, trackId };
  addToPlSelected = new Set(
    userLib.playlists
      .filter((p) => isTrackInPlaylist(p.id, gameId, trackId))
      .map((p) => p.id)
  );
  // Always preselect the playlist we came from via +
  if (window.__forcePlaylistSelectId) {
    addToPlSelected.add(window.__forcePlaylistSelectId);
  }
  const search = $("#add-to-pl-search");
  if (search) search.value = "";
  renderAddToPlList();
  bindScrollFadeY(document.querySelector(".add-to-pl-list"));

  const ov = document.getElementById("add-to-pl-overlay");
  if (!ov) {
    console.warn("[Noma] #add-to-pl-overlay missing — put it as a direct child of <body>");
    return;
  }
  // Defensive: if still nested under #fullscreen-player, move to body
  if (ov.parentElement !== document.body) {
    document.body.appendChild(ov);
  }

  closeAllPopovers();
  ov.classList.remove("hidden");
  ov.style.display = "";
  ov.setAttribute("aria-hidden", "false");
}

function closeAddToPlMenu() {
  $("#add-to-pl-overlay")?.classList.add("hidden");
  $("#add-to-pl-overlay")?.setAttribute("aria-hidden", "true");
  addToPlTarget = null;
  addToPlSelected.clear();
}

function renderAddToPlList() {
  const list = $("#add-to-pl-list");
  if (!list) return;
  const q = ($("#add-to-pl-search")?.value || "").trim().toLowerCase();
  const pinned = userLib.playlists.filter((p) => p.pinned);
  const rest = userLib.playlists.filter((p) => !p.pinned);
  const ordered = [...pinned, ...rest].filter(
    (p) => !q || p.name.toLowerCase().includes(q)
  );
    list.innerHTML = ordered
    .map((pl) => {
      const sel = addToPlSelected.has(pl.id) ? "is-selected" : "";
      const pin = pl.pinned
        ? `<span class="add-to-pl-pin" title="Angepinnt"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>`
        : "";
      return `<li>
        <button type="button" class="add-to-pl-item ${sel}" data-pl-id="${escapeHtml(pl.id)}">
          ${playlistThumbHtml(pl, "add-to-pl-cover")}
          <span class="add-to-pl-name">${escapeHtml(pl.name)}${pin}</span>
          <span class="pl-check"></span>
        </button>
      </li>`;
    })
    .join("");
  list.querySelectorAll(".add-to-pl-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.plId;
      if (addToPlSelected.has(id)) addToPlSelected.delete(id);
      else addToPlSelected.add(id);
      btn.classList.toggle("is-selected");
    });
  });
}

function bindAddToPlaylistUI() {
  $("#add-to-pl-cancel")?.addEventListener("click", closeAddToPlMenu);
  $("#add-to-pl-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "add-to-pl-overlay") closeAddToPlMenu();
  });
  $("#add-to-pl-search")?.addEventListener("input", renderAddToPlList);
  $("#add-to-pl-create")?.addEventListener("click", () => {
    const pl = createPlaylist();
    if (!pl) return;
    addToPlSelected.add(pl.id);
    renderAddToPlList();
    renderLibrary();
  });
    $("#add-to-pl-done")?.addEventListener("click", () => {
    if (!addToPlTarget) return closeAddToPlMenu();
    if (addCollectionTarget) {
      const selected = [...addToPlSelected];
      let tracks = [];
      if (addCollectionTarget.type === "album" && addCollectionTarget.game) {
        tracks = (addCollectionTarget.game.tracks || []).map((t) => ({
          gameId: addCollectionTarget.game.id,
          trackId: t.id,
        }));
      } else if (addCollectionTarget.type === "playlist" && addCollectionTarget.playlist) {
        tracks = (addCollectionTarget.playlist.tracks || []).map((r) => ({
          gameId: r.gameId,
          trackId: r.trackId,
        }));
      }
      for (const plId of selected) {
        for (const ref of tracks) {
          setTrackInPlaylist(plId, ref.gameId, ref.trackId, true);
        }
      }
      addCollectionTarget = null;
      const t = $("#add-to-pl-title");
      if (t) t.textContent = "Zu Playlist hinzufügen";
      closeAddToPlMenu();
      renderLibrary({ animate: false });
      if (state.currentPlaylist) refreshOpenPlaylistDetail();
      showToast?.("Zu Playlists hinzugefügt");
      return;
    }
    const { gameId, trackId } = addToPlTarget;
    for (const pl of userLib.playlists) {
      const want = addToPlSelected.has(pl.id);
      setTrackInPlaylist(pl.id, gameId, trackId, want);
    }

    // When Schnell-Hinzufügen is OFF and user picked exactly one playlist → that becomes
    // the session default for + (does NOT touch settings.quickAddPlaylistId)
    if (!settings.quickAddEnabled && addToPlSelected.size === 1) {
      sessionQuickAddId = [...addToPlSelected][0];
    }

    const game = LIBRARY.find((g) => g.id === gameId);
    const track = game?.tracks?.find((t) => t.id === trackId);
    closeAddToPlMenu();
    renderLibrary({ animate: false });
    syncTrackPlusButtons(gameId, trackId);
    if (state.currentPlaylist && !globalSearchOpen) {
      const stillIn = isTrackInPlaylist(state.currentPlaylist.id, gameId, trackId);
      refreshOpenPlaylistDetail({
        flashTrackId: trackId,
        flashType: stillIn ? "add" : "remove",
      });
    }
    if (typeof showToast === "function") {
      showToast({
        cover: game?.cover || PLACEHOLDER,
        title: track?.title || "Song",
        sub: "Playlists aktualisiert",
      });
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
    bindAllScrollFades(); // add this at end of inject()
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
  bindAllScrollFades();
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

  cancelEditIfNeeded();

  // Prefer explicit context over tab heuristics
  // If we're returning into search from a game (+ Songs flow), keep existing playlist return
  const keepPlaylistSearch =
    searchReturn?.type === "playlist" &&
    searchReturn.playlistId &&
    searchReturn.stayInSearch;

  if (keepPlaylistSearch) {
    // leave searchReturn as-is (playlistId + query + stayInSearch)
    window.__forcePlaylistSelectId =
      window.__forcePlaylistSelectId || searchReturn.playlistId;
  } else if (state.currentPlaylist) {
    searchReturn = {
      type: "playlist",
      playlistId: state.currentPlaylist.id,
      stayInSearch: !!(window.__forcePlaylistSelectId || searchReturn?.stayInSearch),
    };
  } else if (
    gameDetail?.classList.contains("active") &&
    state.currentGame &&
    searchReturn?.type === "library"
  ) {
    // keep library return when opening search from a library album
    searchReturn = { type: "library", gameId: state.currentGame.id };
  } else if (gameDetail?.classList.contains("active") && state.currentGame) {
    searchReturn = {
      type: "game",
      gameId: state.currentGame.id,
      // preserve prior library/playlist origin if any
      from: searchReturn?.type === "library" ? "library" : searchReturn?.type === "playlist" ? "playlist" : null,
      playlistId: searchReturn?.playlistId || null,
    };
  } else if (document.body.classList.contains("games-cat-open")) {
    searchReturn = {
      type: "category",
      catKey: $("#games-browse")?.dataset.catOpen || null,
      catMode: $("#games-browse")?.dataset.catMode || null,
    };
  } else if (
    document.querySelector('.tab[data-tab="playlists"]')?.classList.contains("active")
  ) {
    searchReturn = { type: "playlists" };
  } else {
    searchReturn = { type: "games" };
  }

  globalSearchOpen = true;
  document.body.classList.add("search-open", "search-mode");

  // Always switch top tabs + panels to Games while searching
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  $("#tab-games")?.classList.add("active");
  $("#tab-playlists")?.classList.remove("active");

  gameDetail?.classList.add("hidden");
  gameDetail?.classList.remove("active");
  if (document.body.classList.contains("games-cat-open")) {
    document.body.classList.remove("games-cat-open");
  }

  const title = $("#games-page-title");
  if (title) title.textContent = "Suche";

  $("#gs-toolbar")?.classList.remove("hidden");
  if (typeof syncGsToolbar === "function") syncGsToolbar();
  else if (typeof window.syncGsToolbar === "function") window.syncGsToolbar();

  const input = $("#global-search-input");
  if (clearInput && input) {
    input.value = "";
    $("#global-search-clear")?.classList.add("hidden");
  }
  // Sync focus — required for mobile keyboard (rAF is too late)
  if (input) {
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus();
    }
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

  // Leaving search always clears forced playlist targeting
  window.__forcePlaylistSelectId = null;

  if (ret?.type === "playlist" && ret.playlistId) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-playlists")?.classList.add("active");
    openPlaylistDetail(ret.playlistId);
    return;
  }

  if (ret?.type === "library") {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-playlists")?.classList.add("active");
    if (ret.gameId) {
      searchReturn = { type: "library" };
      openGame(ret.gameId);
    } else {
      gameDetail?.classList.add("hidden");
      gameDetail?.classList.remove("active");
      state.currentGame = null;
      renderLibrary({ animate: false });
    }
    return;
  }

  if (ret?.type === "game" && ret.gameId) {
    // restore tab under the album so both tabs aren’t active
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    if (ret.from === "library") {
      document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
      searchReturn = { type: "library" }; // so album back still returns to library
    } else {
      document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    }
    openGame(ret.gameId);
    return;
  }

  if (ret?.type === "category" && ret.catKey) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    $("#tab-games")?.classList.add("active");
    gameDetail?.classList.add("hidden");
    gameDetail?.classList.remove("active");
    openCategoryFullscreen(ret.catKey, ret.catMode || gamesViewMode, { instant: true });
    return;
  }

  if (ret?.type === "playlists") {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-playlists")?.classList.add("active");
    renderLibrary({ animate: false });
    return;
  }

  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  $("#tab-games")?.classList.add("active");
  gameDetail?.classList.add("hidden");
  gameDetail?.classList.remove("active");
  renderGames({ animate: true });
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
        <button type="button"
          class="gs-lib-btn ${isAlbumInLibrary(g.id) ? "is-in-lib" : ""}"
          data-game-id="${escapeHtml(g.id)}"
          aria-label="${isAlbumInLibrary(g.id) ? "Aus Bibliothek" : "Zur Bibliothek"}"
          title="${isAlbumInLibrary(g.id) ? "Aus Bibliothek" : "Zur Bibliothek"}">
          ${isAlbumInLibrary(g.id) ? FAV_CHECK_SVG : FAV_PLUS_SVG}
        </button>
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
        <button type="button" class="gs-fav-btn ${isTrackInAnyPlaylist(game.id, track.id) ? "is-fav" : ""}" data-game-id="${escapeHtml(game.id)}" data-track-id="${escapeHtml(track.id)}" aria-label="Zur Playlist" title="Zur Playlist">
          ${isTrackInAnyPlaylist(game.id, track.id) ? FAV_CHECK_SVG : FAV_PLUS_SVG}
        </button>
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
  bindScrollFadeY(box);
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
        // + Songs flow: back from game returns to search; search back returns to playlist
        if (searchReturn?.type === "playlist" && searchReturn.playlistId) {
          searchReturn = {
            type: "playlist",
            playlistId: searchReturn.playlistId,
            stayInSearch: true,
            fromPlaylistAdd: true,
            query: q,
          };
          window.__forcePlaylistSelectId = searchReturn.playlistId;
        } else if (searchReturn?.type === "library") {
          searchReturn = { type: "library", query: q };
        } else {
          searchReturn = q ? { type: "search", query: q } : null;
        }
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

  box.querySelectorAll(".gs-lib-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const gid = btn.dataset.gameId;
    const nowIn = toggleAlbumInLibrary(gid);
    btn.classList.toggle("is-in-lib", nowIn);
    btn.innerHTML = nowIn ? FAV_CHECK_SVG : FAV_PLUS_SVG;
    btn.setAttribute("aria-label", nowIn ? "Aus Bibliothek" : "Zur Bibliothek");
    if (typeof showToast === "function") {
      const g = LIBRARY.find((x) => x.id === gid);
      showToast(
        nowIn
          ? { cover: g?.cover || PLACEHOLDER, title: g?.title || "Album", sub: "Zur Bibliothek hinzugefügt" }
          : { cover: g?.cover || PLACEHOLDER, title: g?.title || "Album", sub: "Aus Bibliothek entfernt" }
      );
    }
    renderLibrary({ animate: false });
  });
});

    box.querySelectorAll(".gs-fav-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleTrackPlusClick(btn.dataset.gameId, btn.dataset.trackId);
    });
  });

  // long-press mobile
  box.querySelectorAll(".gs-row").forEach((row) => {
    let lpTimer = null;
    let lpMoved = false;
    row.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      if (e.target.closest(".gs-menu, .gs-fav-btn, .gs-lib-btn")) return;
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
    const q = e.target.value;
    if (searchReturn?.type === "playlist" && searchReturn.stayInSearch) {
      searchReturn.query = q;
    }
    runGlobalSearch(q);
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
    closeAllPopovers("gs");

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
  cancelEditIfNeeded();
  state.currentPlaylist = null;
  gameDetail?.classList.remove("is-playlist-detail");
  trackListEl?.classList.remove("is-playlist");
  const libBtn0 = $("#album-lib-btn");
  if (libBtn0) libBtn0.style.display = "";
  const labelEl0 = document.querySelector(".game-label");
  if (labelEl0) labelEl0.textContent = "Spiel";

  // Preserve where search should return (do NOT open search here)
  const gsInput = $("#global-search-input");
  const savedSearch = gsInput?.value?.trim() || "";
  // Preserve playlist/library even if search UI was just closed by the result click
  if (searchReturn?.type === "playlist" && searchReturn.playlistId) {
    searchReturn = {
      type: "playlist",
      playlistId: searchReturn.playlistId,
      stayInSearch: true,
      fromPlaylistAdd: true,
      query: savedSearch || searchReturn.query || "",
    };
    window.__forcePlaylistSelectId = searchReturn.playlistId;
  } else if (searchReturn?.type === "library") {
    searchReturn = {
      type: "library",
      gameId: searchReturn.gameId,
      query: savedSearch || searchReturn.query || "",
    };
  } else if (globalSearchOpen && savedSearch) {
    searchReturn = { type: "search", query: savedSearch };
  } else if (document.body.classList.contains("games-cat-open")) {
    const browse = $("#games-browse");
    searchReturn = {
      type: "category",
      catKey: browse?.dataset.catOpen || null,
      catMode: browse?.dataset.catMode || gamesViewMode,
    };
  }
  // else: leave existing searchReturn (library / playlist) alone

  // Remember previous album (scroll + its own search), not a global one
  if (state.currentGame && state.currentGame.id !== id) {
    saveAlbumViewState();
  }
  state.currentGame = game;

  tabGames.classList.remove("active");
  tabPlaylists.classList.remove("active");
  gameDetail.classList.remove("hidden");
  gameDetail.classList.add("active");
  exitPlaylistEditMode?.(true);
  // Hide AFTER exit — exit used to un-hide + when pl was null
  $("#pl-add-songs-chip")?.classList.add("hidden");
  $("#pl-add-songs-btn")?.classList.add("hidden");
  $("#pl-edit-btn")?.classList.add("hidden");
  $("#pl-edit-chrome")?.classList.add("hidden");
  $("#pl-multi-wrap")?.classList.add("hidden");
  $("#pl-multi-btn")?.classList.add("hidden");
  $("#pl-multi-trash")?.classList.add("hidden");
  $("#pl-clear-loops-btn")?.classList.add("hidden");
  $("#pl-loops-btn")?.classList.add("hidden");

  const coverEl = $("#game-cover");
  if (coverEl) coverEl.src = game.cover || PLACEHOLDER;

  const titleEl = $("#game-title");
  if (titleEl) {
    titleEl.dataset.full = game.title || "";
    titleEl.dataset.short = game.short || game.title || "";
    const compact = document
      .querySelector(".game-sticky-top")
      ?.classList.contains("is-collapsed");
    titleEl.textContent = compact
      ? titleEl.dataset.short
      : titleEl.dataset.full;
  }

  const libBtn = $("#album-lib-btn");
  if (libBtn) {
    const inLib = isAlbumInLibrary(game.id);
    libBtn.classList.toggle("is-in-lib", inLib);
    libBtn.querySelector(".album-lib-plus")?.classList.toggle("hidden", inLib);
    libBtn.querySelector(".album-lib-check")?.classList.toggle("hidden", !inLib);
    libBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nowIn = toggleAlbumInLibrary(game.id);
      libBtn.classList.toggle("is-in-lib", nowIn);
      libBtn.querySelector(".album-lib-plus")?.classList.toggle("hidden", nowIn);
      libBtn.querySelector(".album-lib-check")?.classList.toggle("hidden", !nowIn);
      toastAlbumLib(game, nowIn);
      renderLibrary({ animate: false });
    };
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
      <button type="button" class="track-fav-btn" data-fav-track="${t.id}" aria-label="Favorit">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
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

  trackListEl.querySelectorAll(".track-fav-btn").forEach((btn) => {
    const trackId = btn.dataset.favTrack;
    paintFavButton(btn, isTrackInAnyPlaylist(game.id, trackId));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleTrackPlusClick(game.id, trackId);
    });
    if (typeof bindPressMinHold === "function") bindPressMinHold(btn);
  });

  bindTrackListFade();
  bindAllScrollFades();
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
        if (e.target.closest(".track-actions, .track-fav-btn")) return;  // ← add .track-fav-btn
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

  const playAllBtn = $("#play-all-btn");
  if (playAllBtn) {
    playAllBtn.onclick = () => {
      unlockMediaElement().catch(() => {});
      unshuffledQueue = null;
      state.queue = game.tracks.map((t) => ({
        gameId: game.id,
        track: t,
        insert: null,
      }));
      state.queueIndex = 0;
      state.shuffle = false;
      clearPlayingPlaylist();
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

  const shuffleAllBtn = $("#shuffle-all-btn");
  if (shuffleAllBtn) {
    shuffleAllBtn.onclick = () => {
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
      clearPlayingPlaylist();
      if (state.loopMode === "count") {
        state.loopsRemaining = settings.loopTimes;
      } else {
        state.loopsRemaining = 0;
      }

      bindPressMinHold(
        document.querySelector(".game-sticky-top") || document
      );

      playCurrent();
      renderQueue();
      updatePlayerUI();
    };
  }

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
      // Leaving search → fully close so Playlists keeps its own search/toggles
      if (globalSearchOpen) {
        globalSearchOpen = false;
        document.body.classList.remove("search-open", "search-mode");
        $("#global-search-results")?.classList.add("hidden");
        if ($("#global-search-results")) $("#global-search-results").innerHTML = "";
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
        searchReturn = null;
      }

      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));

      const name = tab.dataset.tab;

      // Always leave album/playlist detail when switching tabs
      if (plEdit?.active) exitPlaylistEditMode(true);
      state.currentGame = null;
      state.currentPlaylist = null;
      gameDetail.classList.add("hidden");
      gameDetail.classList.remove("active", "is-playlist-detail");
      trackListEl?.classList.remove("is-playlist");
      searchReturn = null;

      const panel = $(`#tab-${name}`);
      if (panel) panel.classList.add("active");

      if (name === "playlists") {
        setTimeout(() => renderLibrary({ animate: false }), 0);
      }
      if (name === "games") {
        renderGames({ animate: false });
      }
    });
  });

  $("#back-to-games").addEventListener("click", () => {
    // From playlist detail → library
    if (state.currentPlaylist) {
      // In edit mode: back = cancel edit, stay on playlist
      if (plEdit?.active) {
        exitPlaylistEditMode(true);
        return;
      }
      state.currentPlaylist = null;
      state.currentGame = null;
      gameDetail.classList.add("hidden");
      gameDetail.classList.remove("active", "is-playlist-detail");
      trackListEl?.classList.remove("is-playlist");
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      $("#tab-playlists")?.classList.add("active");
      const labelEl = document.querySelector(".game-label");
      if (labelEl) labelEl.textContent = "Spiel";
      const libBtn = $("#album-lib-btn");
      if (libBtn) libBtn.style.display = "";
      renderLibrary({ animate: false });
      return;
    }

    if (state.currentGame) saveAlbumViewState(state.currentGame.id);

    // Opened from library → back to playlists tab
    if (searchReturn?.type === "library") {
      state.currentGame = null;
      gameDetail.classList.add("hidden");
      gameDetail.classList.remove("active");
      searchReturn = null;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      $("#tab-playlists")?.classList.add("active");
      renderLibrary({ animate: false });
      return;
    }

    state.currentGame = null;
    gameDetail.classList.add("hidden");
    gameDetail.classList.remove("active");

    // + Songs → search → open game → back: return to SEARCH (playlist is under that)
    if (
      searchReturn?.type === "playlist" &&
      searchReturn.playlistId &&
      (searchReturn.stayInSearch || searchReturn.fromPlaylistAdd)
    ) {
      const pid = searchReturn.playlistId;
      const q =
        searchReturn.query ||
        $("#global-search-input")?.value?.trim() ||
        "";
      searchReturn = {
        type: "playlist",
        playlistId: pid,
        stayInSearch: true,
        fromPlaylistAdd: true,
        query: q,
      };
      window.__forcePlaylistSelectId = pid;
      openGlobalSearch(false); // keepPlaylistSearch path preserves searchReturn
      const input = $("#global-search-input");
      if (input) {
        input.value = q;
        input.blur(); // stay on search results, do not open keyboard
        $("#global-search-clear")?.classList.toggle("hidden", !q.trim());
        runGlobalSearch(q);
      }
      return;
    }

    // Playlist origin without stay-in-search → straight back to playlist
    if (searchReturn?.type === "playlist" && searchReturn.playlistId) {
      const pid = searchReturn.playlistId;
      searchReturn = null;
      window.__forcePlaylistSelectId = null;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      $("#tab-playlists")?.classList.add("active");
      openPlaylistDetail(pid);
      return;
    }

    tabGames.classList.add("active");
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    $("#tab-games")?.classList.add("active");

    if (searchReturn?.type === "search" && searchReturn.query) {
      const q = searchReturn.query;
      searchReturn = null;
      openGlobalSearch(false);
      const input = $("#global-search-input");
      if (input) {
        input.value = q;
        input.blur();
        $("#global-search-clear")?.classList.toggle("hidden", !q.trim());
        runGlobalSearch(q);
      }
      return;
    }

    if (searchReturn?.type === "category" && searchReturn.catKey) {
      const key = searchReturn.catKey;
      const mode = searchReturn.catMode || gamesViewMode;
      searchReturn = null;
      openCategoryFullscreen(key, mode, { instant: true });
      return;
    }

    if (searchReturn?.type === "playlist" && searchReturn.playlistId) {
      const pid = searchReturn.playlistId;
      searchReturn = null;
      window.__forcePlaylistSelectId = null;
      openPlaylistDetail(pid);
      return;
    }

    searchReturn = null;
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
  clearPlayingPlaylist();
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
    state.loopsRemaining = resolveLoopsForQueueItem(item);
  }

  $("#now-cover").src = game?.cover || PLACEHOLDER;
  setMarqueeText($("#now-title"), track.title);
  $("#now-game").textContent = gameNameForPlayer(game);
  $("#fs-cover").src = game?.cover || PLACEHOLDER;
  const _fsT = $("#fs-title"); 
  if (_fsT) _fsT.textContent = track.title;
  $("#fs-game").textContent = gameNameForFullscreen(game);
  // set cover only once we know the track — avoids idle→placeholder→cover flash
  if (game?.cover) {
    setAmbientBackground(game.cover);
  }
  document.body.classList.add("is-playing");
  markPlayingTrack(track.id);

  beginListenSession();

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
  markPlayingLibraryCards();

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
      endListenSession();
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
      endListenSession();
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
    endListenSession();
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
    state.loopsRemaining = resolveLoopsForQueueItem(state.queue[state.queueIndex]);
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
      if (audioCtx && audioCtx.currentTime < softEndFadeAt - 0.05) {
        rescheduleSoftEndAfterResume();
        return;
      }
      transitioning = true;
      transitionStartedAt = softEndFadeAt;
      document.body.classList.add("is-transitioning");
      lastLoopCycle = Math.max(0, lastLoopCycle);
      if (state.loopMode === "count") {
        state.loopsRemaining = 0;
        updatePlayerUI();
      }
      updateProgressUI();
    }, timeToFadeStart * 1000);

    softEndTimer = setTimeout(() => {
      softEndTimer = null;
      if (!state.playing) return;
      if (audioCtx && audioCtx.currentTime < softEndFadeAt + softEndFadeSec - 0.05) {
        rescheduleSoftEndAfterResume();
        return;
      }
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

  // Adding loops while already fading → cancel outro and keep playing
  if (transitioning && next > 0) {
    cancelTransition(true);
  }

  // Soft-end was scheduled with the old count — rebuild from current position
  if (!decodedBuffer || !currentSource || useMediaEl) return;

  const duration = decodedBuffer.duration;
  const loopStart = getLoopStartSec();
  const wantSoftEnd =
    (loopStart > 0 || forceFullLoop) &&
    state.playing &&
    audioCtx &&
    currentGain &&
    !bufferCtxSuspended;

  // Kill wall timers + any leftover pause remain
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
  softEndRemainMs = 0;
  softEndStartRemainMs = 0;

  // ALWAYS kill old AudioParam automation (this was the bug — old ramp kept firing)
  if (audioCtx && currentGain) {
    const now = audioCtx.currentTime;
    currentGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(effectiveVolume(), now);
  }

  if (!wantSoftEnd) return;
  if (transitioning) return; // still fading out with 0 loops left — let it finish

  // Remaining time in the *current* cycle + full loops after that
  const absoluteElapsed =
    pauseOffset + (audioCtx.currentTime - startTime);
  const loopLen = forceFullLoop
    ? Math.max(0.001, duration)
    : Math.max(0.001, duration - loopStart);

  let remainInCycle;
  if (absoluteElapsed < duration) {
    // Still in first playthrough
    remainInCycle = Math.max(0.01, duration - absoluteElapsed);
  } else {
    const intoLoop = (absoluteElapsed - duration) % loopLen;
    remainInCycle = Math.max(0.01, loopLen - intoLoop);
  }

  const loopsAfter = Math.max(0, state.loopsRemaining);
  const timeToFadeStart = remainInCycle + loopsAfter * loopLen;
  const fadeSec = getTransitionSec();

  softEndFadeAt = audioCtx.currentTime + timeToFadeStart;
  softEndFadeSec = fadeSec;

  if (fadeSec <= 0) {
    currentGain.gain.setValueAtTime(0, softEndFadeAt);
  } else {
    currentGain.gain.setValueAtTime(effectiveVolume(), softEndFadeAt);
    currentGain.gain.linearRampToValueAtTime(0, softEndFadeAt + fadeSec);
  }

  softEndStartTimer = setTimeout(() => {
    softEndStartTimer = null;
    if (!state.playing || !currentGain) return;
    if (audioCtx && audioCtx.currentTime < softEndFadeAt - 0.05) {
      rescheduleSoftEndAfterResume();
      return;
    }
    transitioning = true;
    transitionStartedAt = softEndFadeAt;
    document.body.classList.add("is-transitioning");
    lastLoopCycle = Math.max(0, lastLoopCycle);
    if (state.loopMode === "count") {
      state.loopsRemaining = 0;
      updatePlayerUI();
    }
    updateProgressUI();
  }, timeToFadeStart * 1000);

  softEndTimer = setTimeout(() => {
    softEndTimer = null;
    if (!state.playing) return;
    if (audioCtx && audioCtx.currentTime < softEndFadeAt + softEndFadeSec - 0.05) {
      rescheduleSoftEndAfterResume();
      return;
    }
    finishTransition();
  }, (timeToFadeStart + Math.max(0, fadeSec)) * 1000 + 40);
}

function showLoopMenu(x, y) {
  if (state.loopMode !== "count") return;
  const menu = $("#loop-menu");
  const btn = $("#btn-loop");
  if (!menu) return;

  // Only one menu on screen
  closeAllPopovers("loop");

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
  markPlayingLibraryCards();
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
  bindAllScrollFades();
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

    const slot = ensureSlot();
    if (!slot.classList.contains("active")) slot.classList.add("active");
    // only move node if parent/anchor would change
    const rows = [...list.querySelectorAll(".queue-item:not(.dragging)")];
    let anchor = null;
    for (const row of rows) {
      if (+row.dataset.index >= insertBeforeIndex) {
        anchor = row;
        break;
      }
    }
    const next = anchor || null;
    if (slot.parentNode === list && slot.nextSibling === next) {
      dropIndex = insertBeforeIndex;
      lastDropIndex = insertBeforeIndex;
      return; // already correct — no DOM write
    }
    clearGapVisual();
    slot.classList.add("active");

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

  const removedId = state.queue[index]?.track?.id ?? null;
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

  if (state.shuffle && unshuffledQueue && removedId) {
    const ui = unshuffledQueue.findIndex((x) => x.track?.id === removedId);
    if (ui >= 0) unshuffledQueue.splice(ui, 1);
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


let confirmCloseTimer = null;

function openConfirmOverlay() {
  const overlay = $("#confirm-overlay");
  if (!overlay) return;
  clearTimeout(confirmCloseTimer);
  overlay.classList.remove("hidden", "is-closing");
  overlay.setAttribute("aria-hidden", "false");
  // restart open animation
  void overlay.offsetWidth;
}

function closeConfirmOverlay(after) {
  const overlay = $("#confirm-overlay");
  if (!overlay || overlay.classList.contains("hidden")) {
    after?.();
    return;
  }
  if (overlay.classList.contains("is-closing")) return;
  overlay.classList.add("is-closing");
  clearTimeout(confirmCloseTimer);
  confirmCloseTimer = setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.classList.remove("is-closing");
    overlay.setAttribute("aria-hidden", "true");
    after?.();
  }, 100); // snappy close — matches CSS 0.1s
}

function openClearQueueConfirm() {
  const title = $("#confirm-title");
  const body = $("#confirm-overlay")?.querySelector(".confirm-text");
  const ok = $("#confirm-ok");
  if (title) title.textContent = "Warteschlange leeren?";
  if (body) {
    body.textContent =
      "Alle Songs werden entfernt und die Wiedergabe gestoppt.";
  }
  if (ok) ok.textContent = "Leeren";
  openConfirmOverlay();
}

function closeClearQueueConfirm() {
  closeConfirmOverlay();
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

/** True if collapsing the header would still leave scrollable track content. */
function headerCanCollapse() {
  const sc = document.querySelector(".track-list-scroll");
  const sticky = document.querySelector(".game-sticky-top");
  if (!sc || !sticky) return false;
  if (sticky.classList.contains("is-collapsed")) return true; // already collapsed
  const overflow = sc.scrollHeight - sc.clientHeight;
  const expandedH = sticky.offsetHeight || 0;
  const collapsedH = 72; // matches compact sticky height
  const delta = Math.max(0, expandedH - collapsedH);
  // Need leftover overflow after the scroller gains `delta` height
  return overflow > delta + 24;
}

function toggleGameHeaderCollapse(force) {
  const sticky = document.querySelector(".game-sticky-top");
  const scroller = document.querySelector(".track-list-scroll");
  if (!sticky) return;

  const willCollapse =
    typeof force === "boolean" ? force : !sticky.classList.contains("is-collapsed");

  // Already in that state
  if (willCollapse === sticky.classList.contains("is-collapsed")) return;

  // Edit mode: never expand (stay collapsed until exit)
  if (document.body.classList.contains("pl-editing") && !willCollapse) {
    return;
  }

  // No room to collapse → never start the anim (avoids expand flash)
  if (willCollapse && !headerCanCollapse()) {
    const btn = $("#game-header-toggle");
    if (btn) btn.setAttribute("aria-expanded", "true");
    return;
  }

  sticky.classList.toggle("is-collapsed", willCollapse);
  sticky.classList.add("is-animating-header");

  const titleEl = $("#game-title");
  if (titleEl) {
    titleEl.textContent = willCollapse
      ? titleEl.dataset.short || titleEl.dataset.full
      : titleEl.dataset.full || titleEl.textContent;
  }

  const btn = $("#game-header-toggle");
  if (btn) btn.setAttribute("aria-expanded", willCollapse ? "false" : "true");

  // ── Lock scroll on mobile for the whole animation ──
  const mobile =
    typeof isMobileLike === "function"
      ? isMobileLike()
      : window.matchMedia("(hover: none) and (pointer: coarse)").matches;

  if (mobile && scroller) {
    const lockedY = scroller.scrollTop;
    scroller.dataset.scrollLocked = "1";
    scroller.style.overflowY = "hidden";
    scroller.style.touchAction = "none";
    scroller.scrollTop = lockedY;
    void scroller.offsetHeight;
    scroller.scrollTop = lockedY;

    const unlock = () => {
      if (scroller.dataset.scrollLocked !== "1") return;
      delete scroller.dataset.scrollLocked;
      scroller.style.overflowY = "";
      scroller.style.touchAction = "";
      scroller.scrollTop = lockedY;
      sticky.classList.remove("is-animating-header");
    };

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sticky.removeEventListener("transitionend", onEnd);
      unlock();
    };
    const onEnd = (e) => {
      if (e.target !== sticky && !sticky.contains(e.target)) return;
      finish();
    };
    sticky.addEventListener("transitionend", onEnd);
    setTimeout(finish, 480);
  } else {
    setTimeout(() => sticky.classList.remove("is-animating-header"), 450);
  }
  // (removed snap-back RAF — that caused the flash)
}

function bindGameHeaderToggle() {
  const btn = $("#game-header-toggle");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
    if (document.body.classList.contains("pl-editing")) return; // locked collapsed
    const sticky = document.querySelector(".game-sticky-top");
    const collapsed = sticky?.classList.contains("is-collapsed");
    if (!collapsed && !headerCanCollapse()) return;
    toggleGameHeaderCollapse();
  });
}


function updateTrackFade() {
  // Sticky header is outside #track-list-scroll — rows never pass under it.
  // Clear any leftover per-row opacity from older builds.
  const scroller = document.querySelector(".track-list-scroll");
  if (!scroller) return;
  scroller.querySelectorAll(".track-row").forEach((row) => {
    row.style.opacity = "";
    row.style.pointerEvents = "";
    row.style.transition = "";
    row.classList.remove("is-faded-out");
  });
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
  const EXPAND_AT = 8;
  let lastY = 0;
  let ignoreUntil = 0;
  let ignoreDir = 0;
  let ticking = false;

  const onScroll = () => {
    // While locked, force position and ignore collapse logic
    if (scroller.dataset.scrollLocked === "1") {
      return;
    }

    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (scroller.dataset.scrollLocked === "1") return;

      updateTrackFade();

      if (!settings.autoCollapseAlbum) {
        lastY = scroller.scrollTop;
        return;
      }
      if ((!state.currentGame && !state.currentPlaylist) || !gameDetail?.classList.contains("active")) {
        lastY = scroller.scrollTop;
        return;
      }

      const sticky = document.querySelector(".game-sticky-top");
      if (!sticky) {
        lastY = scroller.scrollTop;
        return;
      }

      const y = scroller.scrollTop;
      const goingDown = y > lastY + 1;
      const goingUp = y < lastY - 1;
      const collapsed = sticky.classList.contains("is-collapsed");
      const animating = sticky.classList.contains("is-animating-header");
      const now = performance.now();
      const locked =
        now < ignoreUntil &&
        ((ignoreDir > 0 && goingDown) || (ignoreDir < 0 && goingUp));

      if (!animating && !locked) {
        const canScroll = headerCanCollapse();
        if (!collapsed && canScroll && y >= COLLAPSE_AT && goingDown) {
          lastY = y;
          toggleGameHeaderCollapse(true);
          ignoreUntil = now + 500;
          ignoreDir = 1;
          return;
        }
        if (
          collapsed &&
          y <= EXPAND_AT &&
          (goingUp || y <= 1) &&
          !document.body.classList.contains("pl-editing")
        ) {
          lastY = y;
          toggleGameHeaderCollapse(false);
          ignoreUntil = now + 500;
          ignoreDir = -1;
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
      if (scroller.dataset.scrollLocked === "1") return;
      updateTrackFade();
      if (!settings.autoCollapseAlbum) return;
      if ((!state.currentGame && !state.currentPlaylist) || !gameDetail?.classList.contains("active")) return;
      if (scroller.scrollHeight <= scroller.clientHeight + 24) {
        // no overflow while collapsed → force expand
        if (document.querySelector(".game-sticky-top")?.classList.contains("is-collapsed")) {
          toggleGameHeaderCollapse(false);
        }
        return;
      }
      const sticky = document.querySelector(".game-sticky-top");
      if (!sticky?.classList.contains("is-collapsed")) return;
      if (sticky.classList.contains("is-animating-header")) return;
      if (scroller.scrollTop > EXPAND_AT) return;
      if (document.body.classList.contains("pl-editing")) return;
      if (performance.now() < ignoreUntil && ignoreDir < 0) return;
      toggleGameHeaderCollapse(false);
      ignoreUntil = performance.now() + 500;
      ignoreDir = -1;
      lastY = scroller.scrollTop;
    },
    { passive: true }
  );
  window.addEventListener("resize", updateTrackFade, { passive: true });
  updateTrackFade();
  bindScrollFadeY(scroller);
}

/** Edge fade for any vertical scroller: no fade at top when scrollTop≈0, none at bottom when fully scrolled. */
function updateScrollFadeY(el) {
  if (!el) return;
  const size = parseFloat(getComputedStyle(el).getPropertyValue("--fade-size")) || 28;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const y = el.scrollTop;
  const top = max <= 0 ? 0 : Math.min(size, y);
  const bottom = max <= 0 ? 0 : Math.min(size, max - y);
  el.style.setProperty("--fade-top", `${top}px`);
  el.style.setProperty("--fade-bottom", `${bottom}px`);
}

/** Edge fade for horizontal scroller (games rows). */
function updateScrollFadeX(el) {
  if (!el) return;
  const size = parseFloat(getComputedStyle(el).getPropertyValue("--fade-size")) || 28;
  const max = Math.max(0, el.scrollWidth - el.clientWidth);
  const x = el.scrollLeft;
  const left = max <= 0 ? 0 : Math.min(size, x);
  const right = max <= 0 ? 0 : Math.min(size, max - x);
  el.style.setProperty("--fade-left", `${left}px`);
  el.style.setProperty("--fade-right", `${right}px`);
}

function bindScrollFadeY(el) {
  if (!el || el.dataset.scrollFadeY === "1") return;
  el.dataset.scrollFadeY = "1";
  const tick = () => updateScrollFadeY(el);
  el.addEventListener("scroll", tick, { passive: true });
  window.addEventListener("resize", tick, { passive: true });
  // content size changes
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(tick).observe(el);
  }
  tick();
}

function bindScrollFadeX(el) {
  if (!el || el.dataset.scrollFadeX === "1") return;
  el.dataset.scrollFadeX = "1";
  const tick = () => updateScrollFadeX(el);
  el.addEventListener("scroll", tick, { passive: true });
  window.addEventListener("resize", tick, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(tick).observe(el);
  }
  tick();
}

/** Call once after DOM is ready / after games list is rebuilt. */
function bindAllScrollFades() {
  document
    .querySelectorAll(
      [
        ".track-list-scroll",
        ".games-cat-scroll",
        "#games-browse",
        "#global-search-results",
        "#lib-browse",
        ".queue-list",
        ".fs-queue-list",
        ".add-to-pl-list",
        ".custom-select-list",
        "#settings-scroll",
      ].join(", ")
    )
    .forEach(bindScrollFadeY);

  document
    .querySelectorAll(".games-row-scroll.needs-x-scroll")
    .forEach(bindScrollFadeX);
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
  }, 120);
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
  closeAllPopovers("context");
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

  const isPlaylist = !!payload?.playlist;
  if (isPlaylist) {
    const pl = payload.playlist;
    const coverSrc = playlistCoverSrc(pl);
    const url = Array.isArray(coverSrc) ? coverSrc[0] || PLACEHOLDER : coverSrc;
    if (coverEl) coverEl.src = url || PLACEHOLDER;
    if (titleEl) titleEl.textContent = pl.name || "Playlist";
    if (subEl) subEl.textContent = `${(pl.tracks || []).length} Titel`;
  }

  const alreadyInThisAlbum =
    !isAlbum &&
    !!game &&
    state.currentGame?.id === game.id &&
    gameDetail?.classList.contains("active") &&
    !gameDetail.classList.contains("hidden");

  contextMenu?.querySelectorAll(".ctx-playlist-only").forEach((btn) => {
    // hide delete for Lieblingssongs / pinLocked
    if (btn.dataset.action === "delete-playlist") {
      const pl = payload?.playlist;
      const locked = !pl || pl.id === FAVORITES_ID || pl.pinLocked;
      btn.classList.toggle("hidden", !isPlaylist || locked);
    } else if (btn.dataset.action === "pin-playlist") {
      const pl = payload?.playlist;
      btn.classList.toggle(
        "hidden",
        !isPlaylist || !pl || pl.pinLocked || pl.id === FAVORITES_ID
      );
      const lab = btn.querySelector(".ctx-pin-label");
      if (lab && pl) lab.textContent = pl.pinned ? "Loslösen" : "Anpinnen";
    } else {
      btn.classList.toggle("hidden", !isPlaylist);
    }
  });

  // Do NOT blanket-toggle .ctx-playlist-only again — that undoes pin/delete hides for favorites.
  // hide edit for favorites
  const editBtn = contextMenu?.querySelector('[data-action="edit-playlist"]');
  if (editBtn) {
    editBtn.classList.toggle("hidden", !payload.playlist || payload.playlist.id === FAVORITES_ID);
  }

  // album-only: true album menus only (not playlist)
  contextMenu?.querySelectorAll(".ctx-album-only").forEach((btn) => {
    btn.classList.toggle("hidden", !isAlbum);
  });

  // shared album OR playlist actions
  contextMenu?.querySelectorAll(".ctx-album-or-playlist").forEach((btn) => {
    btn.classList.toggle("hidden", !(isAlbum || isPlaylist));
  });

  contextMenu?.querySelectorAll(".ctx-track-only").forEach((btn) => {
    if (btn.dataset.action === "open-album") {
      btn.classList.toggle("hidden", isAlbum || isPlaylist || alreadyInThisAlbum);
    } else {
      btn.classList.toggle("hidden", isAlbum || isPlaylist);
    }
  });

  const inPlaylistDetail = 
    !!state.currentPlaylist && 
    !isPlaylist && 
    !isAlbum && 
    !!track && 
    !!(payload?.fromPlaylistId || state.currentPlaylist);
    
  contextMenu?.querySelectorAll(".ctx-pl-track-only").forEach((btn) => {
    btn.classList.toggle("hidden", !inPlaylistDetail);
  });

  const playNextBtn = contextMenu?.querySelector('[data-action="play-next"]');
  if (playNextBtn) {
    playNextBtn.lastChild.textContent = isPlaylist
      ? " Playlist als Nächstes"
      : isAlbum
        ? " Album als Nächstes"
        : " Als Nächstes spielen";
  }
  const addEndBtn = contextMenu?.querySelector('[data-action="add-end"]');
  if (addEndBtn) {
    addEndBtn.lastChild.textContent = isPlaylist
      ? " Playlist ans Ende"
      : isAlbum
        ? " Album ans Ende"
        : " Ans Ende der Queue";
  }
  const shuffleBtn = contextMenu?.querySelector('[data-action="shuffle-into"]');
  if (shuffleBtn) {
    shuffleBtn.lastChild.textContent = isPlaylist
      ? " Playlist in die Queue mischen"
      : " Album in die Queue mischen";
  }
  const colLabel = contextMenu?.querySelector(".ctx-collection-to-pl-label");
  if (colLabel) {
    colLabel.textContent = isPlaylist
      ? "Playlist zu Playlist hinzufügen"
      : "Album zu Playlist hinzufügen";
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

  // Only long enough to kill the ghost click after long-press — not a long lockout
  armClickSuppress(130);
  document.body.classList.add("context-menu-open");
}

function bindContextMenu() {
  contextMenu?.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!contextTrack) return;
      const payload = contextTrack;
      const { game, track, album } = payload;
      const action = btn.dataset.action;

      const cover = game?.cover || PLACEHOLDER;
      const albumName = game?.fullscreenName || game?.short || game?.title || "Album";
      const trackName = track?.title || "";

      // ── Playlist menu ──
      if (payload.playlist) {
        const pl = payload.playlist;
        if (action === "play-next") {
          addPlaylistPlayNext(pl);
          hideContextMenu();
          showToast({ cover: playlistThumbUrl(pl), title: pl.name, sub: "Playlist wird als Nächstes abgespielt." });
          return;
        }
        if (action === "add-end") {
          addPlaylistToEnd(pl);
          hideContextMenu();
          showToast({ cover: playlistThumbUrl(pl), title: pl.name, sub: "Playlist ans Ende der Queue sortiert." });
          return;
        }
        if (action === "shuffle-into") {
          shufflePlaylistIntoQueue(pl);
          hideContextMenu();
          showToast({ cover: playlistThumbUrl(pl), title: pl.name, sub: "Playlist in die Queue gemischt." });
          return;
        }
        if (action === "add-collection-to-playlist") {
          hideContextMenu();
          openAddCollectionToPlaylistMenu({ type: "playlist", playlist: pl });
          return;
        }
        if (action === "pin-playlist") {
          if (!pl.pinLocked) {
            togglePinPlaylist(pl.id);
            renderLibrary({ animate: false });
            showToast?.(pl.pinned ? "Angepinnt" : "Losgelöst");
          }
          hideContextMenu();
          return;
        }
        if (action === "edit-playlist") {
          const pl = payload.playlist;
          hideContextMenu();
          if (!pl || pl.id === FAVORITES_ID) return;
          if (state.currentPlaylist?.id !== pl.id) openPlaylistDetail(pl.id);
          openPlaylistEditMetaModal(pl);
          return;
        }
        if (action === "export-playlist") {
          hideContextMenu();
          if (!pl) return;
          exportPlaylistToFile(pl);
          return;
        }
        if (action === "delete-playlist") {
          hideContextMenu();
          openDeletePlaylistConfirm(pl.id);
          return;
        }
        return;
      }

      // ── Album menu ──
      if (album && game) {
        if (action === "play-next") {
          addAlbumPlayNext(game);
          hideContextMenu();
          showToast({ cover, title: albumName, sub: "Album wird als Nächstes abgespielt." });
          return;
        }
        if (action === "add-end") {
          addAlbumToEnd(game);
          hideContextMenu();
          showToast({ cover, title: albumName, sub: "Album ans Ende der Queue sortiert." });
          return;
        }
        if (action === "shuffle-into") {
          shuffleAlbumIntoQueue(game);
          hideContextMenu();
          showToast({ cover, title: albumName, sub: "Album in die Queue gemischt." });
          return;
        }
        if (action === "add-collection-to-playlist") {
          hideContextMenu();
          openAddCollectionToPlaylistMenu({ type: "album", game });
          return;
        }
        return;
      }

      // ── Track menu ──
      if (game && track) {
        if (action === "play-next") {
          addPlayNext(game, track);
          hideContextMenu();
          showToast({ cover, title: trackName, sub: "Song wird als Nächstes abgespielt." });
          return;
        }
        if (action === "add-end") {
          addToEnd(game, track);
          hideContextMenu();
          showToast({ cover, title: trackName, sub: "Song ans Ende der Queue sortiert." });
          return;
        }
        if (action === "add-to-playlist") {
          hideContextMenu();
          openAddToPlaylistMenu(game.id, track.id);
          return;
        }
        if (action === "open-album") {
          hideContextMenu();
          if (!$("#fullscreen-player")?.classList.contains("hidden")) toggleFullscreen();
          // remember where we came from (search / library / playlist)
          if (globalSearchOpen) {
            const q = $("#global-search-input")?.value?.trim() || "";
            if (q) searchReturn = { type: "search", query: q };
            globalSearchOpen = false;
            document.body.classList.remove("search-open", "search-mode");
            $("#global-search-results")?.classList.add("hidden");
          } else if (state.currentPlaylist) {
            searchReturn = { type: "playlist", playlistId: state.currentPlaylist.id };
          } else if (
            document.querySelector('.tab[data-tab="playlists"]')?.classList.contains("active")
          ) {
            searchReturn = { type: "library" };
          }
          openGame(game.id);
          return;
        }
        if (action === "remove-from-playlist") {
          const pid = payload.fromPlaylistId || state.currentPlaylist?.id;
          if (pid) {
            setTrackInPlaylist(pid, game.id, track.id, false);
            hideContextMenu();
            syncTrackPlusButtons(game.id, track.id);
            if (state.currentPlaylist?.id === pid) {
              refreshOpenPlaylistDetail({
                flashTrackId: track.id,
                flashType: "remove",
              });
            }
            showToast?.({
              cover: game.cover || PLACEHOLDER,
              title: track.title,
              sub: "Aus Playlist entfernt",
            });
          }
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
          suppressDocClickUntil = performance.now() + 130;
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
const PRESS_MIN_MS_TOUCH = 150; // higher on touchscreen

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
  ".ctrl-btn, .play-btn, #btn-play, .primary-btn, .tab, .back-btn, .settings-btn, .circle-btn, .header-toggle-btn, .fs-back-btn, .confirm-btn, .game-card, .games-view-btn, .games-row-title, #play-all-btn, #shuffle-all-btn, #album-menu-btn, #album-lib-btn, #pl-loops-btn, #pl-edit-btn, #pl-edit-save, #pl-edit-cancel, #pl-add-songs-chip, #pl-multi-btn, #pl-multi-trash, #pl-clear-loops-btn, #settings-reset-btn, .gs-tool-btn, .gs-chip, .gs-fav-btn, .gs-lib-btn, .track-fav-btn, .context-menu button, #loop-menu button, [data-loop-delta], .card-hover-play, .card-hover-menu, .pl-list-menu, .lib-create-chip, .lib-filter-btn, .pl-card, .pl-list-row, #btn-play, #btn-sleep, #btn-settings, #btn-profile, .sleep-btn, .settings-btn, .topbar .tab, .play-btn";
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
        // Don't capture on game/playlist cards when the real target is a nested control
        if (
          btn.matches(".game-card, .pl-card, .pl-list-row") &&
          e.target.closest(
            "button, .card-hover-actions, .card-hover-play, .card-hover-menu, .pl-list-menu"
          )
        ) {
          return;
        }
        clearTimeout(clearTimer);
        downAt = performance.now();
        minHold = pressMinMs(e);
        pointerId = e.pointerId;
        btn.classList.add("is-pressed");
        // No capture on toolbar chips — capture steals the click onto the view button under the panel on iPad
        if (
          !btn.matches(
            ".gs-chip, .lib-filter-btn, [data-lib-sort], [data-lib-dir], [data-lib-filter]"
          )
        ) {
          try {
            btn.setPointerCapture(e.pointerId);
          } catch (_) {}
        }
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

function setMarqueeText(el, text) {
  if (!el) return;
  const wrap = el.closest(".marquee-wrap");
  el.textContent = text ?? "";
  el.style.removeProperty("--marquee-dist");
  el.style.removeProperty("--marquee-dur");
  wrap?.classList.remove("is-overflowing", "is-scrolling", "mq-end", "mq-cross");
  if (wrap) {
    wrap.style.setProperty("--mq-left", "1");
    wrap.style.setProperty("--mq-right", "0");
    if (wrap._mqTimer) {
      clearInterval(wrap._mqTimer);
      wrap._mqTimer = null;
    }
  }

  // FS title is plain text + CSS ellipsis — never marquee
  if (el.id === "fs-title") return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!wrap || !el) return;
      const overflow = el.scrollWidth - wrap.clientWidth;
      if (overflow <= 4) return; // fits — no scroll
      wrap.classList.add("is-overflowing");
      // Exact overflow only (fades are narrow so we don't need extra pad)
      const dist = Math.max(0, overflow);
      const dur = Math.max(8, Math.min(18, dist / 30));
      el.style.setProperty("--marquee-dist", `${dist}px`);
      el.style.setProperty("--marquee-dur", `${dur}s`);

      const ms = dur * 1000;
      const beat = () => {
        // hold at start
        wrap.classList.remove("is-scrolling", "mq-end", "mq-cross");
        wrap.style.setProperty("--mq-left", "1");
        wrap.style.setProperty("--mq-right", "0");
        setTimeout(() => {
          wrap.classList.add("is-scrolling");
          wrap.style.setProperty("--mq-left", "0");
          wrap.style.setProperty("--mq-right", "0");
        }, ms * 0.12);
        // end of travel — solid right edge so last letters aren't masked
        setTimeout(() => {
          wrap.classList.add("mq-end");
          wrap.style.setProperty("--mq-left", "0");
          wrap.style.setProperty("--mq-right", "1");
        }, ms * 0.72);
        // crossfade while opacity is 0 — both edges solid (no pop)
        setTimeout(() => {
          wrap.classList.add("mq-cross");
          wrap.style.setProperty("--mq-left", "1");
          wrap.style.setProperty("--mq-right", "1");
        }, ms * 0.84);
        // still opacity 0 here — arm start fades before text comes back
        setTimeout(() => {
          wrap.classList.remove("is-scrolling", "mq-end", "mq-cross");
          wrap.style.setProperty("--mq-left", "1");
          wrap.style.setProperty("--mq-right", "0");
        }, ms * 0.90);
      };
      beat();
      wrap._mqTimer = setInterval(beat, ms);
    });
  });
}

// re-check on resize
window.addEventListener(
  "resize",
  () => {
    const now = $("#now-title");
    if (now) setMarqueeText(now, now.textContent);
  },
  { passive: true }
);

function updateProfileAvatar(name) {
  const el = $("#profile-avatar-initials");
  if (!el) return;
  const t = (name || "").trim();
  if (!t) {
    el.textContent = "?";
    return;
  }
  const parts = t.split(/\s+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : t.slice(0, 2).toUpperCase();
  el.textContent = initials;
}

function syncProfileForm() {
  const p = loadProfile();
  const input = $("#profile-display-name");
  if (input) input.value = p.displayName || "";
  updateProfileAvatar(p.displayName || "");

  // Only real games that exist in LIBRARY (ignore stray / playlist ids)
  const games = (userLib.libraryAlbums || []).filter((gid) =>
    LIBRARY.some((g) => g.id === gid)
  ).length;
  const playlists = Array.isArray(userLib?.playlists) ? userLib.playlists.length : 0;
  const fav = getPlaylist(FAVORITES_ID)?.tracks?.length || 0;

  const setText = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  };
  setText("profile-stat-games", games);
  setText("profile-stat-playlists", playlists);
  setText("profile-stat-favs", fav);

  // Listening stats
  flushListenTime();
  const ls = loadListenStats();
  setText("profile-stat-listen-total", formatListenDuration(ls.totalSec || 0));
  setText("profile-stat-listen-week", formatListenDuration(ls.weeks?.[isoWeekKey()] || 0));

  // Top track by seconds
  let topTrack = null;
  let topTrackSec = 0;
  for (const [key, v] of Object.entries(ls.tracks || {})) {
    if ((v.sec || 0) > topTrackSec) {
      topTrackSec = v.sec || 0;
      topTrack = { key, ...v };
    }
  }
  const trackTitleEl = $("#profile-top-track-title");
  const trackSubEl = $("#profile-top-track-sub");
  const trackCoverEl = $("#profile-top-track-cover");
  if (topTrack && topTrackSec > 0) {
    const [gameId, trackId] = topTrack.key.split("::");
    const game = LIBRARY.find((g) => g.id === gameId);
    const track = game?.tracks?.find((t) => t.id === trackId);
    if (trackTitleEl) trackTitleEl.textContent = track?.title || "Unbekannt";
    if (trackSubEl) {
      trackSubEl.textContent = [
        game?.title || game?.short || "",
        formatListenDuration(topTrackSec),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    if (trackCoverEl) {
      trackCoverEl.src = game?.cover || PLACEHOLDER;
      trackCoverEl.hidden = false;
    }
  } else {
    if (trackTitleEl) trackTitleEl.textContent = "—";
    if (trackSubEl) trackSubEl.textContent = "Noch nichts gehört";
    if (trackCoverEl) trackCoverEl.hidden = true;
  }

  // Top game
  let topGameId = null;
  let topGameSec = 0;
  for (const [gid, v] of Object.entries(ls.games || {})) {
    if ((v.sec || 0) > topGameSec) {
      topGameSec = v.sec || 0;
      topGameId = gid;
    }
  }
  const gameTitleEl = $("#profile-top-game-title");
  const gameSubEl = $("#profile-top-game-sub");
  const gameCoverEl = $("#profile-top-game-cover");
  if (topGameId && topGameSec > 0) {
    const game = LIBRARY.find((g) => g.id === topGameId);
    if (gameTitleEl) gameTitleEl.textContent = game?.title || game?.short || topGameId;
    if (gameSubEl) {
      gameSubEl.textContent = [
        game?.composer || "",
        formatListenDuration(topGameSec),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    if (gameCoverEl) {
      gameCoverEl.src = game?.cover || PLACEHOLDER;
      gameCoverEl.hidden = false;
    }
  } else {
    if (gameTitleEl) gameTitleEl.textContent = "—";
    if (gameSubEl) gameSubEl.textContent = "Noch nichts gehört";
    if (gameCoverEl) gameCoverEl.hidden = true;
  }

  // Top playlist
  let topPlId = null;
  let topPlSec = 0;
  for (const [pid, v] of Object.entries(ls.playlists || {})) {
    if ((v.sec || 0) > topPlSec) {
      topPlSec = v.sec || 0;
      topPlId = pid;
    }
  }
  const plTitleEl = $("#profile-top-pl-title");
  const plSubEl = $("#profile-top-pl-sub");
  const plCoverEl = $("#profile-top-pl-cover");
  if (topPlId && topPlSec > 0) {
    const pl = getPlaylist(topPlId);
    // Playlist may be gone (deleted / other account) — don't call cover helpers with null
    if (!pl) {
      if (plTitleEl) plTitleEl.textContent = "—";
      if (plSubEl) plSubEl.textContent = "Noch nichts gehört";
      if (plCoverEl) {
        plCoverEl.hidden = true;
        plCoverEl.innerHTML = "";
      }
    } else {
    if (plTitleEl) plTitleEl.textContent = pl.name || topPlId;
    if (plSubEl) plSubEl.textContent = formatListenDuration(topPlSec);
    if (plCoverEl) {
      plCoverEl.hidden = false;
      plCoverEl.classList.remove("is-single");
      plCoverEl.innerHTML = "";
      const src = typeof playlistCoverSrc === "function" ? playlistCoverSrc(pl) : null;
      if (Array.isArray(src)) {
        src.slice(0, 4).forEach((u) => {
          const img = document.createElement("img");
          img.src = u || PLACEHOLDER;
          img.alt = "";
          img.draggable = false;
          plCoverEl.appendChild(img);
        });
      } else {
        plCoverEl.classList.add("is-single");
        const img = document.createElement("img");
        img.src = src || (pl?.id === FAVORITES_ID ? "Assets/PlaylistCovers/FavSongsCover.png" : PLACEHOLDER);
        img.alt = "";
        img.draggable = false;
        plCoverEl.appendChild(img);
      }
    }
  }  // end else (pl exists)
  } else {
    if (plTitleEl) plTitleEl.textContent = "—";
    if (plSubEl) plSubEl.textContent = "Noch nichts gehört";
    if (plCoverEl) {
      plCoverEl.hidden = true;
      plCoverEl.innerHTML = "";
    }
  }

  getAuthUser?.().then((u) => {
    updateAuthPanels?.(u);
    const meta = loadSyncMeta?.() || {};
    if (u) {
      setProfileSyncUI?.({
        status: "Bereit",
        hint: "Bibliothek & Einstellungen (ohne Lautstärke)",
        last: formatSyncTime?.(meta.lastPushAt || meta.lastPullAt),
      });
    }
  });
}

let profileReturn = null;
let profileCloseTimer = null;

function openProfile() {
  // only one panel
  if (!$("#settings-view")?.classList.contains("hidden")) {
    // close settings instantly (no return restore) then open profile
    const sv = $("#settings-view");
    clearTimeout(settingsCloseTimer);
    sv?.classList.add("hidden");
    sv?.classList.remove("is-closing");
    document.body.classList.remove("settings-open");
    settingsReturn = null;
  }

  if (typeof cancelEditIfNeeded === "function") cancelEditIfNeeded();

  if (!gameDetail.classList.contains("hidden") && state.currentPlaylist) {
    profileReturn = { type: "playlist", playlistId: state.currentPlaylist.id };
  } else if (!gameDetail.classList.contains("hidden") && state.currentGame) {
    profileReturn = { type: "game", gameId: state.currentGame.id };
  } else if ($("#tab-playlists")?.classList.contains("active")) {
    profileReturn = { type: "playlists" };
  } else {
    profileReturn = { type: "games" };
  }

  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  gameDetail.classList.add("hidden");
  gameDetail.classList.remove("active");
  clearTimeout(profileCloseTimer);
  $("#profile-view")?.classList.remove("is-closing");
  $("#profile-view")?.classList.remove("hidden");
  document.body.classList.add("profile-open");

  if (typeof bindScrollFadeY === "function") {
    bindScrollFadeY(document.getElementById("profile-scroll"));
  }
  syncProfileForm();
}

function closeProfile() {
  const view = $("#profile-view");
  if (!view || view.classList.contains("hidden") || view.classList.contains("is-closing")) return;

  view.classList.add("is-closing");
  clearTimeout(profileCloseTimer);
  profileCloseTimer = setTimeout(() => {
    view.classList.add("hidden");
    view.classList.remove("is-closing");
    document.body.classList.remove("profile-open");
  }, 290);

  const ret = profileReturn;
  profileReturn = null;

  if (ret?.type === "playlist" && ret.playlistId) {
    openPlaylistDetail(ret.playlistId);
  } else if (ret?.type === "game" && ret.gameId) {
    openGame(ret.gameId);
  } else if (ret?.type === "playlists") {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-playlists")?.classList.add("active");
    if (typeof renderLibrary === "function") renderLibrary({ animate: false });
  } else {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-games")?.classList.add("active");
    if (typeof renderGames === "function") renderGames({ animate: false });
  }
}

let settingsReturn = null; // { type: "games"|"playlists"|"game"|"playlist", gameId?, playlistId? }

function openSettings() {
    // only one panel
  if (!$("#profile-view")?.classList.contains("hidden")) {
    const pv = $("#profile-view");
    clearTimeout(profileCloseTimer);
    pv?.classList.add("hidden");
    pv?.classList.remove("is-closing");
    document.body.classList.remove("profile-open");
    profileReturn = null;
  }
  // Discard playlist edit so multi-select chrome is gone when we come back
  if (typeof cancelEditIfNeeded === "function") cancelEditIfNeeded();

  // remember where we were (detail first, then tabs)
  if (!gameDetail.classList.contains("hidden") && state.currentPlaylist) {
    settingsReturn = {
      type: "playlist",
      playlistId: state.currentPlaylist.id,
    };
  } else if (!gameDetail.classList.contains("hidden") && state.currentGame) {
    settingsReturn = { type: "game", gameId: state.currentGame.id };
  } else if ($("#tab-playlists")?.classList.contains("active")) {
    settingsReturn = { type: "playlists" };
  } else {
    settingsReturn = { type: "games" };
  }

  // hide main panels, show settings (do not clear state.current*)
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  gameDetail.classList.add("hidden");
  gameDetail.classList.remove("active");
  clearTimeout(settingsCloseTimer);
  $("#settings-view")?.classList.remove("is-closing");
  $("#settings-view")?.classList.remove("hidden");
  document.body.classList.add("settings-open");

  bindScrollFadeY(document.getElementById("settings-scroll"));
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

  const ret = settingsReturn;
  settingsReturn = null;

  if (ret?.type === "playlist" && ret.playlistId) {
    openPlaylistDetail(ret.playlistId);
  } else if (ret?.type === "game" && ret.gameId) {
    openGame(ret.gameId);
  } else if (ret?.type === "playlists") {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="playlists"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-playlists")?.classList.add("active");
    if (typeof renderLibrary === "function") renderLibrary({ animate: false });
  } else {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="games"]')?.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("#tab-games")?.classList.add("active");
    if (typeof renderGames === "function") renderGames({ animate: false });
  }
}

function playlistThumbUrl(pl) {
  if (!pl) return PLACEHOLDER;
  if (pl.id === FAVORITES_ID) return "Assets/PlaylistCovers/FavSongsCover.png";
  const src = playlistCoverSrc(pl);
  if (Array.isArray(src)) return src[0] || PLACEHOLDER;
  return src || PLACEHOLDER;
}

/** HTML thumb: single <img> or 2×2 mosaic */
function playlistThumbHtml(pl, className = "pl-thumb-mosaic") {
  if (!pl) {
    return `<img class="${className}" src="${escapeHtml(PLACEHOLDER)}" alt="">`;
  }
  if (pl.id === FAVORITES_ID) {
    return `<img class="${className}" src="Assets/PlaylistCovers/FavSongsCover.png" alt="">`;
  }
  const src = playlistCoverSrc(pl);
  if (Array.isArray(src)) {
    return `<div class="pl-cover-mosaic ${className}">${src
      .map((u) => `<img src="${escapeHtml(u)}" alt="" draggable="false">`)
      .join("")}</div>`;
  }
  return `<img class="${className}" src="${escapeHtml(src || PLACEHOLDER)}" alt="">`;
}

function rebuildQuickPlMenu(filter = "") {
  const list = document.getElementById("setting-quick-pl-list");
  if (!list) return;
  const q = String(filter || "").trim().toLowerCase();
  const playlists = [...(userLib.playlists || [])].sort((a, b) => {
    if (a.id === FAVORITES_ID) return -1;
    if (b.id === FAVORITES_ID) return 1;
    return String(a.name || "").localeCompare(String(b.name || ""), "de");
  });

  list.innerHTML = "";
  playlists.forEach((pl) => {
    if (q && !String(pl.name || "").toLowerCase().includes(q)) return;
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = pl.id;
    if (settings.quickAddPlaylistId === pl.id) {
      li.setAttribute("aria-selected", "true");
    }
    li.innerHTML = `
      ${playlistThumbHtml(pl, "pl-thumb-mosaic")}
      <span>${escapeHtml(pl.name || "Playlist")}</span>
    `;
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      settings.quickAddPlaylistId = pl.id;
      saveSettings();
      updateQuickPlButtonLabel();
      closeAllCustomSelects();
    });
    list.appendChild(li);
  });
}

function updateQuickPlButtonLabel() {
  const label = document.getElementById("setting-quick-pl-label");
  const cover = document.getElementById("setting-quick-pl-cover");
  const pl = getPlaylist(settings.quickAddPlaylistId || FAVORITES_ID);
  if (label) label.textContent = pl?.name || "Lieblingssongs";
  if (!cover) return;

  const src = playlistCoverSrc(pl);
  // If parent isn’t a wrap yet, keep simple img for non-mosaic
  if (Array.isArray(src) && src.length > 1) {
    const wrap =
      cover.closest("#setting-quick-pl-cover-wrap") ||
      (() => {
        const w = document.createElement("span");
        w.id = "setting-quick-pl-cover-wrap";
        cover.replaceWith(w);
        return w;
      })();
    wrap.innerHTML = playlistThumbHtml(pl, "pl-thumb-mosaic");
  } else {
    // ensure we have an <img id="setting-quick-pl-cover">
    let img = cover;
    if (img.tagName !== "IMG") {
      img = document.createElement("img");
      img.id = "setting-quick-pl-cover";
      cover.replaceWith(img);
    }
    img.src = playlistThumbUrl(pl);
    img.hidden = false;
    img.onerror = () => {
      img.src = PLACEHOLDER;
    };
  }
}

function closeAllCustomSelects(except) {
  document.querySelectorAll(".custom-select.open").forEach((wrap) => {
    if (except && wrap === except) return;
    wrap.classList.remove("open");
    wrap.querySelector(".custom-select-btn")?.setAttribute("aria-expanded", "false");
    wrap.querySelector(".custom-select-menu")?.classList.add("hidden");
  });
}

function bindSettings() {
  $("#btn-settings")?.addEventListener("click", openSettings);
  $("#settings-back")?.addEventListener("click", closeSettings);
  $("#profile-back")?.addEventListener("click", closeProfile);

  // persist name while typing
  $("#profile-display-name")?.addEventListener("input", () => {
    const name = ($("#profile-display-name")?.value || "").trim();
    saveProfile({ displayName: name });
    updateProfileAvatar(name);
  });

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

  $("#setting-normalize-volume")?.addEventListener("change", (e) => {
    settings.normalizeVolume = !!e.target.checked;
    saveSettings();
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

  // ── Transition dropdown (one binding) ──
  $("#setting-transition-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const wrap = $("#setting-transition-wrap");
    const menu = $("#setting-transition-menu");
    const btn = $("#setting-transition-btn");
    const wasOpen = wrap?.classList.contains("open");
    closeAllCustomSelects();
    if (!wasOpen && wrap && menu && btn) {
      wrap.classList.add("open");
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
  });

  $("#setting-transition-menu")?.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = Number(li.dataset.value);
      settings.transitionSec = [0, 5, 10].includes(v)
        ? v
        : DEFAULT_SETTINGS.transitionSec;
      saveSettings();
      syncSettingsForm();
      closeAllCustomSelects();
    });
  });

  // ── Quick-add toggle ──
  $("#setting-quick-add")?.addEventListener("change", (e) => {
    settings.quickAddEnabled = !!e.target.checked;
    saveSettings();
    $("#setting-quick-add-target-row")?.classList.toggle(
      "is-disabled",
      !settings.quickAddEnabled
    );
  });

  // ── Goal playlist dropdown (one binding) ──
  $("#setting-quick-pl-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!settings.quickAddEnabled) return;
    const wrap = $("#setting-quick-pl-wrap");
    const menu = $("#setting-quick-pl-menu");
    const btn = $("#setting-quick-pl-btn");
    const search = $("#setting-quick-pl-search");
    const wasOpen = wrap?.classList.contains("open");
    closeAllCustomSelects();
    if (!wasOpen && wrap && menu && btn) {
      if (search) search.value = "";
      rebuildQuickPlMenu("");
      wrap.classList.add("open");
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => search?.focus());
    }
  });

  $("#setting-quick-pl-search")?.addEventListener("input", (e) => {
    e.stopPropagation();
    rebuildQuickPlMenu(e.target.value);
  });
  $("#setting-quick-pl-search")?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // Close any open custom select on outside click (one document listener)
  document.addEventListener("click", (e) => {
    if (e.target.closest(".custom-select")) return;
    closeAllCustomSelects();
  });
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

  const autoCol = $("#setting-auto-collapse");
  if (autoCol) autoCol.checked = !!settings.autoCollapseAlbum;

  const qa = $("#setting-quick-add");
  if (qa) qa.checked = !!settings.quickAddEnabled;
  $("#setting-quick-add-target-row")?.classList.toggle(
    "is-disabled",
    !settings.quickAddEnabled
  );

  $("#setting-transition-menu")?.querySelectorAll("li").forEach((li) => {
    li.setAttribute(
      "aria-selected",
      li.dataset.value === String(settings.transitionSec) ? "true" : "false"
    );
  });

  updateQuickPlButtonLabel();
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
    // Credit listen time up to the stop, then clear the clock
    if (typeof endListenSession === "function") endListenSession();
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
      closeAllPopovers("sleep");
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