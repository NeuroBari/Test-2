// L'app installabile è stata rimossa. Questo file resta solo per disattivare il
// service worker nei browser che lo avevano già registrato: cancella la cache,
// si deregistra e ricarica le pagine aperte.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
  })());
});
