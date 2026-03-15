/**
 * PACE RISE : Node — record.js v3
 * Dashboard-style Record Entry: event matrix + inline editing
 * v3: sort toggles, unified small-number, pass/-  standardization, wind UI improvements,
 *     heat count for semi/final, manual heat edit, Q/q badges everywhere
 */

// Helper: display bib_number safely (null/undefined → '—')
function bib(val) { return val != null && val !== '' ? val : '—'; }

// Helper: heat display label (custom name or "Heat N")
function heatLabel(h) { return h.heat_name || ('Heat ' + h.heat_number); }

// ============================================================
// State
// ============================================================
const state = {
    events: [], currentGender: 'M',
    selectedEventId: null, selectedEvent: null,
    heats: [], heatId: null, heatEntries: [], results: [], heightAttempts: [],
    currentBarHeight: 2.10, fieldMode: 'input', heightMode: 'input',
    _pendingInlineTrack: {},
    _activeFieldCell: null,   // { entryId, attempt } for inline field editing
    _activeWindCell: null,    // { entryId, attempt } for inline wind editing
    // Combined
    combinedEntries: [], combinedScores: [], combinedSubEvents: [],
};

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    if (!(await requireCompetition())) return;
    renderPageNav('record');
    await renderCompInfoBar();
    state.events = await API.getAllEvents(getCompetitionId());
    setupGenderTabs();
    setupFieldModal();
    setupHeightModal();
    setupFieldClickOutside();
    renderMatrix();

    // If event_id in URL, auto-select
    const urlEventId = getParam('event_id');
    if (urlEventId) {
        const evt = state.events.find(e => e.id === +urlEventId);
        if (evt) {
            state.currentGender = evt.gender;
            document.querySelectorAll('.gender-tab').forEach(b => b.classList.toggle('active', b.dataset.gender === state.currentGender));
            renderMatrix();
            await selectEvent(evt.id);
        }
    }

    renderAuditLog();

    // SSE real-time listeners
    onSSE('entry_status', async (data) => {
        // Refresh current heat data if we're viewing an event
        if (state.heatId && state.selectedEvent) {
            const cat = state.selectedEvent.category;
            if (cat === 'track' || cat === 'relay' || cat === 'road') await loadTrackHeatData();
            else if (cat === 'field_distance') await loadFieldDistanceData();
            else if (cat === 'field_height') await loadFieldHeightData();
        }
    });
    onSSE('result_update', async (data) => {
        if (state.heatId && state.selectedEvent) {
            const cat = state.selectedEvent.category;
            if (cat === 'track' || cat === 'relay' || cat === 'road') {
                state.results = await API.getResults(state.heatId);
                renderTrackTable();
            } else if (cat === 'field_distance') {
                state.results = await API.getResults(state.heatId);
                renderFieldDistanceContent();
            }
        }
    });
    onSSE('height_update', async (data) => {
        if (state.heatId && state.selectedEvent && state.selectedEvent.category === 'field_height') {
            state.heightAttempts = await API.getHeightAttempts(state.heatId);
            renderHeightContent();
        }
    });
    onSSE('wind_update', async (data) => {
        if (state.heatId && data.heat_id === state.heatId && state.selectedEvent) {
            if (requiresWindMeasurement(state.selectedEvent.name, 'track')) await loadHeatWind();
        }
    });
    onSSE('combined_update', async (data) => {
        // Refresh combined scores if viewing combined event
        if (_combinedParentEvt) {
            state.combinedScores = await API.getCombinedScores(_combinedParentEvt.id);
            // If on scoreboard tab, refresh it
            if (_combinedActiveTab === 0) {
                const c = document.getElementById('combined-content');
                if (c) await _renderScoreboard(c);
            }
        }
    });
    onSSE('event_completed', async () => {
        state.events = await API.getAllEvents(getCompetitionId());
        renderMatrix();
    });
    onSSE('event_reverted', async (data) => {
        state.events = await API.getAllEvents(getCompetitionId());
        // Update current event status so UI reflects revert immediately
        if (state.selectedEvent && data && data.event_id === state.selectedEvent.id) {
            state.selectedEvent = await API.getEvent(data.event_id);
        }
        renderMatrix();
    });
    onSSE('event_status_changed', async (data) => {
        state.events = await API.getAllEvents(getCompetitionId());
        renderMatrix();
        // Update current event if it's the one that changed
        if (state.selectedEvent && state.selectedEvent.id === data.event_id) {
            state.selectedEvent = await API.getEvent(data.event_id);
        }
        // If a sub-event changed status, refresh combined parent
        if (_combinedParentEvt) {
            const subEvts = state.events.filter(e => e.parent_event_id === _combinedParentEvt.id);
            if (subEvts.some(s => s.id === data.event_id)) {
                state.combinedScores = await API.getCombinedScores(_combinedParentEvt.id);
            }
        }
    });
});

// ============================================================
// Completed Event Edit Confirmation
// ============================================================
function confirmCompletedEdit() {
    if (state.selectedEvent && state.selectedEvent.round_status === 'completed') {
        return confirm('이 경기는 이미 완료된 경기입니다.\n대회 결과를 정정하시겠습니까?');
    }
    return true;
}

// ============================================================
// Gender Tabs
// ============================================================
function setupGenderTabs() {
    document.querySelectorAll('.gender-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            checkUnsavedBeforeAction(() => {
                document.querySelectorAll('.gender-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.currentGender = btn.dataset.gender;
                renderMatrix();
                state.selectedEventId = null;
                showPlaceholder();
            });
        });
    });
}

// ============================================================
// Event Matrix (Left Panel — same structure as main dashboard)
// ============================================================
function renderMatrix() {
    const container = document.getElementById('record-matrix');
    const events = state.events.filter(e => e.gender === state.currentGender && !e.parent_event_id);

    const categories = [
        { key: 'track', label: 'TRACK', match: c => c === 'track' },
        { key: 'field', label: 'FIELD', match: c => c === 'field_distance' || c === 'field_height' },
        { key: 'combined', label: 'COMBINED', match: c => c === 'combined' },
        { key: 'relay', label: 'RELAY', match: c => c === 'relay' },
        { key: 'road', label: 'ROAD', match: c => c === 'road' },
    ];

    const eventGroups = {};
    events.forEach(e => {
        const gKey = e.name + '|' + e.category;
        if (!eventGroups[gKey]) eventGroups[gKey] = { name: e.name, category: e.category, rounds: [] };
        eventGroups[gKey].rounds.push(e);
    });

    let html = '';
    categories.forEach(cat => {
        const groups = Object.values(eventGroups).filter(g => cat.match(g.category));
        if (groups.length === 0) return;

        html += `<div class="matrix-section matrix-section-compact">
            <div class="matrix-section-title">${cat.label}</div>
            <table class="matrix-table matrix-table-compact">
                <thead><tr>
                    <th>종목</th>
                    <th>예선</th>
                    <th>준결승</th>
                    <th>결승</th>
                </tr></thead>
                <tbody>`;

        groups.forEach(g => {
            const prelim = g.rounds.find(r => r.round_type === 'preliminary');
            const semi = g.rounds.find(r => r.round_type === 'semifinal');
            const fin = g.rounds.find(r => r.round_type === 'final');

            html += `<tr>
                <td class="rec-matrix-event">${g.name}</td>
                <td class="round-cell">${renderRecordBtn(prelim)}</td>
                <td class="round-cell">${renderRecordBtn(semi)}</td>
                <td class="round-cell">${renderRecordBtn(fin)}</td>
            </tr>`;
        });

        html += `</tbody></table></div>`;
    });

    if (!html) html = '<div class="empty-state">해당 성별의 종목이 없습니다.</div>';
    container.innerHTML = html;
}

function renderRecordBtn(evt) {
    if (!evt) return '<span class="round-btn status-none rec-round-btn">—</span>';
    const cls = getRecStatusClass(evt);
    const activeClass = (evt.id === state.selectedEventId) ? ' rec-btn-active' : '';
    const roundLabel = fmtRound(evt.round_type);
    return `<a class="round-btn ${cls}${activeClass} rec-round-btn" href="javascript:void(0)" 
        data-event-id="${evt.id}" onclick="selectEventSafe(${evt.id})" 
        title="${roundLabel} 기록">${roundLabel} 기록</a>`;
}

function getRecStatusClass(evt) {
    const st = evt.round_status;
    if (st === 'completed') return 'status-done';
    if (st === 'in_progress') return 'status-active';
    if (st === 'heats_generated') return 'status-ready';
    return 'status-created';
}

function highlightSelected() {
    document.querySelectorAll('.rec-round-btn[data-event-id]').forEach(b => {
        b.classList.toggle('rec-btn-active', +b.dataset.eventId === state.selectedEventId);
    });
}

function selectEventSafe(eventId) {
    checkUnsavedBeforeAction(async () => { await selectEvent(eventId); });
}

async function selectEvent(eventId) {
    state.selectedEventId = eventId;
    highlightSelected();
    setParams({ event_id: eventId });

    // Show loading spinner
    document.getElementById('record-detail').innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div><p>데이터 불러오는 중...</p></div>`;

    state.selectedEvent = await API.getEvent(eventId);
    state._pendingInlineTrack = {};
    state._activeFieldCell = null;
    state._activeWindCell = null;
    clearUnsaved();
    await renderDetail();
}

// ============================================================
// Detail Panel
// ============================================================

// Video link button for event header (operation key holders can edit)
function buildVideoLinkHTML(evt) {
    const role = sessionStorage.getItem('pace_role');
    const canEdit = (role === 'admin' || role === 'operation');
    return `<div class="event-video-bar" id="event-video-bar" style="display:flex;align-items:center;gap:8px;margin:6px 0 4px;flex-wrap:wrap;">
        <button class="btn btn-sm btn-outline" onclick="playEventVideo()" id="btn-play-video" style="display:none;" title="종목 영상 재생">▶ 영상</button>
        ${canEdit ? `<button class="btn btn-sm btn-outline" onclick="editEventVideoUrl()" title="종목 영상 URL 입력/수정">↗ 영상 링크</button>` : ''}
        <button class="btn btn-sm btn-outline" onclick="playCompVideo()" id="btn-play-comp-video" style="display:none;" title="대회 대표 영상 재생">▶ 대회 영상</button>
    </div>`;
}
async function loadEventVideoButtons() {
    try {
        const res = await API.getEventVideoUrl(state.selectedEvent.id);
        const btn = document.getElementById('btn-play-video');
        if (btn && res.video_url) { btn.style.display = ''; btn.dataset.url = res.video_url; }
        // Check competition video
        const comp = await API.getCompetition(getCompetitionId());
        const cbtn = document.getElementById('btn-play-comp-video');
        if (cbtn && comp.video_url) { cbtn.style.display = ''; cbtn.dataset.url = comp.video_url; }
    } catch(e) {}
}
function playEventVideo() {
    const btn = document.getElementById('btn-play-video');
    if (!btn || !btn.dataset.url) { showToast('영상 URL이 없습니다.', 'warning'); return; }
    openVideoModal(btn.dataset.url, state.selectedEvent ? state.selectedEvent.name : '종목 영상');
}
function playCompVideo() {
    const btn = document.getElementById('btn-play-comp-video');
    if (!btn || !btn.dataset.url) { showToast('대회 영상 URL이 없습니다.', 'warning'); return; }
    openVideoModal(btn.dataset.url, '대회 대표 영상');
}
async function editEventVideoUrl() {
    const current = document.getElementById('btn-play-video')?.dataset?.url || '';
    const url = prompt('종목 영상 URL을 입력하세요 (YouTube):', current);
    if (url === null) return; // cancelled
    try {
        const key = sessionStorage.getItem('accessKey') || '';
        await API.setEventVideoUrl(state.selectedEvent.id, url.trim(), key);
        showToast(url.trim() ? '✓ 영상 URL 저장' : '영상 URL 삭제됨');
        await loadEventVideoButtons();
    } catch(e) { showToast('저장 실패: ' + (e.error||e.message), 'error'); }
}

function showPlaceholder() {
    document.getElementById('record-detail').innerHTML = `
        <div class="detail-placeholder">
            <div class="placeholder-icon">📝</div>
            <p>왼쪽에서 종목을 선택하세요</p>
        </div>`;
}

async function renderDetail() {
    const evt = state.selectedEvent;
    if (!evt) return showPlaceholder();

    state.heats = await API.getHeats(evt.id);
    const cat = evt.category;

    if (cat === 'track' || cat === 'relay' || cat === 'road') await renderTrackDetail(evt);
    else if (cat === 'field_distance') await renderFieldDistanceDetail(evt);
    else if (cat === 'field_height') await renderFieldHeightDetail(evt);
    else if (cat === 'combined') await renderCombinedDetail(evt);
    else showPlaceholder();
}

// ============================================================
// TRACK DETAIL
// ============================================================
async function renderTrackDetail(evt) {
    const detail = document.getElementById('record-detail');
    const isLong = isLongTimeEvent(evt.name);
    const isRoad = isRoadEvent(evt.name);
    const placeholder = getTimePlaceholder(evt.name);
    const hintText = isRoad
        ? 'H:MM:SS.xx 형식 (예: 1:02:33.15). Enter=저장, Tab=다음'
        : isLong
        ? 'M:SS.xx 형식 (예: 3:52.45). Enter=저장, Tab=다음'
        : 'SS.xx 또는 SS.xxx 형식 (예: 10.23, 10.213). Enter=저장, Tab=다음';

    // Parent link for combined sub-events
    let parentLink = '';
    if (evt.parent_event_id) {
        const pe = state.events.find(e => e.id === evt.parent_event_id);
        parentLink = `<div class="parent-link-bar">
            <span class="sub-event-tag">혼성 세부종목</span>
            <a href="/record.html?event_id=${evt.parent_event_id}" class="btn btn-sm btn-outline">← ${pe ? pe.name : '혼성'} 현황</a>
        </div>`;
    }

    let heatTabs = state.heats.map((h, i) =>
        `<button class="heat-tab ${i === 0 ? 'active' : ''}" data-heat-id="${h.id}" onclick="switchTrackHeat(${h.id}, this)">${heatLabel(h)}</button>`
    ).join('');

    detail.innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
            <span class="context-badge">${evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성'}</span>
        </div>
        ${buildVideoLinkHTML(evt)}
        ${parentLink}
        <div class="track-hint">${hintText}</div>
        ${requiresWindMeasurement(evt.name, 'track') ? `
        <div class="wind-input-bar wind-input-bar-large" id="wind-bar">
            <label><strong>🌬️ 풍속 (Wind):</strong></label>
            <input type="number" step="0.1" id="heat-wind-input" placeholder="예: +1.8"
                style="width:120px;padding:8px 12px;border:2px solid var(--primary);border-radius:var(--radius);font-size:16px;font-weight:700;text-align:center;"
                onkeydown="if(event.key==='Enter'){event.preventDefault();saveHeatWind();}">
            <span style="font-size:14px;font-weight:600;color:var(--text-muted);">m/s</span>
            <button class="btn btn-sm btn-primary" onclick="saveHeatWind()" title="현재 히트 풍속 저장" style="padding:8px 16px;font-size:13px;">저장</button>
            <span id="wind-status" style="font-size:12px;margin-left:6px;"></span>
            <span id="wind-record-badge" style="font-size:12px;margin-left:6px;"></span>
            <span id="wind-warning-inline" style="display:none;font-size:11px;color:#ff9800;font-weight:700;margin-left:6px;">⚠ 풍속 미입력</span>
        </div>` : ''}
        <div class="heat-tabs">
            ${heatTabs}
            <button class="btn btn-sm btn-outline" onclick="showHeatEditModal(state.selectedEvent)" style="margin-left:auto;font-size:11px;" title="조/레인 수동 수정">⚙ 조/레인 수정</button>
            <button class="btn btn-sm btn-outline" onclick="validateWARegulations()" style="font-size:11px;" title="WA 규정 검증">✓ WA 검증</button>
        </div>
        <div id="track-content"></div>
        <div class="track-actions">
            <button class="btn btn-primary" id="track-save-all-btn" onclick="saveAllTrackInline()" title="현재 조의 모든 기록을 한번에 저장합니다">✓ 기록 저장</button>
            ${evt.round_type === 'preliminary' ? `
                <button class="btn btn-outline" onclick="openSemifinalQualification()" title="모든 조의 결과를 통합하여 준결승 진출자를 선택합니다">준결승 진출자 선택</button>
                <button class="btn btn-outline" onclick="openTrackQualification()" title="모든 조의 결과를 통합하여 결승 진출자를 선택합니다">결승 진출자 선택</button>
            ` : evt.round_type === 'semifinal' ? `
                <button class="btn btn-outline" onclick="openTrackQualification()" title="모든 조의 결과를 통합하여 결승 진출자를 선택합니다">결승 진출자 선택</button>
            ` : ''}
            ${_buildCompleteUI(evt)}
        </div>
        <div id="track-qual-section" class="qual-panel" style="display:none;"></div>`;

    if (state.heats.length > 0) {
        state.heatId = state.heats[0].id;
        await loadTrackHeatData();
        // Load wind for first heat if wind measurement required
        if (requiresWindMeasurement(evt.name, 'track')) await loadHeatWind();
    }
    loadEventVideoButtons();
}

async function switchTrackHeat(heatId, btn) {
    checkUnsavedBeforeAction(async () => {
        state.heatId = heatId;
        document.querySelectorAll('.heat-tab').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        const tc = document.getElementById('track-content');
        if (tc) tc.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>';
        await loadTrackHeatData();
        if (state.selectedEvent && requiresWindMeasurement(state.selectedEvent.name, 'track')) await loadHeatWind();
    });
}

async function loadTrackHeatData() {
    // Show checked_in athletes + no_show as DNS
    const allEntries = await API.getHeatEntries(state.heatId);
    state.heatEntries = allEntries.filter(e => e.status === 'checked_in' || e.status === 'no_show');
    state.results = await API.getResults(state.heatId);
    state._pendingInlineTrack = {};
    clearUnsaved();
    await renderTrackTable();
    // After rendering, check wind warning
    if (state.selectedEvent && requiresWindMeasurement(state.selectedEvent.name, 'track')) {
        try { const wd = await API.getHeatWind(state.heatId); checkWindWarning(wd.wind); } catch(e) {}
    }
}

