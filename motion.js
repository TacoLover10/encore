// Encore — animated album covers on the Now Playing screen, only for songs that suit one.
// A song gets one when it's an official, well-known release with real album artwork
// (looked up in Deezer's free catalog). The style follows the song's energy:
//   pulse   — loud / fast songs: the cover beats in time
//   drift   — mid-energy songs: slow camera drift with a light sweep
//   breathe — quiet ballads: a soft glow that rises and falls
// Lyric videos, parodies, live recordings, long mixes, obscure tracks and your own files get none.
(() => {
  "use strict";
  const E = window.Encore;
  if (!E) return;
  const { state, engine, store } = E;
  const $ = (s) => document.querySelector(s);

  const art = $("#npBigArt");
  if (!art) return;

  // Wrap the big cover so we can layer a glow and a light sweep around it
  const cover = document.createElement("div");
  cover.className = "np-cover";
  art.parentNode.insertBefore(cover, art);
  const glow = document.createElement("img");
  glow.className = "np-cover-glow"; glow.alt = ""; glow.setAttribute("aria-hidden", "true");
  const sheen = document.createElement("span");
  sheen.className = "np-cover-sheen";
  cover.append(glow, art, sheen);

  const cache = store.get("motion3", {});
  const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "")
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\b(feat|ft)\.?\s.*$/, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const sameArtist = (ra, na) => !!ra && (ra === na || na.startsWith(ra + " ") || ra.startsWith(na + " "));
  const SKIP = /\b(live|lyrics?|lyric video|reaction|parody|interview|commentary|mix|mixtape|full album|cover|karaoke|instrumental|slowed|sped up|nightcore|8d)\b/i;

  let n = 0;
  function jsonp(url) {
    return new Promise((res, rej) => {
      const cb = "__encore_mo" + n++;
      const s = document.createElement("script");
      const t = setTimeout(() => { done(); rej(new Error("timeout")); }, 9000);
      function done() { clearTimeout(t); delete window[cb]; s.remove(); }
      window[cb] = (d) => { done(); res(d); };
      s.onerror = () => { done(); rej(new Error("failed")); };
      s.src = `${url}${url.includes("?") ? "&" : "?"}output=jsonp&callback=${cb}`;
      document.head.appendChild(s);
    });
  }

  // Decide whether this song should get an animated cover, and which style
  async function decide(t) {
    if (!t || t.source !== "yt") return null;                                     // only streamed songs
    if (!t.art || !/googleusercontent/.test(t.art)) return null;                  // real square album art only
    if (t.duration && (t.duration < 60 || t.duration > 480)) return null;         // skip clips and long mixes
    if (SKIP.test(t.title)) return null;
    const nt = norm(t.title), na = norm(t.artist.replace(/\s+-\s+topic$/i, ""));
    if (!nt || !na) return null;
    const s = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(na + " " + nt)}&limit=10`);
    const hit = ((s && s.data) || []).find((r) => {
      const ra = norm(r.artist && r.artist.name), rt = norm(r.title);
      return sameArtist(ra, na) && (rt === nt || rt.startsWith(nt + " ") || nt.startsWith(rt + " "));
    });
    if (!hit) return fromApple(nt, na);                                            // Deezer doesn't carry it: ask Apple's catalog
    if ((hit.rank || 0) < 400000) return null;                                     // obscure tracks don't need one
    const d = await jsonp(`https://api.deezer.com/track/${hit.id}`);
    let bpm = (d && d.bpm) || 0;
    const gain = d && typeof d.gain === "number" ? d.gain : -10;
    if (bpm > 140) bpm /= 2;                                                       // pulse on the half-beat for very fast songs
    const loud = gain >= -9.6, quiet = gain <= -11.5;
    const style = quiet ? "breathe" : loud || bpm >= 100 ? "pulse" : bpm && bpm < 75 ? "breathe" : "drift";
    return { style, beat: bpm ? 60 / bpm : loud ? 0.5 : 0.75 };
  }

  // Fallback for albums Deezer doesn't carry: confirm it's an official release on Apple's catalog,
  // and choose the style from its genre.
  async function fromApple(nt, na) {
    const d = await jsonp(`https://itunes.apple.com/search?term=${encodeURIComponent(na + " " + nt)}&entity=song&limit=10`);
    const r = ((d && d.results) || []).find((x) => {
      const ra = norm(x.artistName), rt = norm(x.trackName);
      return sameArtist(ra, na) && (rt === nt || rt.startsWith(nt + " ") || nt.startsWith(rt + " "));
    });
    if (!r) return null;
    const g = String(r.primaryGenreName || "").toLowerCase();
    if (/hip-hop|rap|dance|electronic|house|latin|reggaeton|k-pop/.test(g)) return { style: "pulse", beat: 0.5 };
    if (/singer|songwriter|jazz|classical|country|soundtrack|folk|vocal|christian/.test(g)) return { style: "breathe", beat: 0.75 };
    return { style: "drift", beat: 0.75 };
  }

  let current = null;
  function apply(m) {
    cover.classList.remove("m-pulse", "m-drift", "m-breathe");
    cover.removeAttribute("style");
    if (!m) return;
    cover.classList.add("m-" + m.style);
    cover.style.setProperty("--beat", m.beat.toFixed(3) + "s");
  }

  async function update() {
    const t = state.current;
    const id = t ? t.id : null;
    glow.src = art.getAttribute("src") || "";
    if (id === current) return;
    current = id;
    apply(null);
    if (!t) return;
    if (!(id in cache)) {
      try { cache[id] = await decide(t); } catch { return; }   // try again next time if Deezer didn't answer
      store.set("motion3", cache);
    }
    if (current === id) apply(cache[id]);
  }

  // Follow the cover image np.js shows, and pause the animation with the music
  new MutationObserver(update).observe(art, { attributes: true, attributeFilter: ["src"] });
  setInterval(() => cover.classList.toggle("paused", engine.isPaused()), 400);
  update();
})();
