const CACHE_NAME = 'meshchat-v1.2.2';
const APP_ASSETS = ['./', './index.html', './core.js', './node.js', './ui.js', './style.css'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
function isApp(url) { const p = new URL(url).pathname; return p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css') || p.endsWith('/'); }
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('ws://') || e.request.url.includes('wss://')) return;
  if (e.request.url.includes('fonts.googleapis.com') || e.request.url.includes('fonts.gstatic.com')) return;
  if (isApp(e.request.url)) {
    e.respondWith(Promise.race([
      fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, c)); } return r; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html'))));
  } else {
    e.respondWith(caches.match(e.request).then(c => { if (c) return c; return fetch(e.request).then(r => { if (r.ok) { const cl = r.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, cl)); } return r; }).catch(() => caches.match('./index.html')); }));
  }
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