async function renderTrackTable() {
    if (state.heatEntries.length === 0) {
        document.getElementById('track-content').innerHTML = `
            <div class="empty-state" style="padding:30px 0;">
                <div style="font-size:24px;margin-bottom:8px;">∅</div>
                <p style="font-weight:600;">소집이 완료된 선수가 없습니다</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">소집실에서 선수 출석 처리를 먼저 진행하세요</p>
                <a href="/callroom.html?event_id=${state.selectedEventId}" class="btn btn-sm btn-primary" style="margin-top:12px;">소집실로 이동</a>
            </div>`;
        return;
    }
    const rows = state.heatEntries.map(e => {
        const r = state.results.find(r => r.event_entry_id === e.event_entry_id);
        // Auto-DNS for no_show athletes from callroom
        const autoStatus = e.status === 'no_show' ? 'DNS' : '';
        return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code||'') : autoStatus, remark: r ? (r.remark||'') : '', _saved: !!r, _isNoShow: e.status === 'no_show' };
    });

    // Lane numbers are stored as-is from Excel (A:1-18, B:19-26) — no renumbering needed

    rows.sort((a, b) => {
        // Status codes (DQ/DNS/DNF) always at bottom
        const scA = a.status_code, scB = b.status_code;
        if (scA && !scB) return 1; if (!scA && scB) return -1;
        if (a.time_seconds == null && b.time_seconds == null) return (a.lane_number || 99) - (b.lane_number || 99);
        if (a.time_seconds == null) return 1;
        if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });

    let rk = 1;
    rows.forEach((r, i) => {
        if (r.status_code) { r.rank = r.status_code; return; }
        if (r.time_seconds == null) r.rank = '';
        else { r.rank = (i > 0 && rows[i - 1].time_seconds === r.time_seconds && !rows[i-1].status_code) ? rows[i - 1].rank : rk; rk = i + 2; }
    });

    const isLong = isLongTimeEvent(state.selectedEvent?.name);
    const _isRoad = isRoadEvent(state.selectedEvent?.name);
    const _roadFmt = _isRoad ? { noDecimal: true } : undefined;
    const placeholder = _isRoad ? '0:00:00' : isLong ? '0:00.00' : '00.00';

    const smallNumLabel = getSmallNumberLabel(state.selectedEvent?.name, state.selectedEvent?.category);

    // Load Q/q badges if preliminary/semifinal
    let quals = [];
    if (state.selectedEvent && (state.selectedEvent.round_type === 'preliminary' || state.selectedEvent.round_type === 'semifinal')) {
        try { quals = await API.getQualifications(state.selectedEvent.id); } catch(e) {}
    }

    // Load relay members batch if relay event
    const isRelayEvent = state.selectedEvent?.category === 'relay';
    let relayMembersMap = {};
    if (isRelayEvent) {
        try { relayMembersMap = await API.getRelayMembersBatch(state.selectedEvent.id); } catch(e) { console.warn('relay members batch failed', e); }
    }

    document.getElementById('track-content').innerHTML = `
        <table class="data-table">
            <thead><tr>
                <th style="width:50px;">RANK</th><th style="width:50px;">${smallNumLabel}</th>
                <th style="width:60px;">BIB</th><th style="text-align:left;">${isRelayEvent ? '팀명' : '선수명'}</th><th style="text-align:left;">소속</th>
                <th style="width:140px;">기록</th>
                <th style="width:80px;" title="DQ/DNS/DNF/NM 입력">상태</th>
                <th style="width:100px;">비고</th>
            </tr></thead>
            <tbody>${rows.map((r, idx) => {
                const currentVal = r.time_seconds != null ? formatTime(r.time_seconds, _roadFmt) : '';
                const pendingVal = state._pendingInlineTrack[r.event_entry_id];
                const displayVal = pendingVal !== undefined ? pendingVal : currentVal;
                const savedClass = (r.time_seconds != null && pendingVal === undefined) ? 'has-value' : '';
                const rowSavedClass = r._saved ? 'row-saved' : '';
                const scBadge = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : '';
                const qualEntry = quals.find(q => q.event_entry_id === r.event_entry_id && q.selected);
                const qualBadge = qualEntry ? `<span class="result-qual-badge result-qual-${qualEntry.qualification_type || 'Q'}">${qualEntry.qualification_type || 'Q'}</span>` : '';
                // Relay member display
                let relayMemberHtml = '';
                if (isRelayEvent) {
                    const rm = relayMembersMap[r.event_entry_id];
                    if (rm && rm.members && rm.members.length > 0) {
                        const memberList = rm.members.map(m =>
                            `<span class="relay-member-tag" title="${m.team || ''}">${m.leg_order ? m.leg_order + '주 ' : ''}${m.name}</span>`
                        ).join('');
                        relayMemberHtml = `<div class="relay-members-row" style="margin-top:3px;display:flex;flex-wrap:wrap;gap:3px;">${memberList}</div>`;
                    } else {
                        relayMemberHtml = `<div style="margin-top:2px;font-size:10px;color:var(--text-muted);">멤버 미등록</div>`;
                    }
                }
                return `<tr class="${rowSavedClass}">
                    <td>${r.status_code ? scBadge : (r.rank || '<span class="no-rank">—</span>')}</td>
                    <td>${r.lane_number || '—'}</td>
                    <td><strong>${bib(r.bib_number)}</strong></td>
                    <td style="text-align:left;">${r.name}${qualBadge}${relayMemberHtml}</td>
                    <td style="font-size:12px;text-align:left;">${r.team || ''}</td>
                    <td><input class="track-time-input ${savedClass}" data-eid="${r.event_entry_id}" data-row="${idx}"
                        value="${displayVal}" placeholder="${placeholder}" ${r.status_code ? 'disabled' : ''}
                        onkeydown="trackInlineKeydown(event,this)" oninput="trackInlineInput(this)" onfocus="this.select()"></td>
                    <td><select class="sc-select" data-eid="${r.event_entry_id}" onchange="setStatusCode(this)" title="DQ=실격, DNS=불출발, DNF=미완주, NM=기록없음">
                        <option value="">—</option><option value="DQ" ${r.status_code==='DQ'?'selected':''}>DQ</option>
                        <option value="DNS" ${r.status_code==='DNS'?'selected':''}>DNS</option>
                        <option value="DNF" ${r.status_code==='DNF'?'selected':''}>DNF</option>
                        <option value="NM" ${r.status_code==='NM'?'selected':''}>NM</option>
                    </select></td>
                    <td><input class="remark-input" data-eid="${r.event_entry_id}" value="${r.remark||''}" placeholder="비고"
                        onchange="saveRemark(this)" title="선수별 비고 입력 (결과지에 표시됩니다)"></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
}

function trackInlineInput(inp) {
    const eid = +inp.dataset.eid;
    const existing = state.results.find(r => r.event_entry_id === eid);
    const _rFmt = isRoadEvent(state.selectedEvent?.name) ? { noDecimal: true } : undefined;
    const existingVal = existing ? formatTime(existing.time_seconds, _rFmt) : '';
    if (inp.value.trim() !== existingVal) { state._pendingInlineTrack[eid] = inp.value; markUnsaved(); }
    else { delete state._pendingInlineTrack[eid]; if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved(); }
}

function trackInlineKeydown(e, inp) {
    if (e.key === 'Enter') { e.preventDefault(); saveSingleTrackInline(inp); }
    else if (e.key === 'Escape') {
        e.preventDefault();
        const eid = +inp.dataset.eid;
        const existing = state.results.find(r => r.event_entry_id === eid);
        const _rFmt2 = isRoadEvent(state.selectedEvent?.name) ? { noDecimal: true } : undefined;
        inp.value = existing ? formatTime(existing.time_seconds, _rFmt2) : '';
        delete state._pendingInlineTrack[eid];
        if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
        inp.blur();
    } else if (e.key === 'Tab' || e.key === 'ArrowDown') {
        // Save current without rerender, then move focus to next row
        e.preventDefault();
        const rowIdx = +inp.dataset.row;
        const dir = e.shiftKey ? -1 : 1;
        const nextRow = rowIdx + dir;
        if (inp.value.trim()) {
            saveSingleTrackInline(inp, false).then(() => {
                const next = document.querySelector(`.track-time-input[data-row="${nextRow}"]`);
                if (next) { next.disabled = false; next.focus(); next.select(); }
            });
        } else {
            const next = document.querySelector(`.track-time-input[data-row="${nextRow}"]`);
            if (next) { next.disabled = false; next.focus(); next.select(); }
        }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const rowIdx = +inp.dataset.row;
        const prev = document.querySelector(`.track-time-input[data-row="${rowIdx - 1}"]`);
        if (prev) prev.focus();
    }
}

async function saveSingleTrackInline(inp, doRerender = true) {
    if (!confirmCompletedEdit()) return;
    const eid = +inp.dataset.eid;
    const v = parseTimeInput(inp.value);
    if (v == null || v <= 0) {
        if (inp.value.trim()) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); }
        return;
    }
    inp.classList.add('saving'); inp.disabled = true;
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: eid, time_seconds: v });
        delete state._pendingInlineTrack[eid];
        if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
        inp.classList.remove('saving'); inp.classList.add('has-value');
        inp.disabled = false;
        showToast('✓ 저장 완료');
        if (doRerender) {
            await loadTrackHeatData();
            const allInputs = document.querySelectorAll('.track-time-input');
            for (const ni of allInputs) { if (!ni.value.trim()) { ni.focus(); break; } }
        }
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) { inp.classList.remove('saving'); inp.disabled = false; inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1500); showToast(err.error || '저장 실패', 'error'); }
}

async function saveAllTrackInline() {
    if (!confirmCompletedEdit()) return;
    const inputs = document.querySelectorAll('.track-time-input');
    for (const inp of inputs) {
        const v = parseTimeInput(inp.value);
        if (v == null || v <= 0) continue;
        const eid = +inp.dataset.eid;
        inp.classList.add('saving'); inp.disabled = true;
        try {
            await API.upsertResult({ heat_id: state.heatId, event_entry_id: eid, time_seconds: v });
            delete state._pendingInlineTrack[eid];
        } catch (err) { inp.classList.remove('saving'); inp.disabled = false; inp.classList.add('error'); showToast(err.error || '저장 실패', 'error'); }
    }
    if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
    showToast('✓ 전체 저장 완료');
    await loadTrackHeatData();
    if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
    renderAuditLog();
}

// Status code (DQ/DNS/DNF/NM) and remark save helpers
// ============================================================
// HEAT WIND — save/load per heat wind for track ≤200m
// ============================================================
async function saveHeatWind() {
    const inp = document.getElementById('heat-wind-input');
    if (!inp || !state.heatId) return;
    const v = parseFloat(inp.value);
    if (isNaN(v)) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); return; }
    try {
        await API.setHeatWind(state.heatId, v);
        const statusEl = document.getElementById('wind-status');
        if (statusEl) { statusEl.textContent = '✓ 저장됨'; statusEl.style.color = 'var(--green)'; setTimeout(() => statusEl.textContent = '', 2000); }
        updateWindRecordBadge(v);
        // Hide inline warning
        const warnEl = document.getElementById('wind-warning-inline');
        if (warnEl) warnEl.style.display = 'none';
    } catch (e) { console.error(e); }
}
async function loadHeatWind() {
    const inp = document.getElementById('heat-wind-input');
    if (!inp || !state.heatId) return;
    try {
        const data = await API.getHeatWind(state.heatId);
        inp.value = data.wind != null ? data.wind : '';
        // Always allow re-entry - never disable the input
        inp.disabled = false;
        updateWindRecordBadge(data.wind);
        // Check if results exist but no wind - show warning
        checkWindWarning(data.wind);
    } catch (e) { inp.value = ''; }
}
function checkWindWarning(wind) {
    const warnEl = document.getElementById('wind-warning-inline');
    if (!warnEl) return;
    // Check if any results exist in current heat
    const hasResults = state.results && state.results.some(r => r.time_seconds != null && r.time_seconds > 0);
    if (hasResults && (wind == null || wind === '')) {
        warnEl.style.display = 'inline';
    } else {
        warnEl.style.display = 'none';
    }
}
function updateWindRecordBadge(wind) {
    const badge = document.getElementById('wind-record-badge');
    if (!badge) return;
    if (wind == null || wind === '') { badge.textContent = ''; return; }
    const w = parseFloat(wind);
    if (isNaN(w)) { badge.textContent = ''; return; }
    if (w <= 2.0) {
        badge.innerHTML = `<span style="color:var(--green);font-weight:700;">기록 유효 (${formatWind(w)})</span>`;
    } else {
        badge.innerHTML = `<span style="color:var(--danger);font-weight:700;">기록 무효 (${formatWind(w)} > +2.0)</span>`;
    }
}

// ============================================================
async function setStatusCode(sel) {
    if (!confirmCompletedEdit()) { sel.value = ''; return; }
    const eid = +sel.dataset.eid;
    const sc = sel.value;
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: eid, status_code: sc, time_seconds: sc ? null : undefined });
        state.results = await API.getResults(state.heatId);
        renderTrackTable();
    } catch (e) { console.error(e); }
}
async function saveRemark(inp) {
    if (!confirmCompletedEdit()) return;
    const eid = +inp.dataset.eid;
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: eid, remark: inp.value.trim() });
    } catch (e) { console.error(e); }
}


