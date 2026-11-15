// Välimuisti sovelluksen tiedostoille, jotta äppi aukeaa nopeasti myös heikolla yhteydellä
const CACHE = 'tiehavainnot-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Ilmoitukset ja Overpass aina verkosta
  if (url.hostname.includes('firebase') || url.hostname.includes('overpass')) return;
  // Karttaruudut: välimuisti ensin, sitten verkko
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(caches.open('tiles-v1').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // Sovellus: verkko ensin, varalla välimuisti
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request)));
});
