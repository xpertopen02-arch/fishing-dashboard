// Keeps the dashboard usable without a connection. Online it always prefers fresh files,
// so a new upload reaches the installed app without a version bump here.
const SHELL = "fish-shell-v1";
const IMAGES = "fish-images-v1";
const WEATHER = "fish-weather-v1";
const MAX_IMAGES = 500;
const MAX_WEATHER = 60;
const SHELL_WAIT_MS = 4000;

const SHELL_FILES = [
  "./", "index.html", "style.css", "app.js", "versions.js", "manifest.webmanifest",
  "data/meta.js", "data/text.js", "data/html.js",
  "icons/icon-192.png", "icons/icon-512.png",
];
const LIBRARIES = [
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
];
const WEATHER_HOSTS = ["api.open-meteo.com", "archive-api.open-meteo.com", "marine-api.open-meteo.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // one file failing must not stop the rest from being saved
    await Promise.allSettled([
      ...SHELL_FILES.map((f) => cache.add(new Request(f, { cache: "no-cache" }))),
      ...LIBRARIES.map(async (url) => cache.put(url, await fetch(url, { mode: "no-cors" }))),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL, IMAGES, WEATHER];
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("fish-") && !keep.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trim(cache, max) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

// Fresh when the network answers soon enough, otherwise the saved copy.
async function shellFile(request) {
  const cache = await caches.open(SHELL);
  // no-cache: GitHub Pages allows 10 minutes of browser caching, which could pair a new page with an old script
  const fresh = fetch(request, { cache: "no-cache" }).then((response) => {
    if (response.ok || response.type === "opaque") cache.put(request, response.clone());
    return response;
  });
  fresh.catch(() => {});
  try {
    return await Promise.race([
      fresh,
      new Promise((_, reject) => setTimeout(reject, SHELL_WAIT_MS, new Error("slow network"))),
    ]);
  } catch {
    const saved = request.mode === "navigate"
      ? await cache.match("index.html")
      : await cache.match(request, { ignoreSearch: true });
    return saved || fresh;
  }
}

// Image names are content hashes, so a saved image never goes out of date.
async function image(request) {
  const cache = await caches.open(IMAGES);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trim(cache, MAX_IMAGES);
  }
  return response;
}

// Only used without a connection, and marked so the page can say the values are old.
async function weather(request) {
  const cache = await caches.open(WEATHER);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const body = await response.clone().blob();
      await cache.put(request, new Response(body, {
        headers: { "content-type": "application/json", "x-fish-saved": new Date().toISOString() },
      }));
      await trim(cache, MAX_WEATHER);
    }
    return response;
  } catch (error) {
    const saved = await cache.match(request);
    if (saved) return saved;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (WEATHER_HOSTS.includes(url.hostname)) {
    event.respondWith(weather(request));
  } else if (url.origin === location.origin) {
    if (url.pathname.includes("/img/")) event.respondWith(image(request));
    else event.respondWith(shellFile(request));
  } else if (LIBRARIES.includes(url.href)) {
    event.respondWith(caches.match(url.href).then((saved) => saved || fetch(request)));
  }
});