// ============================================================
// FIELD DISTANCE DETAIL
// ============================================================
async function renderFieldDistanceDetail(evt) {
    let parentLink = '';
    if (evt.parent_event_id) {
        const pe = state.events.find(e => e.id === evt.parent_event_id);
        parentLink = `<div class="parent-link-bar"><span class="sub-event-tag">혼성 세부종목</span>
            <a href="/record.html?event_id=${evt.parent_event_id}" class="btn btn-sm btn-outline">← ${pe ? pe.name : '혼성'} 현황</a></div>`;
    }

    let heatTabs = state.heats.map((h, i) =>
        `<button class="heat-tab ${i === 0 ? 'active' : ''}" data-heat-id="${h.id}" onclick="switchFieldHeat(${h.id}, this)">${heatLabel(h)}</button>`
    ).join('');

    document.getElementById('record-detail').innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
            <div style="display:flex;gap:6px;align-items:center;">
                <span class="context-badge">${evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성'}</span>
                <div class="mode-toggle">
                    <button id="mode-input-btn" class="mode-btn active" onclick="setFieldMode('input')" title="기록 입력 모드">입력</button>
                    <button id="mode-view-btn" class="mode-btn" onclick="setFieldMode('view')" title="전체 조망 모드">조망</button>
                    <button id="mode-rank-btn" class="mode-btn" onclick="setFieldMode('rank')" title="순위별 정렬 (3차시기 후 상위 8명 표시)">순위</button>
                </div>
                <button class="btn btn-sm btn-outline" onclick="openFieldZoomModal()" title="확대 보기 (PC/태블릿)" style="font-size:12px;padding:4px 10px;">🔍 확대</button>
            </div>
        </div>
        ${buildVideoLinkHTML(evt)}
        ${parentLink}
        <div class="heat-tabs">${heatTabs}</div>
        <div id="field-content"></div>
        <div class="track-actions" style="margin-top:10px;">
            ${_buildCompleteUI(evt)}
        </div>`;

    if (state.heats.length > 0) {
        state.heatId = state.heats[0].id;
        await loadFieldDistanceData();
    }
    loadEventVideoButtons();
}

async function switchFieldHeat(heatId, btn) {
    state.heatId = heatId;
    document.querySelectorAll('.heat-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (state.selectedEvent.category === 'field_height') await loadFieldHeightData();
    else await loadFieldDistanceData();
}

function setFieldMode(mode) {
    state.fieldMode = mode;
    document.getElementById('mode-input-btn')?.classList.toggle('active', mode === 'input');
    document.getElementById('mode-view-btn')?.classList.toggle('active', mode === 'view');
    document.getElementById('mode-rank-btn')?.classList.toggle('active', mode === 'rank');
    renderFieldDistanceContent();
}

async function loadFieldDistanceData() {
    const allEntries = await API.getHeatEntries(state.heatId);
    state.heatEntries = allEntries.filter(e => e.status === 'checked_in' || e.status === 'no_show');
    state.results = await API.getResults(state.heatId);
    renderFieldDistanceContent();
}

function renderFieldDistanceContent() {
    const entries = state.heatEntries, results = state.results;
    const isView = state.fieldMode === 'view';
    const isRank = state.fieldMode === 'rank';
    const needsWind = requiresWindMeasurement(state.selectedEvent?.name, 'field_distance');

    if (entries.length === 0) {
        document.getElementById('field-content').innerHTML = `
            <div class="empty-state" style="padding:30px 0;">
                <div style="font-size:24px;margin-bottom:8px;">∅</div>
                <p style="font-weight:600;">소집이 완료된 선수가 없습니다</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">소집실에서 선수 출석 처리를 먼저 진행하세요</p>
                <a href="/callroom.html?event_id=${state.selectedEventId}" class="btn btn-sm btn-primary" style="margin-top:12px;">소집실로 이동</a>
            </div>`;
        return;
    }

    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {};
        const attWind = {};
        er.forEach(r => { if (r.attempt_number != null) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; } });
        const valid = Object.values(att).filter(d => d != null && d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        // WA: if same athlete has same distance in multiple attempts, the LATER attempt is the official record
        let bestWind = null;
        if (best != null) {
            for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } }
        }
        // Build sorted valid distances (descending) for WA tie-breaking
        const sortedValid = [];
        for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
        sortedValid.sort((a, b) => b - a);
        // Check NM: all attempted rounds are fouls (0) — 3 consecutive fouls = NM
        let isNM = false;
        const attemptedCount = Object.keys(att).length;
        if (attemptedCount >= 3 && best == null) {
            const allFoul = Object.values(att).every(d => d === 0);
            if (allFoul) isNM = true;
        }
        return { ...e, attempts: att, attWind, best, bestWind, isNM, sortedValid };
    });

    // WA Ranking: best distance DESC, then tie-break by 2nd best, 3rd best, etc.
    // Wind does NOT affect ranking per WA Technical Rules.
    const ranked = rows.filter(r => r.best != null).sort((a, b) => {
        if (b.best !== a.best) return b.best - a.best;
        // Tie-break: compare 2nd best, then 3rd, then 4th, etc.
        const maxLen = Math.max(a.sortedValid.length, b.sortedValid.length);
        for (let k = 1; k < maxLen; k++) {
            const aVal = a.sortedValid[k] ?? -1;
            const bVal = b.sortedValid[k] ?? -1;
            if (bVal !== aVal) return bVal - aVal;
        }
        return 0; // truly tied
    });
    let cr = 1;
    ranked.forEach((r, i) => {
        if (i > 0) {
            const prev = ranked[i - 1];
            // Check if all sorted valid marks are identical
            let isTied = prev.best === r.best;
            if (isTied) {
                const maxLen = Math.max(prev.sortedValid.length, r.sortedValid.length);
                for (let k = 1; k < maxLen; k++) {
                    if ((prev.sortedValid[k] ?? -1) !== (r.sortedValid[k] ?? -1)) { isTied = false; break; }
                }
            }
            r.rank = isTied ? prev.rank : cr;
        } else {
            r.rank = cr;
        }
        cr = i + 2;
    });
    rows.forEach(r => {
        if (r.best == null) r.rank = null;
        else { const f = ranked.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
    });

    const top8 = getTop8Ids(rows);
    let sorted;
    if (isRank) {
        const hasRound3 = rows.some(r => r.attempts[3] !== undefined);
        sorted = [...rows].sort((a, b) => {
            if (a.rank != null && b.rank != null) return a.rank - b.rank;
            if (a.rank != null) return -1;
            if (b.rank != null) return 1;
            return 0;
        });
        if (hasRound3 && sorted.length > 8) {
            const top = sorted.filter(r => top8.has(r.event_entry_id));
            const rest = sorted.filter(r => !top8.has(r.event_entry_id));
            sorted = [...top, ...rest];
        }
    } else if (isView) {
        sorted = [...rows].sort((a, b) => { if (a.rank != null && b.rank != null) return a.rank - b.rank; if (a.rank != null) return -1; return 1; });
    } else {
        sorted = [...rows].sort((a, b) => (a.lane_number || 999) - (b.lane_number || 999));
    }

    const content = document.getElementById('field-content');
    content.className = (isView || isRank) ? 'view-mode' : '';
    const hasRound3ForUI = rows.some(r => r.attempts[3] !== undefined);
    const round3Note = (isRank && hasRound3ForUI) ? `<div style="padding:6px 10px;background:#fff9c4;border-radius:var(--radius);font-size:11px;margin-bottom:8px;border-left:3px solid #f9a825;">3차시기 완료 \u2014 상위 8명이 상단에 표시됩니다. (4\u20136차시기 진출)</div>` : '';

    const sortBtns = `<div class="sort-toggle-bar" style="display:flex;gap:4px;margin-bottom:8px;align-items:center;">
        <span style="font-size:11px;font-weight:700;color:var(--text-muted);">정렬:</span>
        <button class="btn btn-xs ${!isRank && !isView ? 'btn-primary' : 'btn-outline'}" onclick="setFieldMode('input')" title="스몰넘버 순서">No.순</button>
        <button class="btn btn-xs ${isRank ? 'btn-primary' : 'btn-outline'}" onclick="setFieldMode('rank')" title="기록순">기록순</button>
        <button class="btn btn-xs ${isView ? 'btn-primary' : 'btn-outline'}" onclick="setFieldMode('view')" title="조망 모드">조망</button>
    </div>`;

    content.innerHTML = `
        ${sortBtns}
        ${round3Note}
        <div class="field-two-panel">
            <div class="field-input-panel">
                <table class="data-table field-table ${needsWind ? 'field-2row-table' : ''}" id="field-distance-table">
                    <thead>
                        ${needsWind ? `<tr><th rowspan="2">순위</th><th rowspan="2">순번</th><th style="text-align:left;">성명</th>
                            <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th>
                            <th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th>
                            <th class="att-col-best" rowspan="2">기록</th>
                        </tr>
                        <tr><th style="text-align:left;">소속</th>
                            <th class="wind-header att-col-first att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th>
                            <th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th>
                        </tr>` : `<tr><th>순위</th><th>순번</th><th style="text-align:left;">성명</th><th style="text-align:left;">소속</th>
                            <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th>
                            <th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th>
                            <th class="att-col-best">기록</th>
                        </tr>`}
                    </thead>
                    <tbody>${sorted.map((r, rowIdx) => {
                        const cls = top8.has(r.event_entry_id) ? 'top8-highlight' : '';
                        const zebraCls = needsWind ? '' : (rowIdx % 2 === 1 ? 'field-row-odd' : '');
                        // === ROW 1: Name + Distance records ===
                        let distCells = '';
                        for (let i = 1; i <= 6; i++) {
                            const v = r.attempts[i];
                            const hasVal = v !== undefined && v !== null;
                            const isFoul = hasVal && v === 0;
                            const isPass = hasVal && v === -1;
                            const isActive = state._activeFieldCell
                                && state._activeFieldCell.entryId === r.event_entry_id
                                && state._activeFieldCell.attempt === i;
                            const attColCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                            if (isActive && !isView && !isRank) {
                                distCells += `<td class="attempt-cell attempt-cell-editing ${attColCls}" data-entry="${r.event_entry_id}" data-attempt="${i}">
                                    <input class="field-dist-input" type="text" data-eid="${r.event_entry_id}" data-att="${i}" data-row="${rowIdx}"
                                        value="${hasVal && !isFoul && !isPass ? v.toFixed(2) : (isPass ? '-' : '')}" placeholder="0.00 / X / -"
                                        onkeydown="fieldInlineKeydown(event,this)" oninput="fieldInlineChange(this)" onblur="fieldInlineBlur(this)" onfocus="this.select()" autofocus>
                                    <button class="btn btn-xs btn-danger foul-inline-btn" onclick="fieldInlineFoul(${r.event_entry_id},${i})" title="파울 (X)">X</button>
                                    <button class="btn btn-xs btn-ghost foul-inline-btn" onclick="fieldInlinePass(${r.event_entry_id},${i})" title="패스 (‑)">‑</button>
                                </td>`;
                            } else {
                                let display = '';
                                if (hasVal) {
                                    if (isFoul) display = '<span class="foul-mark">X</span>';
                                    else if (isPass) display = '<span class="pass-mark">‑</span>';
                                    else display = v.toFixed(2);
                                }
                                const clickAttr = (isView || isRank) ? '' : `onclick="activateFieldCell(${r.event_entry_id},${i})"`;
                                const dblClickAttr = (isView || isRank) ? '' : `ondblclick="fieldDblClickFoul(${r.event_entry_id},${i})"`;
                                distCells += `<td class="attempt-cell ${attColCls}" data-entry="${r.event_entry_id}" data-attempt="${i}" ${clickAttr} ${dblClickAttr}>${display}</td>`;
                            }
                        }
                        // Best display with NM badge
                        let bestDisp;
                        if (r.isNM) {
                            bestDisp = '<span class="nm-mark">NM</span>';
                        } else {
                            bestDisp = r.best != null ? `<span class="best-mark">${r.best.toFixed(2)}</span>` : '<span class="no-rank">—</span>';
                        }

                        // === ROW 2: Team + Wind values ===
                        let windCells = '';
                        for (let i = 1; i <= 6; i++) {
                            const wAttColCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                            const v = r.attempts[i];
                            const hasVal = v !== undefined && v !== null;
                            const isFoul = hasVal && v === 0;
                            const isPass = hasVal && v === -1;
                            const isActiveWind = state._activeWindCell
                                && state._activeWindCell.entryId === r.event_entry_id
                                && state._activeWindCell.attempt === i;
                            if (needsWind) {
                                if (isActiveWind && !isView && !isRank) {
                                    windCells += `<td class="wind-cell wind-cell-editing ${wAttColCls}">
                                        <input class="field-wind-input-2row" type="number" step="0.1" data-eid="${r.event_entry_id}" data-att="${i}"
                                            value="${r.attWind && r.attWind[i] != null ? r.attWind[i] : ''}" placeholder="±0.0"
                                            onkeydown="fieldWindKeydown2(event,this)" onblur="windCellBlur(this)" onfocus="this.select()" autofocus>
                                    </td>`;
                                } else {
                                    let wDisp = '';
                                    if (hasVal && !isFoul && !isPass && r.attWind && r.attWind[i] != null) {
                                        wDisp = formatWind(r.attWind[i]);
                                    }
                                    const wClickAttr = (isView || isRank || !hasVal || isFoul || isPass) ? '' : `onclick="activateWindCell(${r.event_entry_id},${i})"`;
                                    windCells += `<td class="wind-cell ${wAttColCls}" ${wClickAttr}>${wDisp}</td>`;
                                }
                            } else {
                                windCells += `<td class="wind-cell ${wAttColCls}"></td>`;
                            }
                        }
                        const bestWindDisp = (r.bestWind != null && needsWind) ? formatWind(r.bestWind) : '';

                        if (needsWind) {
                            const windZebraCls = rowIdx % 2 === 1 ? 'field-row-odd' : '';
                            return `<tr class="field-row1 ${cls} ${windZebraCls}">
                                <td rowspan="2">${r.isNM ? '<span class="nm-mark">NM</span>' : (r.rank != null ? r.rank : '<span class="no-rank">—</span>')}</td>
                                <td rowspan="2">${r.lane_number || '—'}</td>
                                <td class="name-cell"><strong>${r.name}</strong> <span class="bib-tag">#${bib(r.bib_number)}</span></td>
                                ${distCells}
                                <td rowspan="2" class="best-cell att-col-best">${bestDisp}<div class="best-wind">${bestWindDisp}</div></td>
                            </tr>
                            <tr class="field-row2 ${cls} ${windZebraCls}">
                                <td class="team-cell">${r.team || ''}</td>
                                ${windCells}
                            </tr>`;
                        } else {
                            return `<tr class="${cls} ${zebraCls}">
                                <td>${r.isNM ? '<span class="nm-mark">NM</span>' : (r.rank != null ? r.rank : '<span class="no-rank">—</span>')}</td>
                                <td>${r.lane_number || '—'}</td>
                                <td class="name-cell"><strong>${r.name}</strong> <span class="bib-tag">#${bib(r.bib_number)}</span></td>
                                <td class="team-cell">${r.team || ''}</td>
                                ${distCells}
                                <td class="best-cell att-col-best">${bestDisp}</td>
                            </tr>`;
                        }
                    }).join('')}</tbody>
                </table>
            </div>
            <div class="field-ranking-panel">
                <h3>실시간 순위</h3>
                ${ranked.length === 0 ? '<div class="empty-state">기록 없음</div>' :
                    ranked.map(r => `<div class="ranking-item ${top8.has(r.event_entry_id) ? 'top8' : ''}">
                        <span class="ranking-rank">${r.rank}</span>
                        <span class="ranking-name">${r.name} #${bib(r.bib_number)}</span>
                        <span class="ranking-best">${r.best.toFixed(2)}m${r.bestWind != null && needsWind ? ' (' + formatWind(r.bestWind) + ')' : ''}</span>
                    </div>`).join('')}
            </div>
        </div>`;

    // Auto-focus the active input if it exists
    const activeInput = content.querySelector('.field-dist-input');
    if (activeInput) setTimeout(() => activeInput.focus(), 30);
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

// ============================================================
// Field Distance — Inline Cell Editing
// ============================================================

function activateFieldCell(entryId, attempt) {
    if (state.fieldMode === 'view') return;
    state._activeFieldCell = { entryId, attempt };
    state._activeWindCell = null;
    renderFieldDistanceContent();
}

function deactivateFieldCell() {
    if (!state._activeFieldCell) return;
    state._activeFieldCell = null;
    renderFieldDistanceContent();
}

function activateWindCell(entryId, attempt) {
    if (state.fieldMode === 'view' || state.fieldMode === 'rank') return;
    state._activeWindCell = { entryId, attempt };
    state._activeFieldCell = null;
    renderFieldDistanceContent();
}

function deactivateWindCell() {
    if (!state._activeWindCell) return;
    state._activeWindCell = null;
    renderFieldDistanceContent();
}

// Wind cell Enter/Escape handler for 2-row layout
function fieldWindKeydown2(e, windInp) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const eid = +windInp.dataset.eid;
        const att = +windInp.dataset.att;
        const windVal = windInp.value.trim();
        if (windVal) {
            const wind = parseFloat(windVal);
            if (!isNaN(wind)) {
                saveFieldWind(eid, att, wind);
                return;
            }
        }
        deactivateWindCell();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        deactivateWindCell();
    } else if (e.key === 'Tab') {
        e.preventDefault();
        const eid = +windInp.dataset.eid;
        const att = +windInp.dataset.att;
        const windVal = windInp.value.trim();
        if (windVal) {
            const wind = parseFloat(windVal);
            if (!isNaN(wind)) saveFieldWind(eid, att, wind);
        }
        // Move to next wind cell
        advanceWindCell(eid, att, e.shiftKey);
    }
}

function windCellBlur(windInp) {
    setTimeout(() => {
        const active = document.activeElement;
        if (active && active.classList.contains('field-wind-input-2row')) return;
        const windVal = windInp.value.trim();
        if (windVal) {
            const eid = +windInp.dataset.eid;
            const att = +windInp.dataset.att;
            const wind = parseFloat(windVal);
            if (!isNaN(wind)) { saveFieldWind(eid, att, wind); return; }
        }
        deactivateWindCell();
    }, 100);
}

function advanceWindCell(currentEntryId, currentAttempt, reverse) {
    const sorted = getSortedFieldEntries();
    const cells = [];
    sorted.forEach(r => {
        for (let a = 1; a <= 6; a++) {
            if (r.attempts[a] != null && r.attempts[a] > 0) cells.push({ entryId: r.event_entry_id, attempt: a });
        }
    });
    const idx = cells.findIndex(c => c.entryId === currentEntryId && c.attempt === currentAttempt);
    const next = reverse ? idx - 1 : idx + 1;
    if (next >= 0 && next < cells.length) {
        activateWindCell(cells[next].entryId, cells[next].attempt);
    } else {
        deactivateWindCell();
    }
}

function setupFieldClickOutside() {
    document.addEventListener('click', (e) => {
        // Independent field distance
        if (state._activeFieldCell) {
            if (!e.target.closest('.field-dist-input') && !e.target.closest('.attempt-cell')) deactivateFieldCell();
        }
        // Wind cell
        if (state._activeWindCell) {
            if (!e.target.closest('.field-wind-input-2row') && !e.target.closest('.wind-cell')) deactivateWindCell();
        }
        // Combined sub-field distance
        if (_cSubFieldActive) {
            if (!e.target.closest('.field-dist-input') && !e.target.closest('.attempt-cell')) _cSubFieldDeactivate();
        }
        // Combined sub-field wind
        if (_cSubFieldWindActive) {
            if (!e.target.closest('.field-wind-input-2row') && !e.target.closest('.wind-cell')) _cSubFieldWindDeactivate();
        }
    });
}

function fieldInlineKeydown(e, inp) {
    const eid = +inp.dataset.eid;
    const att = +inp.dataset.att;

    if (e.key === 'Enter') {
        e.preventDefault();
        const val = inp.value.trim();
        // Empty input = clear/delete existing result for this attempt
        if (!val) {
            fieldInlineClear(eid, att);
            return;
        }
        // Check for foul input: 'f', 'F', 'x', 'X'
        if (/^[fFxX]$/.test(val)) {
            fieldInlineFoul(eid, att);
            return;
        }
        // Check for pass input: '-'
        if (val === '-') {
            fieldInlinePass(eid, att);
            return;
        }
        const dist = parseFloat(val);
        if (isNaN(dist) || dist < 0) {
            inp.classList.add('error');
            setTimeout(() => inp.classList.remove('error'), 1000);
            return;
        }
        saveFieldInline(eid, att, dist);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        deactivateFieldCell();
    } else if (e.key === 'Tab') {
        e.preventDefault();
        const val = inp.value.trim();
        if (val) {
            if (/^[fFxX]$/.test(val)) { fieldInlineFoul(eid, att); return; }
            if (val === '-') { fieldInlinePass(eid, att); return; }
            const dist = parseFloat(val);
            if (!isNaN(dist) && dist >= 0) { saveFieldInline(eid, att, dist); return; }
        }
        advanceFieldCell(eid, att, e.shiftKey);
    }
}

function advanceFieldCell(currentEntryId, currentAttempt, reverse) {
    const sorted = getSortedFieldEntries();
    const cells = [];
    sorted.forEach(r => {
        for (let a = 1; a <= 6; a++) cells.push({ entryId: r.event_entry_id, attempt: a });
    });
    const idx = cells.findIndex(c => c.entryId === currentEntryId && c.attempt === currentAttempt);
    const next = reverse ? idx - 1 : idx + 1;
    if (next >= 0 && next < cells.length) {
        state._activeFieldCell = cells[next];
        renderFieldDistanceContent();
    } else {
        deactivateFieldCell();
    }
}

function getSortedFieldEntries() {
    const entries = state.heatEntries;
    const results = state.results;
    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {};
        er.forEach(r => { if (r.attempt_number != null) att[r.attempt_number] = r.distance_meters; });
        const valid = Object.values(att).filter(d => d != null && d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        return { ...e, attempts: att, best };
    });
    return state.fieldMode === 'view'
        ? [...rows].sort((a, b) => {
            const ra = rows.find(x => x.event_entry_id === a.event_entry_id);
            const rb = rows.find(x => x.event_entry_id === b.event_entry_id);
            if (ra?.best != null && rb?.best != null) return rb.best - ra.best;
            if (ra?.best != null) return -1;
            return 1;
        })
        : [...rows].sort((a, b) => +(a.bib_number||0) - +(b.bib_number||0));
}

// Wind input keydown for field distance — Enter saves distance+wind together
function fieldWindKeydown(e, windInp) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const eid = +windInp.dataset.eid;
        const att = +windInp.dataset.att;
        // Find the distance input in the same cell
        const distInp = windInp.closest('td').querySelector('.field-dist-input');
        if (distInp) {
            const val = distInp.value.trim();
            if (val && !/^[fFxX-]$/.test(val)) {
                const dist = parseFloat(val);
                if (!isNaN(dist) && dist >= 0) {
                    saveFieldInline(eid, att, dist);
                    return;
                }
            }
        }
        // If no valid distance, just save wind on existing result
        const windVal = windInp.value.trim();
        if (windVal) {
            const wind = parseFloat(windVal);
            if (!isNaN(wind)) {
                saveFieldWind(eid, att, wind);
            }
        }
    } else if (e.key === 'Escape') {
        e.preventDefault();
        deactivateFieldCell();
    }
}

// Save only wind for an existing field distance result
async function saveFieldWind(entryId, attempt, wind) {
    if (!confirmCompletedEdit()) return;
    try {
        const existing = state.results.find(r => r.event_entry_id === entryId && r.attempt_number === attempt);
        if (existing) {
            await API.upsertResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: existing.distance_meters, wind });
            state.results = await API.getResults(state.heatId);
            state._activeWindCell = null;
            state._activeFieldCell = null;
            showToast('✓ 풍속 저장');
            renderFieldDistanceContent();
        }
    } catch (err) {
        console.error('saveFieldWind error:', err);
    }
}

async function saveFieldInline(entryId, attempt, distance) {
    if (!confirmCompletedEdit()) return;
    // In 2-row layout, wind is entered separately in the wind row
    // Check if there's an existing wind value for this attempt
    const existingResult = state.results.find(r => r.event_entry_id === entryId && r.attempt_number === attempt);
    const wind = existingResult ? (existingResult.wind ?? null) : null;

    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: distance, wind });
        state.results = await API.getResults(state.heatId);
        state._activeFieldCell = null;
        state._activeWindCell = null;
        showToast('✓ 기록 저장');
        renderFieldDistanceContent();
        // If wind measurement needed and distance valid but no wind, auto-activate wind cell
        const needsWind = requiresWindMeasurement(state.selectedEvent?.name, 'field_distance');
        if (needsWind && distance > 0 && wind == null) {
            setTimeout(() => activateWindCell(entryId, attempt), 50);
        }
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) {
        console.error('saveFieldInline error:', err);
        showBanner('저장 실패', 'error');
    }
}

// Show wind warning when valid distance is entered without wind
function showWindWarning(entryId, attempt) {
    let notice = document.getElementById('wind-warning-notice');
    if (!notice) {
        notice = document.createElement('div');
        notice.id = 'wind-warning-notice';
        document.body.appendChild(notice);
    }
    notice.textContent = '⚠ 풍속을 입력하세요!';
    notice.style.display = 'block';
    notice.style.opacity = '1';
    setTimeout(() => { notice.style.opacity = '0'; setTimeout(() => { notice.style.display = 'none'; }, 300); }, 1500);
}

async function fieldInlineFoul(entryId, attempt) {
    if (!confirmCompletedEdit()) return;
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: 0 });
        state.results = await API.getResults(state.heatId);
        state._activeFieldCell = null;
        renderFieldDistanceContent();
        showFoulNotice();
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) {
        console.error('fieldInlineFoul error:', err);
    }
}

// Double-click on a cell to mark as foul (X)
async function fieldDblClickFoul(entryId, attempt) {
    if (state.fieldMode === 'view') return;
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: 0 });
        state.results = await API.getResults(state.heatId);
        state._activeFieldCell = null;
        renderFieldDistanceContent();
        showFoulNotice();
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) { console.error('fieldDblClickFoul error:', err); }
}

// Show foul notice banner
function showFoulNotice() {
    showToast('파울 (X) 처리됨', 'warning');
}

// Show foul notice when x or - is typed in field input
function fieldInlineChange(inp) {
    const val = inp.value.trim().toLowerCase();
    if (val === 'x' || val === 'f') {
        inp.style.borderColor = 'var(--danger)';
        inp.style.background = 'var(--danger-light)';
    } else if (val === '-') {
        inp.style.borderColor = 'var(--text-muted)';
        inp.style.background = '#f0f0f0';
    } else {
        inp.style.borderColor = '';
        inp.style.background = '';
    }
}

// Auto-save on blur (Method A) — save field distance when input loses focus
function fieldInlineBlur(inp) {
    setTimeout(() => {
        const activeEl = document.activeElement;
        // If focus moved to a button in the same cell (foul/pass), don't save yet
        if (activeEl && activeEl.closest && activeEl.closest('td') === inp.closest('td')) return;
        const val = inp.value.trim();
        if (!val) return; // empty = ignore
        const eid = +inp.dataset.eid;
        const att = +inp.dataset.att;
        // Check for foul input
        if (/^[fFxX]$/.test(val)) {
            fieldInlineFoul(eid, att);
            return;
        }
        // Check for pass input
        if (val === '-') {
            fieldInlinePass(eid, att);
            return;
        }
        const dist = parseFloat(val);
        if (isNaN(dist) || dist < 0) return; // invalid = ignore
        saveFieldInline(eid, att, dist);
    }, 100);
}

// Clear/delete result for a specific attempt (empty input + Enter)
async function fieldInlineClear(entryId, attempt) {
    if (!confirmCompletedEdit()) return;
    try {
        await API.deleteResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt });
        state.results = await API.getResults(state.heatId);
        state._activeFieldCell = null;
        renderFieldDistanceContent();
        showToast('✓ 기록 삭제');
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) {
        // If 404 (no result to delete), just deactivate
        state._activeFieldCell = null;
        renderFieldDistanceContent();
    }
}

// Pass entry for field distance events (record as -1 to distinguish from foul=0)
async function fieldInlinePass(entryId, attempt) {
    if (!confirmCompletedEdit()) return;
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: -1 });
        state.results = await API.getResults(state.heatId);
        state._activeFieldCell = null;
        renderFieldDistanceContent();
        showToast('✓ 패스 처리');
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) {
        console.error('fieldInlinePass error:', err);
    }
}

// Keep modal setup for backward compat but it's no longer the primary input
let modalState = { eventEntryId: null, entry: null, attempts: {} };
function setupFieldModal() { /* No longer used — inline editing replaces modal */ }

// ============================================================
// FIELD HEIGHT DETAIL — redesigned: empty start, add-height button, O/X/- toggle
// ============================================================
async function renderFieldHeightDetail(evt) {
    let parentLink = '';
    if (evt.parent_event_id) {
        const pe = state.events.find(e => e.id === evt.parent_event_id);
        parentLink = `<div class="parent-link-bar"><span class="sub-event-tag">혼성 세부종목</span>
            <a href="/record.html?event_id=${evt.parent_event_id}" class="btn btn-sm btn-outline">← ${pe ? pe.name : '혼성'} 현황</a></div>`;
    }

    let heatTabs = state.heats.map((h, i) =>
        `<button class="heat-tab ${i === 0 ? 'active' : ''}" data-heat-id="${h.id}" onclick="switchFieldHeat(${h.id}, this)">${heatLabel(h)}</button>`
    ).join('');

    // Reset bar height state — start empty, heights come from data
    state._heightBarList = [];

    document.getElementById('record-detail').innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
            <div style="display:flex;gap:6px;align-items:center;">
                <span class="context-badge">${evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성'}</span>
                <button class="btn btn-sm btn-outline" onclick="openFieldZoomModal()" title="확대 보기 (PC/태블릿)" style="font-size:12px;padding:4px 10px;">🔍 확대</button>
            </div>
        </div>
        ${buildVideoLinkHTML(evt)}
        ${parentLink}
        <div class="heat-tabs">${heatTabs}</div>
        <div class="height-controls">
            <label>높이 추가:</label>
            <input type="number" id="height-bar-input" step="0.01" min="0" placeholder="예: 2.10" value="">
            <button class="btn btn-primary btn-sm" onclick="addBarHeight()">추가</button>
            <button class="btn btn-outline btn-sm" onclick="addBarHeightPlus5()">+5cm</button>
        </div>
        <div id="height-content"></div>
        <div class="track-actions" style="margin-top:10px;">
            <button class="btn btn-primary" onclick="saveHeightAndReload()" title="현재 기록 상태를 확인하고 새로고침합니다">기록 저장</button>
            ${_buildCompleteUI(evt)}
        </div>`;

    if (state.heats.length > 0) {
        state.heatId = state.heats[0].id;
        await loadFieldHeightData();
    }
    loadEventVideoButtons();
}

function addBarHeight() {
    const inp = document.getElementById('height-bar-input');
    const val = parseFloat(inp.value);
    if (isNaN(val) || val <= 0) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); return; }
    const rounded = Math.round(val * 100) / 100;
    if (!state._heightBarList.includes(rounded)) {
        state._heightBarList.push(rounded);
        state._heightBarList.sort((a, b) => a - b);
    }
    state.currentBarHeight = rounded;
    inp.value = '';
    renderHeightContent();
}

function addBarHeightPlus5() {
    const last = state._heightBarList.length > 0 ? state._heightBarList[state._heightBarList.length - 1] : (state.currentBarHeight || 2.05);
    const next = Math.round((last + 0.05) * 100) / 100;
    if (!state._heightBarList.includes(next)) {
        state._heightBarList.push(next);
        state._heightBarList.sort((a, b) => a - b);
    }
    state.currentBarHeight = next;
    document.getElementById('height-bar-input').value = '';
    renderHeightContent();
}

async function deleteBarHeight(barHeight) {
    const h = parseFloat(barHeight);
    // Check if any attempts recorded at this height
    const attemptsAtHeight = (state.heightAttempts || []).filter(a => a.bar_height === h);
    if (attemptsAtHeight.length > 0) {
        if (!confirm(`${h.toFixed(2)}m에 ${attemptsAtHeight.length}개의 시기 기록이 있습니다.\n이 높이와 모든 기록을 삭제하시겠습니까?`)) return;
        // Delete from server
        try {
            const key = sessionStorage.getItem('op_key') || prompt('운영키를 입력하세요');
            if (!key) return;
            await api('POST', '/api/height-attempts/delete-bar', { heat_id: state.heatId, bar_height: h, admin_key: key });
        } catch (err) { alert('삭제 실패: ' + (err.error || '')); return; }
    }
    // Remove from local bar list
    state._heightBarList = state._heightBarList.filter(x => x !== h);
    state.heightAttempts = await API.getHeightAttempts(state.heatId);
    renderHeightContent();
}

