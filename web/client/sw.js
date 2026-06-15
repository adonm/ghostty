/// <reference lib="webworker" />

// Ghostty PWA Service Worker
// Caches the app shell for offline support. For the WebSocket-based
// terminal, offline mode just shows the cached UI.

const CACHE = "ghostty-pwa-v1";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/app.js",
  "/terminal.js",
  "/renderer.js",
  "/transport.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      )
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Don't cache WebSocket connections or WASM (large, loaded once)
  if (url.pathname === "/ws") return;
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request)),
  );
});
