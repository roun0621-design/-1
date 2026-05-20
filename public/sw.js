// PACE RISE : Node — Service Worker v3
// Offline-first PWA: cache app shell, queue API mutations for sync
// v3: auto version sync, IndexedDB offline queue, background sync

const CACHE_NAME = 'pacerise-v100';
const OFFLINE_URL = '/';

// App shell — version-free paths (actual files are network-first, cache updated on every fetch)
const APP_SHELL = [
    '/',
    '/styles.css',
    '/common.js',
    '/dashboard.html',
    '/admin.html',
    '/callroom.html',
    '/record.html',
    '/record.js',
    '/results.html',
    '/results.js',
    '/dashboard.js',
    '/callroom.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/manifest.json'
];

// ---- IndexedDB for offline queue ----
function openOfflineDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('pacerise-offline', 2);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('queue')) {
                db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains('cache')) {
                db.createObjectStore('cache', { keyPath: 'url' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function enqueueRequest(method, url, body) {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add({
        method, url, body,
        timestamp: Date.now(),
        synced: false
    });
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
}

async function getQueuedRequests() {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result.filter(r => !r.synced));
        req.onerror = () => reject(req.error);
    });
}

async function markSynced(id) {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const req = store.get(id);
    req.onsuccess = () => {
        const record = req.result;
        if (record) {
            record.synced = true;
            store.put(record);
        }
    };
}

async function clearSyncedQueue() {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const req = store.getAll();
    req.onsuccess = () => {
        req.result.filter(r => r.synced).forEach(r => store.delete(r.id));
    };
}

// Cache API response to IndexedDB for offline reads
async function cacheAPIResponse(url, data) {
    try {
        const db = await openOfflineDB();
        const tx = db.transaction('cache', 'readwrite');
        tx.objectStore('cache').put({ url, data, timestamp: Date.now() });
    } catch(e) {}
}

async function getCachedAPIResponse(url) {
    try {
        const db = await openOfflineDB();
        const tx = db.transaction('cache', 'readonly');
        return new Promise((resolve) => {
            const req = tx.objectStore('cache').get(url);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror = () => resolve(null);
        });
    } catch(e) { return null; }
}

// ---- Install: pre-cache app shell ----
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(APP_SHELL);
        })
    );
    self.skipWaiting();
});

// ---- Activate: clean old caches ----
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

// ---- Fetch: network-first for API, cache-first for static ----
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip SSE connections entirely
    if (url.pathname === '/api/sse') return;

    // Skip binary file downloads (Excel, PDF) — don't intercept or cache
    if (url.pathname.includes('/excel') || url.pathname.includes('/pdf') ||
        url.pathname.includes('/documents/comprehensive') || url.pathname.includes('/documents/full-record') ||
        url.pathname.includes('/documents/start-list') || url.pathname.includes('/documents/result-sheet')) return;

    // ---- API Requests ----
    if (url.pathname.startsWith('/api/')) {
        // Skip file uploads (multipart/form-data) entirely — SW cannot clone FormData with files
        const ct = event.request.headers.get('content-type') || '';
        if (ct.includes('multipart/form-data')) return;

        // GET requests: network-first with IndexedDB fallback
        if (event.request.method === 'GET') {
            event.respondWith(
                fetch(event.request)
                    .then(async (response) => {
                        if (response.ok) {
                            // Cache the API response in IndexedDB
                            try {
                                const clone = response.clone();
                                const data = await clone.json();
                                await cacheAPIResponse(url.pathname + url.search, data);
                            } catch(e) {}
                        }
                        return response;
                    })
                    .catch(async () => {
                        // Offline: try IndexedDB cache
                        const cached = await getCachedAPIResponse(url.pathname + url.search);
                        if (cached) {
                            return new Response(JSON.stringify(cached), {
                                headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' }
                            });
                        }
                        return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
                            status: 503, headers: { 'Content-Type': 'application/json' }
                        });
                    })
            );
            return;
        }

        // Mutation requests (POST/PUT/PATCH/DELETE): try network, queue on failure
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.request.method)) {
            event.respondWith(
                event.request.clone().text().then(bodyText => {
                    return fetch(event.request)
                        .catch(async () => {
                            // Network failed: queue for later sync
                            let body = null;
                            try { body = JSON.parse(bodyText); } catch(e) { body = bodyText; }
                            await enqueueRequest(event.request.method, url.pathname + url.search, body);

                            // Notify all clients about queued operation
                            const clients = await self.clients.matchAll();
                            clients.forEach(client => {
                                client.postMessage({
                                    type: 'OFFLINE_QUEUED',
                                    method: event.request.method,
                                    url: url.pathname,
                                    timestamp: Date.now()
                                });
                            });

                            return new Response(JSON.stringify({
                                success: true,
                                offline: true,
                                queued: true,
                                message: 'Operation queued for sync'
                            }), {
                                headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' }
                            });
                        });
                })
            );
            return;
        }
        return;
    }

    // ---- Static Resources ----
    if (event.request.method !== 'GET') return;

    // HTML pages: NETWORK-FIRST (always get latest to prevent stale login forms)
    const isHTML = event.request.mode === 'navigate' ||
        url.pathname.endsWith('.html') ||
        url.pathname === '/';

    if (isHTML) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Network failed — use cache as fallback
                return caches.match(event.request).then(cached => cached || caches.match(OFFLINE_URL));
            })
        );
        return;
    }

    // Other static resources (CSS, JS, images): NETWORK-FIRST for JS/CSS, stale-while-revalidate for others
    // JS and CSS should always get latest to prevent stale code issues
    const isCodeFile = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
    if (isCodeFile) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                return caches.match(event.request).then(cached => cached || caches.match(OFFLINE_URL));
            })
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cached => {
            const networkFetch = fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Network failed, return cache or offline fallback
                return cached || caches.match(OFFLINE_URL);
            });

            // Return cached immediately, update in background
            return cached || networkFetch;
        })
    );
});

// ---- Background Sync: replay queued mutations ----
self.addEventListener('sync', (event) => {
    if (event.tag === 'pacerise-sync') {
        event.waitUntil(syncQueuedRequests());
    }
});

async function syncQueuedRequests() {
    const queued = await getQueuedRequests();
    let synced = 0, failed = 0;

    for (const item of queued) {
        try {
            const opts = {
                method: item.method,
                headers: { 'Content-Type': 'application/json' }
            };
            if (item.body && item.method !== 'GET') {
                opts.body = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
            }
            const response = await fetch(item.url, opts);
            if (response.ok) {
                await markSynced(item.id);
                synced++;
            } else {
                failed++;
            }
        } catch(e) {
            failed++;
        }
    }

    // Notify clients about sync result
    const remaining = (await getQueuedRequests()).length;
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
        client.postMessage({
            type: 'SYNC_COMPLETE',
            synced, failed,
            remaining
        });
    });

    // Clean synced entries
    await clearSyncedQueue();
}

// ---- Message handler: manual sync trigger ----
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'TRIGGER_SYNC') {
        syncQueuedRequests().then(result => {
            event.ports[0]?.postMessage({ success: true });
        });
    }
    if (event.data && event.data.type === 'GET_QUEUE_STATUS') {
        getQueuedRequests().then(queued => {
            event.ports[0]?.postMessage({ pending: queued.length, items: queued });
        });
    }
});
