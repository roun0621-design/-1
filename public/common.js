/**
 * PACE RISE : Node — common.js v11.0
 * Multi-competition, 3-tier auth, shared utilities
 * v11: Offline sync awareness, document download links, WebSocket scoreboard client, security headers
 */

// ============================================================
// Shared formatting helpers
// (deduplicated from record.js / dashboard.js / results.js / callroom.js)
// ============================================================
function bib(val) { return val != null && val !== '' ? val : '—'; }

// ============================================================
// WA Scoring Tables
// ============================================================
const WA_TABLES = {
    M_100m:{A:25.4347,B:18,C:1.81,type:'track'},M_long_jump:{A:0.14354,B:220,C:1.40,type:'field_cm'},
    M_shot_put:{A:51.39,B:1.5,C:1.05,type:'field_m'},M_high_jump:{A:0.8465,B:75,C:1.42,type:'field_cm'},
    M_400m:{A:1.53775,B:82,C:1.81,type:'track'},M_110m_hurdles:{A:5.74352,B:28.5,C:1.92,type:'track'},
    M_discus:{A:12.91,B:4,C:1.1,type:'field_m'},M_pole_vault:{A:0.2797,B:100,C:1.35,type:'field_cm'},
    M_javelin:{A:10.14,B:7,C:1.08,type:'field_m'},M_1500m:{A:0.03768,B:480,C:1.85,type:'track'},
    F_200m:{A:4.99087,B:42.5,C:1.81,type:'track'},F_100m_hurdles:{A:9.23076,B:26.7,C:1.835,type:'track'},
    F_high_jump:{A:1.84523,B:75,C:1.348,type:'field_cm'},F_shot_put:{A:56.0211,B:1.5,C:1.05,type:'field_m'},
    F_long_jump:{A:0.188807,B:210,C:1.41,type:'field_cm'},F_javelin:{A:15.9803,B:3.8,C:1.04,type:'field_m'},
    F_800m:{A:0.11193,B:254,C:1.88,type:'track'},
};
const DECATHLON_EVENTS = [
    {order:1,key:'M_100m',name:'100m',unit:'s'},{order:2,key:'M_long_jump',name:'멀리뛰기',unit:'m'},
    {order:3,key:'M_shot_put',name:'포환던지기',unit:'m'},{order:4,key:'M_high_jump',name:'높이뛰기',unit:'m'},
    {order:5,key:'M_400m',name:'400m',unit:'s'},{order:6,key:'M_110m_hurdles',name:'110m 허들',unit:'s'},
    {order:7,key:'M_discus',name:'원반던지기',unit:'m'},{order:8,key:'M_pole_vault',name:'장대높이뛰기',unit:'m'},
    {order:9,key:'M_javelin',name:'창던지기',unit:'m'},{order:10,key:'M_1500m',name:'1500m',unit:'s'},
];
const HEPTATHLON_EVENTS = [
    {order:1,key:'F_100m_hurdles',name:'100m 허들',unit:'s'},{order:2,key:'F_high_jump',name:'높이뛰기',unit:'m'},
    {order:3,key:'F_shot_put',name:'포환던지기',unit:'m'},{order:4,key:'F_200m',name:'200m',unit:'s'},
    {order:5,key:'F_long_jump',name:'멀리뛰기',unit:'m'},{order:6,key:'F_javelin',name:'창던지기',unit:'m'},
    {order:7,key:'F_800m',name:'800m',unit:'s'},
];

