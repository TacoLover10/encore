// Encore — a static music web app. Runs entirely on GitHub Pages, no API keys.
// Sources:
//   - YouTube: almost every popular song, full length. Search goes through free public
//     Piped / Invidious mirrors (with automatic fallback); playback uses YouTube's
//     official embedded player.
//   - Audius: free full-length tracks from independent artists.
//   - Your own audio files (stored in your browser with IndexedDB).
// Everything you do (playlists, likes, listening history) is saved in your browser.
(() => {
  "use strict";

  const APP_NAME = "EncoreMusicApp";
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const timeoutFetch = (url, ms = 7000) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
  };

  // ---------------- Storage ----------------
  const store = {
    get(key, def) { try { const v = localStorage.getItem("encore:" + key); return v ? JSON.parse(v) : def; } catch { return def; } },
    set(key, val) { try { localStorage.setItem("encore:" + key, JSON.stringify(val)); } catch (e) { toast("Storage is full"); } },
  };

  const state = {
    playlists: store.get("playlists", []),     // [{id, name, created, tracks:[track]}]
    liked: store.get("liked", []),             // [track]
    history: store.get("history", []),         // [{track, ts, secs}]
    queue: [], index: -1,
    shuffle: store.get("shuffle", false),
    repeat: store.get("repeat", "off"),        // off | all | one
    current: null, session: null,
    searchCache: {},
  };
  const save = (k) => store.set(k, state[k]);

  // IndexedDB for uploaded audio files
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("encore", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction("files", mode);
        const out = fn(t.objectStore("files"));
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      put: (rec) => tx("readwrite", (s) => s.put(rec)),
      get: (id) => tx("readonly", (s) => s.get(id)),
      all: () => tx("readonly", (s) => s.getAll()),
      del: (id) => tx("readwrite", (s) => s.delete(id)),
    };
  })();

  // ---------------- YouTube search (no API key) ----------------
  // Free public mirrors come and go, so we try several and remember the one that works.
  const PIPED = [
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.nosebs.ru",
    "https://pipedapi.reallyaweso.me",
    "https://piapi.ggtyler.dev",
    "https://pipedapi.drgns.space",
    "https://api.piped.yt",
  ];
  const INVIDIOUS = [
    "https://inv.nadeko.net",
    "https://yewtu.be",
    "https://invidious.nerdvpn.de",
    "https://iv.ggtyler.dev",
    "https://invidious.f5.si",
  ];
  const mirrors = () => {
    const good = store.get("mirror", null);
    const list = [...PIPED.map((b) => ["piped", b]), ...INVIDIOUS.map((b) => ["inv", b])];
    if (good) list.sort((a, b) => (b[1] === good) - (a[1] === good));
    return list;
  };

  function pipedArt(thumb, id) {
    try {
      const u = new URL(thumb);
      const host = u.searchParams.get("host");
      if (host && host.includes("googleusercontent")) return `https://${host}${u.pathname.replace(/=w\d+-h\d+/, "=w400-h400")}`;
    } catch {}
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  const cleanArtist = (s) => String(s || "Unknown artist").replace(/\s+-\s+Topic$/i, "");

  async function ytSearch(q, kind = "songs") {
    const errors = [];
    for (const [type, base] of mirrors()) {
      try {
        let tracks;
        if (type === "piped") {
          const filter = kind === "songs" ? "music_songs" : "videos";
          const r = await timeoutFetch(`${base}/search?q=${encodeURIComponent(q)}&filter=${filter}`);
          if (!r.ok) throw new Error(r.status);
          const j = await r.json();
          tracks = (j.items || []).filter((i) => i.type === "stream" && !i.isShort && i.url).map((i) => {
            const id = new URL(i.url, "https://x.y").searchParams.get("v");
            return {
              id: "yt:" + id, source: "yt", sid: id, title: i.title, artist: cleanArtist(i.uploaderName),
              art: kind === "songs" ? pipedArt(i.thumbnail, id) : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              duration: i.duration > 0 ? i.duration : 0, genre: "",
            };
          });
        } else {
          const r = await timeoutFetch(`${base}/api/v1/search?q=${encodeURIComponent(kind === "songs" ? q + " audio" : q)}&type=video`);
          if (!r.ok) throw new Error(r.status);
          const j = await r.json();
          tracks = (Array.isArray(j) ? j : []).filter((i) => i.type === "video" && i.videoId).map((i) => ({
            id: "yt:" + i.videoId, source: "yt", sid: i.videoId, title: i.title, artist: cleanArtist(i.author),
            art: `https://i.ytimg.com/vi/${i.videoId}/hqdefault.jpg`, duration: i.lengthSeconds || 0, genre: "",
          }));
        }
        if (!tracks.length && kind === "songs") throw new Error("empty");
        store.set("mirror", base);
        return tracks;
      } catch (e) { errors.push(base + ": " + e.message); }
    }
    console.warn("All YouTube mirrors failed", errors);
    throw new Error("All search mirrors are down right now");
  }

  // "All" search: official songs + every other upload (remixes, parodies, covers), best matches first
  async function searchAll(q) {
    const [songs, vids] = await Promise.allSettled([ytSearch(q, "songs"), ytSearch(q, "videos")]);
    const list = [...(songs.value || []), ...(vids.value || [])];
    if (!list.length) throw (songs.reason || vids.reason || new Error("No results"));
    const norm = (x) => String(x).toLowerCase().replace(/[’']/g, "");
    const words = norm(q).split(/\s+/).filter(Boolean);
    const score = (t) => { const hay = norm(t.title + " " + t.artist); return words.filter((w) => hay.includes(w)).length; };
    const seen = new Set();
    return list.map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.t).filter((t) => !seen.has(t.sid) && seen.add(t.sid));
  }

  // ---------------- Audius (indie, full tracks) ----------------
  let audiusHost = null;
  async function getAudiusHost() {
    if (audiusHost) return audiusHost;
    try {
      const r = await timeoutFetch("https://api.audius.co");
      const j = await r.json();
      const hosts = j.data || [];
      audiusHost = hosts[Math.floor(Math.random() * hosts.length)] || "https://api.audius.co";
    } catch { audiusHost = "https://api.audius.co"; }
    return audiusHost;
  }
  const audiusTrack = (t) => ({
    id: "audius:" + t.id, source: "audius", sid: t.id,
    title: t.title, artist: t.user?.name || "Unknown artist",
    art: t.artwork?.["480x480"] || t.artwork?.["150x150"] || "",
    duration: t.duration || 0, genre: t.genre || "",
  });
  async function audius(path) {
    const host = await getAudiusHost();
    const sep = path.includes("?") ? "&" : "?";
    const r = await timeoutFetch(`${host}/v1${path}${sep}app_name=${APP_NAME}`);
    if (!r.ok) throw new Error("Audius " + r.status);
    return (await r.json()).data || [];
  }
  const searchAudius = async (q) => (await audius(`/tracks/search?query=${encodeURIComponent(q)}&limit=30`)).map(audiusTrack);
  const trendingAudius = async () => (await audius(`/tracks/trending?time=week`)).slice(0, 12).map(audiusTrack);

  const blobUrls = {};
  async function streamUrl(track) {
    if (track.source === "audius") return `${await getAudiusHost()}/v1/tracks/${track.sid}/stream?app_name=${APP_NAME}`;
    if (track.source === "itunes") return track.url;
    if (track.source === "local") {
      if (blobUrls[track.id]) return blobUrls[track.id];
      const rec = await idb.get(track.id);
      if (!rec) throw new Error("File was removed");
      return (blobUrls[track.id] = URL.createObjectURL(rec.blob));
    }
  }
  const badge = (t) => t.source === "yt" ? ""
    : t.source === "audius" ? '<span class="badge full">INDIE</span>'
    : t.source === "itunes" ? '<span class="badge preview">PREVIEW</span>' : '<span class="badge local">MY FILE</span>';

  // ---------------- Playback engine (HTML audio + YouTube embed) ----------------
  const audio = $("#audio");
  let volume = store.get("volume", 0.8);
  audio.volume = volume;
  $("#volume").value = volume;
  let mode = "audio";

  const yt = { player: null, ready: null, tried: new Set() };
  function loadYT() {
    if (yt.ready) return yt.ready;
    yt.ready = new Promise((res) => {
      window.onYouTubeIframeAPIReady = () => {
        yt.player = new YT.Player("ytPlayer", {
          width: "100%", height: "100%",
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, autoplay: 1 },
          events: { onReady: () => res(yt.player), onStateChange: onYtState, onError: onYtError },
        });
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
    return yt.ready;
  }
  function onYtState(e) {
    if (mode !== "yt") return;
    if (e.data === YT.PlayerState.PLAYING) { lastTick = performance.now(); updatePlayBtn(); }
    if (e.data === YT.PlayerState.PAUSED) { lastTick = null; flushSession(); updatePlayBtn(); }
    if (e.data === YT.PlayerState.ENDED) next(true);
  }
  // Some uploads can't be embedded; find another upload of the same song.
  async function onYtError() {
    if (mode !== "yt" || !state.current) return;
    const t = state.current;
    yt.tried.add(t.sid);
    try {
      const alts = await ytSearch(`${t.artist} ${t.title} audio`, "videos");
      const alt = alts.find((a) => !yt.tried.has(a.sid));
      if (alt && yt.tried.size < 5) { yt.tried.add(alt.sid); yt.player.loadVideoById(alt.sid); return; }
    } catch {}
    toast("That song can't be played here — skipping");
    setTimeout(() => next(), 600);
  }

  const engine = {
    isPaused: () => mode === "yt" ? !(yt.player && yt.player.getPlayerState && yt.player.getPlayerState() === 1) : audio.paused,
    time: () => mode === "yt" ? (yt.player?.getCurrentTime?.() || 0) : audio.currentTime,
    duration: () => mode === "yt" ? (yt.player?.getDuration?.() || 0) : (audio.duration || 0),
    seek: (t) => mode === "yt" ? yt.player?.seekTo(t, true) : (audio.currentTime = t),
    play: () => mode === "yt" ? yt.player?.playVideo() : audio.play(),
    pause: () => mode === "yt" ? yt.player?.pauseVideo() : audio.pause(),
    hasTrack: () => !!state.current,
  };

  const videoBox = $("#videoBox");
  $("#videoSize").onclick = () => videoBox.classList.toggle("big");

  async function playQueue(tracks, start = 0) {
    if (!tracks.length) return;
    let q = tracks.slice();
    if (state.shuffle) {
      const first = q.splice(start, 1)[0];
      for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
      q.unshift(first); start = 0;
    }
    state.queue = q; state.index = start;
    await loadAndPlay();
  }

  async function loadAndPlay() {
    const track = state.queue[state.index];
    if (!track) return;
    endSession();
    state.current = track;
    updateNowPlaying();
    try {
      if (track.source === "yt") {
        audio.pause();
        mode = "yt";
        yt.tried = new Set([track.sid]);
        videoBox.classList.remove("hidden");
        const p = await loadYT();
        p.setVolume(Math.round(volume * 100));
        p.loadVideoById(track.sid);
      } else {
        if (yt.player) yt.player.stopVideo();
        videoBox.classList.add("hidden");
        mode = "audio";
        audio.src = await streamUrl(track);
        await audio.play();
      }
    } catch (e) {
      console.warn(e);
      toast("Couldn't play that track — skipping");
      setTimeout(next, 800);
      return;
    }
    state.session = { track: slim(track), ts: Date.now(), secs: 0 };
  }

  const slim = (t) => ({ id: t.id, source: t.source, sid: t.sid, title: t.title, artist: t.artist, art: t.art, duration: t.duration, url: t.url, genre: t.genre });

  function next(auto = false) {
    if (!state.queue.length) return;
    if (auto === true && state.repeat === "one") {
      endSession(); state.session = { track: slim(state.current), ts: Date.now(), secs: 0 };
      engine.seek(0); engine.play(); return;
    }
    if (state.index < state.queue.length - 1) state.index++;
    else if (state.repeat === "all") state.index = 0;
    else { engine.pause(); updatePlayBtn(); return; }
    loadAndPlay();
  }
  function prev() {
    if (engine.time() > 3) { engine.seek(0); return; }
    if (state.index > 0) { state.index--; loadAndPlay(); }
  }

  // Progress bar + listening-time tracking for stats
  let lastTick = null;
  setInterval(() => {
    const now = performance.now();
    const playing = state.current && !engine.isPaused();
    if (state.session && playing && lastTick !== null) {
      const d = (now - lastTick) / 1000;
      if (d > 0 && d < 3) state.session.secs += d;
    }
    lastTick = playing ? now : null;
    const dur = engine.duration();
    if (dur) {
      $("#seek").value = (engine.time() / dur) * 1000;
      $("#curTime").textContent = fmt(engine.time());
      $("#durTime").textContent = fmt(dur);
    }
    updatePlayBtn();
  }, 500);
  audio.addEventListener("pause", () => { if (mode === "audio") flushSession(); });
  audio.addEventListener("ended", () => { if (mode === "audio") next(true); });
  setInterval(flushSession, 10000);
  window.addEventListener("beforeunload", endSession);

  // A play counts toward stats once you've listened 15+ seconds
  function flushSession() {
    const s = state.session;
    if (!s || s.secs < 15) return;
    const existing = state.history.find((h) => h.ts === s.ts);
    if (existing) existing.secs = Math.round(s.secs);
    else state.history.push({ track: s.track, ts: s.ts, secs: Math.round(s.secs) });
    save("history");
  }
  function endSession() { flushSession(); state.session = null; }

  function updatePlayBtn() { $("#playBtn").textContent = engine.isPaused() ? "▶" : "⏸"; }
  function updateNowPlaying() {
    const t = state.current;
    $("#npTitle").innerHTML = t ? esc(t.title) + " " + badge(t) : "Nothing playing";
    $("#npArtist").textContent = t ? t.artist : "";
    $("#npArt").src = t?.art || "";
    $("#npLike").textContent = t && isLiked(t) ? "♥" : "♡";
    $("#npLike").classList.toggle("on", !!(t && isLiked(t)));
    document.title = t ? `${t.title} · ${t.artist}` : "Encore";
    document.querySelectorAll("tr.track").forEach((tr) => tr.classList.toggle("playing", t && tr.dataset.id === t.id));
    if ("mediaSession" in navigator && t) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.art ? [{ src: t.art, sizes: "400x400" }] : [] });
    }
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", prev);
    navigator.mediaSession.setActionHandler("play", () => engine.play());
    navigator.mediaSession.setActionHandler("pause", () => engine.pause());
  }

  $("#playBtn").onclick = () => { if (!engine.hasTrack()) return; engine.isPaused() ? engine.play() : engine.pause(); setTimeout(updatePlayBtn, 200); };
  $("#nextBtn").onclick = () => next();
  $("#prevBtn").onclick = prev;
  $("#seek").oninput = (e) => { const d = engine.duration(); if (d) engine.seek((e.target.value / 1000) * d); };
  $("#volume").oninput = (e) => {
    volume = +e.target.value; audio.volume = volume; store.set("volume", volume);
    if (yt.player?.setVolume) yt.player.setVolume(Math.round(volume * 100));
  };
  const syncModes = () => {
    $("#shuffleBtn").classList.toggle("on", state.shuffle);
    $("#repeatBtn").classList.toggle("on", state.repeat !== "off");
    $("#repeatBtn").textContent = state.repeat === "one" ? "🔂" : "🔁";
  };
  $("#shuffleBtn").onclick = () => { state.shuffle = !state.shuffle; save("shuffle"); syncModes(); };
  $("#repeatBtn").onclick = () => { state.repeat = { off: "all", all: "one", one: "off" }[state.repeat]; save("repeat"); syncModes(); };
  $("#npLike").onclick = () => state.current && toggleLike(state.current);
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.code === "Space") { e.preventDefault(); $("#playBtn").click(); }
    if (e.code === "ArrowRight" && e.shiftKey) next();
    if (e.code === "ArrowLeft" && e.shiftKey) prev();
  });
  syncModes();

  // ---------------- Library & playlists ----------------
  const isLiked = (t) => state.liked.some((x) => x.id === t.id);
  function toggleLike(t) {
    if (isLiked(t)) { state.liked = state.liked.filter((x) => x.id !== t.id); toast("Removed from Liked Songs"); }
    else { state.liked.unshift(slim(t)); toast("Added to Liked Songs"); }
    save("liked"); updateNowPlaying(); renderSidebar();
    document.querySelectorAll(`[data-like="${CSS.escape(t.id)}"]`).forEach((b) => (b.textContent = isLiked(t) ? "♥" : "♡"));
  }
  function createPlaylist(name) {
    const pl = { id: uid(), name: name || `My Playlist #${state.playlists.length + 1}`, created: Date.now(), tracks: [] };
    state.playlists.push(pl); save("playlists"); renderSidebar();
    return pl;
  }
  function addToPlaylist(pl, t) {
    if (pl.tracks.some((x) => x.id === t.id)) return toast("Already in " + pl.name);
    pl.tracks.push(slim(t)); save("playlists"); renderSidebar(); toast("Added to " + pl.name);
  }

  function renderSidebar() {
    const cur = location.hash;
    $("#playlistList").innerHTML =
      `<a class="playlist-item ${cur === "#liked" ? "active" : ""}" href="#liked">♥ Liked Songs · ${state.liked.length}</a>` +
      `<a class="playlist-item ${cur === "#files" ? "active" : ""}" href="#files">📁 My Files</a>` +
      state.playlists.map((p) => `<a class="playlist-item ${cur === "#playlist/" + p.id ? "active" : ""}" href="#playlist/${p.id}">${esc(p.name)}</a>`).join("");
  }
  $("#newPlaylistBtn").onclick = () => {
    const name = prompt("Playlist name:", `My Playlist #${state.playlists.length + 1}`);
    if (name === null) return;
    const pl = createPlaylist(name.trim());
    location.hash = "#playlist/" + pl.id;
  };

  // ---------------- Modal / toast ----------------
  function modal(html) {
    const m = $("#modal");
    m.innerHTML = `<div class="modal-box">${html}</div>`;
    m.classList.remove("hidden");
    m.onclick = (e) => { if (e.target === m || e.target.matches("[data-close]")) closeModal(); };
    return m;
  }
  const closeModal = () => $("#modal").classList.add("hidden");
  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 2400);
  }
  function addToPlaylistMenu(t) {
    const m = modal(`<h3>Add “${esc(t.title)}” to…</h3>
      <button class="modal-opt" data-new>＋ New playlist</button>
      ${state.playlists.map((p) => `<button class="modal-opt" data-pl="${p.id}">${esc(p.name)} <span class="t-src">· ${p.tracks.length} songs</span></button>`).join("")}
      <div style="text-align:right;margin-top:12px"><button class="btn ghost" data-close>Cancel</button></div>`);
    m.querySelectorAll("[data-pl]").forEach((b) => (b.onclick = () => { addToPlaylist(state.playlists.find((p) => p.id === b.dataset.pl), t); closeModal(); }));
    m.querySelector("[data-new]").onclick = () => {
      const name = prompt("Playlist name:", `My Playlist #${state.playlists.length + 1}`);
      if (name === null) return;
      addToPlaylist(createPlaylist(name.trim()), t); closeModal();
    };
  }

  // ---------------- Track list component ----------------
  // ctx: { removable: fn(track) } optional
  function trackTable(tracks, ctx = {}) {
    if (!tracks.length) return `<div class="empty">${ctx.empty || "No songs here yet."}</div>`;
    return `<table class="tracks"><thead><tr><th class="t-num">#</th><th>Title</th><th style="text-align:right">⏱</th><th></th></tr></thead><tbody>
      ${tracks.map((t, i) => `<tr class="track ${state.current?.id === t.id ? "playing" : ""}" data-i="${i}" data-id="${esc(t.id)}">
        <td class="t-num">${i + 1}</td>
        <td><div class="t-main">${t.art ? `<img src="${esc(t.art)}" loading="lazy" alt="">` : `<img alt="">`}
          <div style="min-width:0"><div class="t-title">${esc(t.title)} ${badge(t)}</div><div class="t-artist">${esc(t.artist)}</div></div></div></td>
        <td class="t-src" style="text-align:right">${t.duration ? fmt(t.duration) : ""}</td>
        <td class="t-actions">
          <button data-like="${esc(t.id)}" title="Like">${isLiked(t) ? "♥" : "♡"}</button>
          <button data-add title="Add to playlist">＋</button>
          ${ctx.removable ? `<button data-remove title="Remove">✕</button>` : ""}
        </td></tr>`).join("")}
      </tbody></table>`;
  }
  function bindTracks(root, tracks, ctx = {}) {
    root.querySelectorAll("tr.track").forEach((tr) => {
      const i = +tr.dataset.i, t = tracks[i];
      tr.ondblclick = () => playQueue(tracks, i);
      tr.querySelector(".t-main").onclick = () => playQueue(tracks, i);
      tr.querySelector("[data-like]").onclick = (e) => { e.stopPropagation(); toggleLike(t); };
      tr.querySelector("[data-add]").onclick = (e) => { e.stopPropagation(); addToPlaylistMenu(t); };
      const rm = tr.querySelector("[data-remove]");
      if (rm) rm.onclick = (e) => { e.stopPropagation(); ctx.removable(t); };
    });
  }
  function cardGrid(tracks, cls = "grid") {
    return `<div class="${cls}">${tracks.map((t, i) => `<div class="card" data-i="${i}">
      ${t.art ? `<img src="${esc(t.art)}" loading="lazy" alt="">` : `<div class="ph">♪</div>`}
      <button class="card-play" title="Play">▶</button>
      <div class="card-title">${esc(t.title)}</div><div class="card-sub">${esc(t.artist)}</div></div>`).join("")}</div>`;
  }
  const bindCards = (root, tracks) => root.querySelectorAll(".card[data-i]").forEach((c) => (c.onclick = () => playQueue(tracks, +c.dataset.i)));

  // ---------------- Views ----------------
  const main = $("#main");
  const mobileNav = `<div class="mobile-nav"><a class="tab" href="#home">Home</a><a class="tab" href="#search">Search</a><a class="tab" href="#library">Library</a><a class="tab" href="#stats">Stats</a></div>`;
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
  const YEAR = new Date().getFullYear();
  const SHELVES = [
    ["Today's top hits", `top hits ${YEAR}`],
    ["Hip-hop & rap", `hip hop hits ${YEAR}`],
    ["Pop", `pop hits ${YEAR}`],
    ["R&B", `r&b hits ${YEAR}`],
    ["Latin", `latin hits ${YEAR}`],
    ["Country", `country hits ${YEAR}`],
    ["Rock classics", "classic rock hits"],
    ["Throwbacks", "2000s hits"],
  ];

  // Skip hour-long compilations and "Top 100" mixes on Home
  const isSingleSong = (t) => (!t.duration || t.duration < 600) && !/\b(top \d+|mix|playlist|compilation|full album|non.?stop|hours?)\b/i.test(t.title);

  // Cache home shelves for 6 hours so Home loads instantly
  async function shelf(query) {
    const cache = store.get("shelves2", {});
    const hit = cache[query];
    if (hit && Date.now() - hit.at < 6 * 3600e3 && hit.tracks.length) return hit.tracks;
    const tracks = (await ytSearch(query, "songs")).filter(isSingleSong).slice(0, 14);
    cache[query] = { at: Date.now(), tracks };
    localStorage.removeItem("encore:shelves");
    store.set("shelves2", cache);
    return tracks;
  }

  function viewHome() {
    const recent = [];
    const seen = new Set();
    for (let i = state.history.length - 1; i >= 0 && recent.length < 14; i--) {
      const t = state.history[i].track; if (!seen.has(t.id)) { seen.add(t.id); recent.push(t); }
    }
    main.innerHTML = `${mobileNav}<h1>${greeting()}</h1>
      ${recent.length ? `<h2>Recently played</h2><div id="recent"></div>` : ""}
      ${SHELVES.map(([title], i) => `<h2>${esc(title)}</h2><div data-shelf="${i}"><div class="empty">Loading…</div></div>`).join("")}
      <h2>Trending indie (Audius)</h2><div id="indie"><div class="empty">Loading…</div></div>`;
    if (recent.length) { $("#recent").innerHTML = cardGrid(recent, "shelf"); bindCards($("#recent"), recent); }
    SHELVES.forEach(async ([, q], i) => {
      const el = main.querySelector(`[data-shelf="${i}"]`);
      try {
        const tracks = await shelf(q);
        if (!el.isConnected) return;
        el.innerHTML = cardGrid(tracks, "shelf"); bindCards(el, tracks);
      } catch { if (el.isConnected) el.innerHTML = `<div class="empty">Couldn't load right now — the free search mirrors may be busy. Try again in a minute.</div>`; }
    });
    trendingAudius().then((tr) => { const el = $("#indie"); if (el) { el.innerHTML = cardGrid(tr, "shelf"); bindCards(el, tr); } })
      .catch(() => { const el = $("#indie"); if (el) el.innerHTML = `<div class="empty">Couldn't load.</div>`; });
  }

  let lastQuery = "", lastTab = "all";
  function viewSearch() {
    main.innerHTML = `${mobileNav}<h1>Search</h1>
      <input id="q" type="search" placeholder="What do you want to listen to?" value="${esc(lastQuery)}" autocomplete="off" />
      <div class="tabs" id="srcTabs">
        <button class="tab" data-t="all">All</button>
        <button class="tab" data-t="songs">Official songs</button>
        <button class="tab" data-t="videos">Videos & remixes</button>
        <button class="tab" data-t="indie">Indie</button>
      </div>
      <div id="results"></div>`;
    const q = $("#q"); q.focus();
    let timer;
    const tabs = main.querySelectorAll("#srcTabs .tab");
    const setTab = (t) => { lastTab = t; tabs.forEach((b) => b.classList.toggle("active", b.dataset.t === t)); };
    tabs.forEach((b) => (b.onclick = () => { setTab(b.dataset.t); run(); }));
    setTab(lastTab);
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 450); };

    async function run() {
      const term = q.value.trim(); lastQuery = term;
      const box = $("#results");
      if (!term) { box.innerHTML = `<div class="empty">Search any song, artist or album.</div>`; return; }
      box.innerHTML = `<div class="empty">Searching…</div>`;
      const tab = lastTab;
      const key = tab + ":" + term.toLowerCase();
      if (!state.searchCache[key]) {
        try {
          state.searchCache[key] = tab === "indie" ? await searchAudius(term) : tab === "all" ? await searchAll(term) : await ytSearch(term, tab);
        } catch (e) {
          if (q.value.trim() === term && lastTab === tab) box.innerHTML = `<div class="empty">Search is busy right now (${esc(e.message)}). Try again in a moment.</div>`;
          return;
        }
      }
      if (q.value.trim() !== term || lastTab !== tab) return;
      const tracks = state.searchCache[key];
      box.innerHTML = trackTable(tracks, { empty: "No results." });
      bindTracks(box, tracks);
    }
    run();
  }

  function viewLibrary() {
    main.innerHTML = `${mobileNav}<h1>Your Library</h1>
      <div class="row" style="margin-bottom:20px"><button class="btn" id="libNew">＋ New playlist</button><a class="btn ghost" href="#files">📁 Upload your music</a></div>
      <div class="grid">
        <a class="card" href="#liked"><div class="ph">♥</div><div class="card-title">Liked Songs</div><div class="card-sub">${state.liked.length} songs</div></a>
        <a class="card" href="#files"><div class="ph">📁</div><div class="card-title">My Files</div><div class="card-sub">Your uploads</div></a>
        ${state.playlists.map((p) => `<a class="card" href="#playlist/${p.id}">
          ${p.tracks[0]?.art ? `<img src="${esc(p.tracks[0].art)}" alt="">` : `<div class="ph">♪</div>`}
          <div class="card-title">${esc(p.name)}</div><div class="card-sub">${p.tracks.length} songs</div></a>`).join("")}
      </div>
      <h2>Backup</h2>
      <p class="sub" style="margin:0 0 12px">Your playlists and stats live in this browser. Export them to move to another device.</p>
      <div class="row"><button class="btn ghost" id="exportBtn">⬇ Export data</button><label class="btn ghost">⬆ Import data<input type="file" id="importIn" accept=".json" hidden></label></div>`;
    $("#libNew").onclick = () => $("#newPlaylistBtn").click();
    $("#exportBtn").onclick = () => {
      const data = { app: "encore", version: 1, playlists: state.playlists, liked: state.liked, history: state.history };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      a.download = `encore-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    };
    $("#importIn").onchange = async (e) => {
      try {
        const d = JSON.parse(await e.target.files[0].text());
        if (d.app !== "encore") throw 0;
        if (!confirm("Replace your current playlists, likes and stats with this backup?")) return;
        ["playlists", "liked", "history"].forEach((k) => { state[k] = d[k] || []; save(k); });
        renderSidebar(); route(); toast("Backup imported");
      } catch { toast("That isn't an Encore backup file"); }
    };
  }

  function playlistHeader({ kind, name, count, secs, cover, icon, actions = "" }) {
    return `<div class="pl-head">
      <div class="pl-cover">${cover ? `<img src="${esc(cover)}" alt="">` : icon}</div>
      <div><div class="pl-kind">${kind}</div><div class="pl-name">${esc(name)}</div>
      <div class="t-src">${count} songs${secs ? " · " + fmt(secs) : ""}</div>
      <div class="row" style="margin-top:16px"><button class="btn" id="playAll">▶ Play</button>${actions}</div></div></div>`;
  }

  function viewLiked() {
    const tracks = state.liked;
    main.innerHTML = mobileNav + playlistHeader({ kind: "Playlist", name: "Liked Songs", count: tracks.length, secs: tracks.reduce((a, t) => a + (t.duration || 0), 0), icon: "♥" }) + `<div id="list"></div>`;
    $("#list").innerHTML = trackTable(tracks, { removable: 1, empty: "Tap ♡ on any song to save it here." });
    bindTracks($("#list"), tracks, { removable: (t) => { toggleLike(t); viewLiked(); } });
    $("#playAll").onclick = () => playQueue(tracks, 0);
  }

  function viewPlaylist(id) {
    const pl = state.playlists.find((p) => p.id === id);
    if (!pl) { location.hash = "#library"; return; }
    main.innerHTML = mobileNav + playlistHeader({
      kind: "Playlist", name: pl.name, count: pl.tracks.length, secs: pl.tracks.reduce((a, t) => a + (t.duration || 0), 0),
      cover: pl.tracks[0]?.art, icon: "♪",
      actions: `<button class="btn ghost" id="renamePl">Rename</button><button class="btn ghost" id="deletePl">Delete</button>`,
    }) + `<div id="list"></div>`;
    $("#list").innerHTML = trackTable(pl.tracks, { removable: 1, empty: "Find songs in Search and press ＋ to add them here." });
    bindTracks($("#list"), pl.tracks, { removable: (t) => { pl.tracks = pl.tracks.filter((x) => x.id !== t.id); save("playlists"); renderSidebar(); viewPlaylist(id); } });
    $("#playAll").onclick = () => playQueue(pl.tracks, 0);
    $("#renamePl").onclick = () => { const n = prompt("Rename playlist:", pl.name); if (n && n.trim()) { pl.name = n.trim(); save("playlists"); renderSidebar(); viewPlaylist(id); } };
    $("#deletePl").onclick = () => { if (confirm(`Delete “${pl.name}”?`)) { state.playlists = state.playlists.filter((p) => p.id !== id); save("playlists"); renderSidebar(); location.hash = "#library"; } };
  }

  async function viewFiles() {
    main.innerHTML = `${mobileNav}<div class="pl-head"><div class="pl-cover">📁</div><div><div class="pl-kind">Local</div><div class="pl-name">My Files</div>
      <div class="t-src">Songs you own, stored privately in this browser. Full length, works offline.</div>
      <div class="row" style="margin-top:16px"><button class="btn" id="playAll">▶ Play</button>
      <label class="btn ghost">⬆ Add files<input type="file" id="fileIn" accept="audio/*" multiple hidden></label></div></div></div>
      <div class="dropzone" id="drop">Drag & drop MP3, M4A, FLAC, WAV or OGG files here<br><small>Tip: name files “Artist - Title.mp3” for nicer display</small></div>
      <div id="list"><div class="empty">Loading…</div></div>`;
    const recs = await idb.all().catch(() => []);
    const tracks = recs.sort((a, b) => b.added - a.added).map((r) => r.meta);
    $("#list").innerHTML = trackTable(tracks, { removable: 1, empty: "No files yet." });
    bindTracks($("#list"), tracks, { removable: async (t) => { if (!confirm(`Remove “${t.title}” from this browser?`)) return; await idb.del(t.id); viewFiles(); } });
    $("#playAll").onclick = () => playQueue(tracks, 0);
    $("#fileIn").onchange = (e) => importFiles(e.target.files);
    const drop = $("#drop");
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
    drop.ondragleave = () => drop.classList.remove("drag");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("drag"); importFiles(e.dataTransfer.files); };
  }

  function audioDuration(blob) {
    return new Promise((res) => {
      const a = new Audio(); const u = URL.createObjectURL(blob);
      a.preload = "metadata"; a.src = u;
      a.onloadedmetadata = () => { res(a.duration || 0); URL.revokeObjectURL(u); };
      a.onerror = () => { res(0); URL.revokeObjectURL(u); };
    });
  }
  async function importFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(f.name));
    if (!list.length) return toast("No audio files found");
    toast(`Adding ${list.length} file(s)…`);
    for (const f of list) {
      const base = f.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
      const parts = base.split(/\s+-\s+/);
      const meta = {
        id: "local:" + uid(), source: "local",
        title: (parts.length > 1 ? parts.slice(1).join(" - ") : base).trim(),
        artist: parts.length > 1 ? parts[0].trim() : "Unknown artist",
        art: "", duration: await audioDuration(f), genre: "",
      };
      try { await idb.put({ id: meta.id, added: Date.now(), meta, blob: f }); }
      catch { toast("Browser storage is full"); break; }
    }
    toast("Files added");
    if (location.hash === "#files") viewFiles();
  }

  // ---------------- Monthly stats ----------------
  const monthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const monthLabel = (k) => { const [y, m] = k.split("-"); return new Date(+y, +m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" }); };
  let statsMonth = monthKey(Date.now());

  function viewStats() {
    flushSession();
    const months = [...new Set([monthKey(Date.now()), ...state.history.map((h) => monthKey(h.ts))])].sort().reverse();
    if (!months.includes(statsMonth)) statsMonth = months[0];
    const plays = state.history.filter((h) => monthKey(h.ts) === statsMonth);
    const secs = plays.reduce((a, h) => a + h.secs, 0);

    const byTrack = {}, byArtist = {}, byGenre = {};
    for (const h of plays) {
      const t = h.track;
      (byTrack[t.id] ||= { track: t, plays: 0, secs: 0 }); byTrack[t.id].plays++; byTrack[t.id].secs += h.secs;
      (byArtist[t.artist] ||= { name: t.artist, art: t.art, plays: 0, secs: 0 }); byArtist[t.artist].plays++; byArtist[t.artist].secs += h.secs;
      if (t.genre) { byGenre[t.genre] = (byGenre[t.genre] || 0) + h.secs; }
    }
    const topTracks = Object.values(byTrack).sort((a, b) => b.plays - a.plays || b.secs - a.secs).slice(0, 10);
    const topArtists = Object.values(byArtist).sort((a, b) => b.secs - a.secs).slice(0, 10);
    const topGenres = Object.entries(byGenre).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const [y, m] = statsMonth.split("-").map(Number);
    const days = new Date(y, m, 0).getDate();
    const perDay = Array(days).fill(0);
    plays.forEach((h) => (perDay[new Date(h.ts).getDate() - 1] += h.secs));
    const maxDay = Math.max(1, ...perDay);
    const activeDays = perDay.filter((x) => x > 0).length;
    const hours = Array(24).fill(0);
    plays.forEach((h) => (hours[new Date(h.ts).getHours()] += h.secs));
    const peakHour = hours.indexOf(Math.max(...hours));
    const peakLabel = secs ? new Date(2000, 0, 1, peakHour).toLocaleTimeString(undefined, { hour: "numeric" }) : "—";

    main.innerHTML = `${mobileNav}<div class="row" style="justify-content:space-between;margin-bottom:8px">
        <h1 style="margin:0">Monthly Stats</h1>
        <select id="monthSel">${months.map((k) => `<option value="${k}" ${k === statsMonth ? "selected" : ""}>${monthLabel(k)}</option>`).join("")}</select>
      </div>
      <p class="sub" style="margin-top:4px">Your listening in ${monthLabel(statsMonth)}</p>
      <div class="stat-cards">
        <div class="stat"><div class="n">${Math.round(secs / 60).toLocaleString()}</div><div class="l">minutes listened</div></div>
        <div class="stat"><div class="n">${plays.length}</div><div class="l">plays</div></div>
        <div class="stat"><div class="n">${Object.keys(byTrack).length}</div><div class="l">different songs</div></div>
        <div class="stat"><div class="n">${Object.keys(byArtist).length}</div><div class="l">artists</div></div>
        <div class="stat"><div class="n">${activeDays}</div><div class="l">days you listened</div></div>
        <div class="stat"><div class="n" style="font-size:28px">${peakLabel}</div><div class="l">your peak hour</div></div>
      </div>
      ${!plays.length ? `<div class="empty">No listening yet this month. Play something — songs count after 15 seconds.</div>` : `
      <h2>Minutes per day</h2>
      <div class="chart">${perDay.map((s, i) => `<div class="bar" style="height:${(s / maxDay) * 100}%" data-tip="${monthLabel(statsMonth).split(" ")[0]} ${i + 1}: ${Math.round(s / 60)} min"></div>`).join("")}</div>
      <div class="chart-axis"><span>1</span><span>${Math.ceil(days / 2)}</span><span>${days}</span></div>
      <div class="two-col">
        <div><h2>Top songs</h2>${topTracks.map((x, i) => `<div class="rank" data-ti="${i}" style="cursor:pointer">
          <div class="r">${i + 1}</div>${x.track.art ? `<img src="${esc(x.track.art)}" alt="">` : `<img alt="">`}
          <div class="meta"><div class="t-title">${esc(x.track.title)}</div><div class="t-artist">${esc(x.track.artist)}</div></div>
          <div class="val">${x.plays} play${x.plays > 1 ? "s" : ""}</div></div>`).join("")}</div>
        <div><h2>Top artists</h2>${topArtists.map((x, i) => `<div class="rank">
          <div class="r">${i + 1}</div>${x.art ? `<img src="${esc(x.art)}" alt="" style="border-radius:50%">` : `<img alt="" style="border-radius:50%">`}
          <div class="meta"><div class="t-title">${esc(x.name)}</div></div>
          <div class="val">${Math.round(x.secs / 60)} min</div></div>`).join("")}</div>
      </div>
      ${topGenres.length ? `<h2>Top genres</h2><div class="row">${topGenres.map(([g, s]) => `<span class="tab">${esc(g)} · ${Math.round(s / 60)} min</span>`).join("")}</div>` : ""}
      <div class="row" style="margin-top:28px"><button class="btn" id="mkTop">Save top songs as a playlist</button></div>`}`;

    $("#monthSel").onchange = (e) => { statsMonth = e.target.value; viewStats(); };
    const topList = topTracks.map((x) => x.track);
    main.querySelectorAll("[data-ti]").forEach((el) => (el.onclick = () => playQueue(topList, +el.dataset.ti)));
    const mk = $("#mkTop");
    if (mk) mk.onclick = () => {
      const pl = createPlaylist(`Top Songs · ${monthLabel(statsMonth)}`);
      pl.tracks = topList.map(slim); save("playlists"); renderSidebar();
      location.hash = "#playlist/" + pl.id;
    };
  }

  // ---------------- Router ----------------
  function route() {
    const h = location.hash.slice(1) || "home";
    const [view, arg] = h.split("/");
    document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
    renderSidebar();
    main.scrollTop = 0;
    ({ home: viewHome, search: viewSearch, library: viewLibrary, liked: viewLiked, files: viewFiles, stats: viewStats,
       playlist: () => viewPlaylist(arg) }[view] || viewHome)();
  }
  window.addEventListener("hashchange", route);
  route();
})();
