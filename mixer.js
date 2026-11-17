// Encore — two-deck mixer: play two songs at once and blend them with a crossfader.
// Each deck is its own YouTube player. YouTube doesn't let pages touch the raw audio, so the mixer
// works with what the player allows: volume, crossfade, speed, seeking and cue points.
(() => {
  "use strict";
  const E = window.Encore;
  if (!E || !E.search) return;
  const icon = window.icon, { esc, fmt, toast, engine, state } = E;
  const $ = (s, el = document) => el.querySelector(s);

  const deckHTML = (id, label) => `
    <div class="deck" data-deck="${id}">
      <div class="deck-top">
        <span class="deck-label">${label}</span>
        <div class="deck-search">
          <input type="search" placeholder="Find a song for deck ${label}" autocomplete="off" />
          <div class="deck-results hidden"></div>
        </div>
      </div>
      <div class="deck-screen"><div id="mxPlayer${id}"></div><div class="deck-empty">Search above to load a song onto deck ${label}</div></div>
      <div class="deck-meta"><div class="deck-title">No song loaded</div><div class="deck-artist">&nbsp;</div></div>
      <div class="deck-progress"><span class="d-cur">0:00</span><input type="range" class="d-seek" min="0" max="1000" value="0" aria-label="Position on deck ${label}" /><span class="d-dur">0:00</span></div>
      <div class="deck-controls">
        <button class="cue-btn d-cue" title="Jump to the cue point">CUE</button>
        <button class="play-btn d-play" title="Play / pause deck ${label}">${icon("play")}</button>
        <button class="link-btn d-setcue" title="Mark the current spot as the cue point">Set cue</button>
        <label class="d-speed-l">Speed <select class="d-speed"><option value="1">1×</option></select></label>
      </div>
      <div class="deck-vol">${icon("volume")}<input type="range" class="d-vol" min="0" max="100" value="100" aria-label="Deck ${label} volume" /></div>
      <button class="link-btn d-loadnow">Load the song that's playing</button>
    </div>`;

  // The mixer sits in the same spot as the main panel, so its players keep running when you leave the page
  const root = document.createElement("section");
  root.id = "mixer";
  root.className = "mixer away";
  root.innerHTML = `
    <div class="mobile-nav"><a class="tab" href="#home">Home</a><a class="tab" href="#search">Search</a><a class="tab" href="#library">Library</a><a class="tab" href="#stats">Stats</a><a class="tab" href="#mix">Mixer</a></div>
    <h1>Mixer</h1>
    <p class="sub">Play two songs at once and blend them with the crossfader.</p>
    <div class="mx-decks">${deckHTML("a", "A")}${deckHTML("b", "B")}</div>
    <div class="mx-xfade"><span>A</span><input type="range" id="mxX" min="-100" max="100" value="0" aria-label="Crossfader" /><span>B</span></div>
    <div class="mx-actions">
      <button class="btn ghost" id="mxFadeA">Fade to A</button>
      <button class="btn" id="mxBoth">${icon("play")} Play both</button>
      <button class="btn ghost" id="mxFadeB">Fade to B</button>
      <label class="mx-len">Fade over <select id="mxLen"><option value="4">4 s</option><option value="8" selected>8 s</option><option value="16">16 s</option></select></label>
    </div>`;
  document.querySelector(".app").appendChild(root);

  // ---------------- Decks ----------------
  const waitYT = () => new Promise((res) => {
    const check = () => (window.YT && window.YT.Player ? res() : setTimeout(check, 200));
    check();
  });
  const decks = {};
  function makeDeck(id) {
    const el = root.querySelector(`[data-deck="${id}"]`);
    const d = { id, el, player: null, track: null, cue: 0, vol: 100 };
    d.ready = waitYT().then(() => new Promise((res) => {
      d.player = new YT.Player("mxPlayer" + id, {
        width: "100%", height: "100%",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => { res(d.player); applyVolumes(); },
          onStateChange: (e) => {
            const playing = e.data === YT.PlayerState.PLAYING;
            el.classList.toggle("live", playing);
            $(".d-play", el).innerHTML = icon(playing ? "pause" : "play");
            if (playing && !engine.isPaused()) engine.pause();          // the main player steps aside
            if (e.data === YT.PlayerState.CUED || playing) fillSpeeds(d);
          },
          onError: () => toast(`That song can't be played on deck ${id.toUpperCase()}. Try another upload.`),
        },
      });
    }));

    // Search box with a dropdown of results
    const input = $("input[type=search]", el), results = $(".deck-results", el);
    let timer, lastList = [];
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { results.classList.add("hidden"); return; }
      timer = setTimeout(async () => {
        results.classList.remove("hidden");
        results.innerHTML = `<div class="empty" style="padding:12px">Searching…</div>`;
        try { lastList = (await E.search(q)).slice(0, 8); } catch (e) { results.innerHTML = `<div class="empty" style="padding:12px">Search is busy. Try again in a moment.</div>`; return; }
        if (input.value.trim() !== q) return;
        results.innerHTML = lastList.length ? lastList.map((t, i) => `<div class="deck-result" data-i="${i}">
          ${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : `<span class="r-ph">${icon("note")}</span>`}
          <div style="min-width:0"><div class="t-title">${esc(t.title)}</div><div class="t-artist">${esc(t.artist)}</div></div></div>`).join("")
          : `<div class="empty" style="padding:12px">No results.</div>`;
        results.querySelectorAll(".deck-result").forEach((r) => (r.onclick = () => { load(d, lastList[+r.dataset.i]); results.classList.add("hidden"); input.value = ""; }));
      }, 350);
    });
    document.addEventListener("click", (e) => { if (!el.querySelector(".deck-search").contains(e.target)) results.classList.add("hidden"); });

    $(".d-play", el).onclick = async () => {
      if (!d.track) return toast(`Load a song onto deck ${id.toUpperCase()} first`);
      const p = await d.ready;
      p.getPlayerState() === YT.PlayerState.PLAYING ? p.pauseVideo() : p.playVideo();
    };
    $(".d-seek", el).oninput = (e) => { const p = d.player, dur = p && p.getDuration ? p.getDuration() : 0; if (dur) p.seekTo((e.target.value / 1000) * dur, true); };
    $(".d-setcue", el).onclick = () => { if (!d.player || !d.track) return; d.cue = d.player.getCurrentTime(); toast(`Cue set at ${fmt(d.cue)} on deck ${id.toUpperCase()}`); };
    $(".d-cue", el).onclick = () => { if (d.player && d.track) d.player.seekTo(d.cue, true); };
    $(".d-speed", el).onchange = (e) => { if (d.player) d.player.setPlaybackRate(+e.target.value); };
    $(".d-vol", el).oninput = (e) => { d.vol = +e.target.value; applyVolumes(); };
    $(".d-loadnow", el).onclick = () => {
      const t = state.current;
      if (!t || t.source !== "yt") return toast("Play a song from Search first, then load it here");
      const at = engine.time();
      engine.pause();
      load(d, t, at);
    };
    return d;
  }

  async function load(d, t, startAt = 0) {
    const p = await d.ready;
    d.track = t; d.cue = startAt;
    d.el.classList.add("loaded");
    $(".deck-title", d.el).textContent = t.title;
    $(".deck-artist", d.el).textContent = t.artist;
    p.cueVideoById({ videoId: t.sid, startSeconds: startAt });
    $(".d-speed", d.el).value = "1";
    applyVolumes();
  }

  function fillSpeeds(d) {
    const sel = $(".d-speed", d.el);
    const rates = (d.player.getAvailablePlaybackRates && d.player.getAvailablePlaybackRates()) || [1];
    if (sel.options.length === rates.length) return;
    const cur = d.player.getPlaybackRate ? d.player.getPlaybackRate() : 1;
    sel.innerHTML = rates.map((r) => `<option value="${r}" ${r === cur ? "selected" : ""}>${r}×</option>`).join("");
  }

  // ---------------- Crossfader ----------------
  // Equal-power curve: both decks sit at about 71% in the middle, so the blend doesn't dip in loudness
  const xf = $("#mxX", root);
  function applyVolumes() {
    const t = (+xf.value + 100) / 200;
    const gain = { a: Math.cos(t * Math.PI / 2), b: Math.sin(t * Math.PI / 2) };
    for (const id in decks) {
      const d = decks[id];
      if (d.player && d.player.setVolume) d.player.setVolume(Math.round(d.vol * gain[id]));
    }
  }
  xf.oninput = applyVolumes;

  let fadeAnim = null;
  function fadeTo(target) {
    cancelAnimationFrame(fadeAnim);
    const from = +xf.value, len = +$("#mxLen", root).value * 1000, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / len);
      xf.value = Math.round(from + (target - from) * (0.5 - Math.cos(k * Math.PI) / 2));
      applyVolumes();
      if (k < 1) fadeAnim = requestAnimationFrame(step);
    };
    fadeAnim = requestAnimationFrame(step);
  }
  $("#mxFadeA", root).onclick = () => fadeTo(-100);
  $("#mxFadeB", root).onclick = () => fadeTo(100);
  $("#mxBoth", root).onclick = async () => {
    const loaded = Object.values(decks).filter((d) => d.track);
    if (loaded.length < 2) return toast("Load a song onto both decks first");
    await Promise.all(loaded.map((d) => d.ready));
    loaded.forEach((d) => d.player.playVideo());
  };

  // Progress bars
  setInterval(() => {
    if (root.classList.contains("away")) return;
    for (const id in decks) {
      const d = decks[id], p = d.player;
      if (!p || !p.getDuration || !d.track) continue;
      const dur = p.getDuration(), cur = p.getCurrentTime();
      if (dur) {
        $(".d-seek", d.el).value = (cur / dur) * 1000;
        $(".d-cur", d.el).textContent = fmt(cur);
        $(".d-dur", d.el).textContent = fmt(dur);
      }
    }
  }, 250);

  // Playing something in the main player pauses the decks
  document.addEventListener("encore:userplay", () => {
    for (const id in decks) { const p = decks[id].player; if (p && p.pauseVideo) p.pauseVideo(); }
  });

  // ---------------- Show / hide with the #mix page ----------------
  let built = false;
  function syncRoute() {
    const on = location.hash === "#mix";
    root.classList.toggle("away", !on);
    if (on && !built) { built = true; decks.a = makeDeck("a"); decks.b = makeDeck("b"); }
  }
  window.addEventListener("hashchange", syncRoute);
  syncRoute();
})();