async function saveHeightAndReload() {
    // Height attempts are saved on each toggle click. This button reloads and confirms.
    state.heightAttempts = await API.getHeightAttempts(state.heatId);
    renderHeightContent();
    // Brief visual feedback
    const btn = document.querySelector('.track-actions .btn-primary');
    if (btn) { const orig = btn.textContent; btn.textContent = '✓ 저장됨'; btn.disabled = true; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200); }
}

// Legacy compat
function setBarHeight() {
    state.currentBarHeight = parseFloat(document.getElementById('height-bar-input').value) || 2.10;
}
function raiseBar() {
    state.currentBarHeight = Math.round((state.currentBarHeight + 0.05) * 100) / 100;
    const inp = document.getElementById('height-bar-input');
    if (inp) inp.value = state.currentBarHeight.toFixed(2);
}

async function loadFieldHeightData() {
    const allEntries = await API.getHeatEntries(state.heatId);
    state.heatEntries = allEntries.filter(e => e.status === 'checked_in' || e.status === 'no_show');
    state.heightAttempts = await API.getHeightAttempts(state.heatId);
    // Build bar list from existing data
    const existingHeights = [...new Set(state.heightAttempts.map(a => a.bar_height))].sort((a, b) => a - b);
    state._heightBarList = [...new Set([...(state._heightBarList || []), ...existingHeights])].sort((a, b) => a - b);
    renderHeightContent();
}

function renderHeightContent() {
    const entries = state.heatEntries, attempts = state.heightAttempts;
    const isRank = state.heightMode === 'rank';

    if (entries.length === 0) {
        document.getElementById('height-content').innerHTML = `
            <div class="empty-state" style="padding:30px 0;">
                <div style="font-size:24px;margin-bottom:8px;">∅</div>
                <p style="font-weight:600;">소집이 완료된 선수가 없습니다</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">소집실에서 선수 출석 처리를 먼저 진행하세요</p>
                <a href="/callroom.html?event_id=${state.selectedEventId}" class="btn btn-sm btn-primary" style="margin-top:12px;">소집실로 이동</a>
            </div>`;
        return;
    }

    const heights = state._heightBarList && state._heightBarList.length > 0 ? [...state._heightBarList] : [];

    if (heights.length === 0) {
        document.getElementById('height-content').innerHTML = `
            <div class="empty-state" style="padding:20px 0;">
                <p style="font-weight:600;">바 높이를 추가하세요</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">위의 '높이 추가' 버튼으로 시작 높이를 입력하세요</p>
            </div>`;
        return;
    }

    const rows = entries.map(e => {
        const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {};
        ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
        let best = null, elim = false;
        const isDNS = e.status === 'no_show';
        if (isDNS) elim = true;
        // Count total failures and total O for tiebreaking
        let totalFails = 0, failsAtBest = 0;
        heights.forEach(h => {
            const d = hd[h]; if (!d) return;
            const xCount = Object.values(d).filter(m => m === 'X').length;
            totalFails += xCount;
            if (Object.values(d).includes('O')) { best = h; failsAtBest = xCount; }
            if (xCount >= 3) elim = true;
        });
        return { ...e, heightData: hd, bestHeight: best, eliminated: elim, _isNoShow: isDNS, totalFails, failsAtBest };
    });

    // Ranking logic (always compute for rank column)
    const rankedH = rows.filter(r => r.bestHeight != null).sort((a, b) => {
        if (b.bestHeight !== a.bestHeight) return b.bestHeight - a.bestHeight;
        // Tiebreak: fewer fails at best height first
        if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
        // Tiebreak: fewer total fails first
        return a.totalFails - b.totalFails;
    });
    let rk = 1;
    rankedH.forEach((r, i) => {
        r.rank = (i > 0 && rankedH[i - 1].bestHeight === r.bestHeight
            && rankedH[i - 1].failsAtBest === r.failsAtBest
            && rankedH[i - 1].totalFails === r.totalFails)
            ? rankedH[i - 1].rank : rk;
        rk = i + 2;
    });
    rows.forEach(r => {
        if (r.bestHeight == null) r.rank = null;
        else { const f = rankedH.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
    });

    // Sort: rank mode puts ranked athletes first by rank, then unranked
    const sorted = isRank
        ? [...rows].sort((a, b) => {
            if (a.rank != null && b.rank != null) return a.rank - b.rank;
            if (a.rank != null) return -1;
            if (b.rank != null) return 1;
            // Both unranked: DNS last, then by lane
            if (a._isNoShow && !b._isNoShow) return 1;
            if (!a._isNoShow && b._isNoShow) return -1;
            return (a.lane_number || 999) - (b.lane_number || 999);
        })
        : rows;

    const sortBtns = `<div class="sort-toggle-bar" style="display:flex;gap:4px;margin-bottom:8px;align-items:center;">
        <span style="font-size:11px;font-weight:700;color:var(--text-muted);">정렬:</span>
        <button class="btn btn-xs ${!isRank ? 'btn-primary' : 'btn-outline'}" onclick="setHeightMode('input')" title="레인 순서">No.순</button>
        <button class="btn btn-xs ${isRank ? 'btn-primary' : 'btn-outline'}" onclick="setHeightMode('rank')" title="순위별 정렬">순위순</button>
    </div>`;

    let hdr = '<th>RANK</th><th>No.</th><th>NAME / BIB</th>';
    heights.forEach(h => { hdr += `<th class="height-col-header" style="font-size:10px;">${h.toFixed(2)}m<br><button class="btn-bar-delete" onclick="deleteBarHeight(${h})" title="${h.toFixed(2)}m 삭제">&times;</button></th>`; });
    hdr += '<th>최고</th><th>상태</th>';

    document.getElementById('height-content').innerHTML = `
        ${sortBtns}
        <table class="data-table field-table height-toggle-table">
            <thead><tr>${hdr}</tr></thead>
            <tbody>${sorted.map(r => {
                let cells = '';
                if (r._isNoShow) {
                    // DNS athlete — show empty disabled cells
                    heights.forEach(() => { cells += '<td class="height-toggle-cell" style="opacity:0.3;text-align:center;">—</td>'; });
                } else {
                    heights.forEach(h => {
                        const hd = r.heightData[h] || {};
                        // Check if this height is already resolved: O found, or previous height failed 3X → skip remaining attempts
                        const hasO = Object.values(hd).includes('O');
                        let cellContent = '<div class="height-attempt-row">';
                        for (let i = 1; i <= 3; i++) {
                            const mark = hd[i] || '';
                            const markCls = mark === '-' ? 'mark-pass' : mark ? `mark-${mark}` : 'mark-empty';
                            const disabled = r.eliminated && !mark ? 'disabled' : '';
                            // Skip button if earlier attempt already succeeded or passed
                            const prevResolved = (i > 1 && (hd[i-1] === 'O' || hd[i-1] === '-')) || (i > 2 && (hd[1] === 'O' || hd[1] === '-'));
                            const shouldSkip = !mark && (hasO || prevResolved);
                            const displayMark = mark === 'PASS' ? '-' : mark === '-' ? '-' : (mark || '\u00b7');
                            cellContent += `<button class="height-toggle-btn ${markCls}" onclick="toggleHeightMark(${r.event_entry_id},${h},${i})" ${disabled || shouldSkip ? 'disabled' : ''} title="${i}차 시도">${displayMark}</button>`;
                        }
                        cellContent += '</div>';
                        cells += `<td class="height-toggle-cell">${cellContent}</td>`;
                    });
                }
                // NM: eliminated without any successful clearance
                const isNM = r.eliminated && r.bestHeight == null && !r._isNoShow;
                const statusText = r._isNoShow ? '<span class="sc-badge sc-DNS">DNS</span>'
                    : isNM ? '<span class="nm-mark">NM</span>'
                    : r.eliminated ? '<span style="color:var(--danger);font-weight:700;">탈락</span>'
                    : '<span style="color:var(--green);">경기중</span>';
                return `<tr class="${r.eliminated ? 'row-eliminated' : ''} ${r._isNoShow ? 'row-dns' : ''}">
                    <td>${r._isNoShow ? 'DNS' : isNM ? '<span class="nm-mark">NM</span>' : (r.rank || '—')}</td>
                    <td>${r.lane_number || '—'}</td>
                    <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${bib(r.bib_number)}</span></td>
                    ${cells}
                    <td>${r.bestHeight != null ? `<strong>${r.bestHeight.toFixed(2)}m</strong>` : '—'}</td>
                    <td>${statusText}</td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
}

// Toggle height sort mode
function setHeightMode(mode) {
    state.heightMode = mode;
    renderHeightContent();
}

// Toggle height mark: cycles O → X → - (pass) → empty
async function toggleHeightMark(entryId, barHeight, attemptNumber) {
    const current = state.heightAttempts.find(a => 
        a.event_entry_id === entryId && a.bar_height === barHeight && a.attempt_number === attemptNumber
    );
    const currentMark = current ? current.result_mark : '';
    const cycle = { '': 'O', 'O': 'X', 'X': '-', '-': '', 'PASS': '' };
    const newMark = currentMark in cycle ? cycle[currentMark] : 'O';

    try {
        await API.saveHeightAttempt({
            heat_id: state.heatId,
            event_entry_id: entryId,
            bar_height: barHeight,
            attempt_number: attemptNumber,
            result_mark: newMark
        });
        state.heightAttempts = await API.getHeightAttempts(state.heatId);
        renderHeightContent();
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) {
        console.error('toggleHeightMark error:', err);
    }
}

// ============================================================
// Height Modal
// ============================================================
let heightModalState = { eventEntryId: null };

function setupHeightModal() {
    const ov = document.getElementById('height-modal-overlay');
    if (!ov) return;
    document.getElementById('hmodal-cancel-btn').addEventListener('click', () => { ov.style.display = 'none'; });
    ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; });
    document.querySelectorAll('.height-mark-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await API.saveHeightAttempt({
                    heat_id: state.heatId, event_entry_id: heightModalState.eventEntryId,
                    bar_height: state.currentBarHeight,
                    attempt_number: +document.getElementById('hmodal-attempt-select').value,
                    result_mark: btn.dataset.mark
                });
                ov.style.display = 'none';
                state.heightAttempts = await API.getHeightAttempts(state.heatId);
                renderHeightContent();
                if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
                renderAuditLog();
            } catch (err) { document.getElementById('hmodal-error').textContent = '저장 실패'; document.getElementById('hmodal-error').style.display = 'block'; }
        });
    });
}

function openHeightModal(eid) {
    heightModalState.eventEntryId = eid;
    const entry = state.heatEntries.find(e => e.event_entry_id === eid);
    if (!entry) return;
    document.getElementById('hmodal-athlete-info').textContent = `${entry.name}  #${bib(entry.bib_number)}`;
    document.getElementById('hmodal-event-info').textContent = `${state.selectedEvent.name} | ${state.currentBarHeight.toFixed(2)}m`;
    document.getElementById('hmodal-height-input').value = state.currentBarHeight.toFixed(2);
    const ha = state.heightAttempts.filter(a => a.event_entry_id === eid && a.bar_height === state.currentBarHeight);
    let rH = '';
    if (ha.length === 0) rH = '<div style="color:var(--text-muted);">시도 없음</div>';
    else ha.forEach(a => { rH += `<div>${a.attempt_number}차: <span class="height-mark mark-${a.result_mark}">${a.result_mark}</span></div>`; });
    document.getElementById('hmodal-records').innerHTML = rH;
    document.getElementById('hmodal-attempt-select').value = String(ha.length > 0 ? Math.min(ha.length + 1, 3) : 1);
    document.getElementById('hmodal-error').style.display = 'none';
    document.getElementById('height-modal-overlay').style.display = 'flex';
}


// ============================================================
// COMBINED EVENT DETAIL (10종경기 / 7종경기) — Full Rewrite v3
// Design: simple tabs, reuse existing track/field/height input,
//         no separate _subState — uses main state with parent backup
// ============================================================
let _combinedActiveTab = 0; // 0=scoreboard, 1..N=sub-event order
let _combinedParentEvt = null; // backup of parent event while editing sub-event

async function renderCombinedDetail(evt) {
    const detail = document.getElementById('record-detail');
    detail.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div><p>데이터 로드 중...</p></div>';
    try {
        // Sync check-in from parent to sub-events
        try { await API.syncCombinedCheckin(evt.id); } catch(e) {}
        // Load core data
        const allEntries = await API.getEventEntries(evt.id);
        state.combinedSubEvents = await API.getCombinedSubEvents(evt.id);
        
        // Filter entries: only show athletes that are in heat_entry of any sub-event
        // This prevents showing athletes who are in event_entry but not in any heat (조편성 안 된 선수)
        if (state.combinedSubEvents.length > 0) {
            const firstSub = state.combinedSubEvents[0];
            const subHeats = await API.getHeats(firstSub.id);
            if (subHeats.length > 0) {
                const heatEntries = await API.getHeatEntries(subHeats[0].id);
                const heatAthleteIds = new Set(heatEntries.map(he => he.athlete_id));
                state.combinedEntries = allEntries.filter(e => heatAthleteIds.has(e.athlete_id));
            } else {
                state.combinedEntries = allEntries;
            }
        } else {
            state.combinedEntries = allEntries;
        }
        state.combinedSubEvents = await API.getCombinedSubEvents(evt.id);
        try { await API.syncCombinedScores(evt.id); } catch(e) {}
        state.combinedScores = await API.getCombinedScores(evt.id);
        _combinedParentEvt = evt;

        const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
        const day1Max = evt.gender === 'M' ? 5 : 4;

        // Build Day1/Day2 tab buttons
        let day1Html = '', day2Html = '';
        subDefs.forEach(se => {
            const has = state.combinedScores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
            const cls = (_combinedActiveTab === se.order ? ' active' : '') + (has ? ' tab-completed' : '');
            const btn = `<button class="combined-tab-btn${cls}" data-order="${se.order}" onclick="switchCombinedTab(${se.order})">${se.order}. ${se.name}${has ? ' ✓' : ''}</button>`;
            if (se.order <= day1Max) day1Html += btn; else day2Html += btn;
        });

        detail.innerHTML = `
            <div class="cr-detail-header">
                <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
                <span class="context-badge">${evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성'}</span>
            </div>
            ${buildVideoLinkHTML(evt)}
            <div style="margin:8px 0;">
                <button class="combined-tab-btn combined-tab-overview${_combinedActiveTab === 0 ? ' active' : ''}" data-order="0" onclick="switchCombinedTab(0)">📊 종합 순위</button>
            </div>
            <div style="margin-bottom:4px;">
                <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:4px;">
                    <span style="font-weight:700;font-size:12px;color:var(--primary);min-width:42px;">DAY 1</span>${day1Html}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                    <span style="font-weight:700;font-size:12px;color:var(--danger);min-width:42px;">DAY 2</span>${day2Html}
                </div>
            </div>
            <div id="combined-content"></div>`;

        await _renderCombinedContent();
        loadEventVideoButtons();
    } catch (err) {
        console.error('[Combined]', err);
        detail.innerHTML = `<div style="padding:20px;color:var(--danger);">
            <h3>로드 오류</h3><p>${err.message || JSON.stringify(err)}</p>
            <button class="btn btn-primary" style="margin-top:12px;" onclick="selectEvent(${evt.id})">다시 시도</button></div>`;
    }
}

function switchCombinedTab(order) {
    _combinedActiveTab = order;
    document.querySelectorAll('.combined-tab-btn').forEach(b => {
        const o = b.dataset.order;
        b.classList.toggle('active', o !== undefined && +o === order);
    });
    _renderCombinedContent();
}

async function _renderCombinedContent() {
    const c = document.getElementById('combined-content');
    if (!c) return;
    c.innerHTML = '<div class="loading-inline"><div class="loading-spinner"></div> 불러오는 중...</div>';
    try {
        if (_combinedActiveTab === 0) await _renderScoreboard(c);
        else await _renderSubEvent(c, _combinedActiveTab);
    } catch (err) {
        console.error('[Combined content]', err);
        c.innerHTML = `<div class="empty-state" style="color:var(--danger);">오류: ${err.message || err}<br>
            <button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="_renderCombinedContent()">다시 시도</button></div>`;
    }
}

// ── Scoreboard ──────────────────────────────────────────────
async function _renderScoreboard(container) {
    const evt = _combinedParentEvt || state.selectedEvent;
    try { await API.syncCombinedScores(evt.id); } catch(e) {}
    state.combinedScores = await API.getCombinedScores(evt.id);
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;

    const hdrCols = subDefs.map(se => {
        const has = state.combinedScores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
        return `<th style="cursor:pointer;font-size:11px;min-width:55px;${has ? 'background:var(--primary-lightest);' : ''}" title="클릭하여 기록 입력" onclick="switchCombinedTab(${se.order})">${se.name}</th>`;
    }).join('');

    const rows = state.combinedEntries.map(e => {
        let total = 0; const pts = {};
        subDefs.forEach(se => {
            const sc = state.combinedScores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
            const p = sc ? (sc.wa_points || 0) : 0;
            pts[se.order] = { points: p, raw: sc ? sc.raw_record : null };
            total += p;
        });
        return { ...e, pts, total };
    }).sort((a, b) => b.total - a.total);
    let rk = 1;
    rows.forEach((r, i) => { r.rank = (i > 0 && rows[i-1].total === r.total) ? rows[i-1].rank : rk; rk = i + 2; });

    container.innerHTML = `
        <div style="overflow-x:auto;margin-top:4px;">
            <table class="data-table" style="font-size:12px;">
                <thead><tr>
                    <th style="width:40px;">순위</th><th style="width:50px;">BIB</th>
                    <th style="width:80px;text-align:left;">선수명</th><th style="width:70px;text-align:left;">소속</th>
                    ${hdrCols}
                    <th style="width:65px;">총점</th>
                </tr></thead>
                <tbody>${rows.map(r => {
                    const cells = subDefs.map(se => {
                        const p = r.pts[se.order];
                        if (!p || p.raw == null)
                            return `<td style="cursor:pointer;color:var(--text-muted);" onclick="switchCombinedTab(${se.order})">—</td>`;
                        if (p.raw === 0 && p.points === 0)
                            return `<td style="cursor:pointer;" onclick="switchCombinedTab(${se.order})"><div style="font-weight:600;font-size:11px;color:var(--danger);">NM</div><div style="font-size:10px;color:var(--text-muted);">0pt</div></td>`;
                        if (p.raw <= 0)
                            return `<td style="cursor:pointer;color:var(--text-muted);" onclick="switchCombinedTab(${se.order})">—</td>`;
                        const rec = se.unit === 's' ? formatTime(p.raw) : p.raw.toFixed(2) + 'm';
                        return `<td style="cursor:pointer;" onclick="switchCombinedTab(${se.order})"><div style="font-weight:600;font-size:11px;">${rec}</div><div style="font-size:10px;color:var(--primary);">${p.points}pt</div></td>`;
                    }).join('');
                    return `<tr><td><strong>${r.rank}</strong></td><td><strong>${bib(r.bib_number)}</strong></td>
                        <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>
                        ${cells}
                        <td><strong style="color:var(--primary);font-size:14px;">${r.total > 0 ? r.total : '—'}</strong></td></tr>`;
                }).join('')}</tbody>
            </table>
        </div>
        <p style="margin-top:6px;font-size:11px;color:var(--text-muted);">💡 종목명을 클릭하면 해당 종목 기록 입력으로 이동합니다.</p>
        <div class="track-actions" style="margin-top:12px;">
            ${evt.round_status === 'completed'
                ? `<div style="display:inline-flex;align-items:center;gap:8px;padding:8px 14px;background:#e8f5e9;border-radius:var(--radius);color:#2e7d32;font-weight:600;font-size:13px;">✓ 경기 완료됨</div>
                   <button class="btn btn-warning btn-sm" onclick="revertCombinedComplete()" title="경기 완료를 취소하고 다시 진행 중 상태로 되돌립니다">완료 취소</button>`
                : `<button class="btn btn-success" onclick="completeCombinedEvent()" title="모든 세부종목 기록을 최종 확정하고 경기를 완료합니다">⚑ 모든 경기 완료</button>`}
        </div>`;
}

