// Encore — sync your playlists across devices with a code you choose.
// Your profile is saved as a locked file in this GitHub repo (profiles/…). The code is the key:
// the file is encrypted with it in your browser, so the repo only ever holds scrambled data.
//   Save:   Encore opens GitHub's "new file" page with your locked profile filled in; tap Commit.
//           (Only the repo owner can commit, so nobody else can change your profile.)
//   Unlock: on any device, type the code. Encore reads your latest save from the repo, no key needed.
(() => {
  "use strict";
  const E = window.Encore;
  if (!E) return;
  const { state, store, toast, esc } = E;
  const icon = window.icon;

  // Which repo is this? (works for any https://<owner>.github.io/<repo>/ site)
  const owner = location.hostname.endsWith(".github.io") ? location.hostname.split(".")[0] : null;
  const repo = location.pathname.split("/").filter(Boolean)[0] || (owner ? owner + ".github.io" : null);
  const URL_LIMIT = 7000;   // GitHub refuses prefilled links much longer than ~8,000 characters

  // ---------------- Crypto ----------------
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const profileId = async (code) => hex(await crypto.subtle.digest("SHA-256", enc.encode("encore-id|" + code))).slice(0, 24);
  async function keyFor(code, id) {
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: enc.encode("encore-sync|" + id), iterations: 150000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const pipe = async (u8, stream) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
  async function lock(obj, code, id) {
    const zipped = await pipe(enc.encode(JSON.stringify(obj)), new CompressionStream("gzip"));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(code, id), zipped));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return "ENCORE1:" + b64(all);
  }
  async function unlock(text, code, id) {
    const all = unb64(text.trim().replace(/^ENCORE1:/, ""));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await keyFor(code, id), all.slice(12));
    return JSON.parse(dec.decode(await pipe(new Uint8Array(plain), new DecompressionStream("gzip"))));
  }

  // ---------------- What gets synced ----------------
  const snapshot = () => ({ v: 1, at: Date.now(), playlists: state.playlists, liked: state.liked, recent: state.recent || [], versions: store.get("versions", {}) });

  function merge(remote) {
    // Playlists: add new ones, and add any missing songs to ones you already have
    for (const rp of remote.playlists || []) {
      const lp = state.playlists.find((p) => p.id === rp.id);
      if (!lp) state.playlists.push(rp);
      else { if (rp.name) lp.name = rp.name; for (const t of rp.tracks || []) if (!lp.tracks.some((x) => x.id === t.id)) lp.tracks.push(t); }
    }
    for (const t of remote.liked || []) if (!state.liked.some((x) => x.id === t.id)) state.liked.push(t);
    const seen = new Set();
    state.recent = [...(remote.recent || []), ...(state.recent || [])].sort((a, b) => b.at - a.at)
      .filter((r) => { const k = r.q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
    store.set("versions", { ...(remote.versions || {}), ...store.get("versions", {}) });
    ["playlists", "liked", "recent"].forEach((k) => store.set(k, state[k]));
    E.refresh && E.refresh();
  }

  // ---------------- Talking to GitHub ----------------
  async function latestSave(id) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/profiles/${id}?ref=main&t=${Date.now()}`, { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status === 403 ? "GitHub is limiting requests right now. Try again in a few minutes." : "Couldn't reach GitHub.");
    const files = (await r.json()).filter((f) => f.type === "file" && /\.txt$/.test(f.name)).sort((a, b) => (a.name < b.name ? 1 : -1));
    if (!files.length) return null;
    const text = await fetch(files[0].download_url, { cache: "no-store" }).then((x) => x.text());
    return { name: files[0].name, text };
  }

  async function doUnlock(code, quiet) {
    const id = await profileId(code);
    const save = await latestSave(id);
    if (!save) { if (!quiet) toast("No profile saved with that code yet. Tap Save to create one."); return false; }
    if (store.get("syncLast", null) === save.name && quiet) return true;
    let data;
    try { data = await unlock(save.text, code, id); } catch { if (!quiet) toast("That code didn't unlock the profile."); return false; }
    merge(data);
    store.set("syncLast", save.name);
    if (!quiet) toast("Profile unlocked: playlists and likes are on this device now");
    return true;
  }

  // tab: a window opened right when you tapped Save (phones block tabs opened later)
  const go = (tab, url) => { if (tab && !tab.closed) tab.location.href = url; else location.href = url; };
  async function doSave(code, tab) {
    const id = await profileId(code);
    const content = await lock(snapshot(), code, id);
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    const name = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.txt`;
    store.set("syncLast", name);
    if (content.length <= URL_LIMIT) {
      go(tab, `https://github.com/${owner}/${repo}/new/main?filename=${encodeURIComponent(`profiles/${id}/${name}`)}&value=${encodeURIComponent(content)}`);
      return "link";
    }
    // Too big for a link: download the file and open GitHub's upload page for that folder
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    a.download = name; a.click();
    go(tab, `https://github.com/${owner}/${repo}/upload/main/profiles/${id}`);
    return "upload";
  }

  // ---------------- The "Sync with a code" box in Your Library ----------------
  function render(box) {
    if (!owner || !repo) { box.innerHTML = `<p class="sub" style="margin:0">Code sync works when Encore runs from its GitHub Pages address.</p>`; return; }
    const code = store.get("syncCode", "");
    box.innerHTML = `
      <p class="sub" style="margin:0 0 12px">Pick a code and use it on every device. Your playlists, likes and recent searches are locked with it and saved in your GitHub repo.</p>
      <div class="sync-row">
        <input type="password" id="syncCode" placeholder="Your code" value="${esc(code)}" autocomplete="off" inputmode="text" />
        <button class="btn" id="syncUnlock">${icon("download")} Unlock</button>
        <button class="btn ghost" id="syncSave">${icon("upload")} Save to GitHub</button>
      </div>
      <p class="sync-note" id="syncNote">${code ? "This device is linked to your code. Saves from other devices load automatically when you open Encore." : "Longer codes are safer: anyone who guesses a short code like 9900 could see your playlists."}</p>`;
    const input = box.querySelector("#syncCode");
    const getCode = () => { const c = input.value.trim(); if (c.length < 4) { toast("Use a code with at least 4 characters"); return null; } store.set("syncCode", c); return c; };
    box.querySelector("#syncUnlock").onclick = async () => {
      const c = getCode(); if (!c) return;
      toast("Unlocking…");
      try { await doUnlock(c, false); } catch (e) { toast(e.message); }
      render(box);
    };
    box.querySelector("#syncSave").onclick = async () => {
      const c = getCode(); if (!c) return;
      const tab = window.open("about:blank", "_blank");
      try {
        const how = await doSave(c, tab);
        box.querySelector("#syncNote").textContent = how === "link"
          ? "GitHub opened in a new tab with your locked profile filled in. Tap Commit changes there to finish saving."
          : "Your library is too big for a link, so a file was downloaded. On the GitHub tab that opened, drag that file in and tap Commit changes.";
      } catch (e) { if (tab) tab.close(); toast("Couldn't prepare the save: " + e.message); }
    };
  }
  const fill = () => {
    const box = document.getElementById("syncBox");
    if (!box || box.dataset.ready) return;
    box.dataset.ready = "1"; render(box);
    if (location.hash === "#sync") { box.scrollIntoView({ block: "center" }); const i = box.querySelector("input"); if (i && !i.value) i.focus(); }
  };
  new MutationObserver(fill).observe(document.getElementById("main"), { childList: true });
  fill();

  // Linked device: quietly pick up saves made on other devices when Encore opens
  const saved = store.get("syncCode", "");
  if (saved && owner) setTimeout(() => doUnlock(saved, true).catch(() => {}), 2500);
})();
