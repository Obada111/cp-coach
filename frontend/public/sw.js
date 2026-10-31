const CACHE_NAME = 'cp-coach-static-v2';
const APP_SHELL = [
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/offline.html',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const shellResponse = await fetch('/', { cache: 'reload' });
      if (!shellResponse.ok) {
        throw new Error(`Could not precache the app shell: ${shellResponse.status}`);
      }

      await cache.put('/', shellResponse.clone());
      const html = await shellResponse.text();
      const entryAssets = Array.from(
        html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g),
        (match) => match[1]
      );
      await cache.addAll([...new Set([...APP_SHELL, ...entryAssets])]);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('cp-coach-static-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    if (!event.data) return;
    let payload;
    try {
      payload = event.data.json();
    } catch (error) {
      console.error('Ignoring malformed CP Coach push payload:', error);
      return;
    }

    if (typeof payload.title !== 'string' || typeof payload.body !== 'string') return;
    const options = {
      body: payload.body,
      icon: typeof payload.icon === 'string' ? payload.icon : '/icons/icon-192.png',
      badge: typeof payload.badge === 'string' ? payload.badge : '/icons/icon-192.png',
      tag: typeof payload.tag === 'string' ? payload.tag : 'cp-coach-notification',
      renotify: false,
      data: payload.data && typeof payload.data === 'object' ? payload.data : {},
      actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 2) : [],
    };
    await self.registration.showNotification(payload.title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const requestedUrl = event.notification.data && event.notification.data.url;
    let targetUrl = new URL('/', self.location.origin);
    if (typeof requestedUrl === 'string') {
      try {
        const candidate = new URL(requestedUrl, self.location.origin);
        const allowed = candidate.origin === self.location.origin ||
          candidate.hostname === 'codeforces.com' ||
          candidate.hostname === 'www.codeforces.com';
        if (candidate.origin === self.location.origin || (allowed && candidate.protocol === 'https:')) {
          targetUrl = candidate;
        }
      } catch {
        // Keep the app home page as the safe fallback.
      }
    }

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.focus();
      if (targetUrl.origin === self.location.origin) await existing.navigate(targetUrl.href);
      else await self.clients.openWindow(targetUrl.href);
      return;
    }
    await self.clients.openWindow(targetUrl.href);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/health' ||
    url.pathname.startsWith('/health/')
  ) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          await cache.put(request, response.clone());
        }
        return response;
      })
    );
    return;
  }

  if (APP_SHELL.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (url.pathname === '/' && !url.search && response.ok && response.type === 'basic') {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/', response.clone());
          }
          return response;
        } catch {
          const cachedShell = await caches.match('/');
          if (cachedShell) return cachedShell;

          const offlinePage = await caches.match('/offline.html');
          if (offlinePage) {
            return new Response(offlinePage.body, {
              status: 503,
              statusText: 'Offline',
              headers: offlinePage.headers,
            });
          }

          return new Response('Offline. Reconnect to load Codeforces Coach.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
  }
});
