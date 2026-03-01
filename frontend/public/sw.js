/**
 * Skrīb Service Worker
 *
 * Handles:
 * - Offline caching (cache-first for hashed assets, stale-while-revalidate for pages)
 * - Web Push notifications
 * - Notification click → focus/open app
 */

const CACHE_NAME = 'skrib-v2';

// Pre-cache critical assets on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        '/app.html',
        '/login.html',
        '/manifest.json',
        '/icons/icon-192.png',
      ])
    )
  );
  self.skipWaiting();
});

// Activate: clean old caches, claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch handler with strategy per resource type
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API or WebSocket requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // Cache-first for /assets/* (Vite hashed filenames — immutable)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Stale-while-revalidate for navigations and other static files
  // Return cached version immediately, then update cache in background
  if (event.request.mode === 'navigate' || url.pathname.match(/\.(html|css|js|json|png|svg|ico)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        }).catch(() => cached);

        return cached || fetchPromise;
      })
    );
  }
});

// Push: show notification from server payload
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Skrīb', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/app.html' },
    })
  );
});

// Notification click: focus existing tab or open new window
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/app.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus an existing Skrīb tab if one is open
      for (const client of windowClients) {
        if (client.url.includes('/app.html') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    })
  );
});
