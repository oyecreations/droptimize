/* Droptimize service worker
   - Precaches the app shell so the site opens instantly and works offline.
   - HTML: network-first (always try fresh, fall back to cache, then offline shell).
   - Static (fonts, js, css, images, icons): cache-first, revalidated in the background.
   - /api/* and non-GET: never cached (audits and checkout must always be live).
   Bump CACHE_VERSION on any change to this file or the precache list. */

const CACHE_VERSION = "droptimize-v1";
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/assets/nav.js",
  "/assets/optimize.js?v=14",
  "/assets/checkout.js",
  "/assets/locale.js",
  "/assets/fonts/dm-sans.woff2",
  "/assets/fonts/dm-mono-400.woff2",
  "/assets/fonts/dm-mono-500.woff2",
  "/assets/fonts/playfair.woff2",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/favicon-32.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll fails the whole install if any URL 404s; add individually so
      // a single missing asset never blocks the install.
      Promise.all(
        PRECACHE.map((url) =>
          cache.add(url).catch(() => {
            /* tolerate a missing precache entry */
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle same-origin GETs. Cross-origin (chat widget, CF insights,
  // PageSpeed, Stripe) and non-GET (audit POSTs, checkout) pass straight through.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the API. Always live.
  if (url.pathname.startsWith("/api/")) return;

  // HTML navigations: network-first, fall back to cache, then the cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(request, { ignoreSearch: true })
            .then((hit) => hit || caches.match("/", { ignoreSearch: true }))
        )
    );
    return;
  }

  // Static assets: cache-first, revalidate in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
