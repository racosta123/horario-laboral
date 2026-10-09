// Service worker de Horario Laboral: guarda la app (mismo origen) para abrir sin conexión.
// NUNCA guarda respuestas del Worker ni de Google (datos personales y tokens).
const VERSION = "hl-v0.1.0";
const APP = [
  "./", "./index.html", "./manifest.webmanifest",
  "./css/tokens.css", "./css/componentes.css", "./css/app.css",
  "./js/app.js", "./js/auth.js", "./js/api.js", "./js/ui.js", "./js/instalar.js", "./js/config.js", "./js/vendor/firebase.js",
  "./js/admin.js", "./js/datos.js", "./js/camara.js", "./js/credencial.js", "./js/vendor/qr.js",
  "./icons/iconos.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/favicon-32.png",
  "./fonts/figtree-400.woff2", "./fonts/figtree-500.woff2", "./fonts/figtree-600.woff2", "./fonts/figtree-700.woff2", "./fonts/figtree-800.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // otros orígenes: directo a la red
  // Navegación: red primero (para tener la versión nueva), caché si no hay señal.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))));
    return;
  }
  // Archivos estáticos: caché primero, y se actualiza en segundo plano.
  e.respondWith(
    caches.match(req).then((cacheada) => {
      const red = fetch(req).then((res) => {
        if (res.ok && res.type === "basic") caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cacheada || Response.error());
      return cacheada || red;
    }),
  );
});
