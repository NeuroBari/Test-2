// Service worker dell'app installabile (PWA).
// Strategia "prima la rete": con connessione si usa sempre la versione più recente
// del sito (gli aggiornamenti arrivano subito); senza connessione si apre l'ultima
// versione salvata. I dati (Firebase) e le librerie esterne non passano da qui.

const CACHE = "ferie-neuro-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/app.js",
  "./js/config.js",
  "./js/dates.js",
  "./js/export.js",
  "./js/pwa.js",
  "./js/rotations.js",
  "./js/store.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/favicon-64.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())),
  );
});
