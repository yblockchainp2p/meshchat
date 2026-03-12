const CACHE_NAME = 'meshchat-v1.1.5';
const ASSETS = [
  './',
  './index.html',
  './core.js',
  './node.js',
  './ui.js',
  './style.css'
];

// Install: cache all core assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for assets, network-first for everything else
self.addEventListener('fetch', (e) => {
  // Skip non-GET and WebSocket
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('ws://') || e.request.url.includes('wss://')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) {
        // Return cache, but also update in background
        fetch(e.request).then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, response));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(e.request).then(response => {
        // Cache successful responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback
        return caches.match('./index.html');
      });
    })
  );
});