function calcWAPoints(key, rawRecord) {
    const t = WA_TABLES[key]; if (!t || rawRecord == null || rawRecord <= 0) return 0;
    let val;
    if (t.type === 'track') { val = t.B - rawRecord; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
    else if (t.type === 'field_cm') { val = rawRecord * 100 - t.B; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
    else { val = rawRecord - t.B; if (val <= 0) return 0; return Math.floor(t.A * Math.pow(val, t.C)); }
}

// ============================================================
// Time Helpers
// ============================================================
function parseTimeInput(str) {
    if (!str || !str.trim()) return null;
    str = str.trim();
    // Detect user-intended decimal places from raw input
    let _inputDecPlaces = 2; // default
    const rawDecMatch = str.match(/\.(\d+)$/);
    if (rawDecMatch) _inputDecPlaces = rawDecMatch[1].length >= 3 ? 3 : 2;
    // Also check after colon part (e.g. 3:50.081)
    const colonParts = str.split(':');
    if (colonParts.length > 1) {
        const lastPart = colonParts[colonParts.length - 1];
        const lastDecMatch = lastPart.match(/\.(\d+)$/);
        if (lastDecMatch) _inputDecPlaces = lastDecMatch[1].length >= 3 ? 3 : 2;
    }
    let result;
    const hmsMatch = str.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (hmsMatch) result = (parseInt(hmsMatch[1]) || 0) * 3600 + (parseInt(hmsMatch[2]) || 0) * 60 + (parseFloat(hmsMatch[3]) || 0);
    else if (str.includes(':')) { const p = str.split(':'); result = (parseInt(p[0]) || 0) * 60 + (parseFloat(p[1]) || 0); }
    else { const v = parseFloat(str); return isNaN(v) ? null : v; }
    // Round to intended precision to avoid floating-point artifacts
    // e.g. 3*60+50.08 = 230.07999999998 → round to 2dp → 230.08
    const factor = _inputDecPlaces === 3 ? 1000 : 100;
    return Math.round(result * factor) / factor;
}
function formatTime(s, options) {
    if (s == null) return '';
    const noDecimal = options && options.noDecimal;
    // Show as many decimals as stored (up to 3), or none if noDecimal
    const dp = noDecimal ? 0 : _decPlaces(s);
    if (s >= 3600) { const h = Math.floor(s / 3600); const m = Math.floor((s - h * 3600) / 60); const r = s - h * 3600 - m * 60; return `${h}:${m < 10 ? '0' : ''}${m}:${dp > 0 ? (r < 10 ? '0' : '') + r.toFixed(dp) : String(Math.floor(r)).padStart(2, '0')}`; }
    if (s >= 60) { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${dp > 0 ? (r < 10 ? '0' : '') + r.toFixed(dp) : String(Math.floor(r)).padStart(2, '0')}`; }
    return dp > 0 ? s.toFixed(dp) : String(Math.floor(s));
}
function _decPlaces(v) {
    // Determine decimal places: 2 unless 3rd decimal is genuinely non-zero (milliseconds)
    // Round to 3dp first to eliminate floating-point noise
    const rounded = Math.round(v * 1000) / 1000;
    // Check if 2dp rounding matches 3dp rounding — if so, only 2dp needed
    const rounded2 = Math.round(v * 100) / 100;
    if (Math.abs(rounded - rounded2) < 0.0001) return 2;
    return 3;
}
function isLongTimeEvent(n) {
    if (!n) return false;
    const l = n.toLowerCase();
    return l.includes('800m') || l.includes('1500m') || l.includes('3000m') || l.includes('5000m') || l.includes('10000m') || l.includes('경보') || l.includes('w') || l.includes('10k');
}
function isRoadEvent(n) { if (!n) return false; const l = n.toLowerCase(); return l.includes('마라톤') || l.includes('하프') || l.includes('kmw') || l.includes('단체') || l.includes('10k') || l.includes('5k') || l.includes('half'); }
function isFieldEvent(cat) { return cat === 'field_distance' || cat === 'field_height'; }

// WA Wind measurement rules
// Track ≤200m: wind per heat (one-decimal). No wind for 400m, 400mH, ≥3000m, 4×100m relay, HJ, PV, throws.
// Field: long jump (멀리뛰기) and triple jump (세단뛰기) require wind per attempt.
// Combined-event disciplines: inherit wind rule from their category.
// Record eligibility: wind ≤ +2.0 m/s. >+2.0 m/s → valid performance, append "w" (not record-eligible).
function requiresWindMeasurement(eventName, category) {
    if (!eventName) return false;
    const n = eventName.toLowerCase();
    // Track: only ≤200m individual events (100m, 200m, 100mH, 110mH)
    // Explicitly exclude 400m, 400mH, ≥800m, relays, road, walks
    if (category === 'track') {
        // Exclude events that do NOT need wind
        if (n.includes('400m') || n.includes('800m') || n.includes('1500m') ||
            n.includes('3000m') || n.includes('5000m') || n.includes('10000m') || n.includes('10,000m') ||
            n.includes('sc') || n.includes('장애물') || n.includes('경보') ||
            n.endsWith('w') || n.includes('mw') || n.includes('walk')) return false;
        // Include: 100m, 110m, 200m (covers 100m, 100mH, 110mH, 200m)
        if (n.includes('100m') || n.includes('110m') || n.includes('200m')) return true;
        return false;
    }
    // Relay: no wind measurement needed (4×100m relay included)
    if (category === 'relay') return false;
    // Field distance: long jump and triple jump require wind per attempt
    if (category === 'field_distance') {
        if (n.includes('멀리뛰기') || n.includes('세단뛰기') || n.includes('long') || n.includes('triple')) return true;
        return false;
    }
    // Field height (HJ, PV): no wind
    if (category === 'field_height') return false;
    // Road: no wind
    if (category === 'road') return false;
    return false;
}
function windRecordEligible(wind) {
    // WA rule: wind ≤ +2.0 m/s for record/ranking eligibility
    if (wind == null) return true; // no measurement = assume OK
    return wind <= 2.0;
}
function formatWind(w) {
    if (w == null || w === '') return '';
    const v = parseFloat(w);
    if (isNaN(v)) return '';
    return (v >= 0 ? '+' : '') + v.toFixed(1);
}
function getTimePlaceholder(eventName) { if (isRoadEvent(eventName)) return 'H:MM:SS.xx'; if (isLongTimeEvent(eventName)) return 'M:SS.xx'; return 'SS.xx'; }

/**
 * Format height in athletic notation: 1.70 → "1m70", 2.00 → "2m00"
 * @param {number} meters - height in meters (e.g. 1.70)
 * @returns {string} formatted string (e.g. "1m70")
 */
function formatHeight(meters) {
    if (meters == null || isNaN(meters)) return '—';
    const m = Math.floor(meters);
    const cm = Math.round((meters - m) * 100);
    return m + 'm' + String(cm).padStart(2, '0');
}

/**
 * Check if current KST time is within the Call Room window.
 * Window: callroom_time - 10min ~ callroom_time + 5min
 * @param {string} callroomTime  "HH:MM" format
 * @param {string} scheduledDate "YYYY-MM-DD" format (optional, defaults to today)
 * @returns {boolean}
 */
function isCallRoomWindow(callroomTime, scheduledDate) {
    if (!callroomTime) return false;
    const [h, m] = callroomTime.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return false;
    // KST = UTC+9
    const now = new Date();
    const kstNow = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
    // If scheduledDate provided, check it's today in KST
    if (scheduledDate) {
        const todayKST = kstNow.toISOString().split('T')[0];
        if (scheduledDate !== todayKST) return false;
    }
    const nowMins = kstNow.getHours() * 60 + kstNow.getMinutes();
    const crMins = h * 60 + m;
    return nowMins >= (crMins - 10) && nowMins <= (crMins + 5);
}

// ============================================================
// Format helpers
// ============================================================
// Check if an event uses lane assignment (sprints up to 800m)
function isLaneEvent(eventName) {
    if (!eventName) return false;
    const n = eventName.toLowerCase();
    // 100m, 200m, 400m, 800m, 100mH, 110mH, 400mH, relays up to 4x400m
    if (n.includes('100m') || n.includes('200m') || n.includes('400m') || n.includes('800m')) return true;
    if (n.includes('릴레이') || n.includes('relay')) return true;
    return false;
}
// "Small number" concept: 
// Track ≤800m: lane_number = lane assignment
// Track >800m: lane_number = identifier (bib order number)
// Field events: lane_number = event-order number
// Display: always show small-number alongside BIB
function getSmallNumberLabel(eventName, category) {
    if (isFieldEvent(category)) return 'No.';
    return isLaneEvent(eventName) ? 'LANE' : 'No.';
}
// Is short track event (≤800m) — used for max 8 per heat rule
function isShortTrackEvent(eventName) {
    if (!eventName) return false;
    const n = eventName.toLowerCase();
    if (n.includes('100m') || n.includes('200m') || n.includes('400m') || n.includes('800m')) return true;
    if (n.includes('릴레이') || n.includes('relay')) return true;
    return false;
}

function fmtCat(c) { return { track: 'Track', field_distance: 'Field', field_height: 'Field', combined: '혼성', relay: '릴레이', road: 'Road' }[c] || c; }
function fmtRound(r) { return { preliminary: '예선', semifinal: '준결승', final: '결승' }[r] || r; }
function fmtRoundShort(r) { return { preliminary: '예선', semifinal: '준결', final: '결승' }[r] || r; }
function fmtSt(s) { return { registered: '미확인', checked_in: '출석', no_show: '결석' }[s] || s; }

// ============================================================
// Competition context (localStorage = 전역 동기화)
// ============================================================
function getCompetitionId() {
    const fromUrl = new URLSearchParams(window.location.search).get('comp');
    const fromLocal = localStorage.getItem('pace_competition_id');
    // URL param → localStorage → null
    const compId = fromUrl || fromLocal;
    // Sync: write to localStorage when URL has it
    if (compId && compId !== fromLocal) {
        localStorage.setItem('pace_competition_id', compId);
    }
    // Sync: put in URL if missing
    if (compId && !fromUrl) {
        try {
            const url = new URL(window.location);
            url.searchParams.set('comp', compId);
            window.history.replaceState({}, '', url);
        } catch(e) {}
    }
    return compId;
}
function setCompetitionId(id) {
    localStorage.setItem('pace_competition_id', id);
    // Also update URL param
    try {
        const url = new URL(window.location);
        url.searchParams.set('comp', id);
        window.history.replaceState({}, '', url);
    } catch(e) {}
}

// ============================================================
// URL Params
// ============================================================
function getParam(name) { return new URLSearchParams(window.location.search).get(name); }
function setParams(obj) {
    const url = new URL(window.location);
    for (const [k, v] of Object.entries(obj)) { if (v != null) url.searchParams.set(k, v); else url.searchParams.delete(k); }
    window.history.replaceState({}, '', url);
}

// ============================================================
// Offline Status Banner & Sync
// ============================================================
const _offlineState = { online: navigator.onLine, pendingCount: 0 };

function _createOfflineBanner() {
    if (document.getElementById('pr-offline-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'pr-offline-banner';
    banner.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 16px;font-size:13px;font-weight:600;text-align:center;transition:all .3s;';
    document.body.prepend(banner);
}

function _updateOfflineBanner() {
    const banner = document.getElementById('pr-offline-banner');
    if (!banner) return;
    if (!_offlineState.online) {
        banner.style.display = 'block';
        banner.style.background = '#e74c3c';
        banner.style.color = '#fff';
        banner.textContent = `🔴 오프라인 — 기록은 로컬에 저장됩니다${_offlineState.pendingCount > 0 ? ` (대기 ${_offlineState.pendingCount}건)` : ''}`;
    } else if (_offlineState.pendingCount > 0) {
        banner.style.display = 'block';
        banner.style.background = '#f39c12';
        banner.style.color = '#fff';
        banner.textContent = `🟡 동기화 중... (${_offlineState.pendingCount}건 대기)`;
    } else {
        banner.style.display = 'none';
    }
}

// 온라인/오프라인 감지
window.addEventListener('online', () => {
    _offlineState.online = true;
    _updateOfflineBanner();
    // 온라인 복귀 시 SW에 동기화 요청
    if (navigator.serviceWorker?.controller) {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
            _checkPendingQueue();
            setTimeout(() => { _offlineState.pendingCount = 0; _updateOfflineBanner(); }, 2000);
        };
        navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_SYNC' }, [ch.port2]);
    }
});
window.addEventListener('offline', () => {
    _offlineState.online = false;
    _updateOfflineBanner();
});

// SW 메시지 수신
if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'OFFLINE_QUEUED') {
            _offlineState.pendingCount++;
            _updateOfflineBanner();
        }
        if (e.data?.type === 'SYNC_COMPLETE') {
            _offlineState.pendingCount = e.data.remaining || 0;
            _updateOfflineBanner();
            if (e.data.synced > 0) {
                console.log(`[Sync] ${e.data.synced}건 동기화 완료`);
            }
        }
    });
}

function _checkPendingQueue() {
    if (navigator.serviceWorker?.controller) {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => {
            _offlineState.pendingCount = e.data?.pending || 0;
            _updateOfflineBanner();
        };
        navigator.serviceWorker.controller.postMessage({ type: 'GET_QUEUE_STATUS' }, [ch.port2]);
    }
}

// 페이지 로드 시 배너 생성 + 대기큐 확인
document.addEventListener('DOMContentLoaded', () => {
    _createOfflineBanner();
    _updateOfflineBanner();
    _checkPendingQueue();
});

// ============================================================
// API + Response Cache (loading optimisation)
// ============================================================
async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    // Auto-inject admin_key for write operations to result/height endpoints
    if (body && (method === 'POST' || method === 'PUT' || method === 'DELETE') &&
        (path.includes('/api/results') || path.includes('/api/height-attempts'))) {
        const storedKey = localStorage.getItem('pace_admin_key') || '';
        if (storedKey && !body.admin_key) body.admin_key = storedKey;
    }
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    // SW가 오프라인 큐잉한 응답 감지
    if (res.headers.get('X-Offline') === 'true') {
        const data = await res.json();
        if (data.queued) {
            _offlineState.pendingCount++;
            _updateOfflineBanner();
            console.log(`[Offline] 큐잉됨: ${method} ${path}`);
            return data; // queued 응답을 성공으로 반환
        }
        if (data.offline && !data.error) return data; // 캐시된 GET 응답
    }
    const data = await res.json();
    if (!res.ok) throw { status: res.status, ...data };
    return data;
}

// ── Short-lived response cache (avoids duplicate fetches during page init) ──
const _apiCache = {};
function cachedApi(key, fetcher, ttlMs = 5000) {
    const now = Date.now();
    if (_apiCache[key] && now - _apiCache[key].ts < ttlMs) return _apiCache[key].promise;
    const promise = fetcher();
    _apiCache[key] = { promise, ts: now };
    // Clear on reject so next call retries
    promise.catch(() => { delete _apiCache[key]; });
    return promise;
}
function invalidateCache(key) { if (key) delete _apiCache[key]; else Object.keys(_apiCache).forEach(k => delete _apiCache[k]); }

const API = {
    // Competitions (cached — called by renderCompSelector, renderCompInfoBar, requireCompetition)
    getCompetitions: () => cachedApi('competitions', () => api('GET', '/api/competitions')),
    invalidateCompetitions: () => invalidateCache('competitions'),
    getCompetition: id => api('GET', `/api/competitions/${id}`),
    createCompetition: (data, adminKey) => api('POST', '/api/competitions', { ...data, admin_key: adminKey }),
    updateCompetition: (id, data, adminKey) => api('PUT', `/api/competitions/${id}`, { ...data, admin_key: adminKey }),
    deleteCompetition: (id, adminKey) => api('DELETE', `/api/competitions/${id}`, { admin_key: adminKey }),
    getRecentCompetitions: (opts = {}) => api('GET', '/api/competitions/recent' + (opts.window ? `?window=${encodeURIComponent(opts.window)}` : '')),
    getCompetitionsByFederation: (code) => api('GET', `/api/competitions/by-federation/${encodeURIComponent(code)}`),

    // Federations (cached — called by renderCompInfoBar)
    getFederations: () => cachedApi('federations', () => api('GET', '/api/federations')),
    createFederation: (data, adminKey) => api('POST', '/api/federations', { ...data, admin_key: adminKey }),
    updateFederation: (id, data, adminKey) => api('PUT', `/api/federations/${id}`, { ...data, admin_key: adminKey }),
    deleteFederation: (id, adminKey) => api('DELETE', `/api/federations/${id}`, { admin_key: adminKey }),
    reorderFederations: (order, adminKey) => api('PUT', '/api/federations/reorder', { order, admin_key: adminKey }),

    // Home Popups
    getHomePopups: () => api('GET', '/api/home-popups'),
    createHomePopup: (data, adminKey) => api('POST', '/api/home-popups', { ...data, admin_key: adminKey }),
    updateHomePopup: (id, data, adminKey) => api('PUT', `/api/home-popups/${id}`, { ...data, admin_key: adminKey }),
    deleteHomePopup: (id, adminKey) => api('DELETE', `/api/home-popups/${id}`, { admin_key: adminKey }),

    // Events
    getAllEvents: (compId) => compId ? api('GET', `/api/events?competition_id=${compId}`) : api('GET', '/api/events'),
    getEvent: id => api('GET', `/api/events/${id}`),
    getEventEntries: eid => api('GET', `/api/events/${eid}/entries`),
    getHeats: eid => api('GET', `/api/heats?event_id=${eid}`),
    getHeatEntries: hid => api('GET', `/api/heats/${hid}/entries`),
    getHeatEntriesCheckedIn: hid => api('GET', `/api/heats/${hid}/entries?status=checked_in`),
    getResults: hid => api('GET', `/api/results?heat_id=${hid}`),
    upsertResult: body => api('POST', '/api/results/upsert', body),
    deleteResult: body => api('DELETE', '/api/results', body),
    resetSubEvent: eventId => api('POST', '/api/results/reset-sub-event', { event_id: eventId }),
    updateEntryStatus: (id, st) => api('PATCH', `/api/event-entries/${id}/status`, { status: st }),
    checkinBarcode: (bc, eid) => api('POST', '/api/callroom/checkin', { barcode: bc, event_id: eid }),
    cancelCheckin: (id) => api('PATCH', `/api/event-entries/${id}/status`, { status: 'registered' }),
    saveMemo: (id, memo) => api('PATCH', `/api/event-entries/${id}/memo`, { memo }),
    getEventMemo: (eid) => api('GET', `/api/events/${eid}/callroom-memo`),
    saveEventMemo: (eid, memo) => api('PATCH', `/api/events/${eid}/callroom-memo`, { memo }),
    getHeightAttempts: hid => api('GET', `/api/height-attempts?heat_id=${hid}`),
    saveHeightAttempt: body => api('POST', '/api/height-attempts/save', body),
    getCombinedScores: eid => api('GET', `/api/combined-scores?event_id=${eid}`),
    saveCombinedScore: body => api('POST', '/api/combined-scores/save', body),
    getCombinedSubEvents: pid => api('GET', `/api/combined-sub-events?parent_event_id=${pid}`),
    syncCombinedScores: pid => api('POST', '/api/combined-scores/sync', { parent_event_id: pid }),
    syncCombinedCheckin: eid => api('POST', '/api/combined/sync-checkin', { event_id: eid }),
    saveQualifications: (eid, sel) => api('POST', '/api/qualifications/save', { event_id: eid, selections: sel }),
    approveQualifications: eid => api('POST', '/api/qualifications/approve', { event_id: eid }),
    createFinal: eid => api('POST', `/api/events/${eid}/create-final`, {}),
    getRoundStatus: (compId) => compId ? api('GET', `/api/round-status?competition_id=${compId}`) : api('GET', '/api/round-status'),
    getAuditLog: (compId) => compId ? api('GET', `/api/audit-log?competition_id=${compId}&limit=20`) : api('GET', '/api/audit-log?limit=20'),
    getOperationLog: (limit = 100, compId = null) => compId ? api('GET', `/api/operation-log?limit=${limit}&competition_id=${compId}`) : api('GET', `/api/operation-log?limit=${limit}`),
    // Auth
    verifyAuth: (key, judge_name) => api('POST', '/api/auth/verify', { key, judge_name }),
    verifyAdmin: key => api('POST', '/api/admin/verify', { admin_key: key }),
    // Timetable
    getTimetable: (compId) => api('GET', `/api/timetable/${compId}`),
    deleteTimetable: (compId, adminKey) => api('DELETE', `/api/timetable/${compId}`, { admin_key: adminKey }),
    deleteTimetableDay: (compId, day, adminKey) => api('DELETE', `/api/timetable/${compId}/${day}`, { admin_key: adminKey }),
    // Admin CRUD
    changeKeys: (admin_key, new_operation_key, new_admin_key) => api('POST', '/api/admin/change-keys', { admin_key, new_operation_key, new_admin_key }),
    getAthletes: (adminKey, compId) => api('GET', `/api/admin/athletes?key=${encodeURIComponent(adminKey)}${compId ? '&competition_id=' + compId : ''}`),
    updateAthlete: (id, data, adminKey) => api('PUT', `/api/admin/athletes/${id}`, { ...data, admin_key: adminKey }),
    deleteAthlete: (id, adminKey) => api('DELETE', `/api/admin/athletes/${id}`, { admin_key: adminKey }),
    getAthleteEvents: (id, adminKey) => api('GET', `/api/admin/athletes/${id}/events?key=${encodeURIComponent(adminKey)}`),
    addAthleteEvent: (athleteId, eventId, adminKey) => api('POST', `/api/admin/athletes/${athleteId}/events`, { admin_key: adminKey, event_id: eventId }),
    removeAthleteEvent: (athleteId, entryId, adminKey) => api('DELETE', `/api/admin/athletes/${athleteId}/events/${entryId}`, { admin_key: adminKey }),
    createAthlete: (data, adminKey) => api('POST', '/api/admin/athletes', { ...data, admin_key: adminKey }),
    adminGetEvents: (adminKey, compId) => api('GET', `/api/admin/events?key=${encodeURIComponent(adminKey)}${compId ? '&competition_id=' + compId : ''}`),
    adminUpdateEvent: (id, data, adminKey) => api('PUT', `/api/admin/events/${id}`, { ...data, admin_key: adminKey }),
    adminDeleteEvent: (id, adminKey) => api('DELETE', `/api/admin/events/${id}`, { admin_key: adminKey }),
    adminCreateEvent: (data, adminKey) => api('POST', '/api/admin/events', { ...data, admin_key: adminKey }),
    adminResetDB: (adminKey, compId) => api('POST', '/api/admin/reset-db', { admin_key: adminKey, competition_id: compId }),
    completeEvent: (eid, judge_name, admin_key) => api('POST', `/api/events/${eid}/complete`, { judge_name, admin_key }),
    revertComplete: (eid, admin_key) => api('POST', `/api/events/${eid}/revert-complete`, { admin_key }),
    completeCallroom: (eid, judge_name, heat_id) => api('POST', `/api/events/${eid}/callroom-complete`, { judge_name, heat_id }),
    createSemifinal: (eid, group_count, selections) => api('POST', `/api/events/${eid}/create-semifinal`, { group_count, selections }),
    deleteEvent: (eid, admin_key) => api('DELETE', `/api/events/${eid}`, { admin_key }),
    getFullResults: eid => api('GET', `/api/events/${eid}/full-results`),
    // Video URL
    getEventVideoUrl: eid => api('GET', `/api/events/${eid}/video-url`),
    setEventVideoUrl: (eid, url, key) => api('PUT', `/api/events/${eid}/video-url`, { video_url: url, key }),
    getPublicEvents: (compId) => compId ? api('GET', `/api/public/events?competition_id=${compId}`) : api('GET', '/api/public/events'),
    getCallroomStatus: () => api('GET', '/api/public/callroom-status'),
    getCompetitionInfo: (compId) => compId ? api('GET', `/api/competition-info?competition_id=${compId}`) : api('GET', '/api/competition-info'),
    // Multi-key management
    getOperationKeys: (adminKey) => api('GET', `/api/admin/operation-keys?key=${encodeURIComponent(adminKey)}`),
    createOperationKey: (adminKey, judge_name, key_value, can_manage) => api('POST', '/api/admin/operation-keys', { admin_key: adminKey, judge_name, key_value, can_manage: can_manage || false }),
    deleteOperationKey: (id, adminKey) => api('DELETE', `/api/admin/operation-keys/${id}`, { admin_key: adminKey }),
    toggleOperationKey: (id, active, adminKey) => api('PATCH', `/api/admin/operation-keys/${id}`, { admin_key: adminKey, active }),
    toggleOperationKeyManage: (id, can_manage, adminKey) => api('PATCH', `/api/admin/operation-keys/${id}`, { admin_key: adminKey, can_manage }),
    // Heat management
    addHeat: (eventId, adminKey) => api('POST', `/api/admin/events/${eventId}/add-heat`, { admin_key: adminKey }),
    deleteHeat: (heatId, adminKey) => api('DELETE', `/api/admin/heats/${heatId}`, { admin_key: adminKey }),
    moveHeatEntry: (heatId, eventEntryId, targetHeatId, lane, adminKey) => api('POST', `/api/admin/heats/${heatId}/move-entry`, { admin_key: adminKey, event_entry_id: eventEntryId, target_heat_id: targetHeatId, lane_number: lane }),
    removeHeatEntry: (heatId, eventEntryId, deleteEventEntry, adminKey) => api('POST', `/api/admin/heats/${heatId}/remove-entry`, { admin_key: adminKey, event_entry_id: eventEntryId, delete_event_entry: deleteEventEntry }),
    renameHeat: (heatId, heatName, adminKey) => api('POST', `/api/heats/${heatId}/rename`, { heat_name: heatName, admin_key: adminKey }),
    forceEventStatus: (eventId, round_status, round_type, adminKey) => api('POST', `/api/admin/events/${eventId}/force-status`, { admin_key: adminKey, round_status, round_type }),
    autoSortEvents: (compId, adminKey) => api('POST', '/api/admin/events/auto-sort', { admin_key: adminKey, competition_id: compId }),
    assignLanes: (heat_id, assignments) => api('POST', '/api/lanes/assign', { heat_id, assignments }),
    // Heat edit API (manual edit after auto-allocation)
    updateHeatEntries: (heat_id, entries, adminKey) => api('POST', '/api/admin/heats/update-entries', { heat_id, entries, admin_key: adminKey }),
    getHeatAllocations: (eventId) => api('GET', `/api/events/${eventId}/heat-allocations`),
    // Create final with group count
    createFinalWithGroups: (eid, group_count) => api('POST', `/api/events/${eid}/create-final`, { group_count }),
    getRegisteredJudges: () => api('GET', '/api/registered-judges'),
    // Wind
    setHeatWind: (heatId, wind) => api('POST', `/api/heats/${heatId}/wind`, { wind }),
    getHeatWind: (heatId) => api('GET', `/api/heats/${heatId}/wind`),
    getQualifications: (eventId) => api('GET', `/api/qualifications?event_id=${eventId}`),
    // Live results
    getLiveResults: (eventId) => api('GET', `/api/events/${eventId}/live-results`),
    // Relay members
    getRelayMembers: (eventId, team) => api('GET', `/api/relay-members?event_id=${eventId}&team=${encodeURIComponent(team)}`),
    getRelayMembersByEntry: (eventEntryId) => api('GET', `/api/relay-members?event_entry_id=${eventEntryId}`),
    getRelayMembersBatch: (eventId) => api('GET', `/api/relay-members/batch?event_id=${eventId}`),
    addRelayMember: (eventEntryId, athleteId, legOrder) => api('POST', '/api/relay-members', { event_entry_id: eventEntryId, athlete_id: athleteId, leg_order: legOrder }),
    removeRelayMember: (eventEntryId, athleteId) => api('DELETE', '/api/relay-members', { event_entry_id: eventEntryId, athlete_id: athleteId }),
    updateRelayOrder: (eventEntryId, members) => api('PUT', '/api/relay-members/order', { event_entry_id: eventEntryId, members }),
    // WA validation
    validateWA: (eventId) => api('GET', `/api/wa-validate/${eventId}`),
    autoCorrectWA: (eventId) => api('POST', `/api/wa-correct/${eventId}`),
    // Pacing Light
    getPacingConfigs: (compId) => api('GET', `/api/pacing?competition_id=${compId}`),
    getPacingConfig: (id) => api('GET', `/api/pacing/${id}`),
    savePacingConfig: (data) => api('POST', '/api/pacing', data),
    deletePacingConfig: (id, adminKey) => api('DELETE', `/api/pacing/${id}`, { admin_key: adminKey }),
    getPublicPacing: (compId) => api('GET', `/api/public/pacing?competition_id=${compId}`),
};

// ============================================================
// Gender Color Helpers
// ============================================================
function getGenderColor(gender) {
    if (gender === 'M') return '#1a2a5e'; // navy
    if (gender === 'F') return '#8b1a2a'; // burgundy
    if (gender === 'X') return '#b79f58'; // gold
    return '#9E9E9E';
}
function getGenderBg(gender) {
    if (gender === 'M') return '#e8eaf0';
    if (gender === 'F') return '#f0e0e4';
    if (gender === 'X') return '#f8f4ea';
    return '#f5f5f5';
}
function getGenderLabel(gender) {
    return { M: '남자', F: '여자', X: '혼성' }[gender] || '';
}

// ============================================================
// SSE
// ============================================================
let _sseConnection = null;
let _sseListeners = {};
let _sseReconnectTimer = null;
let _sseReconnectCallbacks = [];

function connectSSE() {
    if (_sseConnection && _sseConnection.readyState !== 2) return;
    if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
    const wasReconnect = !!_sseConnection || _sseReconnectTimer !== null;
    try {
        _sseConnection = new EventSource('/api/sse');
        _sseConnection.addEventListener('connected', () => {
            console.log('[SSE] Connected');
            // Fire reconnect callbacks (refresh stale data)
            _sseReconnectCallbacks.forEach(cb => { try { cb(); } catch(e) {} });
        });
        ['result_update','entry_status','event_completed','callroom_complete','height_update','combined_update','event_reverted','operation_log','event_status_changed','wind_update','pacing_update'].forEach(evt => {
            _sseConnection.addEventListener(evt, (e) => { notifySSE(evt, JSON.parse(e.data)); });
        });
        _sseConnection.onerror = () => {
            console.log('[SSE] Error, reconnecting in 3s...');
            try { _sseConnection.close(); } catch(e) {}
            _sseConnection = null;
            _sseReconnectTimer = setTimeout(connectSSE, 3000);
        };
    } catch (e) { console.log('[SSE] Failed to connect'); }
}

function onSSE(eventType, callback) {
    if (!_sseListeners[eventType]) _sseListeners[eventType] = [];
    _sseListeners[eventType].push(callback);
}

// Register a callback to fire when SSE reconnects (for refreshing stale data)
function onSSEReconnect(callback) {
    _sseReconnectCallbacks.push(callback);
}

function notifySSE(eventType, data) {
    (_sseListeners[eventType] || []).forEach(cb => { try { cb(data); } catch (e) { console.error('[SSE] error:', e); } });
}

connectSSE();

// ============================================================
// Common UI
// ============================================================
async function renderAuditLog() {
    const el = document.getElementById('audit-log-container');
    if (!el) return;
    try {
        // Use operation_log for human-readable messages (e.g. "10종경기 결승 소집완료 - 김로운")
        const logs = await API.getOperationLog(50, getCompetitionId());
        el.innerHTML = logs.map(l => {
            const time = l.created_at ? l.created_at.substring(5, 16).replace('T', ' ') : '';
            const catBadge = l.category === 'callroom' ? '소집' : l.category === 'completion' ? '완료' : l.category === 'round' ? '라운드' : l.category === 'import' ? '업로드' : l.category === 'admin' ? '관리' : l.category || '';
            return `<div class="audit-entry"><strong>[${catBadge}]</strong> ${l.message} — ${time}</div>`;
        }).join('') || '<div class="audit-entry">기록 없음</div>';
    } catch (e) { }
}

function showBanner(el, cls, text) {
    el.className = 'barcode-banner ' + cls;
    el.textContent = text;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// Render single-line competition info bar
async function renderCompInfoBar(containerId) {
    const el = document.getElementById(containerId || 'comp-info-bar');
    if (!el) return;
    try {
        // Parallel: fetch competition info + federations simultaneously
        const [info, feds] = await Promise.all([
            API.getCompetitionInfo(getCompetitionId()),
            API.getFederations().catch(() => [])
        ]);
        let fedBadge = '';
        if (info.federation) {
            const fed = feds.find(f => f.code === info.federation);
            if (fed) {
                fedBadge = `<span style="background:${fed.badge_bg};color:${fed.badge_color};padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600;">${fed.code}</span>`;
            } else {
                fedBadge = `<span style="background:#f5f5f5;color:#616161;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600;">${info.federation}</span>`;
            }
        }
        const role = localStorage.getItem('pace_role') || 'viewer';
        // Shared button style for comp-info-bar action buttons
        const _cibBtnBase = 'white-space:nowrap;font-size:13px;font-weight:700;padding:7px 16px;border:none;border-radius:8px;color:#fff;cursor:pointer;transition:all 0.15s;letter-spacing:0.3px;';
        const docBtnHtml = role !== 'viewer'
            ? `<button id="comp-doc-btn" style="${_cibBtnBase}margin-left:auto;background:linear-gradient(135deg,#b79f58,#8a7640);box-shadow:0 2px 6px rgba(183,159,88,0.3);" onmouseover="this.style.boxShadow='0 4px 12px rgba(183,159,88,0.4)';this.style.transform='translateY(-1px)'" onmouseout="this.style.boxShadow='0 2px 6px rgba(183,159,88,0.3)';this.style.transform=''" onclick="openDocumentList()">&#44592;&#47197;&#51648;</button>`
            : '';
        // 대시보드 모드에서는 히어로 카드가 시간표 진입점을 대체하므로 상단 버튼 숨김
        const isDashboardMode = document.body.classList.contains('dashboard-mode');
        const ttBtnHtml = isDashboardMode ? '' : `<button id="comp-tt-btn" style="${_cibBtnBase}${role === 'viewer' ? 'margin-left:auto;' : 'margin-left:6px;'}background:linear-gradient(135deg,#2a3a6e,#1a2a5e);box-shadow:0 2px 6px rgba(26,42,94,0.3);" onmouseover="this.style.boxShadow='0 4px 12px rgba(26,42,94,0.4)';this.style.transform='translateY(-1px)'" onmouseout="this.style.boxShadow='0 2px 6px rgba(26,42,94,0.3)';this.style.transform=''" onclick="openTimetable()">&#49884;&#44036;&#54364;</button>`;
        el.innerHTML = `<span class="comp-info-name">${info.name || ''}</span>
            ${fedBadge}
            <span class="comp-info-sep">|</span>
            <span class="comp-info-dates">${info.dates || ''}</span>
            <span class="comp-info-sep">|</span>
            <span class="comp-info-venue">${info.venue || ''}</span>
            ${docBtnHtml}${ttBtnHtml}`;
    } catch (e) {}
}

// ============================================================
// Competition Selector (date-aware: active now or starting within 14 days)
// ============================================================
async function renderCompSelector(currentPage) {
    const container = document.getElementById('comp-selector');
    if (!container) return;
    try {
        const all = await API.getCompetitions();
        // Date-based filter: show competitions that are currently relevant
        // 1. status 'active' (running right now)
        // 2. status 'upcoming' AND start_date within 14 days from today
        // 3. Always include the currently selected competition
        const today = new Date(); today.setHours(0,0,0,0);
        const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + 14);
        const currentId = getCompetitionId();

        const comps = all.filter(c => {
            // Always show the competition the user is currently viewing
            if (String(c.id) === currentId) return true;
            // Active competitions (in progress)
            if (c.status === 'active') return true;
            // Upcoming within 14 days
            if (c.status === 'upcoming' && c.start_date) {
                const start = new Date(c.start_date + 'T00:00:00');
                return start <= cutoff;
            }
            return false;
        });
        if (comps.length <= 1) {
            container.style.display = 'none';
            return;
        }
        const opts = comps.map(c => {
            const dot = c.status === 'active' ? '\u25CF' : '\u25CB';
            return `<option value="${c.id}" ${String(c.id) === currentId ? 'selected' : ''}>${dot} ${c.name}</option>`;
        }).join('');
        container.style.cssText = 'margin-bottom:8px;';
        container.innerHTML = `<select id="comp-dropdown" style="
            width:100%; padding:10px 32px 10px 12px; border-radius:8px;
            border:none; font-size:13px; font-weight:700; letter-spacing:0.3px;
            background:#b79f58; color:#fff;
            cursor:pointer; appearance:auto;
            -webkit-appearance:auto;
        ">${opts}</select>`;
        const page = currentPage || 'dashboard';
        document.getElementById('comp-dropdown').addEventListener('change', function() {
            const newId = this.value;
            setCompetitionId(newId);
            location.href = '/' + page + '.html?comp=' + newId;
        });
    } catch(e) {
        container.style.display = 'none';
    }
}

function renderPageNav(currentPage) {
    const nav = document.getElementById('page-nav');
    if (!nav) return;
    const compId = getCompetitionId();
    const q = compId ? `?comp=${compId}` : '';
    const role = localStorage.getItem('pace_role') || 'viewer';

    // Inject login button + refresh button into header-inner if not already there (all pages)
    const headerInner = document.querySelector('.header-inner');
    if (headerInner && !document.getElementById('header-login-btn')) {
        // Create a button group wrapper
        const btnGroup = document.createElement('div');
        btnGroup.className = 'header-btn-group';

        // Back button (for PWA / standalone mode)
        const backBtn = document.createElement('button');
        backBtn.className = 'header-nav-btn';
        backBtn.id = 'header-back-btn';
        backBtn.title = '\ub4a4\ub85c';
        backBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
        backBtn.onclick = function() { history.back(); };

        // Forward button (for PWA / standalone mode)
        const fwdBtn = document.createElement('button');
        fwdBtn.className = 'header-nav-btn';
        fwdBtn.id = 'header-fwd-btn';
        fwdBtn.title = '\uc55e\uc73c\ub85c';
        fwdBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
        fwdBtn.onclick = function() { history.forward(); };

        // Refresh button
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'header-refresh-btn';
        refreshBtn.id = 'header-refresh-btn';
        refreshBtn.title = '\uc0c8\ub85c\uace0\uce68';
        refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
        refreshBtn.onclick = function() {
            location.reload();
        };

        // Login button
        const loginBtn = document.createElement('button');
        loginBtn.className = 'header-login-btn' + (role !== 'viewer' ? ' logged-in' : '');
        loginBtn.id = 'header-login-btn';
        loginBtn.innerHTML = `<span id="header-login-label">${role !== 'viewer' ? '\ub85c\uadf8\uc544\uc6c3' : '\ub85c\uadf8\uc778'}</span>`;
        loginBtn.onclick = function() {
            const r = localStorage.getItem('pace_role') || 'viewer';
            if (r !== 'viewer') {
                // Logout
                localStorage.removeItem('pace_admin_key');
                localStorage.removeItem('pace_role');
                localStorage.removeItem('pace_judge_name');
                location.reload();
            } else if (window._headerLoginToggle) {
                window._headerLoginToggle();
            } else {
                window.location.href = '/?action=login';
            }
        };

        btnGroup.appendChild(backBtn);
        btnGroup.appendChild(fwdBtn);
        btnGroup.appendChild(refreshBtn);
        btnGroup.appendChild(loginBtn);
        headerInner.appendChild(btnGroup);

        // ── Mobile hamburger button ──
        if (!document.getElementById('hamburger-btn')) {
            const hamburger = document.createElement('button');
            hamburger.className = 'hamburger-btn';
            hamburger.id = 'hamburger-btn';
            hamburger.innerHTML = '&#9776;';
            hamburger.onclick = function() { openMobileMenu(); };
            headerInner.appendChild(hamburger);
        }
    }

    // Make header title clickable → home
    const headerTitle = document.querySelector('.header-title');
    if (headerTitle && !headerTitle.dataset.linked) {
        headerTitle.style.cursor = 'pointer';
        headerTitle.addEventListener('click', () => { window.location.href = '/'; });
        headerTitle.dataset.linked = '1';
    }

    let pages;
    if (currentPage === 'home' && role !== 'admin' && role !== 'operation') {
        // Home (viewer): only show home — no other nav links
        pages = [{ key: 'home', label: '\ud648', href: '/' }];
    } else if (role === 'admin' || role === 'operation') {
        // Admin/Operation: all pages including admin (results removed for display mode)
        pages = [
            { key: 'home', label: '\ud648', href: '/' },
            { key: 'dashboard', label: '\ub300\uc2dc\ubcf4\ub4dc', href: `/dashboard.html${q}` },
            { key: 'display-manage', label: '\ub178\ucd9c\uad00\ub9ac', href: `/display-manage.html${q}` },
            { key: 'monitor', label: '\ubaa8\ub2c8\ud130', href: `/monitor.html${q}` },
            { key: 'callroom', label: '\uc18c\uc9d1\uc2e4', href: `/callroom.html${q}` },
            { key: 'record', label: '\uae30\ub85d\uc785\ub825', href: `/record.html${q}` },
            { key: 'admin', label: '\uad00\ub9ac', href: `/admin.html${q}` },
        ];
    } else {
        // Viewer: dashboard only (results page removed)
        pages = [
            { key: 'home', label: '\ud648', href: '/' },
            { key: 'dashboard', label: '\ub300\uc2dc\ubcf4\ub4dc', href: `/dashboard.html${q}` },
        ];
    }
    nav.innerHTML = pages.map(p =>
        `<a href="${p.href}" class="nav-link ${p.key === currentPage ? 'active' : ''}" data-page-key="${p.key}">${p.label}</a>`
    ).join('');

    // ── Build mobile menu (once) ──
    _buildMobileMenu(pages, currentPage, role);

    // ── Conditional nav-link visibility (callroom 종료, 노출관리 mode별) ──
    _adjustNavLinkVisibility(nav);
}

// ============================================================
// Conditional nav-link visibility based on the currently selected competition
//   • callroom        : 대회 종료(status=completed 또는 end_date 경과) 시 숨김
//   • display-manage  : mode='display'(노출용) 대회일 때만 노출. operation 또는 미선택 시 숨김.
//
// 두 가지를 하나의 fetch 결과로 함께 처리해 추가 네트워크 비용 없음.
// 정책: 대회 미선택(viewer 진입 등) 시 callroom은 노출 유지(viewer 자체가 의미있을 수 있음),
//       display-manage는 안전하게 숨김(노출용 대회 컨텍스트가 없으면 의미 없음).
// ============================================================
async function _adjustNavLinkVisibility(nav) {
    const hideLink = (key) => {
        if (nav) {
            const a = nav.querySelector(`a[data-page-key="${key}"]`);
            if (a) a.style.display = 'none';
        }
        const mobileMenu = document.getElementById('mobile-menu');
        if (mobileMenu) {
            mobileMenu.querySelectorAll(`a[data-page-key="${key}"]`).forEach(l => l.style.display = 'none');
        }
    };

    const compId = getCompetitionId();
    if (!compId) {
        // 대회 미선택: display-manage는 의미 없으므로 숨김. callroom은 그대로.
        hideLink('display-manage');
        return;
    }
    try {
        const comp = await API.getCompetition(compId);
        if (!comp) {
            hideLink('display-manage');
            return;
        }
        // (1) callroom: 종료된 대회면 숨김
        const today = new Date().toISOString().slice(0, 10);
        const isEnded = comp.status === 'completed' || (comp.end_date && comp.end_date < today);
        if (isEnded) hideLink('callroom');

        // (2) display-manage: 노출용 대회에서만 노출
        if (comp.mode !== 'display') hideLink('display-manage');
    } catch(e) { /* silently ignore */ }
}

// ============================================================
// Mobile hamburger menu
// ============================================================
function _buildMobileMenu(pages, currentPage, role) {
    // Remove existing mobile menu to rebuild with updated nav links
    const existing = document.getElementById('mobile-menu');
    if (existing) existing.remove();
    const existingOverlay = document.getElementById('mobile-menu-overlay');
    if (existingOverlay) existingOverlay.remove();

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'mobile-menu-overlay';
    overlay.id = 'mobile-menu-overlay';
    overlay.onclick = closeMobileMenu;

    // Menu panel
    const menu = document.createElement('div');
    menu.className = 'mobile-menu';
    menu.id = 'mobile-menu';

    let navLinks = pages.map(p =>
        `<a href="${p.href}" class="${p.key === currentPage ? 'mm-active' : ''}" data-page-key="${p.key}">${p.label}</a>`
    ).join('');

    const loginLabel = role !== 'viewer' ? '\ub85c\uadf8\uc544\uc6c3' : '\ub85c\uadf8\uc778';
    const loginColor = role !== 'viewer' ? 'color:#E53935;' : '';

    menu.innerHTML = `
        <div class="mobile-menu-header">
            <span class="mm-brand">PACE RISE <span class="mm-colon">:</span> <span class="mm-scope">Node</span></span>
            <button class="mobile-menu-close" onclick="closeMobileMenu()">&times;</button>
        </div>
        <div class="mobile-menu-nav">${navLinks}</div>
        <div class="mobile-menu-footer">
            <div class="mobile-menu-divider"></div>
            <button class="mm-action" style="${loginColor}" onclick="mobileMenuLogin()">
                <span>${loginLabel}</span>
            </button>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(menu);
}

function openMobileMenu() {
    const overlay = document.getElementById('mobile-menu-overlay');
    const menu = document.getElementById('mobile-menu');
    if (overlay) overlay.classList.add('open');
    if (menu) { menu.classList.add('open'); }
    document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
    const overlay = document.getElementById('mobile-menu-overlay');
    const menu = document.getElementById('mobile-menu');
    if (menu) menu.classList.remove('open');
    if (overlay) { overlay.classList.remove('open'); setTimeout(() => { overlay.style.display = ''; }, 250); }
    document.body.style.overflow = '';
}

function mobileMenuLogin() {
    closeMobileMenu();
    const r = localStorage.getItem('pace_role') || 'viewer';
    if (r !== 'viewer') {
        localStorage.removeItem('pace_admin_key');
        localStorage.removeItem('pace_role');
        localStorage.removeItem('pace_judge_name');
        location.reload();
    } else if (window._headerLoginToggle) {
        window._headerLoginToggle();
    } else {
        window.location.href = '/?action=login';
    }
}

// ============================================================
// Unsaved changes guard
// ============================================================
let _unsavedChanges = false;
function markUnsaved() { _unsavedChanges = true; }
function clearUnsaved() { _unsavedChanges = false; }
function hasUnsaved() { return _unsavedChanges; }
window.addEventListener('beforeunload', e => { if (_unsavedChanges) { e.preventDefault(); e.returnValue = ''; } });

function checkUnsavedBeforeAction(cb) {
    if (!_unsavedChanges) { cb(); return; }
    if (confirm('저장되지 않은 변경사항이 있습니다. 이동하시겠습니까?')) { clearUnsaved(); cb(); }
}

function getConfirmModalHTML() {
    return `<div id="confirm-overlay" class="modal-overlay" style="display:none;">
        <div class="modal modal-sm">
            <div class="modal-header"><div class="modal-title">저장되지 않은 변경사항</div></div>
            <div class="modal-form"><p style="padding:8px 0;">현재 입력 중인 기록이 저장되지 않았습니다.<br>이동하시겠습니까?</p></div>
            <div class="modal-footer">
                <button id="confirm-stay-btn" class="btn btn-ghost">취소</button>
                <button id="confirm-leave-btn" class="btn btn-danger">이동</button>
            </div>
        </div>
    </div>`;
}

// Check competition context — try auto-detect, else redirect to home
async function requireCompetition() {
    let compId = getCompetitionId();
    if (!compId) {
        // Try to auto-detect: use cached competitions list
        try {
            const comps = await API.getCompetitions();
            if (comps && comps.length > 0) {
                // Prefer active, then upcoming, then first
                const active = comps.find(c => c.status === 'active');
                const upcoming = comps.find(c => c.status === 'upcoming');
                const pick = active || upcoming || comps[0];
                setCompetitionId(pick.id);
                return true;
            }
        } catch(e) {}
        window.location.href = '/';
        return false;
    }
    return true;
}

// ============================================================
// YouTube Video Modal Player
// ============================================================
function extractYouTubeId(url) {
    if (!url) return null;
    let m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}
function extractYouTubeStart(url) {
    if (!url) return 0;
    // t=1h2m30s or t=2m30s or t=45s format first
    let m = url.match(/[?&]t=(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)/);
    if (m) return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
    // ?t=120 or &t=120 or ?start=120 (pure seconds)
    m = url.match(/[?&](?:t|start)=(\d+)/);
    if (m) return parseInt(m[1]);
    return 0;
}
function openVideoModal(url, title) {
    if (!url) return;
    const ytId = extractYouTubeId(url);
    let existing = document.getElementById('video-modal-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'video-modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:100000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease;';
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); } };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:#000;border-radius:12px;overflow:hidden;width:90%;max-width:800px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    if (title) {
        const hdr = document.createElement('div');
        hdr.style.cssText = 'padding:10px 16px;background:#111;color:#fff;font-size:13px;font-weight:600;display:flex;justify-content:space-between;align-items:center;';
        hdr.innerHTML = `<span>${title}</span><button onclick="this.closest('#video-modal-overlay').remove()" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;line-height:1;">&times;</button>`;
        modal.appendChild(hdr);
    }
    const body = document.createElement('div');
    body.style.cssText = 'position:relative;padding-bottom:56.25%;height:0;';
    if (ytId) {
        const startSec = extractYouTubeStart(url);
        const startParam = startSec > 0 ? `&start=${startSec}` : '';
        const origin = encodeURIComponent(window.location.origin);
        body.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0&enablejsapi=1&origin=${origin}${startParam}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" allow="autoplay;encrypted-media;fullscreen" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>`;
    } else {
        // Direct video URL fallback
        body.innerHTML = `<video src="${url}" controls autoplay style="position:absolute;top:0;left:0;width:100%;height:100%;" />`;
    }
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    // ESC key close
    const escHandler = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
}

