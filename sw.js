// Lightweight Service Worker for NWM Market Analyzer PWA (compatible with Netlify & GitHub Pages)
const SHELL_CACHE = "nwm-shell-v5";
const DATA_CACHE = "nwm-data-v1";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./manifest.json?v=2",
  "./icons/icon.svg?v=2",
  "./icons/icon-192.png?v=2",
  "./icons/icon-512.png?v=2",
  "./icons/apple-touch-icon.png?v=2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache local backend API endpoints
  if (url.pathname.includes("/api/")) return;

  // Network-first for all data/ requests (JSON & CSV) so fresh daily updates always win,
  // while falling back to the last cached copy when offline.
  if (url.pathname.includes("/data/")) {
    const cacheKey = url.pathname;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(cacheKey, copy));
          }
          return response;
        })
        .catch(() => caches.match(cacheKey))
    );
    return;
  }

  // Network-first with cache fallback for app shell & navigation requests
  const isShellAsset = SHELL_ASSETS.some((asset) => {
    const suffix = asset.replace(/^\./, "").split("?")[0];
    return suffix && url.pathname.endsWith(suffix);
  });

  if (request.mode === "navigate" || isShellAsset) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  // Cache-first for static icons & other local assets
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