// ── Complete combined event (10종/7종 모든 경기 완료) ──────
async function completeCombinedEvent() {
    const evt = _combinedParentEvt || state.selectedEvent;
    if (!evt) return;
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    
    // Check if all sub-events have scores
    const missingOrders = [];
    subDefs.forEach(se => {
        const hasAny = state.combinedScores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
        if (!hasAny) missingOrders.push(`${se.order}. ${se.name}`);
    });
    
    if (missingOrders.length > 0) {
        const proceed = confirm(`다음 종목에 기록이 없습니다:\n${missingOrders.join('\n')}\n\n그래도 경기를 완료하시겠습니까?`);
        if (!proceed) return;
    } else {
        if (!confirm('모든 세부종목의 기록을 확인했습니까?\n경기를 최종 완료 처리합니다.')) return;
    }
    
    // Show judge/admin key modal (identical to completeRound)
    let judgeOptions = '<option value="">-- 심판 선택 --</option>';
    try {
        const judges = await api('GET', '/api/registered-judges');
        judges.forEach(name => { judgeOptions += `<option value="${name}">${name}</option>`; });
        judgeOptions += `<option value="관리자">관리자</option>`;
    } catch(e) {}

    const modal = document.createElement('div');
    modal.id = 'complete-modal-overlay';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal modal-sm">
            <div class="modal-header"><div class="modal-title">${evt.name} 경기 완료 확인</div></div>
            <div class="modal-form">
                <div class="form-row"><label>심판</label>
                    <select id="cm-judge-select" style="flex:1;padding:7px 12px;border:1.5px solid var(--gray);border-radius:var(--radius);font-size:13px;">
                        ${judgeOptions}
                    </select>
                </div>
                <div class="form-row"><label>운영 키</label><input type="password" id="cm-admin-key" placeholder="운영키 입력" style="flex:1;padding:7px 12px;border:1.5px solid var(--gray);border-radius:var(--radius);font-size:13px;"></div>
                <div id="cm-error" style="display:none;color:var(--danger);font-size:12px;margin-top:4px;font-weight:600;"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" onclick="document.getElementById('complete-modal-overlay').remove()">취소</button>
                <button class="btn btn-success" onclick="doCompleteCombined()">경기 완료</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('cm-judge-select').focus(), 100);
}

async function doCompleteCombined() {
    const evt = _combinedParentEvt || state.selectedEvent;
    const judgeName = document.getElementById('cm-judge-select').value;
    const adminKey = document.getElementById('cm-admin-key').value.trim();
    const errEl = document.getElementById('cm-error');
    
    if (!judgeName) { errEl.textContent = '심판을 선택하세요.'; errEl.style.display = 'block'; return; }
    if (!adminKey) { errEl.textContent = '운영키를 입력하세요.'; errEl.style.display = 'block'; return; }
    
    try {
        // Complete the parent combined event
        await API.completeEvent(evt.id, judgeName, adminKey);
        
        // Also complete all sub-events (some may be heats_generated — that's OK, ignore errors)
        if (state.combinedSubEvents && state.combinedSubEvents.length > 0) {
            for (const sub of state.combinedSubEvents) {
                if (sub.round_status === 'in_progress') {
                    try { await API.completeEvent(sub.id, judgeName, adminKey); } catch(e) {}
                }
            }
        }
        
        document.getElementById('complete-modal-overlay').remove();
        showToast('✓ ' + evt.name + ' 경기 완료', 'success', 3000);
        
        // ★ Re-fetch fresh data from server (same pattern as doCompleteRound)
        state.events = await API.getAllEvents(getCompetitionId());
        const freshEvt = await API.getEvent(evt.id);
        state.selectedEvent = freshEvt;
        _combinedParentEvt = freshEvt;
        
        renderMatrix();
        await renderCombinedDetail(freshEvt);
    } catch(err) {
        console.error('[doCompleteCombined Error]', err);
        errEl.textContent = err.error || err.message || '완료 처리 실패';
        errEl.style.display = 'block';
    }
}

// ── Revert combined event completion (완료 취소) ──────
async function revertCombinedComplete() {
    const evt = _combinedParentEvt || state.selectedEvent;
    if (!evt) return;
    // Guard: check if already not completed
    if (evt.round_status !== 'completed') {
        showToast('이미 진행 중 상태입니다.', 'info', 2000);
        return;
    }
    if (!confirm(`${evt.name} 경기 완료를 취소하시겠습니까?\n다시 진행 중 상태로 되돌립니다.`)) return;

    // Need admin key
    showAdminKeyModal(async (key) => {
        if (!key) return;
        try {
            // Revert parent
            await API.revertComplete(evt.id, key);
            // Revert sub-events that are completed
            if (state.combinedSubEvents) {
                for (const sub of state.combinedSubEvents) {
                    if (sub.round_status === 'completed') {
                        try { await API.revertComplete(sub.id, key); } catch(e) {}
                    }
                }
            }
            showToast('↩️ ' + evt.name + ' 경기 완료가 취소되었습니다.', 'success', 3000);
            _adminUnlocked = true;
            // Re-fetch fresh data
            state.events = await API.getAllEvents(getCompetitionId());
            const freshEvt = await API.getEvent(evt.id);
            state.selectedEvent = freshEvt;
            _combinedParentEvt = freshEvt;
            renderMatrix();
            await renderCombinedDetail(freshEvt);
        } catch(e) {
            if (e.status === 400 || (e.error && e.error.includes('완료 상태'))) {
                state.events = await API.getAllEvents(getCompetitionId());
                const freshEvt = await API.getEvent(evt.id);
                state.selectedEvent = freshEvt;
                _combinedParentEvt = freshEvt;
                _adminUnlocked = true;
                renderMatrix();
                await renderCombinedDetail(freshEvt);
                showToast('이미 되돌려진 상태입니다.', 'info', 2000);
            } else {
                alert(e.error || '완료 취소 실패: 관리자 키를 확인하세요.');
            }
        }
    });
}