// ============================================================
// Branding Footer (injected dynamically)
// ============================================================
(function injectBrandingFooter() {
    if (document.getElementById('pacerise-footer')) return;
    // Dashboard has its own fixed footer — skip injection
    if (document.body.classList.contains('dashboard-mode')) return;
    const footer = document.createElement('footer');
    footer.id = 'pacerise-footer';
    footer.innerHTML = `
        <div class="pr-footer-inner">
            <div class="pr-footer-brand">Competition Operating System</div>
            <div class="pr-footer-powered">Powered by <span class="pr-footer-logo">PACE RISE</span></div>
            <div class="pr-footer-links">
                <a href="https://pace-rise.com" target="_blank" rel="noopener">pace-rise.com</a>
                <span class="pr-footer-sep">|</span>
                <a href="https://instagram.com/pace.rise" target="_blank" rel="noopener">@pace.rise</a>
                <span class="pr-footer-sep">|</span>
                <a href="mailto:pacerise.run@gmail.com">pacerise.run@gmail.com</a>
            </div>
            <div class="pr-footer-privacy">
                <details>
                    <summary>개인정보 처리 안내</summary>
                    <div class="pr-privacy-content">
                        <p><strong>1. 수집 주체</strong><br>PACE RISE (시스템 운영) 및 각 대회 주최·주관 단체</p>
                        <p><strong>2. 수집 항목</strong><br>선수 정보: 이름, 소속(팀), 배번, 성별, 바코드<br>대회 정보: 대회명, 일정, 장소, 종목, 경기 기록, 영상<br>운영 정보: 관리자 계정(이름, 접속키), 접속 로그, 운영 로그</p>
                        <p><strong>3. 수집 및 이용 목적</strong><br>대회 운영 및 실시간 경기 기록 관리<br>경기 결과 공개 및 기록 조회 서비스 제공<br>페이싱 라이트(Wave Light) 등 경기 보조 기능 제공<br>대회 통계 분석 및 시스템 개선</p>
                        <p><strong>4. 보관 기간</strong><br>수집된 정보는 <strong>영구 보관</strong>됩니다.<br>대회 기록의 역사적 가치 및 통계 활용을 위해 별도 삭제하지 않습니다.<br>삭제를 원하시는 경우 아래 연락처로 요청해 주세요.</p>
                        <p><strong>5. 제3자 제공</strong><br>대회 주최·주관 단체 및 소속 연맹에 대회 운영 목적으로 제공됩니다.<br>경기 결과는 누구나 열람 가능한 형태로 공개될 수 있습니다.</p>
                        <p><strong>6. 정보주체의 권리</strong><br>본인 정보의 열람, 정정, 삭제를 요청할 수 있습니다.<br>대회 주최측 또는 PACE RISE에 연락하여 요청해 주세요.</p>
                        <p><strong>7. 문의</strong><br>PACE RISE: pacerise.run@gmail.com<br>각 대회별 주최·주관 단체 연락처는 해당 대회 정보를 참고해 주세요.</p>
                    </div>
                </details>
            </div>
        </div>
    `;
    footer.style.cssText = 'text-align:center;padding:24px 16px 18px;margin-top:40px;border-top:1px solid #e5e7eb;background:#fafbfc;';
    const style = document.createElement('style');
    style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Audiowide&display=swap');
        #pacerise-footer .pr-footer-inner { max-width:600px; margin:0 auto; }
        #pacerise-footer .pr-footer-brand { font-family:'Audiowide','Noto Sans KR',sans-serif; font-size:11px; color:#9ca3af; letter-spacing:1.5px; text-transform:uppercase; margin-bottom:4px; }
        #pacerise-footer .pr-footer-powered { font-size:10px; color:#b0b8c4; margin-bottom:8px; }
        #pacerise-footer .pr-footer-logo { font-family:'Audiowide','Noto Sans KR',sans-serif; font-size:12px; color:#6b7280; letter-spacing:2px; }
        #pacerise-footer .pr-footer-links { font-size:10px; color:#9ca3af; }
        #pacerise-footer .pr-footer-links a { color:#6b7280; text-decoration:none; transition:color 0.15s; }
        #pacerise-footer .pr-footer-links a:hover { color:#b79f58; }
        #pacerise-footer .pr-footer-sep { margin:0 8px; color:#d1d5db; }
        #pacerise-footer .pr-footer-privacy { margin-top:12px; border-top:1px solid #e5e7eb; padding-top:10px; }
        #pacerise-footer .pr-footer-privacy summary { font-size:10px; color:#9ca3af; cursor:pointer; }
        #pacerise-footer .pr-footer-privacy summary:hover { color:#6b7280; }
        #pacerise-footer .pr-privacy-content { text-align:left; font-size:10px; color:#6b7280; line-height:1.6; margin-top:8px; }
        #pacerise-footer .pr-privacy-content p { margin-bottom:6px; }
        #pacerise-footer .pr-privacy-content strong { color:#374151; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(footer);
})();

