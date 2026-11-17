// Encore — sync your playlists across devices with a code you choose.
// Saves live in a separate repo, <owner>/encore-data, as locked (encrypted) files:
//   profiles/<id>.txt  your playlists, likes, recent searches and version picks
//   keys/<id>.txt      the access key that lets Encore write to encore-data, locked with your code
// The code never leaves your device. <id> is a one-way fingerprint of the code.
// Set up once: paste the access key with your code. After that, on any device, the code alone unlocks
// everything and Encore saves by itself in the background.
(() => {
  "use strict";
  const E = window.Encore;
  if (!E) return;
  const { state, store, toast, esc } = E;
  const icon = window.icon;

  const owner = location.hostname.endsWith(".github.io") ? location.hostname.split(".")[0] : null;
  const siteRepo = location.pathname.split("/").filter(Boolean)[0] || (owner ? owner + ".github.io" : null);
  const DATA = "encore-data";
  const API = `https://api.github.com/repos/${owner}/${DATA}/contents`;
  const MIN_CODE = 8;
  const TOKEN_URL = `https://github.com/settings/personal-access-tokens/new?name=Encore+saves&description=Lets+Encore+save+playlists+to+encore-data&target_name=${owner}&expires_in=366&contents=write`;

  // ---------------- Crypto ----------------
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const profileId = async (code) => hex(await crypto.subtle.digest("SHA-256", enc.encode("encore-id|" + code))).slice(0, 24);
  async function keyFor(code, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: enc.encode("encore-sync|" + salt), iterations: 150000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const pipe = async (u8, stream) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
  async function lock(obj, code, salt) {
    const zipped = await pipe(enc.encode(JSON.stringify(obj)), new CompressionStream("gzip"));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(code, salt), zipped));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return "ENCORE1:" + b64(all);
  }
  async function unlock(text, code, salt) {
    const all = unb64(text.trim().replace(/^ENCORE1:/, ""));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await keyFor(code, salt), all.slice(12));
    return JSON.parse(dec.decode(await pipe(new Uint8Array(plain), new DecompressionStream("gzip"))));
  }

  // ---------------- What gets synced ----------------
  const body = () => ({ playlists: state.playlists, liked: state.liked, recent: state.recent || [], versions: store.get("versions", {}) });
  const fingerprint = () => JSON.stringify(body());

  function persist() { ["playlists", "liked", "recent"].forEach((k) => store.set(k, state[k])); E.refresh && E.refresh(); }
  function replaceWith(remote) {
    state.playlists.splice(0, state.playlists.length, ...(remote.playlists || []));
    state.liked.splice(0, state.liked.length, ...(remote.liked || []));
    state.recent = remote.recent || [];
    store.set("versions", remote.versions || {});
    persist();
  }
  function mergeIn(remote) {
    for (const rp of remote.playlists || []) {
      const lp = state.playlists.find((p) => p.id === rp.id);
      if (!lp) state.playlists.push(rp);
      else for (const t of rp.tracks || []) if (!lp.tracks.some((x) => x.id === t.id)) lp.tracks.push(t);
    }
    for (const t of remote.liked || []) if (!state.liked.some((x) => x.id === t.id)) state.liked.push(t);
    const seen = new Set();
    state.recent = [...(remote.recent || []), ...(state.recent || [])].sort((a, b) => b.at - a.at)
      .filter((r) => { const k = r.q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
    store.set("versions", { ...(remote.versions || {}), ...store.get("versions", {}) });
    persist();
  }

  // ---------------- GitHub ----------------
  const headers = (key) => ({ Accept: "application/vnd.github+json", ...(key ? { Authorization: "Bearer " + key } : {}) });
  async function getFile(path, key) {
    const r = await fetch(`${API}/${path}?ref=main&t=${Date.now()}`, { headers: headers(key), cache: "no-store" });
    if (r.status === 404) return null;
    if (r.status === 401) throw new Error("The access key was refused. It may have expired; paste a new one.");
    if (!r.ok) throw new Error(r.status === 403 ? "GitHub is limiting requests right now. Try again in a few minutes." : "Couldn't reach GitHub.");
    const j = await r.json();
    return { sha: j.sha, text: dec.decode(Uint8Array.from(atob(j.content.replace(/\s/g, "")), (c) => c.charCodeAt(0))) };
  }
  async function putFile(path, text, key, sha, message) {
    const r = await fetch(`${API}/${path}`, {
      method: "PUT", headers: { ...headers(key), "Content-Type": "application/json" }, keepalive: text.length < 60000,
      body: JSON.stringify({ message, content: btoa(text), branch: "main", ...(sha ? { sha } : {}) }),
    });
    if (r.status === 401) throw new Error("The access key was refused. It may have expired; paste a new one.");
    if (r.status === 403 || r.status === 404) throw new Error(`That key can't write to ${DATA}. Make sure it has access to ${DATA} with Contents set to Read and write.`);
    if (r.status === 409 || r.status === 422) return { conflict: true };
    if (!r.ok) throw new Error("GitHub didn't accept the save (" + r.status + ").");
    return { sha: (await r.json()).content.sha };
  }

  // Saves made before encore-data existed (link-based saves in the site repo)
  async function oldSave(id) {
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${siteRepo}/contents/profiles/${id}?ref=main`, { cache: "no-store" });
      if (!r.ok) return null;
      const files = (await r.json()).filter((f) => /\.txt$/.test(f.name)).sort((a, b) => (a.name < b.name ? 1 : -1));
      return files.length ? await fetch(files[0].download_url, { cache: "no-store" }).then((x) => x.text()) : null;
    } catch { return null; }
  }

  // ---------------- Sync engine ----------------
  const S = {
    get code() { return store.get("syncCode", ""); },
    get key() { return store.get("syncKey", ""); },
    get at() { return store.get("syncAt", 0); },          // time of the save this device last matched
    get synced() { return store.get("syncPrint", ""); },  // what the library looked like then
  };
  let busy = false, again = false, status = "", timer = 0;
  const setStatus = (s) => { status = s; const el = document.getElementById("syncStatus"); if (el) el.textContent = s; };
  const timeStr = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dirty = () => fingerprint() !== S.synced;
  const markSynced = (at) => { store.set("syncAt", at); store.set("syncPrint", fingerprint()); };

  // Bring this device up to date, then save if there's anything new here.
  async function sync({ quiet = true, forceSave = false } = {}) {
    const code = S.code; if (!code || !owner) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const id = await profileId(code), key = S.key;
      const file = await getFile(`profiles/${id}.txt`, key);
      let sha = file && file.sha;
      if (file) {
        const remote = await unlock(file.text, code, id);
        if (remote.at > S.at) {
          if (dirty() && S.synced) mergeIn(remote);   // changed here and elsewhere: keep both
          else if (!S.synced) mergeIn(remote);        // first time on this device: keep what's here too
          else replaceWith(remote);                   // only changed elsewhere: take it as is
          if (!dirty() || !key) { markSynced(remote.at); if (!quiet) toast("Up to date with your other devices"); }
          else store.set("syncAt", remote.at);
        }
      }
      if (key && (dirty() || forceSave || !file)) {
        setStatus("Saving…");
        const at = Date.now();
        const text = await lock({ v: 2, at, ...body() }, code, id);
        let res = await putFile(`profiles/${id}.txt`, text, key, sha, "Save profile");
        if (res.conflict) { again = true; throw new Error("retry"); }
        markSynced(at);
        setStatus("Saved " + timeStr(at));
        if (!quiet) toast("Saved");
      } else if (key) setStatus(S.at ? "Saved " + timeStr(S.at) : "Saving automatically");
    } catch (e) {
      if (e.message !== "retry") { setStatus("Not saved: " + e.message); if (!quiet) toast(e.message); }
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(() => sync(), 800); }
    }
  }

  // Link this device to a code (and, when given, set up saving with an access key)
  async function link(code, pasteKey) {
    const id = await profileId(code);
    if (pasteKey) {
      if (code.length < MIN_CODE) throw new Error(`Use a code with at least ${MIN_CODE} characters so the key stays safe.`);
      const existing = await getFile(`keys/${id}.txt`, pasteKey);
      const res = await putFile(`keys/${id}.txt`, await lock({ k: pasteKey }, code, id + "|key"), pasteKey, existing && existing.sha, "Save locked key");
      if (res.conflict) throw new Error("Couldn't store the key. Try again.");
      store.set("syncKey", pasteKey);
    } else {
      const kf = await getFile(`keys/${id}.txt`);
      if (kf) {
        try { store.set("syncKey", (await unlock(kf.text, code, id + "|key")).k); }
        catch { throw new Error("That code didn't unlock your profile."); }
      } else {
        const pf = await getFile(`profiles/${id}.txt`);
        if (!pf) {
          const old = await oldSave(id);
          if (!old) throw new Error("No profile with that code yet. Add your access key below to create one.");
          try { mergeIn(await unlock(old, code, id)); } catch { throw new Error("That code didn't unlock your profile."); }
        }
      }
    }
    // Pick up an older link-based save once, so nothing is lost when moving to encore-data
    if (!store.get("syncCode", "")) { const old = await oldSave(id); if (old) try { mergeIn(await unlock(old, code, id)); } catch {} }
    store.set("syncCode", code);
    store.set("syncAt", 0); store.set("syncPrint", "");
    await sync({ quiet: true, forceSave: !!S.key });
  }

  function unlink() { ["syncCode", "syncKey", "syncAt", "syncPrint"].forEach((k) => store.set(k, k === "syncAt" ? 0 : "")); setStatus(""); }

  // Save by itself a few seconds after anything changes
  setInterval(() => {
    if (!S.code || !S.key || busy) return;
    if (dirty() && !timer) { setStatus("Saving soon…"); timer = setTimeout(() => { timer = 0; sync(); }, 3000); }
  }, 2000);
  document.addEventListener("visibilitychange", () => {
    if (!S.code) return;
    if (document.visibilityState === "hidden" && S.key && dirty()) sync();
    if (document.visibilityState === "visible") sync();
  });

  // ---------------- The "Sync with a code" box in Your Library ----------------
  function render(box) {
    if (!owner) { box.innerHTML = `<p class="sub" style="margin:0">Code sync works when Encore runs from its GitHub Pages address.</p>`; return; }
    const code = S.code, key = S.key;
    const keyField = (label) => `
      <div class="sync-row">
        <input type="password" id="syncKey" placeholder="${label}" autocomplete="off" autocapitalize="off" spellcheck="false" />
      </div>
      <p class="sync-note">Only needed once. <a href="${TOKEN_URL}" target="_blank" rel="noopener">Make a key on GitHub</a>: under Repository access pick Only select repositories, choose ${DATA}, then Generate token and copy it here. Encore locks it with your code so your other devices get it automatically.</p>`;

    if (!code) {
      box.innerHTML = `
        <p class="sub" style="margin:0 0 12px">Use one code on every device. Your playlists, likes and recent searches are locked with it and saved for you.</p>
        <div class="sync-row">
          <input type="password" id="syncCode" placeholder="Your code (8+ characters)" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <button class="btn" id="syncLink">${icon("download")} Link</button>
        </div>
        <p class="sync-note">Already set up on another device? Just type your code and tap Link.</p>
        <details class="sync-more"><summary>First time? Add an access key</summary>${keyField("Paste access key")}</details>`;
      const go = async () => {
        const c = box.querySelector("#syncCode").value.trim(), k = (box.querySelector("#syncKey").value || "").trim();
        if (c.length < 4) return toast("Type your code first");
        const btn = box.querySelector("#syncLink"); btn.disabled = true; toast("Linking…");
        try { await link(c, k); toast(S.key ? "Linked. Encore now saves by itself." : "Linked. Your playlists are on this device."); render(box); }
        catch (e) { toast(e.message); btn.disabled = false; }
      };
      box.querySelector("#syncLink").onclick = go;
      box.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); }));
      return;
    }

    if (key) {
      box.innerHTML = `
        <p class="sub" style="margin:0 0 12px">Linked to your code. Changes save by themselves and show up on your other devices when you open Encore there.</p>
        <div class="sync-row">
          <span class="sync-status" id="syncStatus">${esc(status || (S.at ? "Saved " + timeStr(S.at) : "Saving automatically"))}</span>
          <button class="btn" id="syncNow">${icon("upload")} Save now</button>
          <button class="btn ghost" id="syncOff">Unlink</button>
        </div>`;
      box.querySelector("#syncNow").onclick = () => sync({ quiet: false, forceSave: true });
    } else {
      box.innerHTML = `
        <p class="sub" style="margin:0 0 12px">Linked to your code. Saves from your other devices load here, but this device can't save yet.</p>
        ${keyField("Paste access key to turn on saving")}
        <div class="sync-row">
          <button class="btn" id="syncKeyOn">${icon("upload")} Turn on saving</button>
          <button class="btn ghost" id="syncOff">Unlink</button>
        </div>`;
      box.querySelector("#syncKeyOn").onclick = async () => {
        const k = box.querySelector("#syncKey").value.trim(); if (!k) return toast("Paste the access key first");
        try { await link(S.code, k); toast("Saving is on"); render(box); } catch (e) { toast(e.message); }
      };
    }
    box.querySelector("#syncOff").onclick = () => { unlink(); toast("This device is unlinked. Your playlists stay here."); render(box); };
  }

  const fill = () => {
    const box = document.getElementById("syncBox");
    if (!box || box.dataset.ready) return;
    box.dataset.ready = "1"; render(box);
    if (location.hash === "#sync") { box.scrollIntoView({ block: "center" }); const i = box.querySelector("input"); if (i && !i.value) i.focus(); }
  };
  new MutationObserver(fill).observe(document.getElementById("main"), { childList: true });
  fill();

  // Linked device: catch up with other devices when Encore opens
  if (S.code && owner) setTimeout(() => sync(), 2000);
})();
