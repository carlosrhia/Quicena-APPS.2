/* Quincena: funciona sin conexión usando la última copia guardada en cada navegador.
   No necesita caché del servidor: los datos viven en el dispositivo y se sincronizan al volver la red. */
const CACHE = 'quincena-v1';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'favicon.ico', 'icon-maskable-192.png', 'icon-maskable-512.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // La API siempre va a la red: si falla (sin conexión), la app usa sus datos locales.
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r && r.status === 200) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
