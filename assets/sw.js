// MarketMind AI — service worker: makes the app installable and opens it offline.
// App files: network first (so updates show up at once), cached copy when offline.
// api/*: never cached — market data, sign-in and MindGuru always come live from the server.
// Fonts and the PDF library from CDNs: cached after first use.

const VERSION = 'mm-v3';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './js/marketdata.js', './js/ks001.js', './js/conditions.js', './js/library.js', './js/consensus.js',
  './js/account.js', './js/stockpicker.js', './js/mindguru.js', './js/knowledgesync.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.includes('/api/')) return; // always live
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) { const copy = resp.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return resp;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))),
    );
    return;
  }

  if (/fonts\.(googleapis|gstatic)\.com$|cdnjs\.cloudflare\.com$/.test(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
        if (resp.ok || resp.type === 'opaque') { const copy = resp.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return resp;
      })),
    );
  }
});
