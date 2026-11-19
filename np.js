// Encore — full-screen "Now Playing" view, video controls and synced lyrics.
// Lyrics come from LRCLIB (https://lrclib.net), a free lyrics database. No API key needed.
(() => {
  "use strict";
  const E = window.Encore;
  if (!E) return;
  const $ = (s) => document.querySelector(s);
  const icon = window.icon;
  const { state, engine, esc, fmt, store, toast, timeoutFetch } = E;

  const np = $("#np");
  const videoBox = $("#videoBox");
  const ui = { open: false, tab: "song", videoClosed: store.get("videoClosed", false) };
  const isYT = () => state.current && state.current.source === "yt";

  // ---------------- Open / close ----------------
  function openNP(tab) {
    ui.open = true;
    if (tab) ui.tab = tab;
    np.classList.remove("hidden");
    document.body.classList.add("np-open");
    render();
  }
  function closeNP() {
    ui.open = false;
    np.classList.add("hidden");
    document.body.classList.remove("np-open");
    placeVideo();
  }

  // ---------------- Where the YouTube player sits ----------------
  // Corner pop-up, inside the Now Playing screen (Video tab), or tucked away when closed.
  function placeVideo() {
    videoBox.classList.remove("in-np", "offscreen", "hidden");
    videoBox.removeAttribute("style");
    if (E.getMode() !== "yt" || !state.current) { videoBox.classList.add("hidden"); return; }
    if (ui.open && ui.tab === "video") {
      const r = $("#npVideoSlot").getBoundingClientRect();
      videoBox.classList.add("in-np");
      Object.assign(videoBox.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    } else if (ui.open || ui.videoClosed) {
      videoBox.classList.add("offscreen");
    }
    $("#videoBtn").classList.toggle("on", isYT() && !ui.videoClosed);
  }
  window.addEventListener("resize", placeVideo);

  // ---------------- Render ----------------
  function render() {
    const t = state.current;
    if (ui.tab === "video" && !isYT()) ui.tab = "song";
    np.querySelectorAll("[data-np-tab]").forEach((b) => b.classList.toggle("active", b.dataset.npTab === ui.tab));
    np.querySelector('[data-np-tab="video"]').classList.toggle("hidden", !isYT());
    $("#npBg").style.backgroundImage = t && t.art ? `url("${t.art}")` : "none";
    $("#npBigArt").src = (t && t.art) || "";
    $("#npSongTitle").textContent = t ? t.title : "Nothing playing";
    $("#npSongArtist").textContent = t ? t.artist : "";
    $("#npSwitch").classList.toggle("hidden", !isYT());
    $("#npBigArt").classList.toggle("hidden", ui.tab !== "song");
    $("#npVideoSlot").classList.toggle("hidden", ui.tab !== "video");
    $("#npLyrics").classList.toggle("hidden", ui.tab !== "lyrics");
    if (ui.tab === "lyrics") loadLyrics();
    // wait a frame so the video slot has its final size
    requestAnimationFrame(placeVideo);
  }

  // ---------------- Lyrics ----------------
  const cache = {};
  let lyricsFor = null, lines = [], active = -1;
  const norm = (s) => String(s || "").replace(/[’‘]/g, "'").trim();
  const cleanTitle = (s) => norm(s)
    .replace(/[\(\[][^\)\]]*[\)\]]/g, " ")
    .replace(/\s+(ft|feat)\.?\s.*$/i, "")
    .replace(/\s*[|｜].*$/, "")
    .replace(/\b(official|music|lyrics?|video|audio|visuali[sz]er|hd|4k)\b/gi, " ")
    .replace(/\s+/g, " ").trim();

  async function findLyrics(t) {
    const title = norm(t.title), artist = norm(t.artist);
    const head = title.split(/\s[-–|]\s|\s*[\(\[]/)[0].trim();
    const tries = [];
    if (head) tries.push(`track_name=${encodeURIComponent(head)}&artist_name=${encodeURIComponent(artist)}`);
    const dash = title.match(/^(.+?)\s[-–]\s(.+)$/);
    if (dash) tries.push(`track_name=${encodeURIComponent(dash[2].split(/\s*[\(\[]/)[0].trim())}&artist_name=${encodeURIComponent(dash[1])}`);
    tries.push(`q=${encodeURIComponent(cleanTitle(title) + " " + artist)}`);
    if (head) tries.push(`q=${encodeURIComponent(head)}`);
    const d = t.duration || engine.duration() || 0;
    const diff = (x) => (d ? Math.abs((x.duration || 0) - d) : 0);
    for (const q of tries) {
      try {
        const r = await timeoutFetch(`https://lrclib.net/api/search?${q}`, 8000);
        if (!r.ok) continue;
        const list = (await r.json()).filter((x) => x.syncedLyrics || x.plainLyrics || x.instrumental);
        if (!list.length) continue;
        list.sort((a, b) => (diff(a) > 12) - (diff(b) > 12) || !!b.syncedLyrics - !!a.syncedLyrics || diff(a) - diff(b));
        if (d && diff(list[0]) > 45 && q.startsWith("q=")) continue;
        return list[0];
      } catch {}
    }
    return null;
  }

  function parseLRC(lrc) {
    const out = [];
    for (const raw of lrc.split("\n")) {
      const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
      if (m) out.push({ t: +m[1] * 60 + +m[2], text: m[3] });
    }
    return out;
  }

  async function loadLyrics() {
    const t = state.current, box = $("#npLyrics");
    if (!t) { box.innerHTML = `<div class="empty">Play a song to see lyrics.</div>`; return; }
    if (lyricsFor === t.id) return;
    lyricsFor = t.id; lines = []; active = -1;
    box.innerHTML = `<div class="empty">Finding lyrics…</div>`;
    if (!(t.id in cache)) cache[t.id] = await findLyrics(t);
    if (lyricsFor !== t.id) return;
    const L = cache[t.id];
    if (!L) { box.innerHTML = `<div class="empty">No lyrics found for this song.</div>`; return; }
    if (L.instrumental) { box.innerHTML = `<div class="empty">♪ Instrumental ♪</div>`; return; }
    if (L.syncedLyrics) {
      lines = parseLRC(L.syncedLyrics);
      box.innerHTML = lines.map((l, i) => `<p class="ly" data-li="${i}">${esc(l.text) || "♪"}</p>`).join("");
      box.querySelectorAll(".ly").forEach((p) => (p.onclick = () => engine.seek(lines[+p.dataset.li].t)));
    } else {
      box.innerHTML = `<div class="ly-plain">${esc(L.plainLyrics).replace(/\n/g, "<br>")}</div>`;
    }
    box.insertAdjacentHTML("beforeend", `<div class="ly-credit">Lyrics from LRCLIB · tap a line to jump there</div>`);
    box.scrollTop = 0;
  }

  // Progress + karaoke-style highlight
  setInterval(() => {
    if (!ui.open) return;
    const dur = engine.duration(), cur = engine.time();
    if (dur) {
      $("#npSeek").value = (cur / dur) * 1000;
      $("#npCur").textContent = fmt(cur);
      $("#npDur").textContent = fmt(dur);
    }
    if (ui.tab !== "lyrics" || !lines.length) return;
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].t <= cur + 0.3; k++) i = k;
    if (i === active) return;
    active = i;
    const box = $("#npLyrics");
    box.querySelectorAll(".ly.on").forEach((p) => p.classList.remove("on"));
    const p = box.querySelector(`[data-li="${i}"]`);
    if (p) { p.classList.add("on"); p.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }, 250);

  // ---------------- Wiring ----------------
  np.querySelectorAll("[data-np-tab]").forEach((b) => (b.onclick = () => { ui.tab = b.dataset.npTab; render(); }));
  $("#npClose").onclick = closeNP;
  $("#npSwitch").onclick = () => E.switchVersion();
  $("#npSeek").oninput = (e) => { const d = engine.duration(); if (d) engine.seek((e.target.value / 1000) * d); };
  $("#npArt").onclick = () => state.current && openNP();
  $(".now .np-text").onclick = () => state.current && openNP();
  $("#lyricsBtn").onclick = () => {
    if (!state.current) return toast("Play a song first");
    ui.open && ui.tab === "lyrics" ? closeNP() : openNP("lyrics");
  };
  $("#videoClose").onclick = () => {
    ui.videoClosed = true; store.set("videoClosed", true); placeVideo();
    toast("Video closed — tap the video button to bring it back");
  };
  $("#videoBtn").onclick = () => {
    if (!isYT()) return toast("This song has no video");
    ui.videoClosed = !ui.videoClosed; store.set("videoClosed", ui.videoClosed);
    if (ui.open && ui.tab !== "video") closeNP(); else placeVideo();
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.open) closeNP(); });

  document.addEventListener("encore:userplay", () => { if (!ui.open) openNP("song"); });
  document.addEventListener("encore:mode", placeVideo);
  let lastId = null;
  document.addEventListener("encore:track", () => {
    const id = state.current ? state.current.id : null;
    if (id !== lastId) { lastId = id; lyricsFor = null; }
    if (ui.open) render(); else placeVideo();
  });
})();
