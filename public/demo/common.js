/**
 * PACE RISE : SCOPE — common.js v7.0
 * Shared utilities: API, time helpers, WA scoring, navigation
 */

// ============================================================
// WA Scoring Tables (2001 IAAF)
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
    {order:1,key:'M_100m',name:'100m',unit:'s',eventId:101},
    {order:2,key:'M_long_jump',name:'멀리뛰기',unit:'m',eventId:102},
    {order:3,key:'M_shot_put',name:'포환던지기',unit:'m',eventId:103},
    {order:4,key:'M_high_jump',name:'높이뛰기',unit:'m',eventId:104},
    {order:5,key:'M_400m',name:'400m',unit:'s',eventId:105},
    {order:6,key:'M_110m_hurdles',name:'110m 허들',unit:'s',eventId:106},
    {order:7,key:'M_discus',name:'원반던지기',unit:'m',eventId:107},
    {order:8,key:'M_pole_vault',name:'장대높이뛰기',unit:'m',eventId:108},
    {order:9,key:'M_javelin',name:'창던지기',unit:'m',eventId:109},
    {order:10,key:'M_1500m',name:'1500m',unit:'s',eventId:110},
];
const HEPTATHLON_EVENTS = [
    {order:1,key:'F_100m_hurdles',name:'100m 허들',unit:'s',eventId:201},
    {order:2,key:'F_high_jump',name:'높이뛰기',unit:'m',eventId:202},
    {order:3,key:'F_shot_put',name:'포환던지기',unit:'m',eventId:203},
    {order:4,key:'F_200m',name:'200m',unit:'s',eventId:204},
    {order:5,key:'F_long_jump',name:'멀리뛰기',unit:'m',eventId:205},
    {order:6,key:'F_javelin',name:'창던지기',unit:'m',eventId:206},
    {order:7,key:'F_800m',name:'800m',unit:'s',eventId:207},
];

function calcWAPoints(key, rawRecord) {
    const t = WA_TABLES[key];
    if (!t || rawRecord == null || rawRecord <= 0) return 0;
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
    if (str.includes(':')) { const p = str.split(':'); return (parseInt(p[0]) || 0) * 60 + (parseFloat(p[1]) || 0); }
    const v = parseFloat(str); return isNaN(v) ? null : v;
}
function formatTime(s) {
    if (s == null) return '';
    if (s >= 90) { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`; }
    return s.toFixed(2);
}
function isLongTimeEvent(n) {
    if (!n) return false;
    const l = n.toLowerCase();
    return l.includes('800m') || l.includes('1500m') || l.includes('3000m') || l.includes('5000m') || l.includes('10000m');
}

// ============================================================
// Format helpers
// ============================================================
function fmtCat(c) { return { track: 'Track', field_distance: '거리', field_height: '높이', combined: '혼성' }[c] || c; }
function fmtRound(r) { return { preliminary: '예선', semifinal: '준결승', final: '결승' }[r] || r; }
function fmtRoundShort(r) { return { preliminary: '예선', semifinal: '준결', final: '결승' }[r] || r; }
function fmtSt(s) { return { registered: '미확인', checked_in: '출석', no_show: '결석' }[s] || s; }

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
// API
// ============================================================
async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) throw { status: res.status, ...data };
    return data;
}
const API = {
    getAllEvents: () => api('GET', '/api/events'),
    getEvent: id => api('GET', `/api/events/${id}`),
    getEventEntries: eid => api('GET', `/api/events/${eid}/entries`),
    getHeats: eid => api('GET', `/api/heats?event_id=${eid}`),
    getHeatEntries: hid => api('GET', `/api/heats/${hid}/entries`),
    getHeatEntriesCheckedIn: hid => api('GET', `/api/heats/${hid}/entries?status=checked_in`),
    getResults: hid => api('GET', `/api/results?heat_id=${hid}`),
    upsertResult: body => api('POST', '/api/results/upsert', body),
    updateEntryStatus: (id, st) => api('PATCH', `/api/event-entries/${id}/status`, { status: st }),
    checkinBarcode: (bc, eid) => api('POST', '/api/callroom/checkin', { barcode: bc, event_id: eid }),
    getHeightAttempts: hid => api('GET', `/api/height-attempts?heat_id=${hid}`),
    saveHeightAttempt: body => api('POST', '/api/height-attempts/save', body),
    getCombinedScores: eid => api('GET', `/api/combined-scores?event_id=${eid}`),
    saveCombinedScore: body => api('POST', '/api/combined-scores/save', body),
    getCombinedSubEvents: pid => api('GET', `/api/combined-sub-events?parent_event_id=${pid}`),
    syncCombinedScores: pid => api('POST', '/api/combined-scores/sync', { parent_event_id: pid }),
    saveQualifications: (eid, sel) => api('POST', '/api/qualifications/save', { event_id: eid, selections: sel }),
    approveQualifications: eid => api('POST', '/api/qualifications/approve', { event_id: eid }),
    createFinal: eid => api('POST', `/api/events/${eid}/create-final`, {}),
    getRoundStatus: () => api('GET', '/api/round-status'),
    getAuditLog: () => api('GET', '/api/audit-log?limit=20'),
    // Admin
    verifyAdmin: key => api('POST', '/api/admin/verify', { admin_key: key }),
    completeEvent: (eid, judge_name, admin_key) => api('POST', `/api/events/${eid}/complete`, { judge_name, admin_key }),
    completeCallroom: (eid, judge_name) => api('POST', `/api/events/${eid}/callroom-complete`, { judge_name }),
    createSemifinal: (eid, group_count, selections) => api('POST', `/api/events/${eid}/create-semifinal`, { group_count, selections }),
    getFullResults: eid => api('GET', `/api/events/${eid}/full-results`),
    getPublicEvents: () => api('GET', '/api/public/events'),
    getCallroomStatus: () => api('GET', '/api/public/callroom-status'),
};

// ============================================================
// SSE — Server-Sent Events for real-time updates
// ============================================================
let _sseConnection = null;
let _sseListeners = {};

function connectSSE() {
    if (_sseConnection) return;
    try {
        _sseConnection = new EventSource('/api/sse');
        _sseConnection.addEventListener('connected', () => { console.log('[SSE] Connected'); });
        _sseConnection.addEventListener('result_update', (e) => { notifySSE('result_update', JSON.parse(e.data)); });
        _sseConnection.addEventListener('entry_status', (e) => { notifySSE('entry_status', JSON.parse(e.data)); });
        _sseConnection.addEventListener('event_completed', (e) => { notifySSE('event_completed', JSON.parse(e.data)); });
        _sseConnection.addEventListener('callroom_complete', (e) => { notifySSE('callroom_complete', JSON.parse(e.data)); });
        _sseConnection.onerror = () => {
            console.log('[SSE] Error, reconnecting in 5s...');
            _sseConnection.close();
            _sseConnection = null;
            setTimeout(connectSSE, 5000);
        };
    } catch (e) { console.log('[SSE] Failed to connect'); }
}

function onSSE(eventType, callback) {
    if (!_sseListeners[eventType]) _sseListeners[eventType] = [];
    _sseListeners[eventType].push(callback);
}

function notifySSE(eventType, data) {
    const listeners = _sseListeners[eventType] || [];
    listeners.forEach(cb => { try { cb(data); } catch (e) { console.error('[SSE] listener error:', e); } });
}

// Auto-connect SSE when script loads
connectSSE();

// ============================================================
// Common UI: Audit log, banner
// ============================================================
async function renderAuditLog() {
    const el = document.getElementById('audit-log-container');
    if (!el) return;
    try {
        const logs = await API.getAuditLog();
        el.innerHTML = logs.map(l =>
            `<div class="audit-entry"><strong>[${l.action}]</strong> ${l.table_name} #${l.record_id} — ${l.performed_by} — ${l.created_at}</div>`
        ).join('') || '<div class="audit-entry">기록 없음</div>';
    } catch (e) { }
}

