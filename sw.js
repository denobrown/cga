// ═══════════════════════════════════════════════════════════════
// CloudGrid Africa — service worker
// ═══════════════════════════════════════════════════════════════
//
// Kept deliberately minimal. Two jobs:
//   1. Satisfy PWA installability (Chrome requires a registered SW
//      with a fetch handler — a manifest alone isn't enough).
//   2. Genuinely useful offline fallback for the app shell (so a
//      flaky connection doesn't show a browser error page).
//
// Deliberately does NOT touch:
//   - Any non-GET request (POST form submissions must always hit the
//     network directly — intercepting them from a service worker is
//     a classic way to silently break Netlify Forms submissions)
//   - /.netlify/functions/* (feed proxy, contact-info) — always live,
//     never cached, since caching a "hidden phone number" response or
//     stale RSS data would be actively wrong
//   - Cross-origin requests (Google Fonts, GA4, GTM) — left to the
//     browser's normal HTTP cache, no service-worker involvement
//
// Bump CACHE_VERSION whenever the app-shell file list changes, so
// old caches get cleaned up on the next activate.

const CACHE_VERSION = 'cga-shell-v1';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/assets/site.css',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever handle same-origin GET requests. Everything else
  // (POST form submits, Netlify functions, third-party origins)
  // passes straight through untouched.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.netlify/functions/')) return;

  // Network-first for the homepage navigation, falling back to the
  // cached shell if offline — keeps content fresh when online, still
  // shows something useful when not.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/'))
    );
    return;
  }

  // Cache-first for the static shell assets themselves.
  if (APP_SHELL.some((path) => url.pathname === path)) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
  }
});
