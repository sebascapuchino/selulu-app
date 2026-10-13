/* Mesa · Encargos — service worker (v1.3)
 * Precaches the app shell and serves it cache-first, refreshing the cache in the background.
 * Cross-origin requests (Firebase, gstatic) and non-GET requests are never intercepted.
 * Bump VERSION on every release so old caches are removed.
 */
const VERSION = 'mesa-v1.3';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mesa-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const refresh = caches.open(VERSION)
    .then((cache) => fetch(req).then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
      return res;
    }))
    .catch(() => null);
  event.waitUntil(refresh);

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return refresh.then((res) => {
        if (res) return res;
        if (req.mode === 'navigate') return caches.match('./index.html').then((r) => r || Response.error());
        return Response.error();
      });
    })
  );
});
