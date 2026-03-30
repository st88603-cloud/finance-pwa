const cacheName="pwa-v3";
const files=["/","/index.html","/app.js","/manifest.json"];

self.addEventListener("install",e=>{
 e.waitUntil(caches.open(cacheName).then(c=>c.addAll(files)));
});

self.addEventListener("fetch",e=>{
 e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});