// ── Sub-event detail ────────────────────────────────────────
async function _renderSubEvent(container, subOrder) {
    const parentEvt = _combinedParentEvt || state.selectedEvent;
    const subDefs = parentEvt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    const seDef = subDefs.find(se => se.order === subOrder);
    if (!seDef) { container.innerHTML = '<div class="empty-state">종목 정의 없음</div>'; return; }

    // Ensure sub-events loaded
    if (!state.combinedSubEvents || state.combinedSubEvents.length === 0)
        state.combinedSubEvents = await API.getCombinedSubEvents(parentEvt.id);

    // Find DB sub-event
    let dbSub = state.combinedSubEvents.find(s => s.sort_order === subOrder);
    if (!dbSub) dbSub = state.combinedSubEvents[subOrder - 1];
    if (!dbSub) {
        container.innerHTML = `<div class="empty-state">세부 종목을 찾을 수 없습니다 (${subOrder}/${state.combinedSubEvents.length})
            <br><button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="switchCombinedTab(0)">← 종합 순위</button></div>`;
        return;
    }

    // Nav
    const prev = subOrder > 1 ? subOrder - 1 : null;
    const next = subOrder < subDefs.length ? subOrder + 1 : null;

    // WA summary
    const waHtml = _buildWASummary(subOrder);

    container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);margin-bottom:8px;">
            ${prev ? `<button class="btn btn-sm btn-outline" onclick="switchCombinedTab(${prev})">← ${subDefs[prev-1].name}</button>` : '<span></span>'}
            <h3 style="margin:0;">${subOrder}. ${seDef.name} <span class="context-badge" style="font-size:10px;">${dbSub.category}</span></h3>
            ${next ? `<button class="btn btn-sm btn-outline" onclick="switchCombinedTab(${next})">${subDefs[next-1].name} →</button>` : '<span></span>'}
        </div>
        <div id="combined-sub-area"><div class="loading-inline"><div class="loading-spinner"></div></div></div>
        <details style="margin-top:8px;"><summary style="font-weight:600;font-size:13px;cursor:pointer;">WA 점수 현황</summary>${waHtml}</details>
        <div style="margin-top:10px;display:flex;gap:6px;">
            <button class="btn btn-outline" onclick="switchCombinedTab(0)">← 종합 순위</button>
            ${next ? `<button class="btn btn-outline" onclick="switchCombinedTab(${next})">${subDefs[next-1].name} →</button>` : ''}
        </div>`;

    // Load sub-event data and render into #combined-sub-area
    const subEvt = await API.getEvent(dbSub.id);
    const subHeats = await API.getHeats(dbSub.id);
    const area = document.getElementById('combined-sub-area');

    if (subHeats.length === 0) { area.innerHTML = '<div class="empty-state">히트가 없습니다.</div>'; return; }

    const heatId = subHeats[0].id;
    const entries = await API.getHeatEntries(heatId);

    if (entries.length === 0) {
        area.innerHTML = '<div class="empty-state">선수가 배정되지 않았습니다.</div>';
        return;
    }

    const cat = dbSub.category;
    if (cat === 'track') {
        const results = await API.getResults(heatId);
        _renderSubTrack(area, subEvt, entries, results, heatId, parentEvt.id);
    } else if (cat === 'field_distance') {
        const results = await API.getResults(heatId);
        _renderSubFieldDist(area, subEvt, entries, results, heatId, parentEvt.id);
    } else if (cat === 'field_height') {
        const attempts = await API.getHeightAttempts(heatId);
        _renderSubFieldHeight(area, subEvt, entries, attempts, heatId, parentEvt.id);
    } else {
        area.innerHTML = `<div class="empty-state">지원하지 않는 카테고리: ${cat}</div>`;
    }
}

// ── Sub Track ───────────────────────────────────────────────
function _renderSubTrack(area, evt, entries, results, heatId, parentId) {
    const isLong = isLongTimeEvent(evt.name);
    const ph = isLong ? '0:00.00' : '00.00';
    const hint = isLong ? 'M:SS.xx (예: 3:52.45). Enter=저장' : 'SS.xx (예: 10.23). Enter=저장';
    const windNeeded = requiresWindMeasurement(evt.name, 'track');
    const rows = entries.map(e => {
        const r = results.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? r.status_code : null, remark: r ? r.remark : null };
    });
    rows.sort((a,b) => {
        // Status codes at bottom
        if (a.status_code && !b.status_code) return 1; if (!a.status_code && b.status_code) return -1;
        if (a.time_seconds == null && b.time_seconds == null) return (a.lane_number||99)-(b.lane_number||99);
        if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    let rk = 1;
    rows.forEach((r,i) => { if (r.status_code || r.time_seconds == null) r.rank = ''; else { r.rank = (i>0 && rows[i-1].time_seconds === r.time_seconds) ? rows[i-1].rank : rk; rk = i+2; } });

    const windBar = windNeeded ? `
        <div class="wind-input-bar wind-input-bar-large" id="csub-wind-bar" style="margin:8px 0;">
            <label><strong>🌬️ 풍속 (Wind):</strong></label>
            <input type="number" step="0.1" id="csub-heat-wind-input" placeholder="예: +1.8"
                style="width:100px;padding:6px 10px;border:2px solid var(--primary);border-radius:var(--radius);font-size:14px;font-weight:700;text-align:center;"
                onkeydown="if(event.key==='Enter'){event.preventDefault();_cSubTrackSaveWind(${heatId});}">
            <span style="font-size:13px;font-weight:600;color:var(--text-muted);">m/s</span>
            <button class="btn btn-sm btn-primary" onclick="_cSubTrackSaveWind(${heatId})" style="padding:6px 12px;font-size:12px;">저장</button>
            <span id="csub-wind-status" style="font-size:12px;margin-left:6px;"></span>
            <span id="csub-wind-record-badge" style="font-size:12px;margin-left:6px;"></span>
        </div>` : '';

    area.innerHTML = `
        <div class="track-hint">${hint}</div>
        ${windBar}
        <table class="data-table"><thead><tr>
            <th style="width:50px;">RANK</th><th style="width:60px;">BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th style="width:140px;">기록</th><th style="width:75px;" title="DQ/DNS/DNF">상태</th>
        </tr></thead><tbody>${rows.map((r,idx) => {
            const cv = r.time_seconds != null ? formatTime(r.time_seconds) : '';
            const scBadge = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : '';
            return `<tr class="${r.status_code ? 'row-status-code' : ''}">
                <td>${r.status_code ? scBadge : (r.rank || '—')}</td><td><strong>${bib(r.bib_number)}</strong></td>
                <td style="text-align:left;">${r.name}</td><td style="font-size:12px;text-align:left;">${r.team||''}</td>
                <td><input class="track-time-input" data-eid="${r.event_entry_id}" data-hid="${heatId}" data-pid="${parentId}" data-row="${idx}"
                    value="${cv}" placeholder="${ph}" ${cv ? 'class="track-time-input has-value"' : ''} ${r.status_code ? 'disabled' : ''}
                    onkeydown="_cSubTrackKey(event,this)" onfocus="this.select()"></td>
                <td><select class="sc-select" data-eid="${r.event_entry_id}" data-hid="${heatId}" data-pid="${parentId}" onchange="_cSubTrackSetStatus(this)" title="DQ=실격, DNS=불출발, DNF=미완주">
                    <option value="">—</option><option value="DQ" ${r.status_code==='DQ'?'selected':''}>DQ</option>
                    <option value="DNS" ${r.status_code==='DNS'?'selected':''}>DNS</option>
                    <option value="DNF" ${r.status_code==='DNF'?'selected':''}>DNF</option>
                </select></td></tr>`;
        }).join('')}</tbody></table>
        <button class="btn btn-outline" style="margin-top:8px;" onclick="_cSubTrackSaveAll(${heatId},${parentId})">기록 저장</button>`;

    // Load existing wind for this heat
    if (windNeeded) _cSubTrackLoadWind(heatId);
}

async function _cSubTrackLoadWind(heatId) {
    try {
        const data = await API.getHeatWind(heatId);
        const inp = document.getElementById('csub-heat-wind-input');
        if (inp) inp.value = data.wind != null ? data.wind : '';
        _cSubTrackUpdateWindBadge(data.wind);
    } catch(e) {}
}

async function _cSubTrackSaveWind(heatId) {
    const inp = document.getElementById('csub-heat-wind-input');
    if (!inp) return;
    const v = parseFloat(inp.value);
    if (isNaN(v)) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); return; }
    try {
        await API.setHeatWind(heatId, v);
        const st = document.getElementById('csub-wind-status');
        if (st) { st.textContent = '✓ 저장됨'; st.style.color = 'var(--green)'; setTimeout(() => st.textContent = '', 2000); }
        _cSubTrackUpdateWindBadge(v);
    } catch(e) { console.error('_cSubTrackSaveWind:', e); }
}

function _cSubTrackUpdateWindBadge(wind) {
    const badge = document.getElementById('csub-wind-record-badge');
    if (!badge) return;
    if (wind == null || wind === '') { badge.textContent = ''; return; }
    const w = parseFloat(wind);
    if (isNaN(w)) { badge.textContent = ''; return; }
    if (w <= 2.0) {
        badge.innerHTML = `<span style="color:var(--green);font-weight:700;">기록 유효 (${formatWind(w)})</span>`;
    } else {
        badge.innerHTML = `<span style="color:var(--danger);font-weight:700;">기록 무효 (${formatWind(w)} > +2.0)</span>`;
    }
}

async function _cSubTrackKey(e, inp) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const eid = +inp.dataset.eid, hid = +inp.dataset.hid, pid = +inp.dataset.pid;
        const v = parseTimeInput(inp.value);
        if (v == null || v <= 0) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 800); return; }
        inp.disabled = true;
        try {
            await API.upsertResult({ heat_id: hid, event_entry_id: eid, time_seconds: v });
            inp.classList.add('has-value'); inp.disabled = false;
            await syncCombinedFromSubEvent(pid);
            // Move focus to next row
            const next = document.querySelector(`.track-time-input[data-row="${+inp.dataset.row + 1}"]`);
            if (next) next.focus();
        } catch(err) { inp.disabled = false; inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); }
    } else if (e.key === 'Tab' || e.key === 'ArrowDown') {
        e.preventDefault();
        const eid = +inp.dataset.eid, hid = +inp.dataset.hid, pid = +inp.dataset.pid;
        const v = parseTimeInput(inp.value);
        if (v && v > 0) {
            inp.disabled = true;
            try {
                await API.upsertResult({ heat_id: hid, event_entry_id: eid, time_seconds: v });
                inp.classList.add('has-value'); inp.disabled = false;
                await syncCombinedFromSubEvent(pid);
            } catch(err) { inp.disabled = false; }
        }
        const next = document.querySelector(`.track-time-input[data-row="${+inp.dataset.row + 1}"]`);
        if (next) next.focus();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = document.querySelector(`.track-time-input[data-row="${+inp.dataset.row - 1}"]`);
        if (prev) prev.focus();
    }
}

async function _cSubTrackSaveAll(heatId, parentId) {
    const inputs = document.querySelectorAll('.track-time-input');
    let saveCount = 0;
    for (const inp of inputs) {
        const v = parseTimeInput(inp.value);
        if (v == null || v <= 0) continue;
        inp.disabled = true;
        try {
            await API.upsertResult({ heat_id: heatId, event_entry_id: +inp.dataset.eid, time_seconds: v });
            inp.classList.add('has-value');
            saveCount++;
        } catch(e) { inp.classList.add('error'); }
        inp.disabled = false;
    }
    await syncCombinedFromSubEvent(parentId);
    // Also save status codes from dropdowns
    const selects = document.querySelectorAll('.sc-select');
    for (const sel of selects) {
        const sc = sel.value;
        if (sc) {
            try {
                await API.upsertResult({ heat_id: heatId, event_entry_id: +sel.dataset.eid, status_code: sc, time_seconds: null });
            } catch(e) {}
        }
    }
    const btn = document.querySelector('.track-actions .btn-outline');
    if (btn) {
        const orig = btn.textContent;
        btn.textContent = `✓ 저장됨 (${saveCount}건)`; btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }
}

async function _cSubTrackSetStatus(sel) {
    const eid = +sel.dataset.eid, hid = +sel.dataset.hid, pid = +sel.dataset.pid;
    const sc = sel.value;
    try {
        await API.upsertResult({ heat_id: hid, event_entry_id: eid, status_code: sc, time_seconds: sc ? null : undefined });
        await syncCombinedFromSubEvent(pid);
        // Re-fetch and re-render
        const entries = await API.getHeatEntries(hid);
        const results = await API.getResults(hid);
        const area = document.getElementById('combined-sub-area');
        if (area && _cSubHeightData.evt) {
            _renderSubTrack(area, _cSubHeightData.evt, entries.filter(e => e.status === 'checked_in'), results, hid, pid);
        }
    } catch(e) { console.error('_cSubTrackSetStatus error:', e); }
}

// ── Sub Field Distance — inline editing (matches independent field events) ──
let _cSubFieldActive = null; // { entryId, attempt, heatId, parentId }
let _cSubFieldWindActive = null; // { entryId, attempt }
let _cSubFieldData = { entries: [], results: [], heatId: null, parentId: null, needsWind: false, evt: null };

function _renderSubFieldDist(area, evt, entries, results, heatId, parentId) {
    const needsWind = requiresWindMeasurement(evt?.name, 'field_distance');
    _cSubFieldData = { entries, results, heatId, parentId, needsWind, evt };
    _cSubFieldRender(area);
}

function _cSubFieldRender(area) {
    if (!area) area = document.getElementById('combined-sub-area');
    if (!area) return;
    const { entries, results, heatId, parentId, needsWind } = _cSubFieldData;

    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {};
        const attWind = {};
        // Extract status_code from result without attempt_number, or from any result with status_code
        let status_code = null;
        er.forEach(r => {
            if (r.attempt_number != null) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; }
            if (r.status_code) status_code = r.status_code;
        });
        // Auto-detect no_show as DNS
        const isDNS = e.status === 'no_show';
        if (isDNS && !status_code) status_code = 'DNS';
        const valid = Object.values(att).filter(d => d != null && d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        // WA: later attempt is the official record for same distance
        let bestWind = null;
        if (best != null) {
            for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } }
        }
        // Build sorted valid distances (descending) for WA tie-breaking
        const sortedValid = [];
        for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
        sortedValid.sort((a, b) => b - a);
        return { ...e, attempts: att, attWind, best, bestWind, status_code, _isNoShow: isDNS, sortedValid };
    });
    const ranked = rows.filter(r => r.best != null && !r.status_code).sort((a, b) => {
        if (b.best !== a.best) return b.best - a.best;
        // WA tie-break: 2nd best, 3rd best, etc.
        const maxLen = Math.max(a.sortedValid.length, b.sortedValid.length);
        for (let k = 1; k < maxLen; k++) {
            const aV = a.sortedValid[k] ?? -1, bV = b.sortedValid[k] ?? -1;
            if (bV !== aV) return bV - aV;
        }
        return 0;
    });
    let cr = 1;
    ranked.forEach((r, i) => {
        if (i > 0) {
            const prev = ranked[i - 1];
            let isTied = prev.best === r.best;
            if (isTied) {
                const maxLen = Math.max(prev.sortedValid.length, r.sortedValid.length);
                for (let k = 1; k < maxLen; k++) {
                    if ((prev.sortedValid[k] ?? -1) !== (r.sortedValid[k] ?? -1)) { isTied = false; break; }
                }
            }
            r.rank = isTied ? prev.rank : cr;
        } else {
            r.rank = cr;
        }
        cr = i + 2;
    });
    rows.forEach(r => { if (r.best == null) r.rank = null; else { const f = ranked.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; } });

    const sorted = [...rows].sort((a, b) => +(a.bib_number||0) - +(b.bib_number||0));

    // Separate status-code entries for ranking panel
    const scRows = rows.filter(r => r.status_code);

    area.innerHTML = `
        <div class="field-two-panel">
            <div class="field-input-panel">
                <table class="data-table field-table ${needsWind ? 'field-2row-table' : ''}" id="c-field-distance-table">
                    <thead>
                        ${needsWind ? `<tr><th rowspan="2">RANK</th><th style="text-align:left;">NAME / BIB</th>
                            <th class="att-col-first att-col-odd" colspan="1">1</th><th class="att-col-even" colspan="1">2</th><th class="att-col-odd" colspan="1">3</th>
                            <th class="att-col-even" colspan="1">4</th><th class="att-col-odd" colspan="1">5</th><th class="att-col-even" colspan="1">6</th>
                            <th class="att-col-best" rowspan="2">BEST</th><th rowspan="2" style="width:65px;" title="DNS/NM">상태</th>
                        </tr>
                        <tr><th style="text-align:left;">소속</th>
                            <th class="wind-header att-col-first att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th>
                            <th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th>
                        </tr>` : `<tr><th>RANK</th><th>NAME / BIB</th>
                            <th class="att-col-first att-col-odd">1</th><th class="att-col-even">2</th><th class="att-col-odd">3</th><th class="att-col-even">4</th><th class="att-col-odd">5</th><th class="att-col-even">6</th>
                            <th class="att-col-best">BEST</th><th style="width:65px;" title="DNS/NM">상태</th>
                        </tr>`}
                    </thead>
                    <tbody>${sorted.map((r, rowIdx) => {
                        const isDisabled = !!r.status_code;
                        let distCells = '';
                        for (let i = 1; i <= 6; i++) {
                            const attCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                            const v = r.attempts[i];
                            const hasVal = v !== undefined && v !== null;
                            const isFoul = hasVal && v === 0;
                            const isActive = _cSubFieldActive
                                && _cSubFieldActive.entryId === r.event_entry_id
                                && _cSubFieldActive.attempt === i;
                            if (isDisabled) {
                                distCells += `<td class="attempt-cell ${attCls}" style="opacity:0.3;text-align:center;">—</td>`;
                            } else if (isActive) {
                                distCells += `<td class="attempt-cell attempt-cell-editing ${attCls}" data-entry="${r.event_entry_id}" data-attempt="${i}">
                                    <input class="field-dist-input" type="text" data-eid="${r.event_entry_id}" data-att="${i}" data-hid="${heatId}" data-pid="${parentId}" data-row="${rowIdx}"
                                        value="${hasVal && !isFoul ? v.toFixed(2) : ''}" placeholder="0.00"
                                        onkeydown="_cSubFieldKeydown(event,this)" oninput="_cSubFieldChange(this)" onblur="_cSubFieldBlur(this)" onfocus="this.select()" autofocus>
                                    <button class="btn btn-xs btn-danger foul-inline-btn" onclick="_cSubFieldFoul(${r.event_entry_id},${i},${heatId},${parentId})" title="파울 (X)">X</button>
                                </td>`;
                            } else {
                                let display = '';
                                if (hasVal) display = isFoul ? '<span class="foul-mark">X</span>' : v.toFixed(2);
                                distCells += `<td class="attempt-cell ${attCls}" data-entry="${r.event_entry_id}" data-attempt="${i}" 
                                    onclick="_cSubFieldActivate(${r.event_entry_id},${i},${heatId},${parentId})"
                                    ondblclick="_cSubFieldDblFoul(${r.event_entry_id},${i},${heatId},${parentId})">${display}</td>`;
                            }
                        }

                        // Wind row cells (if needed)
                        let windCells = '';
                        if (needsWind) {
                            for (let i = 1; i <= 6; i++) {
                                const wAttCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                                if (isDisabled) {
                                    windCells += `<td class="wind-cell ${wAttCls}" style="opacity:0.3;">—</td>`;
                                    continue;
                                }
                                const v = r.attempts[i];
                                const hasVal = v !== undefined && v !== null;
                                const isFoul = hasVal && v === 0;
                                const isActiveWind = _cSubFieldWindActive
                                    && _cSubFieldWindActive.entryId === r.event_entry_id
                                    && _cSubFieldWindActive.attempt === i;
                                if (isActiveWind) {
                                    windCells += `<td class="wind-cell wind-cell-editing ${wAttCls}">
                                        <input class="field-wind-input-2row" type="number" step="0.1" data-eid="${r.event_entry_id}" data-att="${i}" data-hid="${heatId}" data-pid="${parentId}"
                                            value="${r.attWind && r.attWind[i] != null ? r.attWind[i] : ''}" placeholder="±0.0"
                                            onkeydown="_cSubFieldWindKeydown(event,this)" onblur="_cSubFieldWindBlur(this)" onfocus="this.select()" autofocus>
                                    </td>`;
                                } else {
                                    let wDisp = '';
                                    if (hasVal && !isFoul && r.attWind && r.attWind[i] != null) {
                                        wDisp = formatWind(r.attWind[i]);
                                    }
                                    const wClickAttr = (!hasVal || isFoul) ? '' : `onclick="_cSubFieldWindActivate(${r.event_entry_id},${i})"`;
                                    windCells += `<td class="wind-cell ${wAttCls}" ${wClickAttr}>${wDisp}</td>`;
                                }
                            }
                        }

                        const bestDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` :
                            (r.best != null ? `<span class="best-mark">${r.best.toFixed(2)}</span>` : '<span class="no-rank">—</span>');
                        const bestWindDisp = (!r.status_code && r.bestWind != null && needsWind) ? `<div style="font-size:10px;color:var(--text-muted);">${formatWind(r.bestWind)}</div>` : '';
                        const rankDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` :
                            (r.rank != null ? r.rank : '<span class="no-rank">—</span>');

                        // Status dropdown cell
                        const scCell = `<td><select class="sc-select" data-eid="${r.event_entry_id}" data-hid="${heatId}" data-pid="${parentId}" onchange="_cSubFieldSetStatus(this)" title="DNS=불출전, NM=기록없음" ${r._isNoShow ? 'disabled' : ''}>
                            <option value="">—</option><option value="DNS" ${r.status_code==='DNS'?'selected':''}>DNS</option>
                            <option value="NM" ${r.status_code==='NM'?'selected':''}>NM</option>
                        </select></td>`;

                        if (needsWind) {
                            const windScCell = `<td rowspan="2"><select class="sc-select" data-eid="${r.event_entry_id}" data-hid="${heatId}" data-pid="${parentId}" onchange="_cSubFieldSetStatus(this)" title="DNS=불출전, NM=기록없음" ${r._isNoShow ? 'disabled' : ''}>
                                <option value="">—</option><option value="DNS" ${r.status_code==='DNS'?'selected':''}>DNS</option>
                                <option value="NM" ${r.status_code==='NM'?'selected':''}>NM</option>
                            </select></td>`;
                            return `<tr class="field-row1 ${r.status_code ? 'row-status-code' : ''}">
                                <td rowspan="2">${rankDisp}</td>
                                <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${bib(r.bib_number)}</span></td>
                                ${distCells}
                                <td class="att-col-best" rowspan="2">${bestDisp}${bestWindDisp}</td>
                                ${windScCell}
                            </tr>
                            <tr class="field-row2 ${r.status_code ? 'row-status-code' : ''}">
                                <td style="text-align:left;font-size:11px;color:var(--text-muted);">${r.team || ''}</td>
                                ${windCells}
                            </tr>`;
                        } else {
                            return `<tr class="${r.status_code ? 'row-status-code' : ''}">
                                <td>${rankDisp}</td>
                                <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${bib(r.bib_number)}</span></td>
                                ${distCells}<td class="att-col-best">${bestDisp}</td>${scCell}
                            </tr>`;
                        }
                    }).join('')}</tbody>
                </table>
            </div>
            <div class="field-ranking-panel">
                <h3>실시간 순위</h3>
                ${ranked.length === 0 && scRows.length === 0 ? '<div class="empty-state">기록 없음</div>' :
                    ranked.map(r => `<div class="ranking-item">
                        <span class="ranking-rank">${r.rank}</span>
                        <span class="ranking-name">${r.name} #${bib(r.bib_number)}</span>
                        <span class="ranking-best">${r.best.toFixed(2)}m${r.bestWind != null && needsWind ? ' (' + formatWind(r.bestWind) + ')' : ''}</span>
                    </div>`).join('') +
                    (scRows.length > 0 ? '<hr style="margin:6px 0;border-color:var(--border);">' + scRows.map(r => `<div class="ranking-item" style="opacity:0.6;">
                        <span class="sc-badge sc-${r.status_code}">${r.status_code}</span>
                        <span class="ranking-name">${r.name} #${bib(r.bib_number)}</span>
                    </div>`).join('') : '')}
            </div>
        </div>
        <div class="track-actions" style="margin-top:10px;">
            <button class="btn btn-primary btn-sm" onclick="_cSubFieldSaveAll()" title="기록 확인 및 저장">기록 저장</button>
        </div>`;

    // Auto-focus the active input if it exists
    const activeInput = area.querySelector('.field-dist-input');
    if (activeInput) setTimeout(() => activeInput.focus(), 30);
}

function _cSubFieldActivate(entryId, attempt, heatId, parentId) {
    _cSubFieldActive = { entryId, attempt, heatId, parentId };
    _cSubFieldRender();
}

function _cSubFieldDeactivate() {
    if (!_cSubFieldActive) return;
    _cSubFieldActive = null;
    _cSubFieldRender();
}

function _cSubFieldKeydown(e, inp) {
    const eid = +inp.dataset.eid, att = +inp.dataset.att;
    const hid = +inp.dataset.hid, pid = +inp.dataset.pid;

    if (e.key === 'Enter') {
        e.preventDefault();
        const val = inp.value.trim();
        if (!val) return;
        if (/^[fFxX]$/.test(val)) { _cSubFieldFoul(eid, att, hid, pid); return; }
        const dist = parseFloat(val);
        if (isNaN(dist) || dist < 0) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); return; }
        _cSubFieldSave(eid, att, dist, hid, pid);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        _cSubFieldDeactivate();
    } else if (e.key === 'Tab') {
        e.preventDefault();
        const val = inp.value.trim();
        if (val) {
            if (/^[fFxX]$/.test(val)) { _cSubFieldFoul(eid, att, hid, pid); return; }
            const dist = parseFloat(val);
            if (!isNaN(dist) && dist >= 0) { _cSubFieldSave(eid, att, dist, hid, pid); return; }
        }
        _cSubFieldAdvance(eid, att, e.shiftKey);
    }
}

function _cSubFieldAdvance(currentEntryId, currentAttempt, reverse) {
    const { entries } = _cSubFieldData;
    const sorted = [...entries].sort((a, b) => +(a.bib_number||0) - +(b.bib_number||0));
    const cells = [];
    sorted.forEach(r => { for (let a = 1; a <= 6; a++) cells.push({ entryId: r.event_entry_id, attempt: a }); });
    const idx = cells.findIndex(c => c.entryId === currentEntryId && c.attempt === currentAttempt);
    const next = reverse ? idx - 1 : idx + 1;
    if (next >= 0 && next < cells.length) {
        _cSubFieldActive = { ...cells[next], heatId: _cSubFieldData.heatId, parentId: _cSubFieldData.parentId };
        _cSubFieldRender();
    } else { _cSubFieldDeactivate(); }
}

async function _cSubFieldSave(entryId, attempt, distance, heatId, parentId) {
    try {
        // Preserve existing wind value when saving distance
        const existingResult = _cSubFieldData.results.find(r => r.event_entry_id === entryId && r.attempt_number === attempt);
        const wind = existingResult ? (existingResult.wind ?? null) : null;
        await API.upsertResult({ heat_id: heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: distance, wind });
        _cSubFieldData.results = await API.getResults(heatId);
        _cSubFieldActive = null;
        _cSubFieldRender();
        await syncCombinedFromSubEvent(parentId);
    } catch (err) { console.error('_cSubFieldSave error:', err); showBanner('저장 실패', 'error'); }
}

async function _cSubFieldFoul(entryId, attempt, heatId, parentId) {
    try {
        await API.upsertResult({ heat_id: heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: 0 });
        _cSubFieldData.results = await API.getResults(heatId);
        _cSubFieldActive = null;
        _cSubFieldRender();
        showFoulNotice();
        await syncCombinedFromSubEvent(parentId);
    } catch (err) { console.error('_cSubFieldFoul error:', err); }
}

async function _cSubFieldDblFoul(entryId, attempt, heatId, parentId) {
    await _cSubFieldFoul(entryId, attempt, heatId, parentId);
}

function _cSubFieldChange(inp) {
    const val = inp.value.trim().toLowerCase();
    if (val === 'x' || val === '-' || val === 'f') {
        inp.style.borderColor = 'var(--danger)';
        inp.style.background = 'var(--danger-light)';
    } else { inp.style.borderColor = ''; inp.style.background = ''; }
}

// Auto-save on blur for combined sub-field-distance
function _cSubFieldBlur(inp) {
    const val = inp.value.trim();
    if (!val) return;
    const eid = +inp.dataset.eid, att = +inp.dataset.att;
    const hid = +inp.dataset.hid, pid = +inp.dataset.pid;
    if (/^[fFxX]$/.test(val)) { _cSubFieldFoul(eid, att, hid, pid); return; }
    const dist = parseFloat(val);
    if (isNaN(dist) || dist < 0) return;
    _cSubFieldSave(eid, att, dist, hid, pid);
}

// Set status code for combined sub-field-distance entry
async function _cSubFieldSetStatus(sel) {
    const eid = +sel.dataset.eid, hid = +sel.dataset.hid, pid = +sel.dataset.pid;
    const sc = sel.value;
    try {
        await API.upsertResult({ heat_id: hid, event_entry_id: eid, status_code: sc, distance_meters: sc ? null : undefined });
        _cSubFieldData.results = await API.getResults(hid);
        _cSubFieldRender();
        await syncCombinedFromSubEvent(pid);
    } catch(e) { console.error('_cSubFieldSetStatus error:', e); }
}

// Save all + auto-NM detection for combined sub-field-distance
async function _cSubFieldSaveAll() {
    const { entries, results, heatId, parentId } = _cSubFieldData;
    let nmCount = 0;
    // Check each entry: if all recorded attempts are fouls (distance=0), auto-set NM
    for (const e of entries) {
        if (e.status === 'no_show') continue; // already DNS
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const hasStatusCode = er.some(r => r.status_code);
        if (hasStatusCode) continue; // already has status
        const attemptResults = er.filter(r => r.attempt_number != null);
        if (attemptResults.length === 0) continue; // no attempts yet
        const allFoul = attemptResults.every(r => r.distance_meters === 0 || r.distance_meters === null);
        const hasValidDist = attemptResults.some(r => r.distance_meters != null && r.distance_meters > 0);
        // If all attempts are fouls (distance=0) and there are enough attempts, auto-NM
        // 10종/7종 필드종목은 3회 시기 (예: 원반, 포환, 창던지기, 멀리뛰기)
        if (allFoul && !hasValidDist && attemptResults.length >= 3) {
            try {
                await API.upsertResult({ heat_id: heatId, event_entry_id: e.event_entry_id, status_code: 'NM', distance_meters: null });
                nmCount++;
            } catch(err) { console.error('Auto-NM error:', err); }
        }
    }
    // Refresh data
    _cSubFieldData.results = await API.getResults(heatId);
    _cSubFieldRender();
    await syncCombinedFromSubEvent(parentId);
    const btn = document.querySelector('.track-actions .btn-primary');
    if (btn) {
        const msg = nmCount > 0 ? `✓ 저장됨 (NM ${nmCount}건 자동처리)` : '✓ 저장됨';
        const orig = btn.textContent;
        btn.textContent = msg; btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
}
function _cSubFieldWindActivate(entryId, attempt) {
    _cSubFieldWindActive = { entryId, attempt };
    _cSubFieldActive = null;
    _cSubFieldRender();
}

function _cSubFieldWindDeactivate() {
    if (!_cSubFieldWindActive) return;
    _cSubFieldWindActive = null;
    _cSubFieldRender();
}

function _cSubFieldWindKeydown(e, inp) {
    const eid = +inp.dataset.eid, att = +inp.dataset.att;
    const hid = +inp.dataset.hid, pid = +inp.dataset.pid;
    if (e.key === 'Enter') {
        e.preventDefault();
        const wv = inp.value.trim();
        if (wv) {
            const wind = parseFloat(wv);
            if (!isNaN(wind)) { _cSubFieldWindSave(eid, att, wind, hid, pid); return; }
        }
        _cSubFieldWindDeactivate();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        _cSubFieldWindDeactivate();
    } else if (e.key === 'Tab') {
        e.preventDefault();
        const wv = inp.value.trim();
        if (wv) {
            const wind = parseFloat(wv);
            if (!isNaN(wind)) _cSubFieldWindSave(eid, att, wind, hid, pid);
        }
        _cSubFieldWindAdvance(eid, att, e.shiftKey);
    }
}

function _cSubFieldWindBlur(inp) {
    setTimeout(() => {
        const active = document.activeElement;
        if (active && active.classList.contains('field-wind-input-2row')) return;
        const wv = inp.value.trim();
        if (wv) {
            const eid = +inp.dataset.eid, att = +inp.dataset.att;
            const hid = +inp.dataset.hid, pid = +inp.dataset.pid;
            const wind = parseFloat(wv);
            if (!isNaN(wind)) { _cSubFieldWindSave(eid, att, wind, hid, pid); return; }
        }
        _cSubFieldWindDeactivate();
    }, 100);
}

async function _cSubFieldWindSave(entryId, attempt, wind, heatId, parentId) {
    try {
        const existing = _cSubFieldData.results.find(r => r.event_entry_id === entryId && r.attempt_number === attempt);
        if (existing) {
            await API.upsertResult({ heat_id: heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: existing.distance_meters, wind });
            _cSubFieldData.results = await API.getResults(heatId);
            _cSubFieldWindActive = null;
            _cSubFieldRender();
        }
    } catch(err) { console.error('_cSubFieldWindSave error:', err); }
}

function _cSubFieldWindAdvance(currentEntryId, currentAttempt, reverse) {
    const { entries, results } = _cSubFieldData;
    const sorted = [...entries].sort((a, b) => +(a.bib_number||0) - +(b.bib_number||0));
    const cells = [];
    sorted.forEach(r => {
        const er = results.filter(res => res.event_entry_id === r.event_entry_id);
        for (let a = 1; a <= 6; a++) {
            const res = er.find(res => res.attempt_number === a);
            if (res && res.distance_meters != null && res.distance_meters > 0) cells.push({ entryId: r.event_entry_id, attempt: a });
        }
    });
    const idx = cells.findIndex(c => c.entryId === currentEntryId && c.attempt === currentAttempt);
    const next = reverse ? idx - 1 : idx + 1;
    if (next >= 0 && next < cells.length) {
        _cSubFieldWindActivate(cells[next].entryId, cells[next].attempt);
    } else { _cSubFieldWindDeactivate(); }
}

// ── Sub Field Height — toggle buttons (matches independent height events) ──
let _cSubHeightBarList = [];
let _cSubHeightData = { entries: [], attempts: [], heatId: null, parentId: null, evt: null };

function _renderSubFieldHeight(area, evt, entries, attempts, heatId, parentId) {
    // Build bar list from existing data
    const existingHeights = [...new Set(attempts.map(a => a.bar_height))].sort((a, b) => a - b);
    _cSubHeightBarList = [...new Set([..._cSubHeightBarList, ...existingHeights])].sort((a, b) => a - b);
    _cSubHeightData = { entries, attempts, heatId, parentId, evt };
    _cSubHeightRender(area);
}

function _cSubHeightAddBar() {
    const inp = document.getElementById('c-sub-height-bar-input');
    if (!inp) return;
    const val = parseFloat(inp.value);
    if (isNaN(val) || val <= 0) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); return; }
    const rounded = Math.round(val * 100) / 100;
    if (!_cSubHeightBarList.includes(rounded)) {
        _cSubHeightBarList.push(rounded);
        _cSubHeightBarList.sort((a, b) => a - b);
    }
    inp.value = '';
    _cSubHeightRender();
}

function _cSubHeightAddPlus5() {
    const last = _cSubHeightBarList.length > 0 ? _cSubHeightBarList[_cSubHeightBarList.length - 1] : 1.50;
    const next = Math.round((last + 0.05) * 100) / 100;
    if (!_cSubHeightBarList.includes(next)) {
        _cSubHeightBarList.push(next);
        _cSubHeightBarList.sort((a, b) => a - b);
    }
    document.getElementById('c-sub-height-bar-input').value = '';
    _cSubHeightRender();
}

function _cSubHeightRender(area) {
    if (!area) area = document.getElementById('combined-sub-area');
    if (!area) return;
    const { entries, attempts, heatId, parentId } = _cSubHeightData;
    const heights = _cSubHeightBarList.length > 0 ? [..._cSubHeightBarList] : [];

    let contentHtml = '';
    if (heights.length === 0) {
        contentHtml = `<div class="empty-state" style="padding:20px 0;">
            <p style="font-weight:600;">바 높이를 추가하세요</p>
            <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">위의 '높이 추가' 버튼으로 시작 높이를 입력하세요</p>
        </div>`;
    } else {
        const rows = entries.map(e => {
            const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
            const hd = {};
            ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
            let best = null, elim = false;
            const isDNS = e.status === 'no_show';
            if (isDNS) elim = true;
            heights.forEach(h => {
                const d = hd[h]; if (!d) return;
                if (Object.values(d).includes('O')) best = h;
                if (Object.values(d).filter(m => m === 'X').length >= 3) elim = true;
            });
            return { ...e, heightData: hd, bestHeight: best, eliminated: elim, _isNoShow: isDNS };
        });

        const rankedH = rows.filter(r => r.bestHeight != null).sort((a, b) => b.bestHeight - a.bestHeight);
        let rk = 1;
        rankedH.forEach((r, i) => { r.rank = (i > 0 && rankedH[i - 1].bestHeight === r.bestHeight) ? rankedH[i - 1].rank : rk; rk = i + 2; });
        rows.forEach(r => {
            if (r.bestHeight == null) r.rank = null;
            else { const f = rankedH.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
        });

        let hdr = '<th>RANK</th><th>NAME / BIB</th>';
        heights.forEach(h => { hdr += `<th class="height-col-header" style="font-size:10px;">${h.toFixed(2)}m<br><button class="btn-bar-delete" onclick="_cSubHeightDeleteBar(${h})" title="${h.toFixed(2)}m 삭제">&times;</button></th>`; });
        hdr += '<th>최고</th><th>상태</th>';

        contentHtml = `
            <table class="data-table field-table height-toggle-table">
                <thead><tr>${hdr}</tr></thead>
                <tbody>${rows.map(r => {
                    let cells = '';
                    if (r._isNoShow) {
                        heights.forEach(() => { cells += '<td class="height-toggle-cell" style="opacity:0.3;text-align:center;">—</td>'; });
                    } else {
                    heights.forEach(h => {
                        const hd = r.heightData[h] || {};
                        let cellContent = '<div class="height-attempt-row">';
                        for (let i = 1; i <= 3; i++) {
                            const mark = hd[i] || '';
                            const markCls = mark === 'PASS' ? 'mark-pass' : mark ? `mark-${mark}` : 'mark-empty';
                            const disabled = r.eliminated && !mark ? 'disabled' : '';
                            const displayMark2 = mark === 'PASS' ? '-' : (mark || '·');
                            cellContent += `<button class="height-toggle-btn ${markCls}" onclick="_cSubHeightToggle(${r.event_entry_id},${h},${i})" ${disabled} title="${i}차 시도">${displayMark2}</button>`;
                        }
                        cellContent += '</div>';
                        cells += `<td class="height-toggle-cell">${cellContent}</td>`;
                    });
                    }
                    const isNM = r.eliminated && r.bestHeight == null && !r._isNoShow;
                    const statusText = r._isNoShow ? '<span class="sc-badge sc-DNS">DNS</span>'
                        : isNM ? '<span class="nm-mark">NM</span>'
                        : r.eliminated ? '<span style="color:var(--danger);font-weight:700;">탈락</span>'
                        : '<span style="color:var(--green);">경기중</span>';
                    return `<tr class="${r.eliminated ? 'row-eliminated' : ''} ${r._isNoShow ? 'row-dns' : ''}">
                        <td>${r._isNoShow ? 'DNS' : isNM ? '<span class="nm-mark">NM</span>' : (r.rank || '—')}</td>
                        <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${bib(r.bib_number)}</span></td>
                        ${cells}
                        <td>${r.bestHeight != null ? `<strong>${r.bestHeight.toFixed(2)}m</strong>` : '—'}</td>
                        <td>${statusText}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>`;
    }

    area.innerHTML = `
        <div class="height-controls">
            <label>높이 추가:</label>
            <input type="number" id="c-sub-height-bar-input" step="0.01" min="0" placeholder="예: 1.80" value="">
            <button class="btn btn-primary btn-sm" onclick="_cSubHeightAddBar()">추가</button>
            <button class="btn btn-outline btn-sm" onclick="_cSubHeightAddPlus5()">+5cm</button>
        </div>
        ${contentHtml}
        <div class="track-actions" style="margin-top:10px;">
            <button class="btn btn-primary btn-sm" onclick="_cSubHeightSave()" title="현재 기록 상태를 확인하고 새로고침합니다">기록 저장</button>
        </div>`;
}

async function _cSubHeightDeleteBar(barHeight) {
    const h = parseFloat(barHeight);
    const attemptsAtHeight = (_cSubHeightData.attempts || []).filter(a => a.bar_height === h);
    if (attemptsAtHeight.length > 0) {
        if (!confirm(`${h.toFixed(2)}m에 ${attemptsAtHeight.length}개의 시기 기록이 있습니다.\n이 높이와 모든 기록을 삭제하시겠습니까?`)) return;
        try {
            const key = sessionStorage.getItem('op_key') || prompt('운영키를 입력하세요');
            if (!key) return;
            await api('POST', '/api/height-attempts/delete-bar', { heat_id: _cSubHeightData.heatId, bar_height: h, admin_key: key });
        } catch (err) { alert('삭제 실패: ' + (err.error || '')); return; }
    }
    _cSubHeightBarList = _cSubHeightBarList.filter(x => x !== h);
    _cSubHeightData.attempts = await API.getHeightAttempts(_cSubHeightData.heatId);
    _cSubHeightRender();
}

async function _cSubHeightSave() {
    _cSubHeightData.attempts = await API.getHeightAttempts(_cSubHeightData.heatId);
    _cSubHeightRender();
    const btn = document.querySelector('.track-actions .btn-primary');
    if (btn) { const orig = btn.textContent; btn.textContent = '✓ 저장됨'; btn.disabled = true; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200); }
}