function showBanner(el, cls, text) {
    el.className = 'barcode-banner ' + cls;
    el.textContent = text;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ============================================================
// Common navigation header render
// ============================================================
function renderPageNav(currentPage) {
    const nav = document.getElementById('page-nav');
    if (!nav) return;
    const pages = [
        { key: 'dashboard', label: '대시보드', href: '/demo/' },
        { key: 'callroom', label: '소집실', href: '/demo/callroom.html' },
        { key: 'record', label: '기록입력', href: '/demo/record.html' },
        { key: 'results', label: '결과확인', href: '/demo/results.html' },
        { key: 'admin', label: '관리', href: '/demo/admin.html' },
    ];
    nav.innerHTML = pages.map(p =>
        `<a href="${p.href}" class="nav-link ${p.key === currentPage ? 'active' : ''}">${p.label}</a>`
    ).join('');
}

// ============================================================
// Unsaved changes guard (shared)
// ============================================================
let _unsavedChanges = false;
function markUnsaved() { _unsavedChanges = true; }
function clearUnsaved() { _unsavedChanges = false; }
function hasUnsaved() { return _unsavedChanges; }
window.addEventListener('beforeunload', e => {
    if (_unsavedChanges) { e.preventDefault(); e.returnValue = ''; }
});

function checkUnsavedBeforeAction(cb) {
    if (!_unsavedChanges) { cb(); return; }
    const ov = document.getElementById('confirm-overlay');
    if (!ov) { cb(); return; }
    ov.style.display = 'flex';
    document.getElementById('confirm-leave-btn').onclick = () => { ov.style.display = 'none'; clearUnsaved(); cb(); };
    document.getElementById('confirm-stay-btn').onclick = () => { ov.style.display = 'none'; };
}

// ============================================================
// Common HTML fragments
// ============================================================
function getConfirmModalHTML() {
    return `<div id="confirm-overlay" class="modal-overlay" style="display:none;">
        <div class="modal modal-sm">
            <div class="modal-header"><div class="modal-title">저장되지 않은 변경사항</div></div>
            <div class="modal-form"><p style="padding:8px 0;">현재 입력 중인 기록이 저장되지 않았습니다.<br>이동하시겠습니까?</p></div>
            <div class="modal-footer">
                <button id="confirm-stay-btn" class="btn btn-ghost">취소 (머무르기)</button>
                <button id="confirm-leave-btn" class="btn btn-danger">저장 안함 (이동)</button>
            </div>
        </div>
    </div>`;
}

function getFooterHTML() {
    return `<footer class="footer">
        <details><summary>Audit Log</summary><div id="audit-log-container"></div></details>
    </footer>`;
}

function getHeaderHTML(subtitle) {
    return `<header class="header">
        <div class="header-inner">
            <h1 class="header-title">PACE RISE <span class="header-colon">:</span> <span class="header-scope">SCOPE</span></h1>
            <p class="header-subtitle">Sport Competition Operation Platform for Excellence</p>
        </div>
        <nav class="page-nav" id="page-nav"></nav>
    </header>`;
}
