// Service Worker for Pluto Rewards Leaderboard
// Enables offline functionality and caching

const CACHE_NAME = "pluto-leaderboard-v1";
const URLS_TO_CACHE = [
  "/leaderboard.html",
  "/",
];

// Install event - cache resources
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(URLS_TO_CACHE).catch(() => {
        // Gracefully handle if some URLs aren't available
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener("fetch", (event) => {
  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Skip API calls (they should always be fresh)
  if (event.request.url.includes("/api/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => response)
        .catch(() => {
          // Return offline response
          return new Response(
            JSON.stringify({ error: "Offline - API unavailable" }),
            { status: 503, statusText: "Service Unavailable" }
          );
        })
    );
    return;
  }

  // For static assets, use cache-first strategy
  event.respondWith(
    caches.match(event.request).then((response) => {
      return (
        response ||
        fetch(event.request).then((response) => {
          // Don't cache non-successful responses
          if (!response || response.status !== 200) return response;

          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return response;
        })
      );
    })
  );
});
