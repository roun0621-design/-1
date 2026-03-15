// PACE RISE : Node — Service Worker v1
// Minimal SW for PWA install prompt + offline fallback

const CACHE_NAME = 'pacerise-v33';
const OFFLINE_URL = '/';

// Pre-cache essential assets on install
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([
                '/',
                '/styles.css?v=33',
                '/common.js?v=33',
                '/icons/icon-192.png',
                '/icons/icon-512.png',
                '/manifest.json'
            ]);
        })
    );
    self.skipWaiting();
});

// Clean up old caches on activate
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

// Network-first strategy: try network, fallback to cache
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') return;
    
    // Skip API calls and SSE — always go to network
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/')) return;
    
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Cache successful responses for offline fallback
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Network failed — try cache
                return caches.match(event.request).then(cached => {
                    return cached || caches.match(OFFLINE_URL);
                });
            })
    );
});