// ============================================================
// Toast Notification
// ============================================================
function showToast(message, type = 'success', duration = 2000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    const bg = type === 'success' ? 'var(--green)' : type === 'error' ? '#8b1a2a' : '#b79f58';
    toast.style.cssText = `background:${bg};color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.15);opacity:0;transform:translateY(10px);transition:all 0.25s ease;pointer-events:auto;`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
    setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ============================================================
// BACK BUTTON & SWIPE MODAL CLOSE
// Android hardware back / iPhone swipe-back should close modal, not exit app
// ============================================================
(function() {
    let _modalStack = [];

    // Push a modal state: call this when opening any overlay/modal
    window.pushModalState = function(closeCallback) {
        _modalStack.push(closeCallback);
        history.pushState({ modal: true, depth: _modalStack.length }, '');
    };
    // Pop a modal state: call this when closing a modal normally
    window.popModalState = function() {
        if (_modalStack.length > 0) {
            _modalStack.pop();
            // Silently go back to remove the history entry we pushed
            try { history.back(); } catch(e) {}
        }
    };

    window.addEventListener('popstate', function(e) {
        if (_modalStack.length > 0) {
            const closeFn = _modalStack.pop();
            if (closeFn) closeFn();
        }
    });
})();

// ============================================================
// PWA Service Worker Registration + Offline Sync
// ============================================================
const _EXPECTED_SW_VERSION = 'pacerise-v46';
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Force update: clear old caches that don't match current version
        if (window.caches) {
            caches.keys().then(keys => {
                keys.forEach(k => {
                    if (k.startsWith('pacerise-') && k !== _EXPECTED_SW_VERSION) {
                        caches.delete(k);
                        console.log('[SW] Deleted stale cache:', k);
                    }
                });
            });
        }
        navigator.serviceWorker.register('/sw.js').then(reg => {
            // Force SW update check
            reg.update().catch(() => {});
            // When a new SW is found, force it to activate immediately
            reg.addEventListener('updatefound', () => {
                const newSW = reg.installing;
                if (newSW) {
                    newSW.addEventListener('statechange', () => {
                        if (newSW.state === 'activated') {
                            console.log('[SW] New version activated, reloading for fresh content');
                            window.location.reload();
                        }
                    });
                }
            });
            // Listen for offline queue messages from SW
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data.type === 'OFFLINE_QUEUED') {
                    showToast('Offline: queued for sync', 'warning', 3000);
                    _updateOfflineBadge();
                }
                if (event.data.type === 'SYNC_COMPLETE') {
                    const { synced, failed } = event.data;
                    if (synced > 0) showToast(`Synced ${synced} offline changes`, 'success', 3000);
                    if (failed > 0) showToast(`${failed} changes failed to sync`, 'error', 3000);
                    _updateOfflineBadge();
                }
            });
        }).catch(() => {});
    });
}

