/**
 * PACE RISE : SCOPE — v5.0
 * Sport Competition Operation Platform for Excellence
 * 
 * Key improvements:
 * - Inline track time entry — type directly in the table, no popup
 * - Call Room round selector — pick event then round (예선/결승)
 * - Final round disabled until preliminary complete
 * - Unsaved data guard on tab/event/page switch
 * - Tab-down auto-focus: Enter moves to next row input
 * - "Save All" for batch track time submission
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
    {order:1,key:'M_100m',name:'100m',unit:'s',eventId:101},{order:2,key:'M_long_jump',name:'멀리뛰기',unit:'m',eventId:102},
    {order:3,key:'M_shot_put',name:'포환던지기',unit:'m',eventId:103},{order:4,key:'M_high_jump',name:'높이뛰기',unit:'m',eventId:104},
    {order:5,key:'M_400m',name:'400m',unit:'s',eventId:105},{order:6,key:'M_110m_hurdles',name:'110m 허들',unit:'s',eventId:106},
    {order:7,key:'M_discus',name:'원반던지기',unit:'m',eventId:107},{order:8,key:'M_pole_vault',name:'장대높이뛰기',unit:'m',eventId:108},
    {order:9,key:'M_javelin',name:'창던지기',unit:'m',eventId:109},{order:10,key:'M_1500m',name:'1500m',unit:'s',eventId:110},
];
const HEPTATHLON_EVENTS = [
    {order:1,key:'F_100m_hurdles',name:'100m 허들',unit:'s',eventId:201},{order:2,key:'F_high_jump',name:'높이뛰기',unit:'m',eventId:202},
    {order:3,key:'F_shot_put',name:'포환던지기',unit:'m',eventId:203},{order:4,key:'F_200m',name:'200m',unit:'s',eventId:204},
    {order:5,key:'F_long_jump',name:'멀리뛰기',unit:'m',eventId:205},{order:6,key:'F_javelin',name:'창던지기',unit:'m',eventId:206},
    {order:7,key:'F_800m',name:'800m',unit:'s',eventId:207},
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
    if (str.includes(':')) {
        const p = str.split(':');
        return (parseInt(p[0]) || 0) * 60 + (parseFloat(p[1]) || 0);
    }
    const v = parseFloat(str);
    return isNaN(v) ? null : v;
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
// State
// ============================================================
const state = {
    events: [], currentGender: 'M', currentTab: 'callroom',
    callroomEventId: null, callroomEntries: [],
    trackEventId: null, trackEvent: null, trackHeats: [], trackHeatId: null, trackHeatEntries: [], trackResults: [],
    fieldEventId: null, fieldEvent: null, fieldHeats: [], fieldHeatId: null, fieldHeatEntries: [], fieldResults: [], fieldHeightAttempts: [], fieldMode: 'input',
    currentBarHeight: 2.10,
    combinedEventId: null, combinedEvent: null, combinedEntries: [], combinedScores: [], combinedSubEvents: [],
    resultsEventId: null, resultsEvent: null, resultsHeats: [], resultsHeatId: null,
    unsavedChanges: false,
    _pendingInlineTrack: {}, // {event_entry_id: value} for dirty inline inputs
};

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
    getAuditLog: () => api('GET', '/api/audit-log?limit=20'),
};

// ============================================================
// Unsaved Changes Guard
// ============================================================
function markUnsaved() { state.unsavedChanges = true; }
function clearUnsaved() { state.unsavedChanges = false; state._pendingInlineTrack = {}; }
window.addEventListener('beforeunload', e => {
    if (state.unsavedChanges) { e.preventDefault(); e.returnValue = ''; }
});

function checkUnsavedBeforeAction(cb) {
    if (!state.unsavedChanges) { cb(); return; }
    const ov = document.getElementById('confirm-overlay');
    ov.style.display = 'flex';
    document.getElementById('confirm-leave-btn').onclick = () => { ov.style.display = 'none'; clearUnsaved(); cb(); };
    document.getElementById('confirm-stay-btn').onclick = () => { ov.style.display = 'none'; };
}

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    state.events = await API.getAllEvents();
    setupGenderToggle();
    setupTabs();
    setupFieldModal();
    setupHeightModal();
    setupCombinedModal();
    setupExportButtons();
    await refreshAllSelectors();
    renderAuditLog();
});

// ============================================================
// Gender Toggle
// ============================================================
function setupGenderToggle() {
    document.querySelectorAll('.gender-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            checkUnsavedBeforeAction(async () => {
                document.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.currentGender = btn.dataset.gender;
                await refreshAllSelectors();
            });
        });
    });
}

// ============================================================
// Tabs — with unsaved guard
// ============================================================
function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            checkUnsavedBeforeAction(() => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
                state.currentTab = btn.dataset.tab;
            });
        });
    });
}
function switchToTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const tb = document.querySelector(`[data-tab="${tabName}"]`);
    if (tb) tb.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    state.currentTab = tabName;
}

// ============================================================
// Selectors — Round-aware Call Room
// ============================================================
function getFilteredEvents(cat) {
    const g = state.currentGender;
    return state.events.filter(e => {
        if (e.gender !== g) return false;
        if (cat === 'track') return e.category === 'track';
        if (cat === 'field') return e.category === 'field_distance' || e.category === 'field_height';
        if (cat === 'combined') return e.category === 'combined';
        return true;
    });
}

function getCallroomEventNames() {
    const g = state.currentGender;
    const evts = state.events.filter(e => e.gender === g && !e.parent_event_id);
    const groups = {};
    evts.forEach(e => {
        const key = e.name + '|' + e.category;
        if (!groups[key]) groups[key] = { name: e.name, category: e.category, rounds: [] };
        groups[key].rounds.push(e);
    });
    return Object.values(groups);
}

async function refreshAllSelectors() {
    // Call Room — event groups (name-based), then round sub-selector
    const crGroups = getCallroomEventNames();
    const crSel = document.getElementById('callroom-event-select');
    crSel.innerHTML = crGroups.map(g => `<option value="${g.name}|${g.category}">${g.name} (${fmtCat(g.category)})</option>`).join('');
    if (crGroups.length > 0) { await updateCallroomRounds(); }

    // Track
    const trackEvts = getFilteredEvents('track');
    const mainT = trackEvts.filter(e => !e.parent_event_id), subT = trackEvts.filter(e => e.parent_event_id);
    populateGrouped('track-event-select', mainT, subT);
    if (trackEvts.length > 0) { state.trackEventId = trackEvts[0].id; await renderTrack(); }
    else { document.getElementById('track-tbody').innerHTML = '<tr><td colspan="6" class="empty-state">종목 없음</td></tr>'; }

    // Field
    const fieldEvts = getFilteredEvents('field');
    const mainF = fieldEvts.filter(e => !e.parent_event_id), subF = fieldEvts.filter(e => e.parent_event_id);
    populateGrouped('field-event-select', mainF, subF);
    if (fieldEvts.length > 0) { state.fieldEventId = fieldEvts[0].id; await renderField(); }

    // Combined
    const combEvts = getFilteredEvents('combined');
    populateSimple('combined-event-select', combEvts);
    if (combEvts.length > 0) { state.combinedEventId = combEvts[0].id; await renderCombined(); }

    // Results
    const mainAll = state.events.filter(e => e.gender === state.currentGender && !e.parent_event_id);
    populateSimple('results-event-select', mainAll);
    if (mainAll.length > 0) { state.resultsEventId = mainAll[0].id; await renderResults(); }

    setupSelectorListeners();
}

async function updateCallroomRounds() {
    const sel = document.getElementById('callroom-event-select');
    const val = sel.value;
    if (!val) return;
    const [name, cat] = val.split('|');
    const g = state.currentGender;
    const rounds = state.events.filter(e => e.gender === g && e.name === name && e.category === cat && !e.parent_event_id);
    const rSel = document.getElementById('callroom-round-select');

    // Build options; disable final if preliminary isn't done
    let html = '';
    const prelim = rounds.find(r => r.round_type === 'preliminary');
    const final = rounds.find(r => r.round_type === 'final');
    let prelimDone = true;

    if (prelim && final) {
        // Check if all preliminary heats have full results
        try {
            const heats = await API.getHeats(prelim.id);
            for (const h of heats) {
                const entries = await API.getHeatEntries(h.id);
                const results = await API.getResults(h.id);
                if (results.length < entries.length) { prelimDone = false; break; }
            }
            if (heats.length === 0) prelimDone = false;
        } catch (e) { prelimDone = false; }
    }

    rounds.forEach(r => {
        const isFinal = r.round_type === 'final';
        const disabled = (isFinal && prelim && !prelimDone);
        const label = fmtRound(r.round_type) + (disabled ? ' (예선 미완료)' : '');
        html += `<option value="${r.id}" ${disabled ? 'disabled' : ''}>${label}</option>`;
    });
    rSel.innerHTML = html;

    // Select first non-disabled
    const firstEnabled = rSel.querySelector('option:not([disabled])');
    if (firstEnabled) {
        rSel.value = firstEnabled.value;
        state.callroomEventId = +firstEnabled.value;
        await renderCallRoom();
    }
}

function populateSimple(selId, evts) {
    const sel = document.getElementById(selId);
    if (!sel) return;
    sel.innerHTML = evts.length > 0
        ? evts.map(e => `<option value="${e.id}">${e.name} (${fmtCat(e.category)})</option>`).join('')
        : '<option value="">종목 없음</option>';
}

function populateGrouped(selId, main, sub) {
    const sel = document.getElementById(selId);
    if (!sel) return;
    let html = '';
    if (main.length > 0) {
        html += '<optgroup label="일반 종목">';
        main.forEach(e => { html += `<option value="${e.id}">${e.name} (${fmtRound(e.round_type)})</option>`; });
        html += '</optgroup>';
    }
    if (sub.length > 0) {
        const parents = {};
        sub.forEach(e => { const p = e.parent_event_id; if (!parents[p]) parents[p] = []; parents[p].push(e); });
        for (const pid in parents) {
            const pe = state.events.find(ev => ev.id === +pid);
            html += `<optgroup label="${pe ? pe.name : '혼성'} 세부종목">`;
            parents[pid].forEach(e => { html += `<option value="${e.id}">${e.name}</option>`; });
            html += '</optgroup>';
        }
    }
    if (!html) html = '<option value="">종목 없음</option>';
    sel.innerHTML = html;
}

function fmtCat(c) { return { track: 'Track', field_distance: '거리', field_height: '높이', combined: '혼성' }[c] || c; }
function fmtRound(r) { return { preliminary: '예선', semifinal: '준결승', final: '결승' }[r] || r; }
function fmtSt(s) { return { registered: '미확인', checked_in: '출석', no_show: '결석' }[s] || s; }

function setupSelectorListeners() {
    const bind = (id, cb) => {
        const el = document.getElementById(id);
        if (!el) return;
        const n = el.cloneNode(true);
        el.parentNode.replaceChild(n, el);
        n.addEventListener('change', cb);
    };
    bind('callroom-event-select', async () => { await updateCallroomRounds(); });
    bind('callroom-round-select', async e => { state.callroomEventId = +e.target.value; await renderCallRoom(); });
    bind('track-event-select', async e => { checkUnsavedBeforeAction(async () => { state.trackEventId = +e.target.value; await renderTrack(); }); });
    bind('track-heat-select', async e => { checkUnsavedBeforeAction(async () => { state.trackHeatId = +e.target.value; await loadTrackHeatData(); }); });
    bind('field-event-select', async e => { checkUnsavedBeforeAction(async () => { state.fieldEventId = +e.target.value; await renderField(); }); });
    bind('field-heat-select', async e => { checkUnsavedBeforeAction(async () => { state.fieldHeatId = +e.target.value; await loadFieldHeatData(); }); });
    bind('combined-event-select', async e => { state.combinedEventId = +e.target.value; await renderCombined(); });
    bind('results-event-select', async e => { state.resultsEventId = +e.target.value; await renderResults(); });
    bind('results-heat-select', async e => { state.resultsHeatId = +e.target.value; await loadResultsData(); });

    const rb = (id, cb) => {
        const el = document.getElementById(id);
        if (!el) return;
        const n = el.cloneNode(true);
        el.parentNode.replaceChild(n, el);
        n.addEventListener('click', cb);
    };
    rb('mode-input-btn', () => { state.fieldMode = 'input'; renderFieldContent(); });
    rb('mode-view-btn', () => { state.fieldMode = 'view'; renderFieldContent(); });
}

// ============================================================
// CALL ROOM
// ============================================================
async function renderCallRoom() {
    if (!state.callroomEventId) return;
    const entries = await API.getEventEntries(state.callroomEventId);
    state.callroomEntries = entries;
    const total = entries.length;
    const cIn = entries.filter(e => e.status === 'checked_in').length;
    const nS = entries.filter(e => e.status === 'no_show').length;
    const pend = entries.filter(e => e.status === 'registered').length;

    document.getElementById('callroom-stats').innerHTML = `
        <div class="stat-card" style="border-top-color:var(--text)"><div class="stat-number">${total}</div><div class="stat-label">전체</div></div>
        <div class="stat-card" style="border-top-color:var(--green)"><div class="stat-number" style="color:var(--green)">${cIn}</div><div class="stat-label">출석</div></div>
        <div class="stat-card" style="border-top-color:var(--danger)"><div class="stat-number" style="color:var(--danger)">${nS}</div><div class="stat-label">결석</div></div>
        <div class="stat-card" style="border-top-color:var(--warning)"><div class="stat-number" style="color:var(--warning)">${pend}</div><div class="stat-label">미확인</div></div>`;

    document.getElementById('callroom-tbody').innerHTML = entries.map(e => `<tr>
        <td><strong>${e.bib_number}</strong></td>
        <td style="text-align:left;">${e.name}</td>
        <td style="font-size:12px;text-align:left;">${e.team || ''}</td>
        <td><span class="status-badge status-${e.status}">${fmtSt(e.status)}</span></td>
        <td>
            <button class="btn btn-sm btn-primary" onclick="setEntryStatus(${e.event_entry_id},'checked_in')" ${e.status === 'checked_in' ? 'disabled' : ''}>출석</button>
            <button class="btn btn-sm btn-ghost" onclick="setEntryStatus(${e.event_entry_id},'no_show')" ${e.status === 'no_show' ? 'disabled' : ''}>결석</button>
        </td>
    </tr>`).join('');

    setupBarcodeInput();
}

async function setEntryStatus(id, st) {
    await API.updateEntryStatus(id, st);
    await renderCallRoom();
    renderAuditLog();
}

function setupBarcodeInput() {
    const inp = document.getElementById('barcode-input');
    const btn = document.getElementById('barcode-scan-btn');
    if (!inp || !btn) return;
    const ni = inp.cloneNode(true); inp.parentNode.replaceChild(ni, inp);
    const nb = btn.cloneNode(true); btn.parentNode.replaceChild(nb, btn);
    const doScan = async () => { const v = ni.value.trim(); if (!v) return; await processBarcodeOrBib(v); ni.value = ''; ni.focus(); };
    nb.addEventListener('click', doScan);
    ni.addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
}

async function processBarcodeOrBib(input) {
    const banner = document.getElementById('barcode-banner');
    try {
        let bc = input;
        if (/^\d+$/.test(input) && !input.startsWith('PR')) bc = `PR2026${input}`;
        const res = await API.checkinBarcode(bc, state.callroomEventId);
        if (res.already) showBanner(banner, 'already', `${res.athlete.bib_number}번 ${res.athlete.name} — 이미 출석`);
        else showBanner(banner, 'success', `${res.athlete.bib_number}번 ${res.athlete.name} — 출석 완료`);
        await renderCallRoom();
        renderAuditLog();
    } catch (err) {
        showBanner(banner, 'error', `"${input}" — ${err.error || '조회 실패'}`);
    }
}

function showBanner(el, cls, text) {
    el.className = 'barcode-banner ' + cls;
    el.textContent = text;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ============================================================
// TRACK — INLINE EDITING (no popup)
// ============================================================
async function renderTrack() {
    if (!state.trackEventId) {
        document.getElementById('track-tbody').innerHTML = '<tr><td colspan="6" class="empty-state">종목을 선택하세요</td></tr>';
        return;
    }
    state.trackEvent = await API.getEvent(state.trackEventId);
    state.trackHeats = await API.getHeats(state.trackEventId);

    const hs = document.getElementById('track-heat-select');
    hs.innerHTML = state.trackHeats.map(h => `<option value="${h.id}">Heat ${h.heat_number}</option>`).join('');

    // Show hint for long time events
    const hint = document.getElementById('track-hint');
    if (isLongTimeEvent(state.trackEvent?.name)) {
        hint.innerHTML = 'M:SS.xx 형식으로 입력 (예: 1500m → <strong>3:52.45</strong>, 800m → <strong>1:48.23</strong>). Enter로 저장, Tab으로 다음 선수';
        hint.style.display = 'block';
    } else {
        hint.innerHTML = 'SS.xx 형식으로 입력 (예: <strong>10.23</strong>). Enter로 저장, Tab으로 다음 선수';
        hint.style.display = 'block';
    }

    if (state.trackHeats.length > 0) {
        state.trackHeatId = state.trackHeats[0].id;
        await loadTrackHeatData();
    } else {
        document.getElementById('track-tbody').innerHTML = '<tr><td colspan="6" class="empty-state">Heat 없음</td></tr>';
    }

    // Parent link for combined sub-events
    const pl = document.getElementById('track-parent-link');
    if (pl) {
        if (state.trackEvent.parent_event_id) {
            const pe = state.events.find(e => e.id === state.trackEvent.parent_event_id);
            pl.innerHTML = `<span class="sub-event-tag">혼성 세부종목</span> <button class="btn btn-sm btn-outline" onclick="switchToCombinedTab(${state.trackEvent.parent_event_id})">← ${pe ? pe.name : '혼성'} 현황</button>`;
            pl.style.display = 'flex';
        } else {
            pl.style.display = 'none';
        }
    }

    document.getElementById('track-qual-section').style.display = 'none';
}

async function loadTrackHeatData() {
    if (!state.trackHeatId) return;
    state.trackHeatEntries = await API.getHeatEntries(state.trackHeatId);
    state.trackResults = await API.getResults(state.trackHeatId);
    state._pendingInlineTrack = {};
    clearUnsaved();
    renderTrackTable();
}

function renderTrackTable() {
    const rows = state.trackHeatEntries.map(e => {
        const r = state.trackResults.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null };
    });

    // Sort by time (ranked entries first)
    rows.sort((a, b) => {
        if (a.time_seconds == null && b.time_seconds == null) return (a.lane_number || 99) - (b.lane_number || 99);
        if (a.time_seconds == null) return 1;
        if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });

    let rk = 1;
    rows.forEach((r, i) => {
        if (r.time_seconds == null) r.rank = '';
        else { r.rank = (i > 0 && rows[i - 1].time_seconds === r.time_seconds) ? rows[i - 1].rank : rk; rk = i + 2; }
    });

    const isLong = isLongTimeEvent(state.trackEvent?.name);
    const placeholder = isLong ? '0:00.00' : '00.00';

    document.getElementById('track-tbody').innerHTML = rows.map((r, idx) => {
        // Every row has an inline input (always visible)
        const currentVal = r.time_seconds != null ? formatTime(r.time_seconds) : '';
        const pendingVal = state._pendingInlineTrack[r.event_entry_id];
        const displayVal = pendingVal !== undefined ? pendingVal : currentVal;
        const savedClass = (r.time_seconds != null && pendingVal === undefined) ? 'has-value' : '';

        return `<tr data-eid="${r.event_entry_id}">
            <td>${r.rank || '<span class="no-rank">—</span>'}</td>
            <td>${r.lane_number || '—'}</td>
            <td><strong>${r.bib_number}</strong></td>
            <td style="text-align:left;">${r.name}</td>
            <td style="font-size:12px;text-align:left;">${r.team || ''}</td>
            <td><input class="track-time-input ${savedClass}" data-eid="${r.event_entry_id}" data-row="${idx}" 
                value="${displayVal}" placeholder="${placeholder}"
                onkeydown="trackInlineKeydown(event,this)" oninput="trackInlineInput(this)" onfocus="this.select()"></td>
        </tr>`;
    }).join('');

    // Setup save-all button
    const saveAllBtn = document.getElementById('track-save-all-btn');
    if (saveAllBtn) {
        const nb = saveAllBtn.cloneNode(true);
        saveAllBtn.parentNode.replaceChild(nb, saveAllBtn);
        nb.addEventListener('click', () => saveAllTrackInline());
    }

    // Setup qualification button
    const qualBtn = document.getElementById('track-qual-btn');
    if (qualBtn) {
        const nb = qualBtn.cloneNode(true);
        qualBtn.parentNode.replaceChild(nb, qualBtn);
        nb.addEventListener('click', () => openTrackQualification());
    }
}

function trackInlineInput(inp) {
    const eid = +inp.dataset.eid;
    const existing = state.trackResults.find(r => r.event_entry_id === eid);
    const existingVal = existing ? formatTime(existing.time_seconds) : '';
    if (inp.value.trim() !== existingVal) {
        state._pendingInlineTrack[eid] = inp.value;
        markUnsaved();
    } else {
        delete state._pendingInlineTrack[eid];
        if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
    }
}

function trackInlineKeydown(e, inp) {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveSingleTrackInline(inp);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        // Reset to saved value
        const eid = +inp.dataset.eid;
        const existing = state.trackResults.find(r => r.event_entry_id === eid);
        inp.value = existing ? formatTime(existing.time_seconds) : '';
        delete state._pendingInlineTrack[eid];
        if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
        inp.blur();
    } else if (e.key === 'Tab' || e.key === 'ArrowDown') {
        // Auto-save current if has value, then move to next row
        if (inp.value.trim()) {
            saveSingleTrackInline(inp, false); // don't re-render, let Tab naturally move
        }
    } else if (e.key === 'ArrowUp') {
        // Move to previous row
        e.preventDefault();
        const rowIdx = +inp.dataset.row;
        const prev = document.querySelector(`.track-time-input[data-row="${rowIdx - 1}"]`);
        if (prev) prev.focus();
    }
}

async function saveSingleTrackInline(inp, doRerender = true) {
    const eid = +inp.dataset.eid;
    const v = parseTimeInput(inp.value);
    if (v == null || v <= 0) {
        if (inp.value.trim()) {
            inp.classList.add('error');
            setTimeout(() => inp.classList.remove('error'), 1000);
        }
        return;
    }
    inp.classList.add('saving');
    inp.disabled = true;
    try {
        await API.upsertResult({ heat_id: state.trackHeatId, event_entry_id: eid, time_seconds: v });
        delete state._pendingInlineTrack[eid];
        if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
        if (doRerender) {
            await loadTrackHeatData();
            // Re-focus next empty input
            const allInputs = document.querySelectorAll('.track-time-input');
            for (const ni of allInputs) {
                if (!ni.value.trim()) { ni.focus(); break; }
            }
        }
        if (state.trackEvent && state.trackEvent.parent_event_id) {
            await syncCombinedFromSubEvent(state.trackEvent.parent_event_id);
        }
        renderAuditLog();
    } catch (err) {
        inp.classList.remove('saving');
        inp.disabled = false;
        inp.classList.add('error');
        setTimeout(() => inp.classList.remove('error'), 1500);
    }
}

async function saveAllTrackInline() {
    const inputs = document.querySelectorAll('.track-time-input');
    let saved = 0, errors = 0;
    for (const inp of inputs) {
        const v = parseTimeInput(inp.value);
        if (v == null || v <= 0) continue;
        const eid = +inp.dataset.eid;
        inp.classList.add('saving');
        inp.disabled = true;
        try {
            await API.upsertResult({ heat_id: state.trackHeatId, event_entry_id: eid, time_seconds: v });
            delete state._pendingInlineTrack[eid];
            saved++;
        } catch (err) {
            inp.classList.remove('saving');
            inp.disabled = false;
            inp.classList.add('error');
            errors++;
        }
    }
    if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
    await loadTrackHeatData();
    if (state.trackEvent && state.trackEvent.parent_event_id) {
        await syncCombinedFromSubEvent(state.trackEvent.parent_event_id);
    }
    renderAuditLog();
}

// ============================================================
// Track — Qualification
// ============================================================
function openTrackQualification() {
    const rows = state.trackHeatEntries.map(e => {
        const r = state.trackResults.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null };
    }).filter(r => r.time_seconds != null).sort((a, b) => a.time_seconds - b.time_seconds);

    document.getElementById('track-qual-section').style.display = 'block';
    document.getElementById('track-qual-list').innerHTML = rows.map((r, i) => `
        <div class="qual-checkbox-item">
            <input type="checkbox" data-entry-id="${r.event_entry_id}" ${i < 4 ? 'checked' : ''}>
            <span class="qual-rank">${i + 1}</span>
            <span class="qual-name">${r.name} #${r.bib_number}</span>
            <span class="qual-time">${formatTime(r.time_seconds)}</span>
        </div>`).join('');

    // Approve + create final
    const approveBtn = document.getElementById('track-qual-approve-btn');
    const nb = approveBtn.cloneNode(true);
    approveBtn.parentNode.replaceChild(nb, approveBtn);
    nb.addEventListener('click', async () => {
        if (!confirm('결승 진출자를 확정하고 결승 라운드를 생성합니다.\n계속하시겠습니까?')) return;
        const cbs = document.querySelectorAll('#track-qual-list input[type="checkbox"]');
        const selections = Array.from(cbs).map(c => ({ event_entry_id: +c.dataset.entryId, selected: c.checked ? 1 : 0 }));
        try {
            await API.saveQualifications(state.trackEventId, selections);
            await API.approveQualifications(state.trackEventId);
            const res = await API.createFinal(state.trackEventId);
            alert(`결승 생성 완료 (${res.count}명 진출)`);
            state.events = await API.getAllEvents();
            await refreshAllSelectors();
        } catch (e) { alert('결승 생성 실패: ' + (e.error || '')); }
        renderAuditLog();
    });

    // Cancel
    const cancelBtn = document.getElementById('track-qual-cancel-btn');
    const nc = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(nc, cancelBtn);
    nc.addEventListener('click', () => { document.getElementById('track-qual-section').style.display = 'none'; });
}

// ============================================================
// FIELD
// ============================================================
async function renderField() {
    if (!state.fieldEventId) return;
    state.fieldEvent = await API.getEvent(state.fieldEventId);
    state.fieldHeats = await API.getHeats(state.fieldEventId);
    const hs = document.getElementById('field-heat-select');
    hs.innerHTML = state.fieldHeats.map(h => `<option value="${h.id}">Heat ${h.heat_number}</option>`).join('');

    const pl = document.getElementById('field-parent-link');
    if (pl) {
        if (state.fieldEvent.parent_event_id) {
            const pe = state.events.find(e => e.id === state.fieldEvent.parent_event_id);
            pl.innerHTML = `<span class="sub-event-tag">혼성 세부종목</span> <button class="btn btn-sm btn-outline" onclick="switchToCombinedTab(${state.fieldEvent.parent_event_id})">← ${pe ? pe.name : '혼성'} 현황</button>`;
            pl.style.display = 'flex';
        } else { pl.style.display = 'none'; }
    }

    if (state.fieldHeats.length > 0) {
        state.fieldHeatId = state.fieldHeats[0].id;
        await loadFieldHeatData();
    }
}

async function loadFieldHeatData() {
    if (!state.fieldHeatId) return;
    state.fieldHeatEntries = await API.getHeatEntries(state.fieldHeatId);
    if (state.fieldEvent.category === 'field_height') {
        state.fieldHeightAttempts = await API.getHeightAttempts(state.fieldHeatId);
        document.getElementById('field-distance-section').style.display = 'none';
        document.getElementById('field-height-section').style.display = 'block';
        renderHeightSection();
    } else {
        state.fieldResults = await API.getResults(state.fieldHeatId);
        document.getElementById('field-distance-section').style.display = 'block';
        document.getElementById('field-height-section').style.display = 'none';
        renderFieldContent();
    }
}

function renderFieldContent() {
    const entries = state.fieldHeatEntries, results = state.fieldResults;
    const isView = state.fieldMode === 'view';
    const sec = document.getElementById('field-distance-section');
    sec.classList.toggle('view-mode', isView);
    document.getElementById('mode-input-btn').classList.toggle('active', !isView);
    document.getElementById('mode-view-btn').classList.toggle('active', isView);

    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {};
        er.forEach(r => { if (r.attempt_number != null) att[r.attempt_number] = r.distance_meters; });
        const valid = Object.values(att).filter(d => d != null && d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        return { ...e, attempts: att, best, maxAttempt: er.length > 0 ? Math.max(...er.map(r => r.attempt_number || 0)) : 0 };
    });

    const ranked = rows.filter(r => r.best != null).sort((a, b) => b.best - a.best);
    let cr = 1;
    ranked.forEach((r, i) => { r.rank = (i > 0 && ranked[i - 1].best === r.best) ? ranked[i - 1].rank : cr; cr = i + 2; });
    rows.forEach(r => {
        if (r.best == null) r.rank = null;
        else { const f = ranked.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
    });

    const top8 = getTop8Ids(rows);
    const sorted = isView
        ? [...rows].sort((a, b) => { if (a.rank != null && b.rank != null) return a.rank - b.rank; if (a.rank != null) return -1; if (b.rank != null) return 1; return +a.bib_number - +b.bib_number; })
        : [...rows].sort((a, b) => +a.bib_number - +b.bib_number);

    document.getElementById('field-distance-tbody').innerHTML = sorted.map(r => {
        const cls = top8.has(r.event_entry_id) ? 'top8-highlight' : '';
        let cells = '';
        for (let i = 1; i <= 6; i++) {
            const v = r.attempts[i];
            let c = v !== undefined && v !== null ? (v === 0 ? '<span class="foul-mark">X</span>' : v.toFixed(2)) : '';
            cells += `<td class="attempt-cell" data-entry="${r.event_entry_id}" data-attempt="${i}">${c}</td>`;
        }
        const best = r.best != null ? `<span class="best-mark">${r.best.toFixed(2)}</span>` : '<span class="no-rank">—</span>';
        return `<tr class="${cls}">
            <td>${r.rank != null ? r.rank : '<span class="no-rank">—</span>'}</td>
            <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${r.bib_number}</span></td>
            ${cells}<td data-entry="${r.event_entry_id}" data-type="best">${best}</td>
            <td class="action-col"><button class="btn btn-sm btn-primary" onclick="openFieldModal(${r.event_entry_id})">입력</button></td>
        </tr>`;
    }).join('');

    renderLiveRanking(ranked, top8);
}

function renderLiveRanking(ranked, top8) {
    const p = document.getElementById('field-live-ranking');
    if (!p) return;
    p.innerHTML = ranked.length === 0
        ? '<div class="empty-state">기록 없음</div>'
        : ranked.map(r => `<div class="ranking-item ${top8.has(r.event_entry_id) ? 'top8' : ''}">
            <span class="ranking-rank">${r.rank}</span>
            <span class="ranking-name">${r.name} #${r.bib_number}</span>
            <span class="ranking-best">${r.best.toFixed(2)}m</span>
        </div>`).join('');
}

function getTop8Ids(rows) {
    const wb = rows.filter(r => r.best != null).sort((a, b) => b.best - a.best);
    const ids = new Set();
    if (wb.length <= 8) { wb.forEach(r => ids.add(r.event_entry_id)); }
    else {
        let c = 0;
        for (let i = 0; i < wb.length; i++) {
            if (c < 8) { ids.add(wb[i].event_entry_id); c++; }
            else if (wb[i].best === wb[i - 1].best) ids.add(wb[i].event_entry_id);
            else break;
        }
    }
    return ids;
}

// Field Distance Modal
let modalState = { eventEntryId: null, entry: null, attempts: {} };

function setupFieldModal() {
    const ov = document.getElementById('field-modal-overlay');
    document.getElementById('modal-cancel-btn').addEventListener('click', closeFieldModal);
    ov.addEventListener('click', e => { if (e.target === ov) closeFieldModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov.style.display !== 'none') closeFieldModal(); });
    document.getElementById('modal-save-btn').addEventListener('click', saveFieldResult);
    document.getElementById('modal-distance-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveFieldResult(); });
    document.getElementById('modal-attempt-select').addEventListener('change', updateOverwriteWarning);
}

function openFieldModal(eid) {
    if (state.fieldMode === 'view') return;
    const entry = state.fieldHeatEntries.find(e => e.event_entry_id === eid);
    if (!entry) return;
    const results = state.fieldResults.filter(r => r.event_entry_id === eid);
    const att = {};
    results.forEach(r => { if (r.attempt_number != null) att[r.attempt_number] = r.distance_meters; });
    modalState = { eventEntryId: eid, entry, attempts: att };

    document.getElementById('modal-athlete-info').textContent = `${entry.name}  #${entry.bib_number}`;
    document.getElementById('modal-event-info').textContent = `${state.fieldEvent ? state.fieldEvent.name : ''} | ${entry.team || ''}`;

    const vd = Object.entries(att).filter(([, d]) => d != null && d > 0).map(([, d]) => d);
    const best = vd.length > 0 ? Math.max(...vd) : null;
    let rH = '';
    const keys = Object.keys(att).map(Number).sort((a, b) => a - b);
    if (keys.length === 0) rH = '<div style="color:var(--text-muted);">입력된 기록 없음</div>';
    else keys.forEach(n => {
        const d = att[n];
        rH += d === 0
            ? `<div class="record-line"><span>${n}차: <span class="foul-mark">X</span></span></div>`
            : `<div class="record-line"><span>${n}차: ${d.toFixed(2)}m</span>${d === best ? '<span class="record-best">BEST</span>' : ''}</div>`;
    });
    document.getElementById('modal-records').innerHTML = rH;

    const mx = keys.length > 0 ? Math.max(...keys) : 0;
    document.getElementById('modal-attempt-select').value = String(mx >= 6 ? 6 : mx + 1);
    document.getElementById('modal-distance-input').value = '';
    document.getElementById('modal-error').style.display = 'none';
    updateOverwriteWarning();
    document.getElementById('field-modal-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('modal-distance-input').focus(), 50);
}

function updateOverwriteWarning() {
    const sel = +document.getElementById('modal-attempt-select').value;
    const w = document.getElementById('modal-warning');
    if (modalState.attempts[sel] !== undefined) { w.textContent = '기존 기록을 덮어씁니다'; w.style.display = 'block'; }
    else w.style.display = 'none';
}

function closeFieldModal() {
    document.getElementById('field-modal-overlay').style.display = 'none';
    modalState = { eventEntryId: null, entry: null, attempts: {} };
}

async function saveFieldResult() {
    const aN = +document.getElementById('modal-attempt-select').value;
    const dIn = document.getElementById('modal-distance-input');
    const errDiv = document.getElementById('modal-error');
    if (!dIn.value.trim()) { errDiv.textContent = '기록을 입력해주세요.'; errDiv.style.display = 'block'; return; }
    const dist = parseFloat(dIn.value);
    if (isNaN(dist) || dist < 0) { errDiv.textContent = '유효한 기록을 입력하세요.'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';
    const savedId = modalState.eventEntryId, savedAtt = aN;
    try {
        await API.upsertResult({ heat_id: state.fieldHeatId, event_entry_id: modalState.eventEntryId, attempt_number: aN, distance_meters: dist });
        closeFieldModal();
        state.fieldResults = await API.getResults(state.fieldHeatId);
        renderFieldContent();
        const cell = document.querySelector(`td[data-entry="${savedId}"][data-attempt="${savedAtt}"]`);
        if (cell) { cell.classList.add('flash-success'); setTimeout(() => cell.classList.remove('flash-success'), 500); }
        if (state.fieldEvent && state.fieldEvent.parent_event_id) await syncCombinedFromSubEvent(state.fieldEvent.parent_event_id);
        renderAuditLog();
    } catch (err) { errDiv.textContent = '저장 실패'; errDiv.style.display = 'block'; }
}

// ============================================================
// HEIGHT SECTION
// ============================================================
function renderHeightSection() {
    const entries = state.fieldHeatEntries, attempts = state.fieldHeightAttempts;
    const heights = [...new Set(attempts.map(a => a.bar_height))].sort((a, b) => a - b);
    if (heights.length === 0) heights.push(state.currentBarHeight);

    const thead = document.getElementById('field-height-table').querySelector('thead tr');
    let hdr = '<th>RANK</th><th>NAME / BIB</th>';
    heights.forEach(h => { hdr += `<th style="font-size:10px;">${h.toFixed(2)}m</th>`; });
    hdr += '<th>최고</th><th>상태</th><th class="action-col">ACTION</th>';
    thead.innerHTML = hdr;

    const rows = entries.map(e => {
        const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {};
        ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
        let best = null, elim = false;
        heights.forEach(h => {
            const d = hd[h];
            if (!d) return;
            if (Object.values(d).includes('O')) best = h;
            if (Object.values(d).filter(m => m === 'X').length >= 3) elim = true;
        });
        return { ...e, heightData: hd, bestHeight: best, eliminated: elim };
    });

    const rankedH = rows.filter(r => r.bestHeight != null).sort((a, b) => b.bestHeight - a.bestHeight);
    let rk = 1;
    rankedH.forEach((r, i) => { r.rank = (i > 0 && rankedH[i - 1].bestHeight === r.bestHeight) ? rankedH[i - 1].rank : rk; rk = i + 2; });
    rows.forEach(r => {
        if (r.bestHeight == null) r.rank = null;
        else { const f = rankedH.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
    });

    document.getElementById('field-height-tbody').innerHTML = rows.map(r => {
        let cells = '';
        heights.forEach(h => {
            const hd = r.heightData[h] || {};
            let marks = '';
            for (let i = 1; i <= 3; i++) { const m = hd[i]; if (m) marks += `<span class="height-mark mark-${m}">${m}</span>`; }
            cells += `<td style="font-size:11px;">${marks}</td>`;
        });
        return `<tr>
            <td>${r.rank || '—'}</td>
            <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${r.bib_number}</span></td>
            ${cells}
            <td>${r.bestHeight != null ? `<strong>${r.bestHeight.toFixed(2)}m</strong>` : '—'}</td>
            <td>${r.eliminated ? '<span style="color:var(--danger);font-weight:700;">탈락</span>' : '<span style="color:var(--green);">경기중</span>'}</td>
            <td class="action-col"><button class="btn btn-sm btn-primary" onclick="openHeightModal(${r.event_entry_id})" ${r.eliminated ? 'disabled' : ''}>입력</button></td>
        </tr>`;
    }).join('');

    document.getElementById('height-bar-input').value = state.currentBarHeight.toFixed(2);

    const setBtn = document.getElementById('height-set-bar-btn');
    const nb1 = setBtn.cloneNode(true); setBtn.parentNode.replaceChild(nb1, setBtn);
    nb1.addEventListener('click', () => { state.currentBarHeight = parseFloat(document.getElementById('height-bar-input').value) || 2.10; });

    const raiseBtn = document.getElementById('height-raise-bar-btn');
    const nb2 = raiseBtn.cloneNode(true); raiseBtn.parentNode.replaceChild(nb2, raiseBtn);
    nb2.addEventListener('click', () => {
        state.currentBarHeight = Math.round((state.currentBarHeight + 0.05) * 100) / 100;
        document.getElementById('height-bar-input').value = state.currentBarHeight.toFixed(2);
    });
}

let heightModalState = { eventEntryId: null };

function setupHeightModal() {
    const ov = document.getElementById('height-modal-overlay');
    document.getElementById('hmodal-cancel-btn').addEventListener('click', () => { ov.style.display = 'none'; });
    ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; });
    document.querySelectorAll('.height-mark-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await API.saveHeightAttempt({
                    heat_id: state.fieldHeatId,
                    event_entry_id: heightModalState.eventEntryId,
                    bar_height: state.currentBarHeight,
                    attempt_number: +document.getElementById('hmodal-attempt-select').value,
                    result_mark: btn.dataset.mark
                });
                ov.style.display = 'none';
                state.fieldHeightAttempts = await API.getHeightAttempts(state.fieldHeatId);
                renderHeightSection();
                if (state.fieldEvent && state.fieldEvent.parent_event_id) await syncCombinedFromSubEvent(state.fieldEvent.parent_event_id);
                renderAuditLog();
            } catch (err) {
                document.getElementById('hmodal-error').textContent = '저장 실패';
                document.getElementById('hmodal-error').style.display = 'block';
            }
        });
    });
}

function openHeightModal(eid) {
    heightModalState.eventEntryId = eid;
    const entry = state.fieldHeatEntries.find(e => e.event_entry_id === eid);
    if (!entry) return;
    document.getElementById('hmodal-athlete-info').textContent = `${entry.name}  #${entry.bib_number}`;
    document.getElementById('hmodal-event-info').textContent = `${state.fieldEvent.name} | ${state.currentBarHeight.toFixed(2)}m`;
    document.getElementById('hmodal-height-input').value = state.currentBarHeight.toFixed(2);
    const ha = state.fieldHeightAttempts.filter(a => a.event_entry_id === eid && a.bar_height === state.currentBarHeight);
    let rH = '';
    if (ha.length === 0) rH = '<div style="color:var(--text-muted);">시도 없음</div>';
    else ha.forEach(a => { rH += `<div>${a.attempt_number}차: <span class="height-mark mark-${a.result_mark}">${a.result_mark}</span></div>`; });
    document.getElementById('hmodal-records').innerHTML = rH;
    document.getElementById('hmodal-attempt-select').value = String(ha.length > 0 ? Math.min(ha.length + 1, 3) : 1);
    document.getElementById('hmodal-error').style.display = 'none';
    document.getElementById('height-modal-overlay').style.display = 'flex';
}

// ============================================================
// COMBINED EVENTS
// ============================================================
async function renderCombined() {
    if (!state.combinedEventId) return;
    state.combinedEvent = await API.getEvent(state.combinedEventId);
    state.combinedEntries = await API.getEventEntries(state.combinedEventId);
    state.combinedSubEvents = await API.getCombinedSubEvents(state.combinedEventId);
    await API.syncCombinedScores(state.combinedEventId);
    state.combinedScores = await API.getCombinedScores(state.combinedEventId);

    const subDefs = state.combinedEvent.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;

    // Recalc WA points
    for (const sc of state.combinedScores) {
        if (sc.raw_record > 0) {
            const def = subDefs.find(d => d.order === sc.sub_event_order);
            if (def) {
                const pts = calcWAPoints(def.key, sc.raw_record);
                if (pts !== sc.wa_points) {
                    await API.saveCombinedScore({
                        event_entry_id: sc.event_entry_id,
                        sub_event_name: sc.sub_event_name,
                        sub_event_order: sc.sub_event_order,
                        raw_record: sc.raw_record,
                        wa_points: pts
                    });
                }
            }
        }
    }
    state.combinedScores = await API.getCombinedScores(state.combinedEventId);

    const subDiv = document.getElementById('combined-sub-events');
    subDiv.innerHTML = subDefs.map((se, idx) => {
        const dbSub = state.combinedSubEvents[idx];
        const hasData = state.combinedScores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
        const cls = hasData ? 'completed' : '';
        return `<button class="combined-sub-btn ${cls}" onclick="navigateToSubEvent(${dbSub ? dbSub.id : 0},'${dbSub ? dbSub.category : ''}')">
            <span class="sub-order">${se.order}</span>${se.name}${hasData ? ' ✓' : ''}</button>`;
    }).join('');

    document.getElementById('combined-input-area').style.display = 'none';
    renderCombinedStandings(subDefs);
}

function navigateToSubEvent(eventId, category) {
    if (!eventId) return;
    clearUnsaved();
    if (category === 'track') {
        switchToTab('track');
        state.trackEventId = eventId;
        const s = document.getElementById('track-event-select');
        if (s) s.value = String(eventId);
        renderTrack();
    } else if (category === 'field_distance' || category === 'field_height') {
        switchToTab('field');
        state.fieldEventId = eventId;
        const s = document.getElementById('field-event-select');
        if (s) s.value = String(eventId);
        renderField();
    }
}

function switchToCombinedTab(parentEventId) {
    clearUnsaved();
    switchToTab('combined');
    state.combinedEventId = parentEventId;
    const s = document.getElementById('combined-event-select');
    if (s) s.value = String(parentEventId);
    renderCombined();
}

async function syncCombinedFromSubEvent(parentEventId) {
    try {
        await API.syncCombinedScores(parentEventId);
        const scores = await API.getCombinedScores(parentEventId);
        const pe = state.events.find(e => e.id === parentEventId);
        if (!pe) return;
        const subDefs = pe.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
        for (const sc of scores) {
            if (sc.raw_record > 0) {
                const def = subDefs.find(d => d.order === sc.sub_event_order);
                if (def) {
                    const pts = calcWAPoints(def.key, sc.raw_record);
                    if (pts !== sc.wa_points) {
                        await API.saveCombinedScore({
                            event_entry_id: sc.event_entry_id,
                            sub_event_name: sc.sub_event_name,
                            sub_event_order: sc.sub_event_order,
                            raw_record: sc.raw_record,
                            wa_points: pts
                        });
                    }
                }
            }
        }
    } catch (e) { console.error('sync:', e); }
}

function renderCombinedStandings(subDefs) {
    const headerRow = document.getElementById('combined-standings-table').querySelector('thead tr');
    let hdr = '<th>RANK</th><th>BIB</th><th>선수명</th>';
    subDefs.forEach(se => { hdr += `<th style="font-size:9px;padding:3px 2px;writing-mode:vertical-lr;max-width:26px;">${se.name}</th>`; });
    hdr += '<th>총점</th>';
    headerRow.innerHTML = hdr;

    const rows = state.combinedEntries.map(e => {
        let total = 0;
        const pts = {}, recs = {};
        subDefs.forEach(se => {
            const sc = state.combinedScores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
            const p = sc ? sc.wa_points : 0;
            const rec = sc ? sc.raw_record : null;
            pts[se.order] = p;
            recs[se.order] = rec;
            total += p;
        });
        return { ...e, pts, recs, total };
    }).sort((a, b) => b.total - a.total);

    let rk = 1;
    rows.forEach((r, i) => { r.rank = (i > 0 && rows[i - 1].total === r.total) ? rows[i - 1].rank : rk; rk = i + 2; });

    document.getElementById('combined-standings-tbody').innerHTML = rows.map(r => {
        let cells = '';
        subDefs.forEach(se => {
            const rec = r.recs[se.order], p = r.pts[se.order];
            let d = '—';
            if (rec && rec > 0) {
                const rs = se.unit === 's' ? formatTime(rec) : rec.toFixed(2) + 'm';
                d = `<div style="font-size:10px;">${rs}</div><div style="font-size:10px;color:var(--green);font-weight:700;">${p}</div>`;
            }
            cells += `<td style="padding:2px 3px;line-height:1.2;">${d}</td>`;
        });
        return `<tr>
            <td><strong>${r.rank}</strong></td><td>${r.bib_number}</td><td style="text-align:left;">${r.name}</td>
            ${cells}
            <td><span class="combined-total-points">${r.total > 0 ? r.total : '—'}</span></td>
        </tr>`;
    }).join('');
}

function setupCombinedModal() {
    const ov = document.getElementById('combined-modal-overlay');
    document.getElementById('cmodal-cancel-btn').addEventListener('click', () => { ov.style.display = 'none'; });
    ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; });
}

// ============================================================
// RESULTS
// ============================================================
async function renderResults() {
    if (!state.resultsEventId) return;
    state.resultsEvent = await API.getEvent(state.resultsEventId);
    state.resultsHeats = await API.getHeats(state.resultsEventId);
    const hs = document.getElementById('results-heat-select');
    hs.innerHTML = state.resultsHeats.map(h => `<option value="${h.id}">Heat ${h.heat_number}</option>`).join('');
    if (state.resultsHeats.length > 0) {
        state.resultsHeatId = state.resultsHeats[0].id;
        await loadResultsData();
    } else {
        document.getElementById('results-tbody').innerHTML = '';
        document.getElementById('results-header-area').innerHTML = '<div class="empty-state">Heat 없음</div>';
    }
}

async function loadResultsData() {
    if (!state.resultsHeatId || !state.resultsEvent) return;
    const entries = await API.getHeatEntries(state.resultsHeatId);
    const cat = state.resultsEvent.category;
    const gL = { M: '남자', F: '여자', X: '혼성' }[state.resultsEvent.gender] || '';

    document.getElementById('results-header-area').innerHTML = `<h2>${state.resultsEvent.name} ${gL}</h2><p>2026 Pace Rise Invitational — ${new Date().toLocaleDateString('ko-KR')}</p>`;

    if (cat === 'track') {
        const results = await API.getResults(state.resultsHeatId);
        document.getElementById('results-thead').innerHTML = '<tr><th>RANK</th><th>LANE</th><th>BIB</th><th>선수명</th><th>소속</th><th>기록</th></tr>';
        const rows = entries.map(e => { const r = results.find(r => r.event_entry_id === e.event_entry_id); return { ...e, time_seconds: r ? r.time_seconds : null }; })
            .sort((a, b) => { if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1; return a.time_seconds - b.time_seconds; });
        let rk = 1;
        rows.forEach((r, i) => { r.rank = r.time_seconds == null ? '—' : ((i > 0 && rows[i - 1].time_seconds === r.time_seconds) ? rows[i - 1].rank : rk); rk = i + 2; });
        document.getElementById('results-tbody').innerHTML = rows.map(r =>
            `<tr><td>${r.rank}</td><td>${r.lane_number || '—'}</td><td>${r.bib_number}</td><td style="text-align:left;">${r.name}</td><td>${r.team || ''}</td><td style="font-family:var(--font-mono);font-weight:600;">${r.time_seconds != null ? formatTime(r.time_seconds) : '—'}</td></tr>`
        ).join('');
    } else if (cat === 'field_distance') {
        const results = await API.getResults(state.resultsHeatId);
        document.getElementById('results-thead').innerHTML = '<tr><th>RANK</th><th>BIB</th><th>선수명</th><th>소속</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>BEST</th></tr>';
        const rows = entries.map(e => {
            const er = results.filter(r => r.event_entry_id === e.event_entry_id);
            const att = {};
            er.forEach(r => { if (r.attempt_number) att[r.attempt_number] = r.distance_meters; });
            const valid = Object.values(att).filter(d => d > 0);
            return { ...e, att, best: valid.length > 0 ? Math.max(...valid) : null };
        }).sort((a, b) => { if (a.best == null) return 1; if (b.best == null) return -1; return b.best - a.best; });
        let rk = 1;
        rows.forEach((r, i) => { r.rank = r.best == null ? '—' : ((i > 0 && rows[i - 1].best === r.best) ? rows[i - 1].rank : rk); rk = i + 2; });
        document.getElementById('results-tbody').innerHTML = rows.map(r => {
            let c = '';
            for (let i = 1; i <= 6; i++) { const v = r.att[i]; c += `<td style="font-family:var(--font-mono);font-size:12px;">${v != null ? (v === 0 ? 'X' : v.toFixed(2)) : ''}</td>`; }
            return `<tr><td>${r.rank}</td><td>${r.bib_number}</td><td style="text-align:left;">${r.name}</td><td>${r.team || ''}</td>${c}<td style="font-weight:700;font-family:var(--font-mono);">${r.best != null ? r.best.toFixed(2) : '—'}</td></tr>`;
        }).join('');
    } else if (cat === 'field_height') {
        const ha = await API.getHeightAttempts(state.resultsHeatId);
        const hts = [...new Set(ha.map(a => a.bar_height))].sort((a, b) => a - b);
        let h = '<tr><th>RANK</th><th>BIB</th><th>선수명</th><th>소속</th>';
        hts.forEach(h2 => { h += `<th style="font-size:10px;">${h2.toFixed(2)}</th>`; });
        h += '<th>최고</th></tr>';
        document.getElementById('results-thead').innerHTML = h;
        const rows = entries.map(e => {
            const ea = ha.filter(a => a.event_entry_id === e.event_entry_id);
            const hd = {};
            ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
            let best = null;
            hts.forEach(h2 => { const d = hd[h2]; if (d && Object.values(d).includes('O')) best = h2; });
            return { ...e, hd, best };
        }).sort((a, b) => { if (a.best == null) return 1; if (b.best == null) return -1; return b.best - a.best; });
        let rk = 1;
        rows.forEach((r, i) => { r.rank = r.best == null ? '—' : ((i > 0 && rows[i - 1].best === r.best) ? rows[i - 1].rank : rk); rk = i + 2; });
        document.getElementById('results-tbody').innerHTML = rows.map(r => {
            let c = '';
            hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) m += d[i]; } c += `<td style="font-size:11px;">${m || ''}</td>`; });
            return `<tr><td>${r.rank}</td><td>${r.bib_number}</td><td style="text-align:left;">${r.name}</td><td>${r.team || ''}</td>${c}<td style="font-weight:700;">${r.best != null ? r.best.toFixed(2) + 'm' : '—'}</td></tr>`;
        }).join('');
    } else if (cat === 'combined') {
        await API.syncCombinedScores(state.resultsEventId);
        const scores = await API.getCombinedScores(state.resultsEventId);
        const subDefs = state.resultsEvent.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
        const allEntries = await API.getEventEntries(state.resultsEventId);
        for (const sc of scores) {
            if (sc.raw_record > 0) {
                const def = subDefs.find(d => d.order === sc.sub_event_order);
                if (def && calcWAPoints(def.key, sc.raw_record) !== sc.wa_points) {
                    await API.saveCombinedScore({ event_entry_id: sc.event_entry_id, sub_event_name: sc.sub_event_name, sub_event_order: sc.sub_event_order, raw_record: sc.raw_record, wa_points: calcWAPoints(def.key, sc.raw_record) });
                }
            }
        }
        const fresh = await API.getCombinedScores(state.resultsEventId);
        let hdr = '<tr><th>RANK</th><th>BIB</th><th>선수명</th>';
        subDefs.forEach(se => { hdr += `<th style="font-size:9px;">${se.name}</th>`; });
        hdr += '<th>총점</th></tr>';
        document.getElementById('results-thead').innerHTML = hdr;
        const rows = allEntries.map(e => {
            let t = 0;
            const pts = {};
            subDefs.forEach(se => { const sc = fresh.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order); pts[se.order] = sc ? sc.wa_points : 0; t += pts[se.order]; });
            return { ...e, pts, total: t };
        }).sort((a, b) => b.total - a.total);
        let rk = 1;
        rows.forEach((r, i) => { r.rank = (i > 0 && rows[i - 1].total === r.total) ? rows[i - 1].rank : rk; rk = i + 2; });
        document.getElementById('results-tbody').innerHTML = rows.map(r => {
            let c = '';
            subDefs.forEach(se => { c += `<td style="font-size:10px;">${r.pts[se.order] || '—'}</td>`; });
            return `<tr><td>${r.rank}</td><td>${r.bib_number}</td><td style="text-align:left;">${r.name}</td>${c}<td><strong>${r.total || '—'}</strong></td></tr>`;
        }).join('');
    } else {
        document.getElementById('results-thead').innerHTML = '';
        document.getElementById('results-tbody').innerHTML = '<tr><td class="empty-state">데이터 없음</td></tr>';
    }
}

// ============================================================
// EXPORT
// ============================================================
function setupExportButtons() {
    document.getElementById('export-excel-btn').addEventListener('click', () => {
        const t = document.getElementById('results-table');
        if (!t) return;
        const wb = XLSX.utils.table_to_book(t, { sheet: 'Results' });
        XLSX.writeFile(wb, `${state.resultsEvent ? state.resultsEvent.name : 'results'}_results.xlsx`);
    });
    document.getElementById('export-png-btn').addEventListener('click', async () => {
        const el = document.getElementById('results-content');
        if (!el) return;
        try {
            const c = await html2canvas(el, { scale: 2, backgroundColor: '#fff' });
            const a = document.createElement('a');
            a.download = `${state.resultsEvent ? state.resultsEvent.name : 'results'}.png`;
            a.href = c.toDataURL('image/png');
            a.click();
        } catch (e) { alert('이미지 생성 실패'); }
    });
    document.getElementById('export-pdf-btn').addEventListener('click', async () => {
        const el = document.getElementById('results-content');
        if (!el) return;
        try {
            const c = await html2canvas(el, { scale: 2, backgroundColor: '#fff' });
            const w = window.open('', '_blank');
            w.document.write(`<html><head><title>Results</title></head><body style="margin:0;padding:20px;"><img src="${c.toDataURL('image/png')}" style="max-width:100%;"><script>window.onload=function(){window.print();}<\/script></body></html>`);
            w.document.close();
        } catch (e) { alert('PDF 생성 실패'); }
    });
}

// ============================================================
// AUDIT LOG
// ============================================================
async function renderAuditLog() {
    try {
        const logs = await API.getAuditLog();
        document.getElementById('audit-log-container').innerHTML = logs.map(l =>
            `<div class="audit-entry"><strong>[${l.action}]</strong> ${l.table_name} #${l.record_id} — ${l.performed_by} — ${l.created_at}</div>`
        ).join('') || '<div class="audit-entry">기록 없음</div>';
    } catch (e) { }
}