async function _cSubHeightToggle(entryId, barHeight, attemptNumber) {
    const { heatId, parentId, attempts } = _cSubHeightData;
    const current = attempts.find(a =>
        a.event_entry_id === entryId && a.bar_height === barHeight && a.attempt_number === attemptNumber
    );
    const currentMark = current ? current.result_mark : '';
    const cycle = { '': 'O', 'O': 'X', 'X': '-', '-': '', 'PASS': '' };
    const newMark = currentMark in cycle ? cycle[currentMark] : 'O';

    try {
        await API.saveHeightAttempt({
            heat_id: heatId,
            event_entry_id: entryId,
            bar_height: barHeight,
            attempt_number: attemptNumber,
            result_mark: newMark
        });
        _cSubHeightData.attempts = await API.getHeightAttempts(heatId);
        _cSubHeightRender();
        await syncCombinedFromSubEvent(parentId);
    } catch (err) {
        console.error('_cSubHeightToggle error:', err);
    }
}

// ── WA Summary ──────────────────────────────────────────────
function _buildWASummary(subOrder) {
    const evt = _combinedParentEvt || state.selectedEvent;
    if (!evt) return '';
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    const seDef = subDefs.find(se => se.order === subOrder);
    if (!seDef) return '';
    const rows = state.combinedEntries.map(e => {
        let cum = 0;
        subDefs.forEach(se => { if (se.order < subOrder) { const sc = state.combinedScores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order); cum += sc ? (sc.wa_points||0) : 0; } });
        const sc = state.combinedScores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === subOrder);
        const wa = sc ? sc.wa_points : 0, raw = sc ? sc.raw_record : null;
        return { ...e, cum, wa, raw, total: cum + wa };
    }).sort((a,b) => b.total - a.total);
    return `<table class="data-table" style="font-size:12px;margin-top:4px;">
        <thead><tr><th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th>기록</th><th>WA점수</th><th>이전누적</th><th>현재누적</th></tr></thead>
        <tbody>${rows.map((r,i) => {
            const rec = r.raw && r.raw > 0 ? (seDef.unit === 's' ? formatTime(r.raw) : r.raw.toFixed(2) + 'm') : '—';
            return `<tr><td>${i+1}</td><td>${bib(r.bib_number)}</td><td style="text-align:left;">${r.name}</td>
                <td><strong>${rec}</strong></td><td>${r.wa || '—'}</td><td>${r.cum || '—'}</td><td><strong>${r.total || '—'}</strong></td></tr>`;
        }).join('')}</tbody></table>`;
}

// ── Sync combined scores ────────────────────────────────────
async function syncCombinedFromSubEvent(parentEventId) {
    try {
        await API.syncCombinedScores(parentEventId);
        state.combinedScores = await API.getCombinedScores(parentEventId);
        // Update WA summary if visible
        const waEl = document.querySelector('details > table.data-table');
        if (waEl && _combinedActiveTab > 0) {
            const details = waEl.closest('details');
            if (details) { const sum = details.querySelector('summary'); details.innerHTML = ''; if (sum) details.appendChild(sum); details.insertAdjacentHTML('beforeend', _buildWASummary(_combinedActiveTab)); }
        }
    } catch(e) { console.error('[syncCombined]', e); }
}

// ADMIN KEY — edit lock for completed events (custom modal)
// ============================================================
let _adminUnlocked = false;

async function checkAdminBeforeEdit(callback) {
    // If event is completed, require admin key
    if (state.selectedEvent && state.selectedEvent.round_status === 'completed' && !_adminUnlocked) {
        showAdminKeyModal(async (key) => {
            if (!key) return;
            try {
                await API.verifyAdmin(key);
                _adminUnlocked = true;
                callback();
            } catch (e) {
                showBanner(document.querySelector('.barcode-banner') || document.body, 'error', '관리자 키가 올바르지 않습니다.');
            }
        });
        return;
    }
    callback();
}

function showAdminKeyModal(onSubmit) {
    // Remove old overlay to prevent stale event listeners
    let overlay = document.getElementById('admin-key-overlay');
    if (overlay) overlay.remove();
    
    overlay = document.createElement('div');
    overlay.id = 'admin-key-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal modal-sm">
        <div class="modal-header"><div class="modal-title">관리자 인증 필요</div></div>
        <div class="modal-form">
            <p style="padding:8px 0;font-size:13px;">경기가 완료된 상태입니다. 수정하려면 관리자 키를 입력하세요.</p>
            <input type="password" id="admin-key-modal-input" class="form-input" placeholder="관리자 키" style="width:100%;padding:8px 12px;margin-top:4px;">
            <div id="admin-key-modal-error" style="display:none;color:var(--danger);font-size:12px;margin-top:6px;"></div>
        </div>
        <div class="modal-footer">
            <button id="admin-key-cancel-btn" class="btn btn-ghost">취소</button>
            <button id="admin-key-submit-btn" class="btn btn-primary">인증</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.style.display = 'flex';
    const inp = document.getElementById('admin-key-modal-input');
    inp.value = '';
    let submitted = false;
    const closeOverlay = () => { overlay.remove(); };
    const submit = () => {
        if (submitted) return;
        submitted = true;
        closeOverlay();
        onSubmit(inp.value);
    };
    document.getElementById('admin-key-submit-btn').onclick = submit;
    document.getElementById('admin-key-cancel-btn').onclick = closeOverlay;
    inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') closeOverlay(); };
    // Close on overlay background click
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    setTimeout(() => inp.focus(), 50);
}

// ============================================================
// QUALIFICATION WORKFLOW — Q/q per-athlete, combined ranking
// ============================================================
let _qualMode = 'final'; // or 'semifinal'
let _qualAllRows = []; // all heats combined data