// ---- Offline awareness ----
let _isOffline = !navigator.onLine;
window.addEventListener('online', () => {
    _isOffline = false;
    _updateOfflineBadge();
    showToast('Online', 'success', 2000);
    // Trigger manual sync via SW
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        const mc = new MessageChannel();
        navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_SYNC' }, [mc.port2]);
    }
    // Also try Background Sync API
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(reg => reg.sync.register('pacerise-sync'));
    }
});
window.addEventListener('offline', () => {
    _isOffline = true;
    _updateOfflineBadge();
    showToast('Offline mode', 'warning', 3000);
});

function _updateOfflineBadge() {
    let badge = document.getElementById('offline-badge');
    if (_isOffline) {
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'offline-badge';
            badge.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;background:#f59e0b;color:#fff;text-align:center;font-size:11px;font-weight:700;padding:3px 0;letter-spacing:0.5px;';
            badge.textContent = 'OFFLINE MODE';
            document.body.appendChild(badge);
        }
    } else {
        if (badge) badge.remove();
    }
}

// ---- Pending sync count helper ----
async function getOfflineQueueCount() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return 0;
    return new Promise((resolve) => {
        const mc = new MessageChannel();
        mc.port1.onmessage = (e) => resolve(e.data.pending || 0);
        navigator.serviceWorker.controller.postMessage({ type: 'GET_QUEUE_STATUS' }, [mc.port2]);
        setTimeout(() => resolve(0), 2000);
    });
}

