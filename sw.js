// Service worker dell'app installabile (PWA).
// Strategia "prima la rete": con connessione si usa sempre la versione più recente
// del sito (gli aggiornamenti arrivano subito); senza connessione si apre l'ultima
// versione salvata. I dati (Firebase) e le librerie esterne non passano da qui.

const CACHE = "ferie-neuro-v3";
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
  "./js/push.js",
  "./js/rotations.js",
  "./js/store.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./img/logo.svg",
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

// Notifiche push inviate dal programma su GitHub Actions (notifier/notify.mjs)
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Ferie & Congressi", {
    body: data.body || "Ci sono novità.",
    icon: "icons/icon-192.png",
    badge: "icons/favicon-64.png",
    tag: data.tag || "ferie-neuro",
    data: { url: data.url || "./" },
  }));
});

// Tocco sulla notifica: porta in primo piano il sito (o l'app) se è già aperto, altrimenti lo apre
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      return open.navigate(url).catch(() => {});
    }
    return self.clients.openWindow(url);
  })());
});
