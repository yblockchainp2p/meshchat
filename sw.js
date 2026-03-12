const CACHE_NAME = 'meshchat-v1.1.6';
const APP_ASSETS = [
  './',
  './index.html',
  './core.js',
  './node.js',
  './ui.js',
  './style.css'
];

// Install: cache core assets, activate immediately
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_ASSETS))
  );
  self.skipWaiting();
});

// Activate: nuke ALL old caches, take control of all clients
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Is this one of our app files? (html, js, css)
function isAppAsset(url) {
  const u = new URL(url);
  const path = u.pathname;
  return path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css') || path.endsWith('/');
}

// Fetch strategy:
//   App assets (html/js/css) → NETWORK-FIRST (3s timeout, then cache fallback)
//   Everything else → cache-first with background update
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('ws://') || e.request.url.includes('wss://')) return;
  if (e.request.url.includes('fonts.googleapis.com') || e.request.url.includes('fonts.gstatic.com')) return;

  if (isAppAsset(e.request.url)) {
    // NETWORK-FIRST for app files — always get fresh version
    e.respondWith(
      Promise.race([
        fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]).catch(() => {
        return caches.match(e.request).then(cached => {
          return cached || caches.match('./index.html');
        });
      })
    );
  } else {
    // Cache-first for other resources (images, etc.)
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        }).catch(() => caches.match('./index.html'));
      })
    );
  }
});

// Listen for skip-waiting message from app
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