// ============================================================
// DOCUMENT GENERATION HELPERS
// ============================================================
function openStartList(eventId) {
    window.open(`/api/documents/start-list/${eventId}`, '_blank');
}
function openResultSheet(eventId) {
    window.open(`/api/documents/result-sheet/${eventId}`, '_blank');
}
function openADCards(compId) {
    window.open(`/api/documents/ad-card/${compId || getCompetitionId()}`, '_blank');
}
// ============================================================
// TIMETABLE VIEWER (시간표)
// ============================================================
async function openTimetable(compId) {
    compId = compId || getCompetitionId();
    if (!compId) { showToast('대회를 먼저 선택하세요', 'error'); return; }
    try {
        const data = await API.getTimetable(compId);
        const dayKeys = Object.keys(data.days || {}).map(Number).sort((a, b) => a - b);
        if (dayKeys.length === 0) { showToast('등록된 시간표가 없습니다', 'error'); return; }

        let overlay = document.getElementById('timetable-overlay');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'timetable-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        const modal = document.createElement('div');
        modal.style.cssText = 'background:#fff;border-radius:16px;max-width:720px;width:94%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.3);overflow:hidden;';

        // Count total items
        let totalItems = 0;
        dayKeys.forEach(d => {
            const dd = data.days[d];
            totalItems += (dd.track || []).length + (dd.field || []).length;
        });

        // Header (matching document list modal style)
        const headerHtml = `<div style="background:linear-gradient(135deg,#f0f0f0,#d8d8d8);padding:18px 22px;border-bottom:1px solid #c0c0c0;flex-shrink:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <h3 style="font-size:18px;font-weight:800;margin:0;color:#4a4a4a;">경기 시간표</h3>
                    <p style="font-size:11px;color:#8a8a8a;margin:3px 0 0;font-weight:500;">Competition Timetable · 총 ${totalItems}개 경기</p>
                </div>
                <button onclick="document.getElementById('timetable-overlay').remove()" style="background:rgba(255,255,255,0.8);border:1px solid #c0c0c0;width:34px;height:34px;border-radius:50%;font-size:18px;cursor:pointer;color:#555;display:flex;align-items:center;justify-content:center;transition:all 0.15s;font-weight:300;" onmouseover="this.style.background='#fff';this.style.borderColor='#8a8a8a'" onmouseout="this.style.background='rgba(255,255,255,0.8)';this.style.borderColor='#c0c0c0'">&times;</button>
            </div>
            <div id="tt-day-tabs" style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;"></div>
        </div>`;

        const contentHtml = `<div id="tt-content" style="overflow-y:auto;padding:16px 22px 22px;flex:1;"></div>`;
        modal.innerHTML = headerHtml + contentHtml;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Day tabs
        const tabContainer = document.getElementById('tt-day-tabs');

        // 일차의 마지막 경기 시작시각(분) 계산 헬퍼
        function _ttModalLastEventMin(dayNum) {
            const dd = data.days[dayNum];
            if (!dd) return -1;
            let last = -1;
            ['track','field'].forEach(sec => {
                (dd[sec] || []).forEach(it => {
                    if (!it.time) return;
                    const m = String(it.time).match(/^(\d{1,2}):(\d{2})/);
                    if (!m) return;
                    const mins = parseInt(m[1],10)*60 + parseInt(m[2],10);
                    if (mins > last) last = mins;
                });
            });
            return last;
        }

        // Auto-detect current day with 30-minute transition rule
        // 규칙: 오늘이 N일차이고 (마지막 경기 시작 + 30분) 지나면 N+1일차 기본 활성.
        //       대회 마지막 N일차 + 30분 지나면 1일차로 폴백(대회 종료 후 기본 표시).
        const _TT_NEXT_DAY_OFFSET_MIN = 30;
        let activeDay = dayKeys[0]; // fallback: first day
        let _allEnded = false; // 대회 전부 종료 여부 (정보용)
        if (data.start_date) {
            const now = new Date(); // browser local time (KST)
            const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
            const start = new Date(data.start_date + 'T00:00:00');
            const today = new Date(todayStr + 'T00:00:00');
            const diffDays = Math.floor((today - start) / (1000 * 60 * 60 * 24)) + 1;
            const nowMin = now.getHours()*60 + now.getMinutes();

            if (diffDays < dayKeys[0]) {
                // 대회 시작 전
                activeDay = dayKeys[0];
            } else if (dayKeys.includes(diffDays)) {
                // 오늘이 대회 일차 범위 안
                const lastMin = _ttModalLastEventMin(diffDays);
                if (lastMin >= 0 && nowMin >= lastMin + _TT_NEXT_DAY_OFFSET_MIN) {
                    // 오늘 + 30분 지남 → 다음 일차로
                    const nextDay = dayKeys.find(d => d > diffDays);
                    if (nextDay) {
                        activeDay = nextDay;
                    } else {
                        // 마지막 날이었음 → 대회 종료, 1일차 기본 표시
                        activeDay = dayKeys[0];
                        _allEnded = true;
                    }
                } else {
                    activeDay = diffDays;
                }
            } else if (diffDays > dayKeys[dayKeys.length - 1]) {
                // 대회 마지막 일차도 지남 → 1일차 기본 표시
                activeDay = dayKeys[0];
                _allEnded = true;
            } else {
                // 사이의 휴식일 등 → 가장 가까운 미래 일차
                const futureDay = dayKeys.find(d => d >= diffDays);
                activeDay = futureDay || dayKeys[0];
            }
        }
        // Store current HH:MM for highlighting
        const _nowForHighlight = new Date();
        const _currentHHMM = String(_nowForHighlight.getHours()).padStart(2,'0') + ':' + String(_nowForHighlight.getMinutes()).padStart(2,'0');

        function renderDayTabs() {
            tabContainer.innerHTML = dayKeys.map(d => {
                const dd = data.days[d];
                const cnt = (dd.track || []).length + (dd.field || []).length;
                const isActive = d === activeDay;
                return `<button onclick="window._ttShowDay(${d})" style="padding:6px 16px;border-radius:20px;border:1.5px solid ${isActive ? '#6b6b6b' : '#c0c0c0'};background:${isActive ? '#6b6b6b' : '#fff'};color:${isActive ? '#fff' : '#6b6b6b'};font-size:12px;font-weight:${isActive ? '700' : '500'};cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:4px;">${d}일차 <span style="font-size:10px;opacity:.7;">(${cnt})</span></button>`;
            }).join('');
        }

        function renderDay(dayNum) {
            activeDay = dayNum;
            renderDayTabs();
            const dayData = data.days[dayNum];
            if (!dayData) { document.getElementById('tt-content').innerHTML = '<p style="color:#999;text-align:center;padding:40px 0;">데이터 없음</p>'; return; }

            // Determine if this is today's schedule
            let isTodayDay = false;
            if (data.start_date) {
                const nowD = new Date();
                const todayS = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-${String(nowD.getDate()).padStart(2,'0')}`;
                const startD = new Date(data.start_date + 'T00:00:00');
                const todayD = new Date(todayS + 'T00:00:00');
                const diff = Math.floor((todayD - startD) / (1000 * 60 * 60 * 24)) + 1;
                if (diff === dayNum) isTodayDay = true;
            }

            // Find closest event to current time (TRACK only for better UX)
            let closestEventId = null;
            if (isTodayDay) {
                let minDiff = Infinity;
                const nowMins = _nowForHighlight.getHours() * 60 + _nowForHighlight.getMinutes();
                (dayData['track'] || []).forEach(item => {
                    if (!item.time) return;
                    const [h, m] = item.time.split(':').map(Number);
                    if (isNaN(h)) return;
                    const itemMins = h * 60 + (m || 0);
                    const d = Math.abs(itemMins - nowMins);
                    if (d < minDiff) { minDiff = d; closestEventId = 'tt-item-' + item.id; }
                });
            }

            let html = '';
            const sections = [
                { key: 'track', label: '트랙 경기', badgeCls: 'ico ico-track', badgeText: 'TRACK', color: '#6b6b6b', bg: '#f0f0f0', border: '#c0c0c0' },
                { key: 'field', label: '필드 경기', badgeCls: 'ico ico-field', badgeText: 'FIELD', color: '#b79f58', bg: '#f8f4ea', border: '#e8dfc0' }
            ];

            for (const sec of sections) {
                const items = dayData[sec.key] || [];
                if (items.length === 0) continue;

                html += `<div style="margin-bottom:16px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid ${sec.bg};">
                        <span class="${sec.badgeCls}">${sec.badgeText}</span>
                        <span style="font-size:14px;font-weight:800;color:${sec.color};">${sec.label}</span>
                        <span style="font-size:11px;color:#999;margin-left:auto;">${items.length}개</span>
                    </div>
                    <div style="background:#fff;border:1px solid ${sec.border};border-radius:10px;overflow:hidden;">`;

                items.forEach((item, idx) => {
                    const borderBottom = idx < items.length - 1 ? 'border-bottom:1px solid #f5f5f5;' : '';
                    const isHighlighted = closestEventId === ('tt-item-' + item.id);
                    const highlightStyle = isHighlighted ? 'background:#f5f0e0 !important;border-left:3px solid #b79f58;' : '';
                    const nowBadge = isHighlighted ? '<span style="background:#b79f58;color:#fff;font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:4px;">NOW</span>' : '';
                    // Call Room badge: show only within callroom_time -10min ~ +5min (KST)
                    const crBadge = isCallRoomWindow(item.callroom_time, item.scheduled_date) ? '<span class="ico-callroom" style="margin-left:4px;">Call Room</span>' : '';
                    const hasLink = !!item.event_id;
                    const defaultBg = idx % 2 && !isHighlighted ? '#fafbfc' : '';
                    const hoverBg = hasLink ? '#f8f4ea' : '';
                    const restoreBg = isHighlighted ? '#f5f0e0' : defaultBg;
                    // Build combined event name: "종별 종목명 라운드명" (e.g., "남고 100m 예선")
                    const _roundFull = (item.round || '').trim();
                    const _bracketMatch = _roundFull.match(/\(([^)]+)\)/);
                    const _roundBase = _roundFull.replace(/\([^)]*\)/g, '').trim();
                    const _eventFullName = `${item.category || ''} ${item.event_name}${_roundBase ? ' ' + _roundBase : ''}`.trim();
                    // Right-aligned tags: result link badge + round badge + bracket info (color-coded)
                    const _resultTag = item.result_url ? `<span style="color:#fff;font-size:9px;font-weight:700;background:#2e7d32;padding:2px 6px;border-radius:8px;white-space:nowrap;cursor:pointer;" onclick="event.stopPropagation();window.open('${(item.result_url||'').replace(/'/g,"\\'")}','_blank')">결과</span>` : '';
                    const _bracketTag = _bracketMatch ? `<span style="color:#8a7640;font-size:10px;font-weight:600;background:#f8f4ea;padding:1px 6px;border-radius:8px;white-space:nowrap;">(${_bracketMatch[1]})</span>` : '';
                    const _roundColorMap = { '예선': { color: '#1565c0', bg: '#e3f2fd' }, '준결승': { color: '#e65100', bg: '#fff3e0' }, '결승': { color: '#b71c1c', bg: '#ffebee' }, '기록경기': { color: '#4a148c', bg: '#f3e5f5' } };
                    const _rbc = _roundColorMap[_roundBase] || { color: '#555', bg: '#f0f0f0' };
                    const _roundBadge = _roundBase ? `<span style="color:${_rbc.color};font-size:10px;font-weight:600;background:${_rbc.bg};padding:1px 6px;border-radius:8px;white-space:nowrap;">${_roundBase}</span>` : '';
                    // Click behavior: display mode → open result_url if exists, else do nothing
                    // Non-display mode → navigate to event
                    let clickAction = '';
                    if (hasLink) {
                        if (typeof _isDisplayMode !== 'undefined' && _isDisplayMode) {
                            clickAction = `onclick="window._ttOpenResultUrl(${item.event_id})"`;
                        } else {
                            clickAction = `onclick="window._ttGoToEvent(${item.event_id})"`;
                        }
                    }
                    html += `<div id="tt-item-${item.id}" ${clickAction} style="display:flex;align-items:center;gap:8px;padding:9px 12px;${borderBottom}${defaultBg ? 'background:' + defaultBg + ';' : ''}${highlightStyle}${hasLink ? 'cursor:pointer;transition:background .1s;' : ''}" ${hasLink ? `onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${restoreBg}'"` : ''}>
                        <span style="font-weight:700;color:#333;font-size:13px;font-variant-numeric:tabular-nums;min-width:48px;white-space:nowrap;">${item.time}${nowBadge}</span>
                        <span style="flex:1;font-weight:600;font-size:13px;color:#222;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_eventFullName}${crBadge}</span>
                        <div style="display:flex;gap:3px;flex-shrink:0;align-items:center;">${_resultTag}${_roundBadge}${_bracketTag}</div>
                    </div>`;
                });

                html += '</div></div>';
            }

            document.getElementById('tt-content').innerHTML = html || '<p style="color:#999;text-align:center;padding:40px 0;">데이터 없음</p>';

            // Auto-scroll to highlighted event
            if (closestEventId) {
                setTimeout(() => {
                    const el = document.getElementById(closestEventId);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            }
        }

        window._ttShowDay = renderDay;
        // Display mode: open result_url in new tab (if exists)
        window._ttOpenResultUrl = async function(eventId) {
            try {
                const evt = await API.getEvent(eventId);
                if (evt && evt.result_url) {
                    window.open(evt.result_url, '_blank');
                }
                // No result_url → do nothing
            } catch(e) { /* silent */ }
        };
        window._ttGoToEvent = function(eventId) {
            // Close timetable overlay and navigate to event
            const overlay = document.getElementById('timetable-overlay');
            if (overlay) overlay.remove();
            // Determine current page and trigger event selection
            const page = location.pathname;
            if (page.includes('dashboard')) {
                if (typeof openLiveResult === 'function') openLiveResult(eventId);
            } else if (page.includes('callroom')) {
                if (typeof selectEvent === 'function') selectEvent(eventId);
            } else if (page.includes('record')) {
                if (typeof selectEvent === 'function') selectEvent(eventId);
            } else if (page.includes('results')) {
                if (typeof openResultDetail === 'function') openResultDetail(eventId);
            } else {
                // Fallback: go to dashboard with event
                window.location.href = '/dashboard.html?event=' + eventId;
            }
        };
        renderDay(activeDay);
    } catch (e) {
        if (e && e.status === 404) { showToast('등록된 시간표가 없습니다', 'error'); }
        else { showToast('시간표를 불러오지 못했습니다', 'error'); console.error(e); }
    }
}

function _ttCategoryBadge(cat) {
    if (!cat) return '';
    const c = cat.trim();
    let bg = '#e0e0e0', color = '#333';
    if (c.includes('남') && !c.includes('여')) { bg = '#f0f0f0'; color = '#6b6b6b'; }
    else if (c.includes('여') && !c.includes('남')) { bg = '#f0e0e4'; color = '#8b1a2a'; }
    else if (c.includes('/') || c.includes('혼')) { bg = '#f8f4ea'; color = '#8a7640'; }
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${bg};color:${color};white-space:nowrap;">${c}</span>`;
}

function _ttRoundBadge(round) {
    if (!round) return '';
    const r = round.trim();
    let bg = '#f5f5f5', color = '#616161';
    if (r.includes('결승') || r.toLowerCase().includes('final')) { bg = '#f5f0e0'; color = '#8a7640'; }
    else if (r.includes('예선') || r.includes('준결')) { bg = '#f8f4ea'; color = '#b79f58'; }
    else if (r.match(/\d+종/)) { bg = '#f8f4ea'; color = '#6b5520'; }
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${bg};color:${color};white-space:nowrap;">${r}</span>`;
}

async function openDocumentList() {
    const compId = getCompetitionId();
    if (!compId) { showToast('대회를 먼저 선택하세요', 'error'); return; }
    try {
        const docs = await api('GET', `/api/documents/${compId}`);
        let overlay = document.getElementById('doc-list-overlay');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'doc-list-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        const general = docs.filter(d => !d.event_id);
        const eventDocs = docs.filter(d => d.event_id);

        // Group by gender -> category -> events
        const genderOrder = { M: 0, F: 1, X: 2 };
        const genderLabel = { M: '남자', F: '여자', X: '혼성' };
        const genderEmoji = { M: '<span class="ico-dot ico-dot-m"></span>', F: '<span class="ico-dot ico-dot-f"></span>', X: '<span class="ico-dot ico-dot-x"></span>' };
        const genderGroups = {};
        for (const d of eventDocs) {
            const g = d.gender || 'X';
            if (!genderGroups[g]) genderGroups[g] = {};
            const evKey = `${d.event_name}__${d.round || ''}`;
            if (!genderGroups[g][evKey]) genderGroups[g][evKey] = { name: d.event_name, round: d.round, category: d.category || '', docs: [] };
            genderGroups[g][evKey].docs.push(d);
        }
        const sortedGenders = Object.keys(genderGroups).sort((a, b) => (genderOrder[a] ?? 9) - (genderOrder[b] ?? 9));

        const roundMap = { preliminary: '예선', semifinal: '준결승', final: '결승' };
        const catMap = { track: '트랙', field_distance: '필드(투척/도약)', field_height: '필드(높이)', combined: '혼성경기', relay: '릴레이', road: '도로' };
        const filterId = 'doc-filter-' + Date.now();

        // Build general docs (comprehensive, ad-card)
        let generalHtml = general.map(d => {
            const isExcel = d.type.includes('excel');
            const icon = '';
            const badgeStyle = isExcel
                ? 'background:#f5f0e0;color:#8a7640;border:1px solid #d4c8a0;'
                : 'background:#f8f4ea;color:#b79f58;border:1px solid #e8dfc0;';
            const badgeLabel = isExcel ? 'EXCEL' : 'PDF';
            return `<a href="${d.url}" target="_blank" style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:10px;background:#fafafa;text-decoration:none;color:#333;font-size:13px;font-weight:600;transition:all 0.15s;border:1px solid #e8e8e8;" onmouseover="this.style.background='#f5f0e0';this.style.borderColor='#c4b070'" onmouseout="this.style.background='#fafafa';this.style.borderColor='#e8e8e8'">
                <span style="font-size:20px;line-height:1;">${icon}</span>
                <span style="flex:1;">${d.label.replace(/^\s*/, '')}</span>
                <span style="display:inline-block;padding:3px 10px;border-radius:5px;font-size:10px;font-weight:800;letter-spacing:0.5px;${badgeStyle}">${badgeLabel}</span>
            </a>`;
        }).join('');

        // Build gender sections with category grouping
        let eventSectionsHtml = '';
        for (const g of sortedGenders) {
            const events = genderGroups[g];
            const eventKeys = Object.keys(events);

            // Sub-group by category
            const catGroups = {};
            for (const evKey of eventKeys) {
                const ev = events[evKey];
                const cat = ev.category || 'other';
                if (!catGroups[cat]) catGroups[cat] = [];
                catGroups[cat].push(ev);
            }
            const catOrder = ['track', 'field_distance', 'field_height', 'combined', 'relay', 'road', 'other'];
            const sortedCats = Object.keys(catGroups).sort((a, b) => catOrder.indexOf(a) - catOrder.indexOf(b));

            let catHtml = '';
            for (const cat of sortedCats) {
                const catEvents = catGroups[cat];
                const catLabel = catMap[cat] || '기타';
                let rowsHtml = catEvents.map(ev => {
                    const roundStr = roundMap[ev.round] || ev.round || '';
                    const sl = ev.docs.find(d => d.type === 'start-list');
                    const rs = ev.docs.find(d => d.type === 'result-sheet');
                    const evId = rs ? rs.event_id : (sl ? sl.event_id : null);
                    return `<div class="doc-event-row" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #f5f5f5;font-size:13px;" data-event-name="${(ev.name || '').toLowerCase()}">
                        <span style="flex:1;font-weight:600;color:#333;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ev.name}${roundStr ? ` <span style="font-weight:400;color:#999;font-size:11px;">${roundStr}</span>` : ''}</span>
                        <div style="display:flex;gap:4px;flex-shrink:0;">
                            ${sl ? `<a href="${sl.url}" target="_blank" style="display:inline-flex;align-items:center;gap:3px;padding:5px 12px;border-radius:6px;background:#f0f0f0;color:#6b6b6b;text-decoration:none;font-size:11px;font-weight:700;border:1px solid #c0c0c0;transition:all 0.15s;" onmouseover="this.style.background='#d8d8d8'" onmouseout="this.style.background='#f0f0f0'">출전</a>` : '<span style="display:inline-block;width:60px;"></span>'}
                            ${rs ? `<a href="${rs.url}" target="_blank" style="display:inline-flex;align-items:center;gap:3px;padding:5px 12px;border-radius:6px;background:#f8f4ea;color:#b79f58;text-decoration:none;font-size:11px;font-weight:700;border:1px solid #e8dfc0;transition:all 0.15s;" onmouseover="this.style.background='#f0ead6'" onmouseout="this.style.background='#f8f4ea'">결과</a>` : '<span style="display:inline-block;width:60px;"></span>'}
                            ${evId ? `<button onclick="docDownloadResultPNG(${evId}, this)" style="display:inline-flex;align-items:center;gap:3px;padding:5px 12px;border-radius:6px;background:#f5f0e0;color:#8a7640;font-size:11px;font-weight:700;border:1px solid #d4c8a0;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.background='#e8dfc0'" onmouseout="this.style.background='#f5f0e0'">PNG</button>` : ''}
                        </div>
                    </div>`;
                }).join('');
                catHtml += `<div class="doc-cat-group" style="margin-bottom:4px;">
                    <div style="padding:5px 10px;font-size:11px;font-weight:700;color:#757575;background:#fafafa;border-bottom:1px solid #eee;letter-spacing:0.5px;">${catLabel}</div>
                    ${rowsHtml}
                </div>`;
            }

            const gColor = g === 'M' ? '#1a2a5e' : g === 'F' ? '#8b1a2a' : '#b79f58';
            const gBg = g === 'M' ? '#e8eaf0' : g === 'F' ? '#f0e0e4' : '#f8f4ea';
            const gBorder = g === 'M' ? '#b0b4c8' : g === 'F' ? '#c89898' : '#d4c8a0';
            eventSectionsHtml += `
            <div class="doc-gender-section" style="margin-top:16px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <span style="font-size:14px;">${genderEmoji[g] || ''}</span>
                    <span style="display:inline-block;padding:4px 14px;border-radius:99px;font-size:13px;font-weight:800;background:${gBg};color:${gColor};letter-spacing:1px;">${genderLabel[g] || g}</span>
                    <span style="font-size:11px;color:#bbb;font-weight:500;">${eventKeys.length}개 종목</span>
                </div>
                <div style="background:#fff;border:1px solid ${gBorder};border-radius:10px;overflow:hidden;">
                    ${catHtml}
                </div>
            </div>`;
        }

        const totalDocs = docs.length;
        const modal = document.createElement('div');
        modal.style.cssText = 'background:#fff;border-radius:16px;max-width:720px;width:94%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.3);overflow:hidden;';
        modal.innerHTML = `
            <div style="background:linear-gradient(135deg,#f8f4ea,#f5f0e0);padding:18px 22px;border-bottom:1px solid #e8dfc0;flex-shrink:0;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <h3 style="font-size:18px;font-weight:800;margin:0;color:#6b5520;">기록지 / 문서</h3>
                        <p style="font-size:11px;color:#c4b070;margin:3px 0 0;font-weight:500;">총 ${totalDocs}개 문서</p>
                    </div>
                    <button onclick="this.closest('#doc-list-overlay').remove()" style="background:rgba(255,255,255,0.8);border:1px solid #e8dfc0;width:34px;height:34px;border-radius:50%;font-size:18px;cursor:pointer;color:#555;display:flex;align-items:center;justify-content:center;transition:all 0.15s;font-weight:300;" onmouseover="this.style.background='#fff';this.style.borderColor='#c4b070'" onmouseout="this.style.background='rgba(255,255,255,0.8)';this.style.borderColor='#e8dfc0'">&times;</button>
                </div>
            </div>
            <div style="padding:10px 22px;border-bottom:1px solid #f0f0f0;flex-shrink:0;background:#fafafa;">
                <div style="position:relative;">
                    <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:12px;opacity:0.4;color:#999;">검색</span>
                    <input type="text" id="${filterId}" placeholder="종목명으로 검색..." style="width:100%;padding:9px 12px 9px 32px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:13px;outline:none;transition:border 0.2s;box-sizing:border-box;background:#fff;" onfocus="this.style.borderColor='#b79f58';this.style.boxShadow='0 0 0 3px rgba(183,159,88,0.1)'" onblur="this.style.borderColor='#e0e0e0';this.style.boxShadow='none'">
                </div>
            </div>
            <div style="overflow-y:auto;padding:16px 22px 22px;flex:1;">
                <div style="margin-bottom:16px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #f5f0e0;">
                        <span class="ico ico-track" style="font-size:11px;">DATA</span>
                        <span style="font-size:14px;font-weight:800;color:#8a7640;">종합 문서</span>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        ${generalHtml}
                    </div>
                </div>
                <div style="margin-top:8px;padding-top:8px;border-top:2px solid #eee;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span class="ico ico-field" style="font-size:11px;">DOC</span>
                        <span style="font-size:14px;font-weight:800;color:#333;">종목별 문서</span>
                        <span style="font-size:11px;color:#999;margin-left:4px;">출전명단 & 경기결과</span>
                    </div>
                </div>
                <div id="doc-event-sections">
                    ${eventSectionsHtml}
                </div>
            </div>`;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Search filter
        const filterInput = document.getElementById(filterId);
        if (filterInput) {
            filterInput.addEventListener('input', function() {
                const q = this.value.trim().toLowerCase();
                const rows = modal.querySelectorAll('.doc-event-row');
                const sections = modal.querySelectorAll('.doc-gender-section');
                const catSections = modal.querySelectorAll('.doc-cat-group');
                rows.forEach(r => {
                    const name = r.getAttribute('data-event-name') || '';
                    r.style.display = !q || name.includes(q) ? '' : 'none';
                });
                // Hide category groups if all events hidden
                catSections.forEach(c => {
                    const visible = c.querySelectorAll('.doc-event-row:not([style*="display: none"])');
                    c.style.display = visible.length ? '' : 'none';
                });
                // Hide gender sections if all categories hidden
                sections.forEach(s => {
                    const visible = s.querySelectorAll('.doc-event-row:not([style*="display: none"])');
                    s.style.display = visible.length ? '' : 'none';
                });
            });
        }
    } catch(e) {
        showToast('문서 목록을 불러오지 못했습니다', 'error');
    }
}

// Download result sheet as PNG from document list modal (PDF→PNG conversion)
async function docDownloadResultPNG(eventId, btn) {
    if (!eventId) return;
    const origText = btn.innerHTML;
    btn.innerHTML = '⏳ 생성중...';
    btn.disabled = true;
    try {
        const resp = await fetch('/api/documents/result-sheet/' + eventId + '/png');
        if (!resp.ok) throw new Error('PNG 생성 실패');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'result_' + eventId + '.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        btn.innerHTML = 'Done';
        setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 2000);
    } catch(e) {
        btn.innerHTML = 'Fail';
        setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 2000);
        if (typeof showToast === 'function') showToast('PNG 다운로드 실패: ' + e.message, 'error');
    }
}

