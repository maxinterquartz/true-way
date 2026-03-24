const CACHE_NAME = 'true-way-v1';
const STATIC_ASSETS = [
  '/',
  '/order',
  '/driver',
  '/css/main.css',
  '/css/order.css',
  '/css/driver.css',
  '/js/utils.js',
  '/js/order.js',
  '/js/driver.js',
  '/manifest.json'
];

self.addEventListener('install', event => {
  console.log('SW: Установка');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log('SW: Активация');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && event.request.method === 'GET') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
