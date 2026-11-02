/**
 * Pallio's service worker: what lets the app open in a home with no signal
 * (Level-1 doc:33; Mark Q8 default: read the chart and draft offline, sign on
 * reconnect).
 *
 * It keeps only what carries no patient data: the /offline page and the
 * scripts, styles and icons it runs on. The patients' charts and the drafts
 * live in IndexedDB, written and read by that page, never here. /api/ is
 * never touched: what it answers is PHI and must be live. Any other page is
 * fetched from the network as always; when the network cannot be reached, the
 * browser is sent to the offline copy instead of an error.
 *
 * Network first throughout, so a deploy is picked up the moment the device is
 * online; the cache is only ever the fallback.
 */
const CACHE = "pallio-offline-v1";
const SHELL = "/offline";
const MAX_ENTRIES = 400;

const isAsset = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  url.pathname === "/manifest.webmanifest" ||
  url.pathname.startsWith("/pwa-icon/") ||
  url.pathname.startsWith("/apple-icon") ||
  url.pathname === "/favicon.ico";

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_ENTRIES) {
    await Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map((k) => cache.delete(k)));
  }
}

/** The offline page and everything its HTML names, fetched fresh. */
async function warm() {
  const cache = await caches.open(CACHE);
  const res = await fetch(SHELL, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put(SHELL, res);
  const assets = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) assets.add(m[1]);
  await Promise.all(
    [...assets].map((a) =>
      fetch(a)
        .then((r) => (r.ok ? cache.put(a, r) : undefined))
        .catch(() => undefined),
    ),
  );
  await trim(cache);
}

self.addEventListener("install", (event) => {
  event.waitUntil(warm().catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("pallio-offline-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// The offline page asks for a fresh copy of itself when a clinician saves
// their caseload, so what opens offline is the version just used online.
self.addEventListener("message", (event) => {
  if (event.data === "warm") event.waitUntil(warm().catch(() => undefined));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    if (url.pathname === SHELL) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(SHELL, copy));
            }
            return res;
          })
          .catch(async () => (await caches.match(SHELL)) || Response.error()),
      );
      return;
    }
    // Any other page: the network, or, with none, the offline copy. A
    // redirect rather than the copy's HTML under this URL, so the page that
    // opens is the one its scripts were built for.
    event.respondWith(
      fetch(req).catch(async () => ((await caches.match(SHELL)) ? Response.redirect(SHELL, 302) : Response.error())),
    );
    return;
  }

  if (isAsset(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then(async (c) => {
              await c.put(req, copy);
              await trim(c);
            });
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || Response.error()),
    );
  }
});
