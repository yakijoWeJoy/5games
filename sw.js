/*
 * Offline starter for the installed app. Always network first, so players never get an old version
 * while online; the copy kept here is used only when there is no internet (the game then explains
 * that it needs a connection). Bump CACHE with every release.
 */
const CACHE = 'dv-2.8';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // only our own files; fonts, relay servers and analytics go straight to the network
  if (url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { /* storage full: fine */ });
    }
    return res;
  }).catch(async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    // the app page itself, whatever its ?room=… or ?utm=… was
    if (req.mode === 'navigate') {
      const page = await caches.match(req, { ignoreSearch: true });
      if (page) return page;
    }
    return Response.error();
  }));
});
