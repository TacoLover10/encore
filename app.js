// Encore — a static music web app. Runs entirely on GitHub Pages, no API keys.
// Sources:
//   - YouTube: almost every popular song, full length. Search goes through free public
//     Piped / Invidious mirrors (with automatic fallback); playback uses YouTube's
//     official embedded player.
//   - Audius: free full-length tracks from independent artists.
//   - Your own audio files (stored in your browser with IndexedDB).
// Everything you do (your queue, likes, listening history) is saved in your browser.
(() => {
  "use strict";

  const APP_NAME = "EncoreMusicApp";
  const icon = window.icon;
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
    liked: store.get("liked", []),             // [track]
    history: store.get("history", []),         // [{track, ts, secs}]
    recent: store.get("recent", []),           // last 5 searches [{q, at, track}]
    queue: [], index: -1,                      // tracks queued by you carry q: true
    shuffle: store.get("shuffle", false),
    repeat: store.get("repeat", "off"),        // off | all | one
    current: null, session: null,
    searchCache: {},
  };
  const save = (k) => store.set(k, state[k]);
  // Playlists and code sync were removed; clear what they left behind
  ["playlists", "syncCode", "syncKey", "syncAt", "syncPrint", "syncLast"].forEach((k) => localStorage.removeItem("encore:" + k));

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

  // Ask three mirrors at once and use whichever answers first, and remember answers for this visit
  const searchMemo = new Map();
  function ytSearch(q, kind = "songs") {
    const key = kind + "|" + q.toLowerCase();
    if (searchMemo.has(key)) return searchMemo.get(key);
    const p = ytSearchRace(q, kind).catch((e) => { searchMemo.delete(key); throw e; });
    searchMemo.set(key, p);
    return p;
  }
  async function ytSearchRace(q, kind) {
    const list = mirrors();
    for (let i = 0; i < list.length; i += 3) {
      try { return await Promise.any(list.slice(i, i + 3).map(([type, base]) => ytSearchOne(type, base, q, kind))); } catch {}
    }
    throw new Error("All search mirrors are down right now");
  }
  async function ytSearchOne(type, base, q, kind) {
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
        // Put clean / radio edits last unless you searched for them
        if (!/\b(clean|radio edit|edited|censored)\b/i.test(q)) {
          const isClean = (t) => /\b(clean|radio edit|edited|censored)\b/i.test(t.title);
          tracks = [...tracks.filter((t) => !isClean(t)), ...tracks.filter(isClean)];
        }
        if (!tracks.length && kind === "songs") throw new Error("empty");
        store.set("mirror", base);
        return tracks;
  }

  // "All" search: official songs + every other upload (remixes, parodies, covers), best matches first
  async function searchAll(q) {
    const [songs, vids] = await Promise.allSettled([ytSearch(q, "songs"), ytSearch(q, "videos")]);
    const list = [...(songs.value || []), ...(vids.value || [])];
    if (!list.length) throw (songs.reason || vids.reason || new Error("No results"));
    const norm = (x) => String(x).toLowerCase().replace(/[’']/g, "");
    const words = norm(q).split(/\s+/).filter(Boolean);
    const cleanRe = /\b(clean|radio edit|edited|censored)\b/i;
    const score = (t) => { const hay = norm(t.title + " " + t.artist); return words.filter((w) => hay.includes(w)).length - (cleanRe.test(t.title) && !cleanRe.test(q) ? 0.5 : 0); };
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

  // Remember which upload you picked for a song (e.g. explicit instead of clean)
  const songKey = (t) => (t.artist + "|" + t.title).toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/[^a-z0-9|]+/g, " ").trim();
  const versions = store.get("versions", {});
  const playSid = (t) => versions[songKey(t)] || t.sid;

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
    let q = tracks.map((t) => { const s = slim(t); delete s.q; return s; });
    if (state.shuffle) {
      const first = q.splice(start, 1)[0];
      for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
      q.unshift(first); start = 0;
    }
    q.splice(start + 1, 0, ...queuedNext());   // songs you queued stay next in line
    // Keep what you were listening to behind the new song, so Previous takes you back
    const hist = state.current && loadedId ? state.queue.slice(Math.max(0, state.index - 49), state.index + 1) : [];
    const was = hist.length && engine.time() > 2 ? { track: state.current, at: engine.time() } : null;
    state.queue = [...hist, ...q]; state.index = hist.length + start;
    await loadAndPlay(true);
    // Tapped a song by accident? One tap takes you back to where you were.
    if (was && was.track.id !== state.current.id) toast(`Playing “${state.current.title}”`, { label: "Go back", run: () => {
      const i = state.queue.lastIndexOf(was.track);
      if (i >= 0) { state.index = i; loadAndPlay(true, was.at); }
    } });
  }

  let loadedId = null;   // the track actually loaded into a player (vs. just shown)
  async function loadAndPlay(userStarted = false, startAt = 0) {
    const track = state.queue[state.index];
    if (!track) return;
    endSession();
    state.current = track;
    saveQueue();
    updateNowPlaying();
    // YouTube doesn't allow its songs to start while Encore is in the background;
    // line it up so it starts as soon as you come back.
    if (track.source === "yt" && document.hidden && !userStarted) {
      loadedId = null; pendingResume = true;
      if (yt.player?.stopVideo) yt.player.stopVideo();
      audio.pause(); updatePlayBtn(); return;
    }
    loadedId = track.id;
    if (userStarted) document.dispatchEvent(new Event("encore:userplay"));
    try {
      if (track.source === "yt") {
        audio.pause();
        mode = "yt";
        yt.tried = new Set([playSid(track)]);
        document.dispatchEvent(new Event("encore:mode"));
        const p = await loadYT();
        p.setVolume(Math.round(volume * 100));
        p.loadVideoById(playSid(track), startAt);
      } else {
        if (yt.player) yt.player.stopVideo();
        mode = "audio";
        document.dispatchEvent(new Event("encore:mode"));
        audio.src = await streamUrl(track);
        if (startAt) audio.addEventListener("loadedmetadata", () => { audio.currentTime = startAt; }, { once: true });
        await audio.play();
      }
    } catch (e) {
      console.warn(e);
      toast("Couldn't play that track — skipping");
      setTimeout(next, 800);
      return;
    }
    if (track.source !== "yt") setMediaState();
    state.session = { track: slim(track), ts: Date.now(), secs: 0 };
  }

  // "Sounds censored?" — pick another upload of the same song. The original is always
  // first in the list, so you can go back any time. Encore remembers your pick.
  const verCache = {};
  async function findVersions(t) {
    const key = songKey(t);
    if (verCache[key]) return verCache[key];
    const [a, b] = await Promise.allSettled([ytSearch(`${t.artist} ${t.title}`, "songs"), ytSearch(`${t.artist} ${t.title} explicit`, "videos")]);
    const core = key.split("|")[1] || "";
    const okDur = (c) => !t.duration || !c.duration || Math.abs(c.duration - t.duration) <= 20;
    const bad = /\b(radio edit|instrumental|karaoke|cover|sped|slowed|nightcore|reaction|8d|tribute|made famous|in the style of|originally performed|as performed)\b/i;
    const sameArtist = (c) => songKey(c).startsWith(t.artist.toLowerCase());
    const seen = new Set([t.sid]);
    const list = [...(a.value || []), ...(b.value || [])].filter((c) => {
      if (seen.has(c.sid)) return false; seen.add(c.sid);
      return okDur(c) && (songKey(c).split("|")[1] || "").includes(core) && !bad.test(c.title);
    }).sort((x, y) => sameArtist(y) - sameArtist(x)).slice(0, 7);
    return (verCache[key] = list);
  }
  function useVersion(t, sid) {
    const key = songKey(t), at = engine.time();
    if (sid === t.sid) delete versions[key]; else versions[key] = sid;
    store.set("versions", versions);
    yt.tried = new Set([sid]);
    yt.player.loadVideoById(sid, at);
    closeModal();
    toast(sid === t.sid ? "Back to the original version" : "Switched version. Encore will remember this.");
  }
  async function switchVersion() {
    const t = state.current;
    if (!t || mode !== "yt" || !yt.player) return;
    const nowSid = (yt.player.getVideoData && yt.player.getVideoData().video_id) || playSid(t);
    const row = (sid, title, sub, cur) => `<button class="modal-opt ver-opt ${cur ? "cur" : ""}" data-sid="${esc(sid)}">
        <span class="ver-dot">${cur ? icon("play") : ""}</span>
        <span class="ver-text"><span class="ver-title">${esc(title)}</span><span class="t-src">${esc(sub)}</span></span></button>`;
    const draw = (list, loading) => {
      const m = modal(`<h3>Choose a version</h3>
        <p class="sub" style="margin:-6px 0 10px">If a song sounds censored or wrong, try another upload. Your pick is remembered.</p>
        ${row(t.sid, "Original", `${t.title} · ${t.artist}${t.duration ? " · " + fmt(t.duration) : ""}`, nowSid === t.sid)}
        ${loading ? `<div class="empty" style="padding:14px">Finding other versions…</div>`
          : list.length ? list.map((c) => row(c.sid, c.title, `${c.artist}${c.duration ? " · " + fmt(c.duration) : ""}`, nowSid === c.sid)).join("")
          : `<div class="empty" style="padding:14px">No other versions found.</div>`}
        <div style="text-align:right;margin-top:12px"><button class="btn ghost" data-close>Close</button></div>`);
      m.querySelectorAll("[data-sid]").forEach((b) => (b.onclick = () => { if (b.dataset.sid !== nowSid) useVersion(t, b.dataset.sid); else closeModal(); }));
    };
    draw([], true);
    let list = [];
    try { list = await findVersions(t); } catch {}
    // A version picked earlier that the search didn't return still shows up
    if (nowSid !== t.sid && !list.some((c) => c.sid === nowSid)) list = [{ sid: nowSid, title: "Your current pick", artist: t.artist }, ...list];
    if (!$("#modal").classList.contains("hidden") && state.current === t) draw(list, false);
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
    if (engine.time() > 3 && loadedId) { engine.seek(0); return; }
    if (state.index > 0) { state.index--; loadAndPlay(); }
  }

  // ---------------- Queue ----------------
  // state.queue holds what played before, the current song, then what's coming.
  // Songs you add yourself are marked q:true and line up right after the current song.
  const upcoming = () => state.queue.slice(state.index + 1);
  const queuedNext = () => { const out = []; for (const t of upcoming()) { if (!t.q) break; out.push(t); } return out; };
  function saveQueue() {
    const from = Math.max(0, state.index - 20);   // keep a little history, not everything
    store.set("queue", { q: state.queue.slice(from, from + 220), i: state.index - from });
    renderQueue();
  }
  function addToQueue(t, playNext = false) {
    const s = { ...slim(t), q: true };
    if (!state.current) { state.queue = [s]; state.index = 0; loadAndPlay(true); return toast("Playing " + t.title); }
    const at = state.index + 1 + (playNext ? 0 : queuedNext().length);
    state.queue.splice(at, 0, s);
    saveQueue();
    toast(playNext ? `“${t.title}” plays next` : `Added “${t.title}” to the queue`);
  }
  function queueMenu(t) {
    const m = modal(`<h3>${esc(t.title)}</h3><p class="sub" style="margin:-6px 0 12px">${esc(t.artist)}</p>
      <button class="modal-opt" data-next>${icon("playNext")} Play next</button>
      <button class="modal-opt" data-end>${icon("queueAdd")} Add to queue</button>
      <div style="text-align:right;margin-top:12px"><button class="btn ghost" data-close>Cancel</button></div>`);
    m.querySelector("[data-next]").onclick = () => { addToQueue(t, true); closeModal(); };
    m.querySelector("[data-end]").onclick = () => { addToQueue(t); closeModal(); };
  }
  // Restore the queue from last time (shown in the player, starts when you press play)
  (() => {
    const saved = store.get("queue", null);
    if (!saved || !saved.q || !saved.q[saved.i]) return;
    state.queue = saved.q; state.index = saved.i; state.current = saved.q[saved.i];
  })();

  const qPanel = $("#queuePanel");
  const qRow = (t, abs, opts = {}) => `<div class="q-row ${opts.now ? "now" : ""}" data-abs="${abs}">
      ${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy" decoding="async">` : `<div class="q-ph">${icon("note")}</div>`}
      <div class="q-main"><div class="q-title">${esc(t.title)}</div><div class="q-artist">${esc(t.artist)}</div></div>
      ${opts.now ? "" : `<span class="q-btns">
        <button class="icon-btn" data-up title="Move up">${icon("up")}</button>
        <button class="icon-btn" data-down title="Move down">${icon("down")}</button>
        <button class="icon-btn" data-rm title="Remove from queue">${icon("close")}</button></span>`}
    </div>`;
  function renderQueue() {
    if (!qPanel || qPanel.classList.contains("hidden")) return;
    const mine = queuedNext(), first = state.index + 1, rest = upcoming().slice(mine.length);
    const restStart = first + mine.length;
    qPanel.querySelector(".q-body").innerHTML = !state.current
      ? `<div class="empty">Nothing playing. Tap ${icon("queueAdd")} on any song to start a queue.</div>`
      : `<h4>Now playing</h4>${qRow(state.current, state.index, { now: true })}
        <div class="q-sec"><h4>Next in your queue</h4>${mine.length ? `<button class="link-btn" id="qClear">Clear</button>` : ""}</div>
        ${mine.length ? mine.map((t, i) => qRow(t, first + i)).join("") : `<p class="q-hint">Tap ${icon("queueAdd")} on any song to line it up here.</p>`}
        ${rest.length ? `<div class="q-sec"><h4>Next up</h4><span class="q-count">${rest.length} song${rest.length > 1 ? "s" : ""}</span></div>
          ${rest.slice(0, 60).map((t, i) => qRow(t, restStart + i)).join("")}` : ""}`;
    qPanel.querySelectorAll(".q-row[data-abs]").forEach((row) => {
      const abs = +row.dataset.abs;
      if (abs === state.index) return;
      row.querySelector(".q-main").onclick = () => { state.index = abs; loadAndPlay(true); };
      row.querySelector("[data-rm]").onclick = () => { state.queue.splice(abs, 1); saveQueue(); };
      const move = (to) => {
        if (to <= state.index || to >= state.queue.length) return;
        const a = state.queue[abs], b = state.queue[to];
        if (!!a.q !== !!b.q) a.q = !!b.q;   // crossing into the other section takes on its label
        state.queue[abs] = b; state.queue[to] = a; saveQueue();
      };
      row.querySelector("[data-up]").onclick = () => move(abs - 1);
      row.querySelector("[data-down]").onclick = () => move(abs + 1);
    });
    const c = $("#qClear"); if (c) c.onclick = () => { const n = queuedNext().length; state.queue.splice(state.index + 1, n); saveQueue(); };
  }
  const openQueue = () => { qPanel.classList.toggle("hidden"); renderQueue(); };
  $("#queueBtn").onclick = openQueue;
  $("#npQueue").onclick = openQueue;
  qPanel.querySelector("[data-qclose]").onclick = () => qPanel.classList.add("hidden");
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") qPanel.classList.add("hidden"); });

  // Keep the screen awake while music plays, so the phone's auto-sleep doesn't stop it.
  // (Locking the phone yourself still pauses YouTube songs; your own files keep playing.)
  let wakeLock = null, wakeBusy = false;
  async function syncWakeLock() {
    if (!("wakeLock" in navigator) || wakeBusy) return;
    const playing = (state.current && !engine.isPaused()) || !!document.querySelector(".deck.live");
    const want = playing && document.visibilityState === "visible";
    if (want === !!wakeLock) return;
    wakeBusy = true;
    try {
      if (want) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); }
      else { await wakeLock.release(); wakeLock = null; }
    } catch {}
    wakeBusy = false;
  }
  document.addEventListener("visibilitychange", syncWakeLock);
  document.addEventListener("pointerdown", () => { if (!wakeLock) syncWakeLock(); }, { passive: true });

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
    syncWakeLock();
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

  // Tint the main panel with the colors of the song's artwork
  let ambientFor = null;
  function setAmbient(src) {
    if (src === ambientFor) return;
    ambientFor = src;
    const root = document.documentElement.style;
    if (!src) return root.removeProperty("--ambient");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (ambientFor !== src) return;
      try {
        const c = document.createElement("canvas"); c.width = c.height = 16;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = (mx - mn) / 255 + 0.05;   // favor colorful pixels over greys
          r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
        }
        root.setProperty("--ambient", `rgb(${(r / n) | 0}, ${(g / n) | 0}, ${(b / n) | 0})`);
      } catch {}
    };
    img.src = src;
  }

  function updatePlayBtn() { const k = engine.isPaused() ? "play" : "pause", b = $("#playBtn"); if (b.dataset.k !== k) { b.dataset.k = k; b.innerHTML = icon(k); } }
  function updateNowPlaying() {
    const t = state.current;
    $("#npTitle").innerHTML = t ? esc(t.title) + " " + badge(t) : "Nothing playing";
    $("#npArtist").textContent = t ? t.artist : "";
    $("#npArt").src = t?.art || "";
    setAmbient(t && t.art);
    $("#npLike").innerHTML = icon(t && isLiked(t) ? "heartFill" : "heart");
    $("#npLike").classList.toggle("on", !!(t && isLiked(t)));
    document.title = t ? `${t.title} · ${t.artist}` : "Encore";
    document.querySelectorAll("tr.track").forEach((tr) => tr.classList.toggle("playing", t && tr.dataset.id === t.id));
    if ("mediaSession" in navigator && t) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.art ? [{ src: t.art, sizes: "400x400" }] : [] });
    }
    document.dispatchEvent(new Event("encore:track"));
  }
  // Lock screen & Control Center controls. Your files and indie (Audius) songs keep playing
  // when you leave Encore; YouTube's rules don't allow its songs to play in the background,
  // so those pause and pick up again when you come back.
  let pendingResume = false;
  function setMediaState() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = engine.isPaused() ? "paused" : "playing";
      const d = engine.duration();
      if (mode === "audio" && d && isFinite(d)) navigator.mediaSession.setPositionState({ duration: d, position: Math.min(engine.time(), d), playbackRate: 1 });
    } catch {}
  }
  const bgBlocked = () => mode === "yt" && document.hidden;
  if ("mediaSession" in navigator) {
    const h = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
    h("nexttrack", () => next());
    h("previoustrack", prev);
    h("play", () => { if (bgBlocked()) return; loadedId === state.current?.id ? engine.play() : loadAndPlay(true); });
    h("pause", () => engine.pause());
    h("seekto", (e) => { if (mode === "audio" && e.seekTime != null) { engine.seek(e.seekTime); setMediaState(); } });
  }
  ["play", "pause", "loadedmetadata"].forEach((ev) => audio.addEventListener(ev, setMediaState));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Remember a YouTube song that was playing so it continues when you return
      if (mode === "yt" && loadedId && !engine.isPaused()) pendingResume = true;
    } else if (pendingResume) {
      pendingResume = false;
      if (state.current && loadedId !== state.current.id) loadAndPlay(true);
      else if (mode === "yt") setTimeout(() => engine.play(), 150);
    }
  });

  $("#playBtn").onclick = () => { if (!engine.hasTrack()) return; if (loadedId !== state.current.id) return loadAndPlay(true); engine.isPaused() ? engine.play() : engine.pause(); setTimeout(updatePlayBtn, 200); };
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
    $("#repeatBtn").innerHTML = icon(state.repeat === "one" ? "repeatOne" : "repeat");
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
    document.querySelectorAll(`[data-like="${CSS.escape(t.id)}"]`).forEach((b) => (b.innerHTML = icon(isLiked(t) ? "heartFill" : "heart")));
  }
  function renderSidebar() {
    const cur = location.hash;
    $("#playlistList").innerHTML =
      `<a class="playlist-item ${cur === "#liked" ? "active" : ""}" href="#liked">${icon("heartFill")} Liked Songs · ${state.liked.length}</a>` +
      `<a class="playlist-item ${cur === "#files" ? "active" : ""}" href="#files">${icon("folder")} My Files</a>`;
  }
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
  function toast(msg, action) {
    const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
    if (action) {
      const b = document.createElement("button"); b.className = "toast-btn"; b.textContent = action.label;
      b.onclick = () => { t.classList.add("hidden"); action.run(); };
      t.appendChild(b);
    }
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), action ? 6000 : 2400);
  }
  // ---------------- Track list component ----------------
  // ctx: { removable: fn(track) } optional
  function trackTable(tracks, ctx = {}) {
    if (!tracks.length) return `<div class="empty">${ctx.empty || "No songs here yet."}</div>`;
    return `<table class="tracks"><thead><tr><th class="t-num">#</th><th>Title</th><th style="text-align:right">${icon("clock")}</th><th></th></tr></thead><tbody>
      ${tracks.map((t, i) => `<tr class="track ${state.current?.id === t.id ? "playing" : ""}" data-i="${i}" data-id="${esc(t.id)}">
        <td class="t-num"><span class="n">${i + 1}</span><span class="pi">${icon("play")}</span></td>
        <td><div class="t-main">${t.art ? `<img src="${esc(t.art)}" loading="lazy" decoding="async" alt="">` : `<img alt="">`}
          <div style="min-width:0"><div class="t-title">${esc(t.title)} ${badge(t)}</div><div class="t-artist">${esc(t.artist)}</div></div></div></td>
        <td class="t-src" style="text-align:right">${t.duration ? fmt(t.duration) : ""}</td>
        <td class="t-actions">
          <button data-like="${esc(t.id)}" title="Like">${icon(isLiked(t) ? "heartFill" : "heart")}</button>
          <button data-add title="Add to queue">${icon("queueAdd")}</button>
          ${ctx.removable ? `<button data-remove title="Remove">${icon("close")}</button>` : ""}
        </td></tr>`).join("")}
      </tbody></table>`;
  }
  function bindTracks(root, tracks, ctx = {}) {
    root.querySelectorAll("tr.track").forEach((tr) => {
      const i = +tr.dataset.i, t = tracks[i];
      tr.ondblclick = () => playQueue(tracks, i);
      tr.querySelector(".t-main").onclick = () => playQueue(tracks, i);
      tr.querySelector(".t-num").onclick = () => playQueue(tracks, i);
      tr.querySelector("[data-like]").onclick = (e) => { e.stopPropagation(); toggleLike(t); };
      tr.querySelector("[data-add]").onclick = (e) => { e.stopPropagation(); queueMenu(t); };
      const rm = tr.querySelector("[data-remove]");
      if (rm) rm.onclick = (e) => { e.stopPropagation(); ctx.removable(t); };
    });
  }
  function cardGrid(tracks, cls = "grid") {
    return `<div class="${cls}">${tracks.map((t, i) => `<div class="card" data-i="${i}">
      ${t.art ? `<img src="${esc(t.art)}" loading="lazy" decoding="async" alt="">` : `<div class="ph">${icon("note")}</div>`}
      <button class="card-play" title="Play">${icon("play")}</button>
      <button class="card-add" title="Add to queue">${icon("queueAdd")}</button>
      <div class="card-title">${esc(t.title)}</div><div class="card-sub">${esc(t.artist)}</div></div>`).join("")}</div>`;
  }
  const bindCards = (root, tracks) => root.querySelectorAll(".card[data-i]").forEach((c) => {
    c.onclick = () => playQueue(tracks, +c.dataset.i);
    c.querySelector(".card-add").onclick = (e) => { e.stopPropagation(); queueMenu(tracks[+c.dataset.i]); };
  });

  // ---------------- Views ----------------
  const main = $("#main");
  const mobileNav = `<div class="mobile-nav"><a class="tab" href="#home">Home</a><a class="tab" href="#search">Search</a><a class="tab" href="#library">Library</a><a class="tab" href="#stats">Stats</a><a class="tab" href="#mix">Mixer</a></div>`;
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
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
    q.onkeydown = (e) => { if (e.key === "Enter" && q.value.trim()) { clearTimeout(timer); addRecent(q.value.trim(), null); run(); } };

    async function run() {
      const term = q.value.trim(); lastQuery = term;
      const box = $("#results");
      if (!term) { renderRecent(box, (again) => { q.value = again; addRecent(again, null); run(); }); return; }
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
      // Remember this search, and the song you picked from it
      box.querySelectorAll("tr.track").forEach((tr) => {
        const pick = () => addRecent(term, tracks[+tr.dataset.i]);
        tr.querySelector(".t-main").addEventListener("click", pick);
        tr.querySelector(".t-num").addEventListener("click", pick);
      });
    }
    run();
  }

  // ---------------- Recent searches ----------------
  function addRecent(q, track) {
    const key = q.toLowerCase();
    const old = state.recent.find((r) => r.q.toLowerCase() === key);
    const entry = { q, at: Date.now(), track: track ? slim(track) : (old && old.track) || null };
    state.recent = [entry, ...state.recent.filter((r) => r.q.toLowerCase() !== key)].slice(0, 5);
    save("recent");
  }
  function renderRecent(box, searchAgain) {
    if (!state.recent.length) {
      box.innerHTML = `<div class="empty">Search any song, artist or album. Your last 5 searches, and the song you played from each, will show up here.</div>`;
      return;
    }
    box.innerHTML = `<div class="recent-head"><h2>Recent searches</h2><button class="link-btn" id="clearRecent">Clear all</button></div>
      <div class="recent">${state.recent.map((r, i) => `<div class="recent-item" data-ri="${i}">
        ${r.track && r.track.art ? `<img src="${esc(r.track.art)}" alt="" loading="lazy" decoding="async">` : `<div class="r-ph">${icon("search")}</div>`}
        <div class="r-main" title="${r.track ? "Play" : "Search again"}">
          <div class="r-title">${esc(r.track ? r.track.title : r.q)}</div>
          <div class="r-q">${r.track ? `${esc(r.track.artist)}, from your search “${esc(r.q)}”` : "No song played from this search yet"}</div>
        </div>
        ${r.track ? `<button class="icon-btn" data-play title="Play">${icon("play")}</button><button class="icon-btn" data-queue title="Add to queue">${icon("queueAdd")}</button>` : ""}
        <button class="icon-btn" data-again title="Search “${esc(r.q)}” again">${icon("search")}</button>
        <button class="icon-btn" data-del title="Remove">${icon("close")}</button>
      </div>`).join("")}</div>`;
    box.querySelectorAll(".recent-item").forEach((el) => {
      const r = state.recent[+el.dataset.ri];
      const play = () => r.track ? playQueue([r.track], 0) : searchAgain(r.q);
      el.querySelector(".r-main").onclick = play;
      const p = el.querySelector("[data-play]"); if (p) p.onclick = play;
      const qb = el.querySelector("[data-queue]"); if (qb) qb.onclick = () => queueMenu(r.track);
      el.querySelector("[data-again]").onclick = () => searchAgain(r.q);
      el.querySelector("[data-del]").onclick = () => { state.recent = state.recent.filter((x) => x !== r); save("recent"); renderRecent(box, searchAgain); };
    });
    $("#clearRecent").onclick = () => { state.recent = []; save("recent"); renderRecent(box, searchAgain); };
  }

  function viewLibrary() {
    main.innerHTML = `${mobileNav}<h1>Your Library</h1>
      <div class="row" style="margin-bottom:20px"><a class="btn ghost" href="#files">${icon("upload")} Upload your music</a></div>
      <div class="grid">
        <a class="card" href="#liked"><div class="ph">${icon("heartFill")}</div><div class="card-title">Liked Songs</div><div class="card-sub">${state.liked.length} songs</div></a>
        <a class="card" href="#files"><div class="ph">${icon("folder")}</div><div class="card-title">My Files</div><div class="card-sub">Your uploads</div></a>
      </div>`;
  }

  function playlistHeader({ kind, name, count, secs, cover, icon: iconHtml, actions = "" }) {
    return `<div class="pl-head">
      <div class="pl-cover">${cover ? `<img src="${esc(cover)}" alt="">` : iconHtml}</div>
      <div><div class="pl-kind">${kind}</div><div class="pl-name">${esc(name)}</div>
      <div class="t-src">${count} songs${secs ? " · " + fmt(secs) : ""}</div>
      <div class="row" style="margin-top:16px"><button class="btn" id="playAll">${icon("play")} Play</button><button class="btn ghost" id="queueAll">${icon("queueAdd")} Add all to queue</button>${actions}</div></div></div>`;
  }

  function viewLiked() {
    const tracks = state.liked;
    main.innerHTML = mobileNav + playlistHeader({ kind: "Collection", name: "Liked Songs", count: tracks.length, secs: tracks.reduce((a, t) => a + (t.duration || 0), 0), icon: icon("heartFill") }) + `<div id="list"></div>`;
    $("#list").innerHTML = trackTable(tracks, { removable: 1, empty: "Tap the heart on any song to save it here." });
    bindTracks($("#list"), tracks, { removable: (t) => { toggleLike(t); viewLiked(); } });
    $("#playAll").onclick = () => playQueue(tracks, 0);
    $("#queueAll").onclick = () => queueAll(tracks);
  }
  function queueAll(tracks) {
    if (!tracks.length) return;
    if (!state.current) return playQueue(tracks, 0);
    const at = state.index + 1 + queuedNext().length;
    state.queue.splice(at, 0, ...tracks.map((t) => ({ ...slim(t), q: true })));
    saveQueue(); toast(`Added ${tracks.length} song${tracks.length > 1 ? "s" : ""} to the queue`);
  }

  async function viewFiles() {
    main.innerHTML = `${mobileNav}<div class="pl-head"><div class="pl-cover">${icon("folder")}</div><div><div class="pl-kind">Local</div><div class="pl-name">My Files</div>
      <div class="t-src">Songs you own, stored privately in this browser. Full length, works offline.</div>
      <div class="row" style="margin-top:16px"><button class="btn" id="playAll">${icon("play")} Play</button>
      <label class="btn ghost">${icon("upload")} Add files<input type="file" id="fileIn" accept="audio/*" multiple hidden></label></div></div></div>
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
      <div class="row" style="margin-top:28px"><button class="btn" id="mkTop">${icon("play")} Play top songs</button><button class="btn ghost" id="qTop">${icon("queueAdd")} Add top songs to queue</button></div>`}`;

    $("#monthSel").onchange = (e) => { statsMonth = e.target.value; viewStats(); };
    const topList = topTracks.map((x) => x.track);
    main.querySelectorAll("[data-ti]").forEach((el) => (el.onclick = () => playQueue(topList, +el.dataset.ti)));
    const mk = $("#mkTop");
    if (mk) { mk.onclick = () => playQueue(topList, 0); $("#qTop").onclick = () => queueAll(topList); }
  }

  // ---------------- Router ----------------
  function route() {
    const h = location.hash.slice(1) || "home";
    const [view] = h.split("/");
    document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
    renderSidebar();
    main.scrollTop = 0;
    ({ home: viewHome, search: viewSearch, library: viewLibrary, liked: viewLiked, files: viewFiles, stats: viewStats }[view] || viewHome)();
  }
  window.addEventListener("hashchange", route);
  route();
  if (state.current) updateNowPlaying();

  // iPhone: no pinch or double-tap zooming
  ["gesturestart", "gesturechange", "gestureend"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

  // Pick up new versions of Encore right away (phones can hold on to an old copy).
  // Only reloads when nothing is playing, so it never cuts off a song.
  const versionsOf = (s) => (String(s).match(/\.(?:js|css)\?v=\d+/g) || []).sort().join(" ");
  setTimeout(async () => {
    try {
      const html = await fetch(location.pathname + "?fresh=" + Date.now(), { cache: "no-store" }).then((r) => r.text());
      const mine = versionsOf([...document.querySelectorAll("script[src], link[href]")].map((e) => e.getAttribute("src") || e.getAttribute("href")).join(" "));
      const latest = versionsOf(html);
      const key = "encore:updated:" + latest;
      if (latest && mine && latest !== mine && !sessionStorage.getItem(key) && (!state.current || engine.isPaused())) {
        sessionStorage.setItem(key, "1");
        location.reload();
      }
    } catch {}
  }, 2500);
  // Warm up the YouTube player in the background so the first song starts quickly
  setTimeout(() => loadYT(), 1500);

  // Shared with np.js (Now Playing screen + lyrics)
  window.Encore = { state, engine, esc, fmt, store, toast, timeoutFetch, toggleLike, isLiked, switchVersion, addToQueue, queueMenu, search: searchAll, refresh: () => { renderSidebar(); route(); }, getMode: () => mode };
})();