// Inject loading spinner into page (auto on DOMContentLoaded)
document.addEventListener('DOMContentLoaded', function() {
    // --- Loading spinner overlay: inject if not present ---
    if (!document.getElementById('pr-loading')) {
        const overlay = document.createElement('div');
        overlay.className = 'pr-loading-overlay';
        overlay.id = 'pr-loading';
        overlay.innerHTML = '<div class="pr-loading-spinner"></div>';
        document.body.appendChild(overlay);
    }

    // --- Font size control (A+/A-): auto-inject for callroom & record pages ---
    const pageTitle = document.title.toLowerCase();
    const isCallroom = pageTitle.includes('\uc18c\uc9d1\uc2e4') || pageTitle.includes('callroom');
    const isRecord = pageTitle.includes('\uae30\ub85d\uc785\ub825') || pageTitle.includes('record');
    if ((isCallroom || isRecord) && !document.getElementById('pr-font-ctrl')) {
        const pageTitleBar = document.querySelector('.page-title-bar');
        if (pageTitleBar) {
            const ctrl = document.createElement('div');
            ctrl.className = 'font-size-ctrl';
            ctrl.id = 'pr-font-ctrl';
            ctrl.innerHTML = '<button onclick="prFontDown()" title="\uae00\uc528 \ucd95\uc18c">A\u2212</button>'
                + '<span class="font-size-label">100%</span>'
                + '<button onclick="prFontUp()" title="\uae00\uc528 \ud655\ub300">A+</button>';
            pageTitleBar.style.display = 'flex';
            pageTitleBar.style.alignItems = 'center';
            pageTitleBar.style.justifyContent = 'space-between';
            pageTitleBar.style.flexWrap = 'wrap';
            pageTitleBar.appendChild(ctrl);
            // Initialize font size on the main content area
            const targetSel = isCallroom ? '.callroom-dashboard' : '.record-dashboard';
            prInitFontSize(targetSel);
        }
    }
});

