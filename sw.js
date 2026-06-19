// Reptilift service worker — cache core assets for offline use.
const CACHE = "reptilift-v3.6";
const ASSETS = [
  "./", "index.html", "styles.css", "script.js", "supabase-config.js",
  "logo.png", "eyes.png", "introeyes.png", "icon-192.png", "icon-512.png",
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
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match("index.html")))
  );
});
