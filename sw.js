// Einfacher Offline-Cache für die App-Hülle. Bilder aus den Quellen werden zusätzlich
// beim Ansehen zwischengespeichert, damit Favoriten auch ohne Netz laden.
const VERSION = "pixelboard-v3";
const SHELL = [
  "./", "index.html", "style.css", "manifest.json", "icon.svg", "sources_index.json",
  "icon-192.png", "icon-512.png",
  "js/app.js", "js/ble.js", "js/protocol.js", "js/imaging.js", "js/vendor/gifenc.esm.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== "pixelboard-img").map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin) {
    // App-Hülle: erst Netz (für Updates), bei Offline aus dem Cache
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
  } else if (url.hostname === "raw.githubusercontent.com") {
    // Bilder: erst Cache, dann Netz
    e.respondWith(
      caches.open("pixelboard-img").then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
  }
});
