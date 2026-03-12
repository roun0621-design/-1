/**
 * PACE RISE : Node — common.js v9.0
 * Multi-competition, 3-tier auth, shared utilities
 */

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
// Record eligibility: wind ≤ +2.0 m/s. ≥+2.1 m/s → valid performance but not ranked/record.
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
    // Competitions
    getCompetitions: () => api('GET', '/api/competitions'),
    getCompetition: id => api('GET', `/api/competitions/${id}`),
    createCompetition: (data, adminKey) => api('POST', '/api/competitions', { ...data, admin_key: adminKey }),
    updateCompetition: (id, data, adminKey) => api('PUT', `/api/competitions/${id}`, { ...data, admin_key: adminKey }),
    deleteCompetition: (id, adminKey) => api('DELETE', `/api/competitions/${id}`, { admin_key: adminKey }),
    getRecentCompetitions: () => api('GET', '/api/competitions/recent'),
    getCompetitionsByFederation: (code) => api('GET', `/api/competitions/by-federation/${encodeURIComponent(code)}`),

    // Federations
    getFederations: () => api('GET', '/api/federations'),
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
    updateEntryStatus: (id, st) => api('PATCH', `/api/event-entries/${id}/status`, { status: st }),
    checkinBarcode: (bc, eid) => api('POST', '/api/callroom/checkin', { barcode: bc, event_id: eid }),
    cancelCheckin: (id) => api('PATCH', `/api/event-entries/${id}/status`, { status: 'registered' }),
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
    if (gender === 'M') return '#2196F3'; // blue
    if (gender === 'F') return '#F8BBD0'; // light pink
    if (gender === 'X') return '#FFF176'; // yellow
    return '#9E9E9E';
}
function getGenderBg(gender) {
    if (gender === 'M') return '#e3f2fd';
    if (gender === 'F') return '#fce4ec';
    if (gender === 'X') return '#fffde7';
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

function connectSSE() {
    if (_sseConnection && _sseConnection.readyState !== 2) return;
    if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
    try {
        _sseConnection = new EventSource('/api/sse');
        _sseConnection.addEventListener('connected', () => { console.log('[SSE] Connected'); });
        ['result_update','entry_status','event_completed','callroom_complete','height_update','combined_update','event_reverted','operation_log','event_status_changed','wind_update'].forEach(evt => {
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
        const info = await API.getCompetitionInfo(getCompetitionId());
        let fedBadge = '';
        if (info.federation) {
            // Dynamic federation badge from DB (no hardcoding)
            try {
                const feds = await API.getFederations();
                const fed = feds.find(f => f.code === info.federation);
                if (fed) {
                    fedBadge = `<span style="background:${fed.badge_bg};color:${fed.badge_color};padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600;">${fed.code}</span>`;
                } else {
                    fedBadge = `<span style="background:#f5f5f5;color:#616161;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600;">${info.federation}</span>`;
                }
            } catch(e) {
                fedBadge = `<span style="background:#f5f5f5;color:#616161;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600;">${info.federation}</span>`;
            }
        }
        el.innerHTML = `<span class="comp-info-name">${info.name || ''}</span>
            ${fedBadge}
            <span class="comp-info-sep">|</span>
            <span class="comp-info-dates">${info.dates || ''}</span>
            <span class="comp-info-sep">|</span>
            <span class="comp-info-venue">${info.venue || ''}</span>`;
    } catch (e) {}
}

function renderPageNav(currentPage) {
    const nav = document.getElementById('page-nav');
    if (!nav) return;
    const compId = getCompetitionId();
    const q = compId ? `?comp=${compId}` : '';
    const role = sessionStorage.getItem('pace_role') || 'viewer';

    // Inject login button + refresh button into header-inner if not already there (all pages)
    const headerInner = document.querySelector('.header-inner');
    if (headerInner && !document.getElementById('header-login-btn')) {
        // Create a button group wrapper
        const btnGroup = document.createElement('div');
        btnGroup.className = 'header-btn-group';

        // Refresh button
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'header-refresh-btn';
        refreshBtn.id = 'header-refresh-btn';
        refreshBtn.title = '\uc0c8\ub85c\uace0\uce68'; // 새로고침
        refreshBtn.innerHTML = '\u21bb'; // ↻
        refreshBtn.onclick = function() {
            location.reload();
        };

        // Login button
        const loginBtn = document.createElement('button');
        loginBtn.className = 'header-login-btn' + (role !== 'viewer' ? ' logged-in' : '');
        loginBtn.id = 'header-login-btn';
        loginBtn.innerHTML = `<span id="header-login-label">${role !== 'viewer' ? '\ub85c\uadf8\uc544\uc6c3' : '\ub85c\uadf8\uc778'}</span>`;
        loginBtn.onclick = function() {
            const r = sessionStorage.getItem('pace_role') || 'viewer';
            if (r !== 'viewer') {
                // Logout
                sessionStorage.removeItem('pace_admin_key');
                sessionStorage.removeItem('pace_role');
                sessionStorage.removeItem('pace_judge_name');
                location.reload();
            } else if (window._headerLoginToggle) {
                window._headerLoginToggle();
            } else {
                window.location.href = '/?action=login';
            }
        };

        btnGroup.appendChild(refreshBtn);
        btnGroup.appendChild(loginBtn);
        headerInner.appendChild(btnGroup);
    }

    // Make header title clickable → home
    const headerTitle = document.querySelector('.header-title');
    if (headerTitle && !headerTitle.dataset.linked) {
        headerTitle.style.cursor = 'pointer';
        headerTitle.addEventListener('click', () => { window.location.href = '/'; });
        headerTitle.dataset.linked = '1';
    }

    let pages;
    if (currentPage === 'home') {
        // Home: only show home — no other nav links
        pages = [{ key: 'home', label: '홈', href: '/' }];
    } else if (role === 'admin') {
        // Admin: all pages including admin
        pages = [
            { key: 'home', label: '홈', href: '/' },
            { key: 'dashboard', label: '대시보드', href: `/dashboard.html${q}` },
            { key: 'callroom', label: '소집실', href: `/callroom.html${q}` },
            { key: 'record', label: '기록입력', href: `/record.html${q}` },
            { key: 'results', label: '결과확인', href: `/results.html${q}` },
            { key: 'admin', label: '관리', href: `/admin.html${q}` },
        ];
    } else if (role === 'operation') {
        // Judge/operation: dashboard + callroom + record + results (NO admin tab)
        pages = [
            { key: 'home', label: '홈', href: '/' },
            { key: 'dashboard', label: '대시보드', href: `/dashboard.html${q}` },
            { key: 'callroom', label: '소집실', href: `/callroom.html${q}` },
            { key: 'record', label: '기록입력', href: `/record.html${q}` },
            { key: 'results', label: '결과확인', href: `/results.html${q}` },
        ];
    } else {
        // Viewer: dashboard + results (public read-only)
        pages = [
            { key: 'home', label: '홈', href: '/' },
            { key: 'dashboard', label: '대시보드', href: `/dashboard.html${q}` },
            { key: 'results', label: '결과확인', href: `/results.html${q}` },
        ];
    }
    nav.innerHTML = pages.map(p =>
        `<a href="${p.href}" class="nav-link ${p.key === currentPage ? 'active' : ''}">${p.label}</a>`
    ).join('');
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
        // Try to auto-detect: fetch competitions and use the latest active or first one
        try {
            const comps = await fetch('/api/competitions').then(r => r.json());
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
        #pacerise-footer .pr-footer-links a:hover { color:#2d9d78; }
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
    const bg = type === 'success' ? 'var(--green)' : type === 'error' ? '#c62828' : '#f57f17';
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
// PWA Service Worker Registration
// ============================================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}
