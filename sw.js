// Reptilift service worker — cache core assets for offline use.
const CACHE = "reptilift-v4.54";
const ASSETS = [
  "./", "index.html", "styles.css", "script.js", "supabase-config.js",
  "logo.png", "icon-192.png", "icon-512.png",
  // the startup splash is a video (the cinematic intro) — precache for offline.
  "intro.mp4",
  "apple-touch-icon.png", "favicon.png", "manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // Only handle same-origin app-shell requests. Let cross-origin requests
  // (Supabase API at *.supabase.co, the jsdelivr CDN, Google Fonts) go straight
  // to the network so auth/sync and font loads are never cached or intercepted.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  // Stale-while-revalidate: serve cache instantly if present, but always refetch
  // in the background and update the cache, so code/config changes self-heal on
  // the next load (no more stale config stuck behind a missed cache bump).
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((hit) => {
        const fetched = fetch(e.request).then((res) => {
          cache.put(e.request, res.clone()).catch(() => {});
          return res;
        }).catch(() => hit || cache.match("index.html"));
        return hit || fetched;
      })
    )
  );
});
