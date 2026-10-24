// alate service worker: an offline app shell for the dashboard.
// Network-first: an online answer is always fresh; the cache answers only when the
// network fails. The provisioning and dashboard APIs stay network-only: they are
// dynamic and, off loopback, key-guarded.
// ponytail: the precache list mirrors server.ts's static table by hand; bump CACHE
// when a shell file's server-side route set changes.
'use strict';
const CACHE = 'alate-shell-v1';
const SHELL = ['/', '/style.css', '/app.js', '/theme.js', '/diff.mjs', '/logo.png',
  '/manifest.webmanifest', '/fonts/source-serif-4.woff2', '/fonts/jetbrains-mono.woff2',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request).then((hit) =>
    hit || (e.request.mode === 'navigate' ? caches.match('/') : undefined))));
});