async function loadAllHeatsForQual() {
    // Load entries and results from ALL heats
    const allRows = [];
    for (const heat of state.heats) {
        const entries = await API.getHeatEntries(heat.id);
        const results = await API.getResults(heat.id);
        entries.forEach(e => {
            const r = results.find(r => r.event_entry_id === e.event_entry_id);
            allRows.push({
                ...e,
                heat_id: heat.id,
                heat_number: heat.heat_number,
                time_seconds: r ? r.time_seconds : null,
                qual: null // Q, q, or null
            });
        });
    }
    // Sort by time
    allRows.sort((a, b) => {
        if (a.time_seconds == null && b.time_seconds == null) return 0;
        if (a.time_seconds == null) return 1;
        if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    // Assign rank
    let rk = 1;
    allRows.forEach((r, i) => {
        if (r.time_seconds == null) { r.rank = ''; return; }
        if (i > 0 && allRows[i - 1].time_seconds === r.time_seconds) r.rank = allRows[i - 1].rank;
        else r.rank = rk;
        rk = i + 2;
    });
    _qualAllRows = allRows;
    return allRows;
}

async function openSemifinalQualification() {
    _qualMode = 'semifinal';
    await loadAllHeatsForQual();
    renderQualPanel('준결승 진출자 선택', true);
    document.getElementById('track-qual-section').style.display = 'block';
}

async function openTrackQualification() {
    _qualMode = 'final';
    await loadAllHeatsForQual();
    renderQualPanel('결승 진출자 선택', false);
    document.getElementById('track-qual-section').style.display = 'block';
}

function renderQualPanel(title, isSemifinal) {
    const section = document.getElementById('track-qual-section');
    const rows = _qualAllRows;
    const withTime = rows.filter(r => r.time_seconds != null);
    const noTime = rows.filter(r => r.time_seconds == null);

    // View mode tabs: combined vs per-heat
    const heatNums = [...new Set(rows.map(r => r.heat_number))].sort((a,b) => a - b);

    // Auto Q/q assignment controls
    const totalWithTime = withTime.length;
    const defaultQPerHeat = Math.min(3, Math.ceil(totalWithTime / (heatNums.length || 1)));
    const defaultQ = Math.min(defaultQPerHeat * heatNums.length, totalWithTime);

    section.innerHTML = `
        <div class="qual-panel-header">
            <h3>${title}</h3>
            <button class="btn btn-sm btn-ghost" onclick="document.getElementById('track-qual-section').style.display='none'" title="진출자 선택 패널을 닫습니다">닫기</button>
        </div>
        <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm ${true ? 'btn-primary' : 'btn-outline'}" id="qual-view-all" onclick="switchQualView('all')" title="모든 조의 결과를 기록 순으로 정렬합니다">전체 통합</button>
            ${heatNums.map(n => `<button class="btn btn-sm btn-outline" id="qual-view-h${n}" onclick="switchQualView(${n})" title="${n}조 선수만 표시합니다">${n}조</button>`).join('')}
        </div>
        <div style="margin-bottom:8px;padding:8px 12px;background:#f0f4ff;border-radius:var(--radius);border-left:3px solid var(--primary);display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <span style="font-size:12px;font-weight:700;">자동 배분:</span>
            <label style="font-size:11px;">Q(순위진출/조):</label>
            <input type="number" id="qual-auto-Q-per-heat" value="${defaultQPerHeat}" min="0" max="20" style="width:50px;padding:2px 6px;border:1px solid var(--gray);border-radius:4px;font-size:12px;" title="각 조에서 순위로 자동 진출하는 인원">
            <label style="font-size:11px;">q(기록진출):</label>
            <input type="number" id="qual-auto-q-total" value="${Math.max(0, 8 - defaultQ)}" min="0" max="20" style="width:50px;padding:2px 6px;border:1px solid var(--gray);border-radius:4px;font-size:12px;" title="순위 진출 후 나머지 기록순으로 추가 진출하는 인원">
            <button class="btn btn-sm btn-primary" onclick="autoAssignQualification()" title="입력한 인원수에 따라 자동으로 Q/q를 배정합니다">자동 배분</button>
            <button class="btn btn-sm btn-outline" onclick="clearAllQualification()" title="모든 Q/q 선택을 초기화합니다">초기화</button>
        </div>
        <p class="qual-desc" style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
            <strong>Q</strong> = 순위 자동진출 (대형큐: 조별 상위) &nbsp; <strong>q</strong> = 기록 진출 (소형큐: 나머지 기록순) &nbsp; 클릭으로 Q → q → 해제 전환
        </p>
        <div id="qual-table-container"></div>
        ${isSemifinal ? `
            <div style="margin:10px 0;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fff3e0;border-radius:var(--radius);border-left:3px solid #ff9800;">
                <label style="font-size:12px;font-weight:700;">준결승 조 수:</label>
                <input type="number" id="semi-group-count" value="2" min="1" max="8" style="width:60px;padding:6px 10px;border:2px solid #ff9800;border-radius:4px;font-size:14px;font-weight:700;text-align:center;" title="생성할 준결승 조의 수를 입력하세요">
                <span style="font-size:11px;color:var(--text-muted);">WA 규정: ≤800m 종목 조당 최대 8명, 서펜타인 시딩</span>
            </div>
        ` : `
            <div style="margin:10px 0;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#e8f5e9;border-radius:var(--radius);border-left:3px solid var(--green);">
                <label style="font-size:12px;font-weight:700;">결승 조 수:</label>
                <input type="number" id="final-group-count" value="1" min="1" max="4" style="width:60px;padding:6px 10px;border:2px solid var(--green);border-radius:4px;font-size:14px;font-weight:700;text-align:center;" title="결승 조 수 (기본 1조)">
                <span style="font-size:11px;color:var(--text-muted);">WA 규정: 자동 레인 배정 (중앙→외곽)</span>
            </div>
        `}
        <div class="qual-actions" style="margin-top:10px;">
            ${isSemifinal
                ? `<button class="btn btn-primary" onclick="approveSemifinalQualification()" title="q 선택 선수를 준결승으로 이동합니다">준결승 확정 및 생성</button>`
                : `<button class="btn btn-primary" onclick="approveQualification()" title="q 선택 선수를 결승으로 이동합니다">결승 확정 및 생성</button>`
            }
            <button class="btn btn-outline" onclick="openManualHeatEditUI()" style="margin-left:8px;" title="생성 후 수동으로 조 편성/레인 수정">생성 후 수동 편집</button>
        </div>`;

    renderQualTable('all');
}

// Auto-assign Q (large-queue: per-heat top N) and q (small-queue: remaining best times)
function autoAssignQualification() {
    const qPerHeat = parseInt(document.getElementById('qual-auto-Q-per-heat')?.value) || 0;
    const qTotal = parseInt(document.getElementById('qual-auto-q-total')?.value) || 0;

    // Reset all
    _qualAllRows.forEach(r => r.qual = null);

    // Group by heat
    const heatGroups = {};
    _qualAllRows.forEach(r => {
        if (!heatGroups[r.heat_number]) heatGroups[r.heat_number] = [];
        heatGroups[r.heat_number].push(r);
    });

    // Assign Q: top N per heat (by time, ascending)
    const qAssignedIds = new Set();
    for (const [hNum, rows] of Object.entries(heatGroups)) {
        const sorted = rows.filter(r => r.time_seconds != null).sort((a, b) => a.time_seconds - b.time_seconds);
        for (let i = 0; i < Math.min(qPerHeat, sorted.length); i++) {
            sorted[i].qual = 'Q';
            qAssignedIds.add(sorted[i].event_entry_id);
        }
    }

    // Assign q: remaining athletes sorted by time, take top qTotal
    if (qTotal > 0) {
        const remaining = _qualAllRows
            .filter(r => r.time_seconds != null && !qAssignedIds.has(r.event_entry_id))
            .sort((a, b) => a.time_seconds - b.time_seconds);
        for (let i = 0; i < Math.min(qTotal, remaining.length); i++) {
            remaining[i].qual = 'q';
        }
    }

    // Re-render
    const activeBtn = document.querySelector('#track-qual-section .btn-primary[id^="qual-view-"]');
    const viewFilter = activeBtn?.id === 'qual-view-all' ? 'all' : parseInt(activeBtn?.id?.replace('qual-view-h', ''));
    renderQualTable(viewFilter || 'all');
}

function clearAllQualification() {
    _qualAllRows.forEach(r => r.qual = null);
    const activeBtn = document.querySelector('#track-qual-section .btn-primary[id^="qual-view-"]');
    const viewFilter = activeBtn?.id === 'qual-view-all' ? 'all' : parseInt(activeBtn?.id?.replace('qual-view-h', ''));
    renderQualTable(viewFilter || 'all');
}

function switchQualView(heatNum) {
    // Toggle button styles
    document.querySelectorAll('#track-qual-section .btn-sm').forEach(b => {
        if (b.id?.startsWith('qual-view-')) {
            b.classList.remove('btn-primary');
            b.classList.add('btn-outline');
        }
    });
    const targetId = heatNum === 'all' ? 'qual-view-all' : `qual-view-h${heatNum}`;
    const btn = document.getElementById(targetId);
    if (btn) { btn.classList.remove('btn-outline'); btn.classList.add('btn-primary'); }

    renderQualTable(heatNum);
}

function renderQualTable(heatFilter) {
    let rows = [..._qualAllRows];
    if (heatFilter !== 'all') rows = rows.filter(r => r.heat_number === heatFilter);
    // Recompute rank for filtered view
    const withTime = rows.filter(r => r.time_seconds != null);
    withTime.sort((a, b) => a.time_seconds - b.time_seconds);
    let rk = 1;
    withTime.forEach((r, i) => {
        if (i > 0 && withTime[i - 1].time_seconds === r.time_seconds) r.displayRank = withTime[i - 1].displayRank;
        else r.displayRank = rk;
        rk = i + 2;
    });
    const noTime = rows.filter(r => r.time_seconds == null);
    noTime.forEach(r => r.displayRank = '');
    const sorted = [...withTime, ...noTime];

    document.getElementById('qual-table-container').innerHTML = `
        <table class="data-table" style="font-size:12px;">
            <thead><tr>
                <th style="width:40px;">순위</th>
                <th style="width:40px;">Q/q</th>
                <th style="width:40px;">조</th>
                <th style="width:50px;">BIB</th>
                <th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>
                <th style="width:80px;">기록</th>
            </tr></thead>
            <tbody>${sorted.map(r => {
                const qualBadge = r.qual === 'Q' ? '<span class="qual-badge qual-Q" title="순위 자동진출 (Q)">Q</span>'
                    : r.qual === 'q' ? '<span class="qual-badge qual-q" title="기록 진출 (q)">q</span>'
                    : '<span class="qual-badge qual-none" title="클릭하여 진출 설정">—</span>';
                return `<tr class="${r.qual ? 'row-qual-selected' : ''}">
                    <td>${r.displayRank || '—'}</td>
                    <td style="cursor:pointer;" onclick="toggleQual(${r.event_entry_id})" title="클릭: Q(순위진출)→q(기록진출)→해제">${qualBadge}</td>
                    <td>${r.heat_number}조</td>
                    <td><strong>${bib(r.bib_number)}</strong></td>
                    <td style="text-align:left;">${r.name}</td>
                    <td style="font-size:11px;text-align:left;">${r.team || ''}</td>
                    <td>${r.time_seconds != null ? formatTime(r.time_seconds) : '—'}</td>
                </tr>`;
            }).join('')}</tbody>
        </table>
        <div style="margin-top:6px;font-size:11px;color:var(--text-muted);">
            총 ${sorted.length}명 / Q(순위): ${_qualAllRows.filter(r => r.qual === 'Q').length}명, q(기록): ${_qualAllRows.filter(r => r.qual === 'q').length}명
        </div>`;
}

function toggleQual(entryId) {
    const r = _qualAllRows.find(r => r.event_entry_id === entryId);
    if (!r) return;
    // Cycle: null → Q → q → null
    if (r.qual == null) r.qual = 'Q';
    else if (r.qual === 'Q') r.qual = 'q';
    else r.qual = null;
    // Re-render current view
    const activeBtn = document.querySelector('#track-qual-section .btn-primary[id^="qual-view-"]');
    const viewFilter = activeBtn?.id === 'qual-view-all' ? 'all' : parseInt(activeBtn?.id?.replace('qual-view-h', ''));
    renderQualTable(viewFilter || 'all');
}

async function approveQualification() {
    const qualified = _qualAllRows.filter(r => r.qual === 'Q' || r.qual === 'q');
    if (qualified.length === 0) { alert('진출자가 선택되지 않았습니다. Q 또는 q를 지정하세요.'); return; }
    const groupCount = parseInt(document.getElementById('final-group-count')?.value) || 1;
    if (!confirm(`결승 ${groupCount}개 조로 ${qualified.length}명을 확정하고 결승 라운드를 생성합니다.\nWA 규정에 따라 서펜타인 시딩 및 레인 배정이 적용됩니다.\n계속하시겠습니까?`)) return;

    const selections = _qualAllRows.map(r => ({
        event_entry_id: r.event_entry_id,
        selected: r.qual === 'Q' || r.qual === 'q' ? 1 : 0,
        qualification_type: r.qual || ''
    }));
    try {
        await API.saveQualifications(state.selectedEventId, selections);
        await API.approveQualifications(state.selectedEventId);
        const res = await API.createFinalWithGroups(state.selectedEventId, groupCount);
        alert(`결승 생성 완료 (${res.count}명 진출, ${groupCount}개 조)`);
        state.events = await API.getAllEvents(getCompetitionId());
        renderMatrix();
        document.getElementById('track-qual-section').style.display = 'none';
        // Offer to open manual edit
        if (res.final_event_id && confirm('생성된 조 편성/레인을 확인하시겠습니까?')) {
            await selectEvent(res.final_event_id);
        }
    } catch (e) { alert('결승 생성 실패: ' + (e.error || '')); }
    renderAuditLog();
}

async function approveSemifinalQualification() {
    const qualified = _qualAllRows.filter(r => r.qual === 'Q' || r.qual === 'q');
    if (qualified.length === 0) { alert('진출자가 선택되지 않았습니다. Q 또는 q를 지정하세요.'); return; }
    const groupCount = parseInt(document.getElementById('semi-group-count')?.value) || 2;
    if (!confirm(`준결승 ${groupCount}개 조로 ${qualified.length}명을 확정하고 준결승 라운드를 생성합니다.\n계속하시겠습니까?`)) return;

    const selections = _qualAllRows.map(r => ({
        event_entry_id: r.event_entry_id,
        selected: r.qual === 'Q' || r.qual === 'q',
        qualification_type: r.qual || ''
    }));

    try {
        const res = await API.createSemifinal(state.selectedEventId, groupCount, selections);
        alert(`준결승 생성 완료 (${res.count}명, ${groupCount}개 조)`);
        state.events = await API.getAllEvents(getCompetitionId());
        renderMatrix();
        document.getElementById('track-qual-section').style.display = 'none';
    } catch (e) { alert('준결승 생성 실패: ' + (e.error || '')); }
    renderAuditLog();
}

// ============================================================
// COMPLETE UI BUILDER — unified for all event types
// ============================================================
function _buildCompleteUI(evt) {
    if (evt.round_status === 'completed') {
        return `<div style="display:inline-flex;align-items:center;gap:8px;padding:8px 14px;background:#e8f5e9;border-radius:var(--radius);color:#2e7d32;font-weight:600;font-size:13px;">✓ 경기 완료됨</div>
                <button class="btn btn-warning btn-sm" onclick="revertRoundComplete()" title="경기 완료를 취소하고 다시 진행 중 상태로 되돌립니다">완료 취소</button>`;
    }
    return `<button class="btn btn-success" onclick="completeRound()" title="모든 기록이 저장된 후 경기를 최종 완료 처리합니다">경기 완료</button>`;
}

// ============================================================
// REVERT ROUND COMPLETION — for general/relay events
// ============================================================
async function revertRoundComplete() {
    const evt = state.selectedEvent;
    if (!evt) return;
    // Guard: check if already not completed (SSE may have updated state)
    if (evt.round_status !== 'completed') {
        showToast('이미 진행 중 상태입니다.', 'info', 2000);
        return;
    }
    if (!confirm(`${evt.name} 경기 완료를 취소하시겠습니까?\n다시 진행 중 상태로 되돌립니다.`)) return;

    showAdminKeyModal(async (key) => {
        if (!key) return;
        try {
            await API.revertComplete(evt.id, key);
            _adminUnlocked = true;
            showToast('↩️ ' + evt.name + ' 경기 완료가 취소되었습니다.', 'success', 3000);
            state.events = await API.getAllEvents(getCompetitionId());
            state.selectedEvent = await API.getEvent(evt.id);
            renderMatrix();
            await renderDetail();
            renderAuditLog();
        } catch(e) {
            // If already reverted (400), just refresh state
            if (e.status === 400 || (e.error && e.error.includes('완료 상태'))) {
                state.events = await API.getAllEvents(getCompetitionId());
                state.selectedEvent = await API.getEvent(evt.id);
                _adminUnlocked = true;
                renderMatrix();
                await renderDetail();
                showToast('이미 되돌려진 상태입니다.', 'info', 2000);
            } else {
                alert(e.error || '완료 취소 실패: 관리자 키를 확인하세요.');
            }
        }
    });
}

// ============================================================
// ROUND COMPLETION — with registered judge dropdown
// ============================================================
async function completeRound() {
    // Validate: all entries in all heats must have a result or status code
    try {
        const allHeats = await API.getHeats(state.selectedEventId);
        const isHeight = state.selectedEvent && state.selectedEvent.category === 'field_height';
        let missingCount = 0;
        for (const h of allHeats) {
            const entries = await API.getHeatEntries(h.id);
            if (isHeight) {
                // Height events: check height_attempts — need at least one attempt OR status code
                const attempts = await API.getHeightAttempts(h.id);
                for (const e of entries) {
                    if (e.status === 'no_show') continue; // no_show = DNS, skip
                    const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
                    if (ea.length === 0) missingCount++;
                }
            } else {
                const results = await API.getResults(h.id);
                for (const e of entries) {
                    if (e.status === 'no_show') continue; // no_show = DNS, skip
                    const r = results.find(r => r.event_entry_id === e.event_entry_id);
                    if (!r || (r.time_seconds == null && r.distance_meters == null && !r.status_code)) missingCount++;
                }
            }
        }
        if (missingCount > 0) {
            const msg = isHeight
                ? `높이 시기가 입력되지 않은 선수가 ${missingCount}명 있습니다.\n(패스/탈락 선수도 최소 한 번의 시기 기록이 필요합니다)\n계속 완료하시겠습니까?`
                : `기록이 입력되지 않은 선수가 ${missingCount}명 있습니다.\n모든 선수의 기록 또는 상태코드(DQ/DNS/DNF/NM)를 입력한 후 경기를 완료하세요.`;
            if (isHeight) {
                if (!confirm(msg)) return;
            } else {
                alert(msg);
                return;
            }
        }
    } catch(e) { console.error(e); }

    // Fetch registered judges
    let judgeOptions = '<option value="">-- 심판 선택 --</option>';
    try {
        const judges = await api('GET', '/api/registered-judges');
        judges.forEach(name => { judgeOptions += `<option value="${name}">${name}</option>`; });
        judgeOptions += `<option value="관리자">관리자</option>`;
    } catch(e) {}

    const modal = document.createElement('div');
    modal.id = 'complete-modal-overlay';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal modal-sm">
            <div class="modal-header"><div class="modal-title">경기 완료 확인</div></div>
            <div class="modal-form">
                <div class="form-row"><label>심판</label>
                    <select id="complete-judge-name" style="flex:1;padding:7px 12px;border:1.5px solid var(--gray);border-radius:var(--radius);font-size:13px;">
                        ${judgeOptions}
                    </select>
                </div>
                <div class="form-row"><label>운영 키</label><input type="password" id="complete-admin-key" placeholder="운영키 입력" style="flex:1;padding:7px 12px;border:1.5px solid var(--gray);border-radius:var(--radius);font-size:13px;"></div>
                <div id="complete-error" style="display:none;color:var(--danger);font-size:12px;margin-top:4px;font-weight:600;"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" onclick="document.getElementById('complete-modal-overlay').remove()">취소</button>
                <button class="btn btn-success" onclick="doCompleteRound()" title="이 경기를 완료 처리합니다">경기 완료</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('complete-judge-name').focus(), 100);
}

async function doCompleteRound() {
    const judgeName = document.getElementById('complete-judge-name').value;
    const adminKey = document.getElementById('complete-admin-key').value;
    const errEl = document.getElementById('complete-error');

    if (!judgeName) { errEl.textContent = '심판을 선택하세요.'; errEl.style.display = 'block'; return; }
    if (!adminKey) { errEl.textContent = '운영키를 입력하세요.'; errEl.style.display = 'block'; return; }

    try {
        await API.completeEvent(state.selectedEventId, judgeName, adminKey);
        document.getElementById('complete-modal-overlay').remove();
        showToast('✓ ' + (state.selectedEvent?.name || '') + ' 경기 완료', 'success', 3000);
        state.events = await API.getAllEvents(getCompetitionId());
        state.selectedEvent = await API.getEvent(state.selectedEventId);
        renderMatrix();
        await renderDetail();
        renderAuditLog();
    } catch (e) {
        errEl.textContent = e.error || '완료 처리 실패';
        errEl.style.display = 'block';
    }
}

// ============================================================
// 10종 경기 날짜별 분리 (Day 1 / Day 2)
// ============================================================
// Decathlon: Day 1 = events 1-5, Day 2 = events 6-10
// Heptathlon: Day 1 = events 1-4, Day 2 = events 5-7

// ============================================================
// MANUAL HEAT / LANE EDIT UI
// ============================================================
async function openManualHeatEditUI() {
    // This opens for the MOST RECENTLY created round (semifinal or final)
    // First, find the latest created event
    const events = await API.getAllEvents(getCompetitionId());
    const parentEvt = state.selectedEvent;
    if (!parentEvt) { alert('종목을 먼저 선택하세요.'); return; }
    
    // Find the latest semifinal or final for this event
    const related = events.filter(e => 
        e.name === parentEvt.name && e.gender === parentEvt.gender && e.category === parentEvt.category &&
        (e.round_type === 'semifinal' || e.round_type === 'final') && e.id !== parentEvt.id
    ).sort((a, b) => b.id - a.id);
    
    const targetEvt = related[0];
    if (!targetEvt) { alert('생성된 준결승/결승이 없습니다.'); return; }
    
    await showHeatEditModal(targetEvt);
}

async function showHeatEditModal(evt) {
    if (!evt) evt = state.selectedEvent;
    if (!evt) { alert('종목을 먼저 선택하세요.'); return; }
    try {
        const allocData = await API.getHeatAllocations(evt.id);
        const heats = allocData.heats;
        const isShort = isShortTrackEvent(evt.name);
        
        let modal = document.getElementById('heat-edit-overlay');
        if (modal) modal.remove();
        
        modal = document.createElement('div');
        modal.id = 'heat-edit-overlay';
        modal.className = 'modal-overlay';
        modal.style.display = 'flex';
        
        let heatsHtml = '';
        heats.forEach(h => {
            let rowsHtml = h.entries.map((e, idx) => `
                <tr data-entry-id="${e.event_entry_id}" data-heat-id="${h.id}">
                    <td style="font-size:12px;"><strong>${bib(e.bib_number)}</strong></td>
                    <td style="text-align:left;font-size:12px;">${e.name}</td>
                    <td style="font-size:11px;">${e.team || ''}</td>
                    <td><input type="number" class="lane-edit-input" value="${e.lane_number || ''}" min="1" ${isShort ? 'max="8"' : ''} 
                        style="width:50px;padding:4px;border:1px solid var(--gray);border-radius:4px;text-align:center;font-size:13px;font-weight:700;"
                        data-entry-id="${e.event_entry_id}" data-heat-id="${h.id}"></td>
                    <td>
                        <select class="heat-move-select" data-entry-id="${e.event_entry_id}" data-current-heat="${h.id}" style="padding:2px 4px;font-size:11px;border:1px solid var(--gray);border-radius:4px;">
                            ${heats.map(h2 => `<option value="${h2.id}" ${h2.id === h.id ? 'selected' : ''}>${h2.heat_name || ('Heat ' + h2.heat_number)}</option>`).join('')}
                        </select>
                    </td>
                </tr>
            `).join('');
            
            heatsHtml += `
                <div class="heat-edit-group" style="margin-bottom:16px;">
                    <h4 style="margin:0 0 6px;padding:4px 8px;background:var(--gray-light);border-radius:4px;">
                        ${h.heat_name || ('Heat ' + h.heat_number)} <span style="font-size:11px;color:var(--text-muted);">(${h.entries.length}명${isShort ? ', 최대 8명' : ''})</span>
                    </h4>
                    <table class="data-table" style="font-size:12px;">
                        <thead><tr><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>레인</th><th>조 이동</th></tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>`;
        });
        
        modal.innerHTML = `
            <div class="modal" style="max-width:750px;max-height:85vh;overflow-y:auto;">
                <div class="modal-header">
                    <div class="modal-title">${evt.name} ${fmtRound(evt.round_type)} — 조 편성 / 레인 수정</div>
                    <div style="font-size:11px;color:var(--text-muted);">WA 규정: 상위 시드 → 중앙 레인 3~6, 하위 시드 → 외곽 1,2,7,8</div>
                </div>
                <div class="modal-form" style="padding:0 16px;">
                    ${heatsHtml}
                </div>
                <div class="modal-footer" style="padding:12px 16px;display:flex;gap:8px;">
                    <button class="btn btn-outline" onclick="autoCorrectWAFromModal(${evt.id})" title="WA 규정에 맞게 자동 수정">🔄 WA 자동 수정</button>
                    <div style="flex:1;"></div>
                    <button class="btn btn-ghost" onclick="document.getElementById('heat-edit-overlay').remove()">닫기</button>
                    <button class="btn btn-primary" onclick="saveManualHeatEdit(${evt.id})">저장</button>
                </div>
            </div>`;
        
        document.body.appendChild(modal);
    } catch (e) {
        console.error(e);
        alert('조 편성 데이터를 불러올 수 없습니다: ' + (e.error || e.message));
    }
}

async function autoCorrectWAFromModal(eventId) {
    try {
        const result = await api('POST', `/api/wa-correct/${eventId}`);
        if (result.corrections > 0) {
            showToast(`WA 규정 자동 수정: ${result.corrections}개 레인 수정됨`);
            document.getElementById('heat-edit-overlay')?.remove();
            await showHeatEditModal(state.selectedEvent || { id: eventId });
            if (state.selectedEventId) await selectEvent(state.selectedEventId);
        } else {
            showToast('WA 규정 위반 없음', 'success');
        }
    } catch(e) { alert('자동 수정 실패: ' + (e.error || e.message)); }
}

async function validateWARegulations() {
    if (!state.selectedEvent) return;
    try {
        const result = await api('GET', `/api/wa-validate/${state.selectedEvent.id}`);
        if (result.valid && result.issues.length === 0) {
            showToast('WA 규정 검증 통과', 'success');
        } else {
            const msgs = result.issues.map(i => `• ${i.message}`).join('\n');
            const action = confirm(`WA 규정 검증 결과:\n\n${msgs}\n\n자동 수정하시겠습니까?`);
            if (action) {
                await autoCorrectWAFromModal(state.selectedEvent.id);
            }
        }
    } catch(e) { alert('검증 실패: ' + (e.error || e.message)); }
}

async function saveManualHeatEdit(eventId) {
    const adminKey = sessionStorage.getItem('pace_admin_key') || sessionStorage.getItem('accessKey') || '';
    const inputs = document.querySelectorAll('#heat-edit-overlay .lane-edit-input');
    const moveSelects = document.querySelectorAll('#heat-edit-overlay .heat-move-select');
    
    // First handle heat moves
    const moves = [];
    moveSelects.forEach(sel => {
        const entryId = parseInt(sel.dataset.entryId);
        const currentHeat = parseInt(sel.dataset.currentHeat);
        const targetHeat = parseInt(sel.value);
        if (targetHeat !== currentHeat) {
            moves.push({ event_entry_id: entryId, source_heat_id: currentHeat, target_heat_id: targetHeat });
        }
    });
    
    // Then handle lane updates
    const heatUpdates = {};
    inputs.forEach(inp => {
        const heatId = inp.dataset.heatId;
        const entryId = inp.dataset.entryId;
        const lane = parseInt(inp.value) || 0;
        // Check if this entry was moved to a different heat
        const move = moves.find(m => m.event_entry_id === parseInt(entryId));
        const effectiveHeatId = move ? String(move.target_heat_id) : heatId;
        if (!heatUpdates[effectiveHeatId]) heatUpdates[effectiveHeatId] = [];
        heatUpdates[effectiveHeatId].push({ event_entry_id: parseInt(entryId), lane_number: lane });
    });
    
    try {
        // Execute moves first
        for (const move of moves) {
            await API.moveHeatEntry(move.source_heat_id, move.event_entry_id, move.target_heat_id, null, adminKey);
        }
        // Then update lanes
        for (const [heatId, entries] of Object.entries(heatUpdates)) {
            await API.assignLanes(parseInt(heatId), entries);
        }
        showToast('조/레인 배정이 저장되었습니다.');
        document.getElementById('heat-edit-overlay').remove();
        // Refresh the current view
        if (state.selectedEventId) await selectEvent(state.selectedEventId);
    } catch (e) {
        alert('저장 실패: ' + (e.error || e.message));
    }
}

// ============================================================
// FIELD ZOOM MODAL — fullscreen popup for PC/tablet viewing
// ============================================================
function openFieldZoomModal() {
    // Determine content source: field-content or height table
    const fieldContent = document.getElementById('field-content');
    if (!fieldContent) { showToast('확대할 내용이 없습니다.', 'info'); return; }

    // Remove old overlay
    let overlay = document.getElementById('field-zoom-overlay');
    if (overlay) overlay.remove();

    const evt = state.selectedEvent;
    const heat = state.heats.find(h => h.id === state.currentHeatId);
    const title = evt ? `${evt.name} ${fmtRound(evt.round_type)} — ${heat ? heatLabel(heat) : ''}` : '확대 보기';

    overlay = document.createElement('div');
    overlay.id = 'field-zoom-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;flex-direction:column;overflow:hidden;';
    overlay.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:#1a1f2b;color:#fff;flex-shrink:0;">
            <h3 style="margin:0;font-size:18px;font-family:var(--font-brand);letter-spacing:1px;">🔍 ${title}</h3>
            <button onclick="closeFieldZoomModal()" style="background:none;border:2px solid rgba(255,255,255,.3);color:#fff;font-size:16px;padding:6px 16px;border-radius:6px;cursor:pointer;font-weight:700;">✕ 닫기</button>
        </div>
        <div id="field-zoom-body" style="flex:1;overflow:auto;padding:16px;background:#fff;"></div>`;

    document.body.appendChild(overlay);

    // Clone the field content into zoom body
    const zoomBody = document.getElementById('field-zoom-body');
    const clone = fieldContent.cloneNode(true);
    clone.id = 'field-zoom-clone';

    // Make the zoomed view bigger and read-only: scale up fonts and table
    clone.style.cssText = 'font-size:16px;';
    // Scale up tables
    clone.querySelectorAll('table').forEach(t => {
        t.style.fontSize = '15px';
        t.style.width = '100%';
    });
    clone.querySelectorAll('th, td').forEach(cell => {
        cell.style.padding = '10px 12px';
    });
    clone.querySelectorAll('input, button, select').forEach(el => {
        el.style.fontSize = '15px';
        el.style.padding = '8px 12px';
    });
    // Make BIB and name cells larger
    clone.querySelectorAll('.bib-cell, .name-cell').forEach(cell => {
        cell.style.fontSize = '16px';
        cell.style.fontWeight = '700';
    });
    // Scale up attempt cells
    clone.querySelectorAll('.attempt-cell, .best-cell').forEach(cell => {
        cell.style.fontSize = '16px';
    });

    zoomBody.appendChild(clone);

    if (window.pushModalState) pushModalState(() => closeFieldZoomModal());
}

function closeFieldZoomModal() {
    const overlay = document.getElementById('field-zoom-overlay');
    if (overlay) overlay.remove();
    if (window.popModalState) popModalState();
}

// (renameHeatPrompt removed — heat renaming is now in admin.html event management tab)
