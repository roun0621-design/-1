// PACE RISE : Node — Service Worker v3
// Offline-first PWA: cache app shell, queue API mutations for sync
// v3: auto version sync, IndexedDB offline queue, background sync

const CACHE_NAME = 'pacerise-v186';
const OFFLINE_URL = '/';

// App shell — version-free paths (actual files are network-first, cache updated on every fetch)
const APP_SHELL = [
    '/',
    '/styles.css',
    '/fonts/d2coding-subset.woff2',
    '/fonts/d2coding-bold-subset.woff2',
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

// ─── 오프라인 큐에 넣어도 되는 요청 (2026-09 점검) ─────────────────────────────
//   예전엔 실패한 /api 쓰기를 전부 큐에 넣고 '성공'으로 응답했다 → 오프라인 로그인(비밀번호가 큐에 저장됨), 기록증 문자 발송,
//   결승 생성, 기록 초기화까지 '성공'으로 보였다가 나중에 혼자 실행됐다. 같은 값을 여러 번 보내도 결과가 같은
//   심판 기록 입력·소집 출석만 큐에 넣고, 나머지는 '저장 안 됨'을 그대로 알린다.
const QUEUEABLE = [
    ['POST', /^\/api\/results\/upsert$/],
    ['POST', /^\/api\/height-attempts\/save$/],
    ['POST', /^\/api\/heats\/\d+\/wind$/],
    ['PATCH', /^\/api\/event-entries\/\d+\/(status|memo|manual-rank)$/],
    ['POST', /^\/api\/callroom\/checkin$/],
];
const isQueueable = (method, pathname) => QUEUEABLE.some(([m, re]) => m === method && re.test(pathname));
const MUTATION_TIMEOUT_MS = 12000;      // 응답 없는 요청이 입력칸을 '저장 중'으로 영원히 묶어두지 않게
const MAX_REPLAY_TRIES = 30;

// 같은 칸(같은 조·선수·시기·높이)에 대한 큐 항목 식별자 — 재전송 때 마지막 값만 보낸다
function slotKeyOf(item) {
    const b = (item.body && typeof item.body === 'object') ? item.body : {};
    return [item.method, String(item.url).split('?')[0], b.heat_id, b.event_entry_id, b.attempt_number, b.bar_height, b.event_id, b.barcode].map(v => (v == null ? '' : v)).join('|');
}

async function enqueueRequest(method, url, body, headers) {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add({
        method, url, body, headers: headers || {},
        timestamp: Date.now(),
        tries: 0,
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

async function updateQueued(id, patch) {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const req = store.get(id);
    req.onsuccess = () => { const record = req.result; if (record) store.put(Object.assign(record, patch)); };
    return new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });   // 완료까지 기다린다 (예전엔 기다리지 않아 같은 항목이 두 번 전송될 수 있었다)
}
const markSynced = id => updateQueued(id, { synced: true });

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

    // 외부 도메인(FCM/구글 등) 요청은 절대 가로채지 않음 — getToken 의
    // fcmregistrations.googleapis.com 호출이 'Failed to fetch(token-subscribe-failed)'
    // 로 깨지는 것 방지. (오프라인 SW 의 알려진 함정)
    if (url.origin !== self.location.origin) return;

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
                    .then((response) => {
                        // ⚠️ 응답을 '즉시' 페이지로 돌려준다. IndexedDB 캐시 쓰기는
                        //    백그라운드로 떼어내(await 하지 않음) — 캐시 쓰기가 blocked/hang
                        //    되더라도 페이지 fetch 가 영원히 멈추지 않도록 한다.
                        //    (예전엔 await cacheAPIResponse 가 response 반환을 막아
                        //     /e/<slug> 진입 시 대시보드가 '로딩 중' 에서 멈추는 버그가 있었음.)
                        if (response.ok) {
                            const clone = response.clone();
                            const cacheKey = url.pathname + url.search;
                            const bg = (async () => {
                                try {
                                    const data = await clone.json();
                                    await cacheAPIResponse(cacheKey, data);
                                } catch (e) {}
                            })();
                            if (event.waitUntil) { try { event.waitUntil(bg); } catch (e) {} }
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

        // Mutation requests (POST/PUT/PATCH/DELETE)
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.request.method)) {
            const method = event.request.method;
            const queueable = isQueueable(method, url.pathname);
            const authKey = event.request.headers.get('x-admin-key') || '';
            event.respondWith(
                event.request.clone().text().then(bodyText => {
                    const ctl = new AbortController();
                    // 시간 제한은 큐에 넣을 수 있는(=짧고, 다시 보내도 안전한) 요청에만 건다. 일괄 가져오기·문서 생성 같은 긴 작업은 끊지 않는다.
                    const timer = queueable ? setTimeout(() => ctl.abort(), MUTATION_TIMEOUT_MS) : null;
                    return fetch(event.request, { signal: ctl.signal })
                        .then(r => { clearTimeout(timer); return r; })
                        .catch(async () => {
                            clearTimeout(timer);
                            if (!queueable) {
                                // 큐에 넣지 않는 요청: '성공'인 척하지 않는다 — 화면이 실패를 알 수 있게 오류로 돌려준다
                                return new Response(JSON.stringify({ error: '네트워크 연결이 끊겨 처리되지 않았습니다. 연결을 확인한 뒤 다시 시도하세요.', offline: true, network_error: true }),
                                    { status: 503, headers: { 'Content-Type': 'application/json' } });
                            }
                            let body = null;
                            try { body = JSON.parse(bodyText); } catch(e) { body = bodyText; }
                            // ─── 오프라인 입력 시각 자동 박기 (충돌 감지 메타데이터) ───
                            const offlineInputAt = Date.now();
                            if (body && typeof body === 'object' && !Array.isArray(body) && body.offline_input_at == null) {
                                body.offline_input_at = offlineInputAt;
                            }
                            await enqueueRequest(method, url.pathname + url.search, body, authKey ? { 'x-admin-key': authKey } : {});

                            const clients = await self.clients.matchAll();
                            clients.forEach(client => {
                                client.postMessage({ type: 'OFFLINE_QUEUED', method, url: url.pathname, timestamp: Date.now() });
                            });

                            return new Response(JSON.stringify({
                                success: true, offline: true, queued: true,
                                offline_input_at: offlineInputAt,
                                message: 'Operation queued for sync'
                            }), { headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' } });
                        });
                })
            );
            return;
        }
        return;
    }

});

// ---- Background Sync: replay queued mutations ----
self.addEventListener('sync', (event) => {
    if (event.tag === 'pacerise-sync') {
        event.waitUntil(syncQueuedRequests());
    }
});

// 동시에 한 번만 돈다 — online 이벤트 2곳 + Background Sync 가 겹치면 같은 항목이 2~3번 전송되고 가짜 '충돌' 알림이 떴다
let _syncInFlight = null;
function syncQueuedRequests() {
    if (_syncInFlight) return _syncInFlight;
    _syncInFlight = _syncQueuedRequests().finally(() => { _syncInFlight = null; });
    return _syncInFlight;
}

async function _syncQueuedRequests() {
    const all = (await getQueuedRequests()).filter(i => !i.dead).sort((a, b) => a.id - b.id);
    let synced = 0, failed = 0;
    const conflicts = [];  // ─── 충돌(운영진 우선)로 거부된 항목 모음
    const dropped = [];    // ─── 서버가 거부해 다시 보내도 소용없는 항목 (심판에게 보여준다)

    // 같은 칸을 오프라인에서 고쳐 쓴 경우(X → O, 10.52 → 10.25) 마지막 값만 보낸다.
    //   예전엔 둘 다 순서대로 보냈고, 첫 전송이 서버 시각으로 기록되면서 둘째(=심판이 고친 값)가 '서버가 더 최신'으로 거부됐다.
    const lastOfSlot = new Map();
    all.forEach(i => lastOfSlot.set(slotKeyOf(i), i.id));
    const queued = [];
    for (const i of all) { if (lastOfSlot.get(slotKeyOf(i)) === i.id) queued.push(i); else await markSynced(i.id); }

    for (const item of queued) {
        try {
            const opts = {
                method: item.method,
                headers: Object.assign({ 'Content-Type': 'application/json' }, item.headers || {}),   // 저장해 둔 키를 함께 보낸다 (PATCH 는 본문에 키가 없어 재전송이 403 으로 영구 실패했다)
            };
            if (item.body && item.method !== 'GET') {
                opts.body = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
            }
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), MUTATION_TIMEOUT_MS);
            opts.signal = ctl.signal;
            const response = await fetch(item.url, opts);
            clearTimeout(timer);
            if (response.ok) {
                await markSynced(item.id);
                synced++;
                continue;
            }
            let detail = null;
            try { detail = await response.clone().json(); } catch(e) {}
            if (response.status === 409 && detail && detail.error === 'CONFLICT_NEWER_ON_SERVER') {
                conflicts.push({
                    url: item.url,
                    offline_input_at: item.body && item.body.offline_input_at,
                    server_value: detail.server_value,
                    rejected_offline_value: detail.rejected_offline_value,
                    message: detail.message
                });
                await markSynced(item.id);  // 큐에서 제거 (= synced 처리)
                continue;
            }
            const tries = (item.tries || 0) + 1;
            // 401/403(로그인 만료 — 다시 로그인하면 풀린다)·429·5xx 는 다시 시도, 그 밖의 4xx 는 다시 보내도 같다 → 큐에서 빼고 알린다
            const retryable = [401, 403, 408, 429].includes(response.status) || response.status >= 500;
            if (!retryable || tries >= MAX_REPLAY_TRIES) {
                dropped.push({ url: item.url, method: item.method, body: item.body, status: response.status, error: (detail && (detail.error || detail.message)) || '', offline_input_at: item.body && item.body.offline_input_at });
                await markSynced(item.id);
            } else {
                await updateQueued(item.id, { tries, last_status: response.status });
            }
            failed++;
        } catch(e) {
            failed++;       // 아직 네트워크가 안 된다 — 그대로 둔다
        }
    }

    // Notify clients about sync result
    const remaining = (await getQueuedRequests()).length;
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
        client.postMessage({ type: 'SYNC_COMPLETE', synced, failed, remaining, conflicts, dropped });
    });

    // Clean synced entries
    await clearSyncedQueue();
    return { synced, failed, remaining };
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