// ============================================================
// LOADING SPINNER (wrap global fetch — debounced to avoid flicker)
// ============================================================
window.prShowLoading = function() { const el = document.getElementById('pr-loading'); if (el) el.classList.add('show'); };
window.prHideLoading = function() { const el = document.getElementById('pr-loading'); if (el) el.classList.remove('show'); };
(function() {
    let activeReqs = 0;
    let showTimer = null;
    let safetyTimer = null;
    const DEBOUNCE_MS = 300;
    const SAFETY_MS = 8000; // force hide after 8s max
    const origFetch = window.fetch;
    function clearAll() {
        activeReqs = 0;
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
        prHideLoading();
    }
    window.fetch = function() {
        activeReqs++;
        if (activeReqs === 1 && !showTimer) {
            showTimer = setTimeout(() => { if (activeReqs > 0) prShowLoading(); showTimer = null; }, DEBOUNCE_MS);
            // Safety: force hide after SAFETY_MS no matter what
            if (safetyTimer) clearTimeout(safetyTimer);
            safetyTimer = setTimeout(clearAll, SAFETY_MS);
        }
        return origFetch.apply(this, arguments)
            .then(function(r) { return r; })
            .catch(function(e) { throw e; })
            .finally(function() {
                activeReqs--;
                if (activeReqs <= 0) clearAll();
            });
    };
})();

// ============================================================
// FONT SIZE CONTROL (A+/A-) — for callroom & record pages
// ============================================================
window.prInitFontSize = function(targetSelector) {
    const STEPS = [100, 110, 120, 130, 140, 150];
    const KEY = 'pr-font-zoom';
    let currentIdx = STEPS.indexOf(parseInt(localStorage.getItem(KEY)) || 100);
    if (currentIdx < 0) currentIdx = 0;

    function apply() {
        const pct = STEPS[currentIdx];
        localStorage.setItem(KEY, pct);
        const target = document.querySelector(targetSelector);
        if (target) target.style.zoom = (pct / 100);
        const label = document.querySelector('.font-size-label');
        if (label) label.textContent = pct + '%';
    }

    window.prFontUp = function() { if (currentIdx < STEPS.length - 1) { currentIdx++; apply(); } };
    window.prFontDown = function() { if (currentIdx > 0) { currentIdx--; apply(); } };
    window.prFontReset = function() { currentIdx = 0; apply(); };

    apply();
};
