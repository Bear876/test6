const CACHE = 'vytreos-v4';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.allSettled(APP_SHELL.map(url => c.add(url).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Push notifications — show a reminder when the server (or a test) sends one.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { title: 'Vytreos', body: (e.data && e.data.text()) || '' }; }
  const title = data.title || 'Vytreos';
  const options = {
    body: data.body || 'Time for your weekly eye-health check-in.',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/favicon.svg',
    data: data.url || '/',
    tag: data.tag || 'vytreos-reminder',
    renotify: true
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept: API calls, Firebase, external AI providers
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('groq.com') ||
    url.hostname.includes('mistral.ai') ||
    url.hostname.includes('huggingface.co') ||
    url.hostname.includes('roboflow.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  ) {
    return;
  }

  // Navigations: network-first, fall back to the cached app shell so the app
  // still opens offline. Successful loads refresh the cache.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put('/', clone)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets: network-first too (keeps updates fresh), cache as fallback.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
