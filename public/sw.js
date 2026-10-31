/* Quincena: funciona sin conexión usando la última copia guardada en cada navegador.
   Solo se guardan en caché los archivos de la propia app. Las peticiones a Supabase (datos e imágenes
   privadas) y la configuración nunca se guardan en caché. */
const CACHE = 'quincena-v2';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'favicon.ico', 'icon-maskable-192.png', 'icon-maskable-512.png', 'icon-192.png', 'icon-512.png', 'vendor/supabase.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // Supabase y otros dominios: siempre a la red, sin caché
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('/config.js') || url.pathname.endsWith('admin.html')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r && r.status === 200) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
