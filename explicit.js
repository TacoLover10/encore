// Encore — "E" badges for explicit songs.
// YouTube doesn't say whether a song is explicit, so we look each song up in Deezer's free
// catalog (no API key), which labels explicit and clean versions. When a song has both an
// explicit and a clean version, the upload's length decides which one it is.
(() => {
  "use strict";
  const E = window.Encore;
  if (!E) return;
  const { store } = E;

  const cache = store.get("explicit", {});      // key -> 1 (explicit) | 0
  let dirty = false;
  setInterval(() => { if (dirty) { dirty = false; store.set("explicit", cache); } }, 3000);

  const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "")
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\b(feat|ft)\.?\s.*$/, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const cleanArtist = (s) => String(s || "").replace(/\s+-\s+topic$/i, "").replace(/vevo$/i, "").replace(/\bofficial\b/i, "");
  const CLEAN = /\b(clean|radio edit|edited|censored)\b/i;
  const EXPL = /\bexplicit\b/i;
  const parseDur = (s) => { const p = String(s || "").trim().split(":").map(Number); return p.length > 1 && p.every((n) => !isNaN(n)) ? p.reduce((a, n) => a * 60 + n, 0) : 0; };

  // Deezer's API supports JSONP, so it works from a static site
  let n = 0;
  function jsonp(url) {
    return new Promise((res, rej) => {
      const cb = "__encore_dz" + n++;
      const s = document.createElement("script");
      const t = setTimeout(() => { done(); rej(new Error("timeout")); }, 9000);
      function done() { clearTimeout(t); delete window[cb]; s.remove(); }
      window[cb] = (d) => { done(); res(d); };
      s.onerror = () => { done(); rej(new Error("failed")); };
      s.src = `${url}&output=jsonp&callback=${cb}`;
      document.head.appendChild(s);
    });
  }

  // Small queue so we don't flood Deezer
  const queue = [];
  let running = 0;
  const pending = {};
  function schedule(key, fn) {
    if (key in cache) return Promise.resolve(cache[key]);
    if (pending[key]) return pending[key];
    pending[key] = new Promise((resolve) => { queue.push({ fn, resolve }); pump(); })
      .then((v) => { delete pending[key]; if (v !== null) { cache[key] = v; dirty = true; } return v; });
    return pending[key];
  }
  function pump() {
    while (running < 3 && queue.length) {
      const { fn, resolve } = queue.shift();
      running++;
      fn().catch(() => null).then((v) => { running--; resolve(v); setTimeout(pump, 120); });
    }
  }

  async function lookup(title, artist, dur) {
    if (CLEAN.test(title)) return 0;
    if (EXPL.test(title)) return 1;
    let a = cleanArtist(artist), t = title;
    const dash = title.match(/^(.+?)\s[-–]\s(.+)$/);
    if (dash && !norm(dash[1]).includes(norm(a)) && /vevo|official|music|records|tv/i.test(artist)) { a = dash[1]; t = dash[2]; }
    else if (dash && norm(dash[1]) === norm(a)) t = dash[2];
    const na = norm(a), nt = norm(t);
    if (!nt) return 0;
    const d = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(a + " " + nt)}&limit=15`);
    const list = (d && d.data) || [];
    const same = list.filter((r) => {
      const ra = norm(r.artist && r.artist.name), rt = norm(r.title);
      return ra && na && (na.includes(ra) || ra.includes(na)) && (rt === nt || rt.startsWith(nt + " ") || nt.startsWith(rt + " "));
    });
    if (!same.length) return 0;
    const isExp = (r) => r.explicit_lyrics || r.explicit_content_lyrics === 1;
    const exp = same.filter(isExp);
    if (!exp.length) return 0;
    const clean = same.filter((r) => !isExp(r) && (r.explicit_content_lyrics === 3 || CLEAN.test(r.title)));
    if (!clean.length || !dur) return 1;
    // Both versions exist: pick the one whose length matches this upload
    const best = (arr) => Math.min(...arr.map((r) => Math.abs((r.duration || 0) - dur)));
    return best(exp) <= best(clean) ? 1 : 0;
  }

  const badge = () => {
    const b = document.createElement("span");
    b.className = "exp"; b.title = "Explicit"; b.textContent = "E";
    return b;
  };
  function mark(el, key, title, artist, dur) {
    if (!el) return;
    if (el.dataset.expKey === key && !(cache[key] === 1 && !el.querySelector(":scope > .exp"))) return;
    el.dataset.expKey = key;
    const apply = (v) => {
      if (el.dataset.expKey !== key) return;
      const has = el.querySelector(":scope > .exp");
      if (v === 1 && !has) el.prepend(badge());
      if (v !== 1 && has) has.remove();
    };
    if (key in cache) return apply(cache[key]);
    schedule(key, () => lookup(title, artist, dur)).then(apply);
  }
  const text = (el) => (el ? [...el.childNodes].filter((c) => c.nodeType === 3 || !c.classList.contains("badge") && !c.classList.contains("exp")).map((c) => c.textContent).join("").trim() : "");

  function scan() {
    // Track rows (search, playlists, liked songs)
    document.querySelectorAll("tr.track").forEach((tr) => {
      if (!/^yt:/.test(tr.dataset.id || "")) return;
      const title = text(tr.querySelector(".t-title")), artistEl = tr.querySelector(".t-artist");
      const durCell = tr.querySelector("td.t-src");
      const dur = parseDur(durCell && durCell.textContent);
      mark(artistEl, tr.dataset.id, title, text(artistEl), dur);
    });
    // Cards (home shelves, recently played)
    document.querySelectorAll(".card[data-i]").forEach((c) => {
      const title = text(c.querySelector(".card-title")), sub = c.querySelector(".card-sub");
      if (title) mark(sub, "song:" + norm(text(sub)) + "|" + norm(title), title, text(sub), 0);
    });
    // Player bar + Now Playing screen
    const t = E.state.current;
    if (t && t.source === "yt") {
      mark(document.querySelector("#npArtist"), t.id, t.title, t.artist, t.duration);
      mark(document.querySelector("#npSongArtist"), t.id, t.title, t.artist, t.duration);
    }
  }

  let timer;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 80); })
    .observe(document.body, { childList: true, subtree: true });
  scan();
})();
