/* Offline app-shell cache: network-first for API, cache-first for assets. */
const SHELL = "qofeno-shell-v1";
self.addEventListener("install", (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./index.html", "./app.css", "./app.js"]))));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // never cache API responses
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ??
        fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(e.request, copy));
            return res;
          })
          .catch(() => caches.match("./index.html")),
    ),
  );
});
