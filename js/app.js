import { Board } from "./ble.js";
import * as P from "./protocol.js";
import { render, encodeText } from "./imaging.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PAGE = 60;

// ---------------------------------------------------------------- Einstellungen
const settings = {
  get(k, d) { try { const v = localStorage.getItem("pb_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pb_" + k, JSON.stringify(v)); } catch { /* privat */ } },
};

// ---------------------------------------------------------------- Bibliothek (IndexedDB)
const db = {
  _p: null,
  open() {
    if (!this._p) {
      this._p = new Promise((res, rej) => {
        const r = indexedDB.open("pixelboard", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("library", { keyPath: "id" });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return this._p;
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction("library", mode);
      const out = fn(t.objectStore("library"));
      t.oncomplete = () => res(out && "result" in out ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx("readonly", (s) => s.getAll()); },
  put(item) { return this.tx("readwrite", (s) => s.put(item)); },
  del(id) { return this.tx("readwrite", (s) => s.delete(id)); },
};

// ---------------------------------------------------------------- Board
const board = new Board();
board.chunkSize = settings.get("chunk", 244);
board.idleMinutes = settings.get("idle", 3);
board.addEventListener("change", renderStatus);

let busy = 0;
function renderStatus() {
  const on = board.connected;
  $("#dot").className = "dot" + (busy > 0 ? " busy" : on ? " on" : "");
  $("#statusText").textContent = busy > 0 ? "sendet …" : on ? `${board.info?.width ?? 32}×${board.info?.height ?? 32}` : "Verbinden";
  const w = board.info?.width ?? 32, h = board.info?.height ?? 32;
  $("#matrix").style.setProperty("--cols", w);
  $("#matrix").style.setProperty("--rows", h);
  $("#connInfo").textContent = board.device
    ? `${board.device.name || "Board"} · ${on ? "verbunden" : "getrennt"}${board.info ? ` · ${w}×${h} (Typ ${board.info.ledType})` : ""}`
    : "Noch kein Board ausgewählt";
}

async function ensureDevice() {
  if (!board.device) await board.choose();
}

async function withBusy(fn, okMsg) {
  busy++; renderStatus();
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg, "ok");
    return r;
  } catch (e) {
    if (e && e.name === "NotFoundError") toast("Kein Board ausgewählt", "err");
    else toast(e?.message || String(e), "err");
    console.error(e);
  } finally {
    busy--; renderStatus();
  }
}

$("#statusBtn").onclick = () => {
  if (board.connected) { board.disconnect(); toast("Getrennt", "ok"); return; }
  withBusy(async () => { if (!board.device) await board.choose(); else await board.connect(); }, "Verbunden");
};
$("#connBtn").onclick = () => withBusy(async () => { if (!board.device) await board.choose(); else await board.connect(); }, "Verbunden");
$("#discBtn").onclick = () => { board.disconnect(); toast("Getrennt", "ok"); };
$("#pickBtn").onclick = () => withBusy(() => board.choose(), "Verbunden");
$("#pickAllBtn").onclick = () => withBusy(() => board.choose({ acceptAll: true }), "Verbunden");

// ---------------------------------------------------------------- Toast
let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2800);
}

// ---------------------------------------------------------------- Suche
const WORD = /[\p{L}\p{N}]+/gu;
function score(q, ...texts) {
  const hay = texts.join(" ").toLowerCase();
  const mainWords = new Set(hay.split(" · ")[0].match(WORD) || []);
  const allWords = new Set(hay.match(WORD) || []);
  let s = 0;
  for (const w of q.toLowerCase().match(WORD) || []) {
    if (mainWords.has(w)) s += 4;
    else if (allWords.has(w)) s += 3;
    else if ([...mainWords].some((x) => x.startsWith(w))) s += 2;
    else if ([...allWords].some((x) => x.startsWith(w))) s += 1;
    else return 0;
  }
  return s;
}
function search(q, entries, key) {
  if (!q) return entries;
  return entries
    .map((e, i) => [score(q, ...key(e)), i, e])
    .filter((t) => t[0] > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map((t) => t[2]);
}

// ---------------------------------------------------------------- Quellen & Galerie
const state = { sources: [], source: null, q: "", list: [], shown: 0, item: null, fit: settings.get("fit", "crop") };
const libUrls = new Map();

async function libraryItems() {
  const items = (await db.all()).sort((a, b) => b.added - a.added);
  return items.map((it) => {
    if (!libUrls.has(it.id)) libUrls.set(it.id, URL.createObjectURL(it.blob));
    return { id: it.id, name: it.name, thumb: libUrls.get(it.id), anim: it.blob.type === "image/gif", pixelart: true, blob: it.blob };
  });
}

async function loadSources() {
  const idx = await fetch("sources_index.json").then((r) => r.json());
  const lib = await libraryItems();
  state.sources = [
    { id: "library", name: "Meine Bibliothek", license: "eigene Dateien (nur auf diesem Gerät)", license_url: "", count: lib.length },
    ...idx.sources.map((s) => ({ ...s, count: s.items.length })),
  ];
  const chips = $("#chips");
  chips.innerHTML = "";
  for (const s of state.sources) {
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.id = s.id;
    b.innerHTML = `${esc(s.name)}<b>${s.count}</b>`;
    b.onclick = () => selectSource(s.id);
    chips.appendChild(b);
  }
  const saved = settings.get("source", null);
  const first = state.sources.find((s) => s.id !== "library" || s.count > 0);
  selectSource(state.sources.some((s) => s.id === saved) ? saved : first.id);
}

function updateLibCount(n) {
  const lib = state.sources.find((s) => s.id === "library");
  lib.count = n;
  const b = document.querySelector('.chip[data-id="library"] b');
  if (b) b.textContent = n;
}

async function selectSource(id) {
  state.source = state.sources.find((s) => s.id === id);
  settings.set("source", id);
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.id === id));
  document.querySelector(`.chip[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  $("#license").textContent = state.source.license || "";
  $("#license").href = state.source.license_url || "#";
  await refreshList();
}

async function refreshList() {
  const s = state.source;
  let entries;
  if (s.id === "library") {
    const lib = await libraryItems();
    updateLibCount(lib.length);
    entries = search(state.q, lib, (it) => [it.name]);
  } else {
    entries = search(state.q, s.items, (it) => [it[1], it[0]]).map(([rel, name]) => ({
      id: rel, name, thumb: s.base + rel, anim: rel.toLowerCase().endsWith(".gif"), pixelart: !!s.pixelart,
    }));
  }
  state.list = entries;
  state.shown = 0;
  $("#grid").innerHTML = "";
  $("#count").textContent = entries.length ? `${entries.length.toLocaleString("de-DE")} Einträge` : "";
  $("#empty").hidden = entries.length > 0;
  $("#empty").textContent = s.id === "library"
    ? "Noch nichts gespeichert. Tippe auf ＋, um Bilder vom Handy hinzuzufügen, oder merke dir Bilder aus anderen Quellen."
    : "Nichts gefunden.";
  showMore();
}

function showMore() {
  const next = state.list.slice(state.shown, state.shown + PAGE);
  const frag = document.createDocumentFragment();
  for (const it of next) {
    const b = document.createElement("button");
    b.className = "tile" + (it.pixelart ? " px" : "");
    b.innerHTML = `<img loading="lazy" decoding="async" alt="${esc(it.name)}" src="${esc(it.thumb)}">${it.anim ? '<span class="badge">GIF</span>' : ""}`;
    b.onclick = () => openSheet(it);
    frag.appendChild(b);
  }
  $("#grid").appendChild(frag);
  state.shown += next.length;
}
new IntersectionObserver((e) => { if (e[0].isIntersecting && state.shown < state.list.length) showMore(); }, { rootMargin: "600px" })
  .observe($("#sentinel"));

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); refreshList(); }, 250);
});

// ---------------------------------------------------------------- Hinzufügen
$("#uploadBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  let n = 0;
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    await db.put({ id: crypto.randomUUID(), name: f.name.replace(/\.[^.]+$/, ""), blob: f, added: Date.now() });
    n++;
  }
  if (n) { toast(`${n} Datei(en) hinzugefügt`, "ok"); selectSource("library"); }
};

// ---------------------------------------------------------------- Detail & Senden
const blobCache = new Map();
async function getBlob(it) {
  if (it.blob) return it.blob;
  if (blobCache.has(it.thumb)) return blobCache.get(it.thumb);
  const res = await fetch(it.thumb);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  let blob = await res.blob();
  const ext = it.thumb.split("?")[0].split(".").pop().toLowerCase();
  const mime = { gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext];
  if (mime && blob.type !== mime) blob = new Blob([blob], { type: mime });
  if (blobCache.size > 40) blobCache.delete(blobCache.keys().next().value);
  blobCache.set(it.thumb, blob);
  return blob;
}

let rendered = null;
let renderToken = 0;
async function renderPreview() {
  const it = state.item;
  const token = ++renderToken;
  const img = $("#pv");
  $("#pvSpin").hidden = false;
  $("#pvSpin").textContent = "lädt …";
  img.style.opacity = 0;
  rendered = null;
  try {
    const blob = await getBlob(it);
    const r = await render(blob, {
      width: board.info?.width ?? 32, height: board.info?.height ?? 32,
      mode: state.fit, pixelart: it.pixelart, maxFrames: settings.get("maxFrames", 64),
    });
    if (token !== renderToken) return;
    rendered = r;
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }));
    img.src = img.dataset.url;
    img.onload = () => { $("#pvSpin").hidden = true; img.style.opacity = 1; };
    $("#pvSrc").textContent = `${state.source.name} · ${r.isGif ? r.frames + " Frames" : "Standbild"} · ${(r.bytes.length / 1024).toFixed(1)} KB`;
  } catch (e) {
    if (token === renderToken) $("#pvSpin").textContent = "Fehler";
    toast(e.message || String(e), "err");
  }
}

function openSheet(it) {
  state.item = it;
  $("#pvName").textContent = it.name.split(" · ")[0];
  $("#pvSrc").textContent = state.source.name;
  const isLib = state.source.id === "library";
  $("#saveBtn").textContent = isLib ? "🗑 Löschen" : "☆ Merken";
  $("#saveBtn").classList.toggle("danger", isLib);
  setFit(state.fit, false);
  $("#scrim").classList.add("show");
  $("#sheet").classList.add("show");
  renderPreview();
}
function closeSheet() { $("#scrim").classList.remove("show"); $("#sheet").classList.remove("show"); }
$("#scrim").onclick = closeSheet;
let touchY = null;
$("#sheet").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
$("#sheet").addEventListener("touchend", (e) => { if (touchY != null && e.changedTouches[0].clientY - touchY > 60) closeSheet(); touchY = null; });

function setFit(fit, rerender = true) {
  state.fit = fit;
  settings.set("fit", fit);
  document.querySelectorAll("#fitSeg button").forEach((b) => b.classList.toggle("active", b.dataset.fit === fit));
  if (rerender && state.item) renderPreview();
}
document.querySelectorAll("#fitSeg button").forEach((b) => (b.onclick = () => setFit(b.dataset.fit)));

function setProgress(f) {
  const p = $("#progress");
  p.classList.toggle("show", f !== null);
  p.firstElementChild.style.width = `${Math.round((f || 0) * 100)}%`;
}

$("#sendBtn").onclick = async () => {
  $("#sendBtn").disabled = true;
  await withBusy(async () => {
    await ensureDevice();
    if (!rendered) await renderPreview();
    if (!rendered) throw new Error("Bild konnte nicht vorbereitet werden");
    const t0 = performance.now();
    setProgress(0);
    await board.send(P.imagePlan(rendered.bytes, rendered.isGif), setProgress);
    return ((performance.now() - t0) / 1000).toFixed(1);
  }, (s) => `Gesendet (${s} s)`);
  setProgress(null);
  $("#sendBtn").disabled = false;
};

$("#saveBtn").onclick = async () => {
  const it = state.item;
  if (state.source.id === "library") {
    if (!confirm("Aus der Bibliothek löschen?")) return;
    await db.del(it.id);
    if (libUrls.has(it.id)) { URL.revokeObjectURL(libUrls.get(it.id)); libUrls.delete(it.id); }
    toast("Gelöscht", "ok");
    closeSheet();
    refreshList();
    return;
  }
  try {
    const blob = await getBlob(it);
    await db.put({ id: crypto.randomUUID(), name: it.name.split(" · ")[0], blob, added: Date.now() });
    updateLibCount(state.sources.find((s) => s.id === "library").count + 1);
    toast("In „Meine Bibliothek“ gespeichert", "ok");
  } catch (e) { toast(e.message, "err"); }
};

// ---------------------------------------------------------------- Tabs
document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("active", x === b));
  const t = b.dataset.tab;
  $("#galleryPanel").style.display = t === "gallery" ? "" : "none";
  $("#galleryHeader").style.display = t === "gallery" ? "" : "none";
  $("#textPanel").classList.toggle("show", t === "text");
  $("#ctrlPanel").classList.toggle("show", t === "ctrl");
  window.scrollTo(0, 0);
}));

// ---------------------------------------------------------------- Text
$("#txtSpeed").oninput = (e) => ($("#txtSpeedVal").textContent = e.target.value);
let textTimer;
function scheduleTextPreview() { clearTimeout(textTimer); textTimer = setTimeout(drawTextPreview, 250); }
["#txt", "#txtColor", "#txtFont"].forEach((s) => $(s).addEventListener("input", scheduleTextPreview));

async function drawTextPreview() {
  const text = $("#txt").value;
  const c = $("#txtPreview");
  const h = board.info?.height ?? 32;
  if (!text) { c.width = 1; return; }
  const enc = await encodeText(text, { height: h, color: P.hexToRgb($("#txtColor").value), font: $("#txtFont").value });
  const width = enc.preview.reduce((n, p) => n + (p.bits ? p.slot : h), 0) || 1;
  c.width = width; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, h);
  ctx.fillStyle = $("#txtColor").value;
  let x = 0;
  for (const p of enc.preview) {
    if (p.bits) {
      for (let i = 0; i < p.bits.length; i++) if (p.bits[i]) ctx.fillRect(x + (i % p.slot), Math.floor(i / p.slot), 1, 1);
      x += p.slot;
    } else if (p.image) {
      ctx.putImageData(p.image, x, 0);
      x += h;
    }
  }
}

$("#txtSend").onclick = () => {
  const text = $("#txt").value.trim();
  if (!text) return toast("Bitte Text eingeben", "err");
  withBusy(async () => {
    await ensureDevice();
    const anim = +$("#txtAnim").value;
    const color = P.hexToRgb($("#txtColor").value);
    const h = board.info?.height ?? 32;
    const enc = await encodeText(text, { height: h, color, font: $("#txtFont").value, reverse: anim === 2 });
    if (!enc.count) throw new Error("Nichts zu senden");
    const props = P.textProperties(anim, +$("#txtSpeed").value, +$("#txtRainbow").value, color);
    await board.send(P.textPlan(enc.blocks, enc.count, props));
  }, "Text gesendet");
};

// ---------------------------------------------------------------- Steuerung
const bright = $("#bright");
bright.value = settings.get("bright", 60);
$("#brightVal").textContent = bright.value + "%";
bright.oninput = () => ($("#brightVal").textContent = bright.value + "%");
bright.onchange = () => {
  settings.set("bright", +bright.value);
  withBusy(async () => { await ensureDevice(); await board.send(P.brightnessCommand(+bright.value)); }, `Helligkeit ${bright.value}%`);
};
document.querySelectorAll("[data-power]").forEach((b) => (b.onclick = () => withBusy(async () => {
  await ensureDevice();
  await board.send(P.powerCommand(b.dataset.power === "1"));
}, b.dataset.power === "1" ? "Eingeschaltet" : "Ausgeschaltet")));
for (let i = 1; i <= 6; i++) {
  const b = document.createElement("button");
  b.className = "btn"; b.textContent = `Stil ${i}`;
  b.onclick = () => withBusy(async () => {
    await ensureDevice();
    await board.send(P.clockCommand({ style: i, showDate: $("#clockDate").checked, format24: true }));
  }, `Uhr Stil ${i}`);
  $("#clockBtns").appendChild(b);
}
$("#chunkSize").value = String(board.chunkSize);
$("#chunkSize").onchange = (e) => { board.chunkSize = +e.target.value; settings.set("chunk", board.chunkSize); };
$("#idleMin").value = String(board.idleMinutes);
$("#idleMin").onchange = (e) => { board.idleMinutes = +e.target.value; settings.set("idle", board.idleMinutes); };
$("#maxFrames").value = String(settings.get("maxFrames", 64));
$("#maxFrames").onchange = (e) => settings.set("maxFrames", +e.target.value);

// ---------------------------------------------------------------- Start
if (!Board.supported || !window.isSecureContext) $("#btBanner").hidden = false;
board.restore().catch(() => {}).finally(renderStatus);
loadSources().catch((e) => toast("Quellen: " + e.message, "err"));
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
