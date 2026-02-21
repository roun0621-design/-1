/**
 * PACE RISE : SCOPE — record.js v2
 * Dashboard-style Record Entry: event matrix + inline editing
 */

// ============================================================
// State
// ============================================================
const state = {
    events: [], currentGender: 'M',
    selectedEventId: null, selectedEvent: null,
    heats: [], heatId: null, heatEntries: [], results: [], heightAttempts: [],
    currentBarHeight: 2.10, fieldMode: 'input',
    _pendingInlineTrack: {},
    _activeFieldCell: null,   // { entryId, attempt } for inline field editing
    // Combined
    combinedEntries: [], combinedScores: [], combinedSubEvents: [],
};

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    renderPageNav('record');
    state.events = await API.getAllEvents();
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
});

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
        { key: 'track', label: 'TRACK' },
        { key: 'field_distance', label: 'FIELD — 거리' },
        { key: 'field_height', label: 'FIELD — 높이' },
        { key: 'combined', label: 'COMBINED' },
    ];

    const eventGroups = {};
    events.forEach(e => {
        const gKey = e.name + '|' + e.category;
        if (!eventGroups[gKey]) eventGroups[gKey] = { name: e.name, category: e.category, rounds: [] };
        eventGroups[gKey].rounds.push(e);
    });

    let html = '';
    categories.forEach(cat => {
        const groups = Object.values(eventGroups).filter(g => g.category === cat.key);
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
    if (st === 'heats_generated' || st === 'in_progress') return 'status-active';
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
    clearUnsaved();
    await renderDetail();
}

// ============================================================
// Detail Panel
// ============================================================
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

    if (cat === 'track') await renderTrackDetail(evt);
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
    const placeholder = isLong ? '0:00.00' : '00.00';
    const hintText = isLong
        ? 'M:SS.xx 형식 (예: 3:52.45). Enter=저장, Tab=다음'
        : 'SS.xx 형식 (예: 10.23). Enter=저장, Tab=다음';

    // Parent link for combined sub-events
    let parentLink = '';
    if (evt.parent_event_id) {
        const pe = state.events.find(e => e.id === evt.parent_event_id);
        parentLink = `<div class="parent-link-bar">
            <span class="sub-event-tag">혼성 세부종목</span>
            <a href="/demo/record.html?event_id=${evt.parent_event_id}" class="btn btn-sm btn-outline">← ${pe ? pe.name : '혼성'} 현황</a>
        </div>`;
    }

    let heatTabs = state.heats.map((h, i) =>
        `<button class="heat-tab ${i === 0 ? 'active' : ''}" data-heat-id="${h.id}" onclick="switchTrackHeat(${h.id}, this)">Heat ${h.heat_number}</button>`
    ).join('');

    detail.innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
            <span class="context-badge">${evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성'}</span>
        </div>
        ${parentLink}
        <div class="track-hint">${hintText}</div>
        <div class="heat-tabs">${heatTabs}</div>
        <div id="track-content"></div>
        <div class="track-actions">
            <button class="btn btn-outline" id="track-save-all-btn" onclick="saveAllTrackInline()">전체 저장</button>
            ${evt.round_type === 'preliminary' ? `
                <button class="btn btn-accent" onclick="openSemifinalQualification()">준결승 진출자 선택</button>
                <button class="btn btn-accent" onclick="openTrackQualification()">결승 진출자 선택</button>
            ` : evt.round_type === 'semifinal' ? `
                <button class="btn btn-accent" onclick="openTrackQualification()">결승 진출자 선택</button>
            ` : ''}
            <button class="btn btn-danger" onclick="completeRound()">경기 완료</button>
        </div>
        <div id="track-qual-section" class="qual-panel" style="display:none;">
            <div class="qual-panel-header">
                <h3 id="qual-panel-title">결승 진출자 선택</h3>
                <button class="btn btn-sm btn-ghost" onclick="document.getElementById('track-qual-section').style.display='none'">닫기</button>
            </div>
            <p class="qual-desc">체크한 선수가 진출합니다.</p>
            <div id="track-qual-list"></div>
            <div id="semi-group-section" style="display:none;">
                <div style="margin:10px 0;display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:700;">조 수:</label>
                    <input type="number" id="semi-group-count" value="2" min="1" max="8" style="width:60px;padding:4px 8px;border:1.5px solid var(--gray);border-radius:4px;font-size:13px;">
                </div>
            </div>
            <div class="qual-actions" id="qual-actions-area">
                <button class="btn btn-accent" onclick="approveQualification()">결승 확정 및 생성</button>
            </div>
        </div>`;

    if (state.heats.length > 0) {
        state.heatId = state.heats[0].id;
        await loadTrackHeatData();
    }
}

async function switchTrackHeat(heatId, btn) {
    checkUnsavedBeforeAction(async () => {
        state.heatId = heatId;
        document.querySelectorAll('.heat-tab').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        await loadTrackHeatData();
    });
}

async function loadTrackHeatData() {
    state.heatEntries = await API.getHeatEntriesCheckedIn(state.heatId);
    state.results = await API.getResults(state.heatId);
    state._pendingInlineTrack = {};
    clearUnsaved();
    renderTrackTable();
}

function renderTrackTable() {
    if (state.heatEntries.length === 0) {
        document.getElementById('track-content').innerHTML = `
            <div class="empty-state" style="padding:30px 0;">
                <div style="font-size:24px;margin-bottom:8px;">🚫</div>
                <p style="font-weight:600;">소집이 완료된 선수가 없습니다</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">소집실에서 선수 출석 처리를 먼저 진행하세요</p>
                <a href="/demo/callroom.html?event_id=${state.selectedEventId}" class="btn btn-sm btn-primary" style="margin-top:12px;">소집실로 이동</a>
            </div>`;
        return;
    }
    const rows = state.heatEntries.map(e => {
        const r = state.results.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null };
    });

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

    const isLong = isLongTimeEvent(state.selectedEvent?.name);
    const placeholder = isLong ? '0:00.00' : '00.00';

    document.getElementById('track-content').innerHTML = `
        <table class="data-table">
            <thead><tr>
                <th style="width:50px;">RANK</th><th style="width:50px;">LANE</th>
                <th style="width:60px;">BIB</th><th>선수명</th><th>소속</th>
                <th style="width:140px;">기록</th>
            </tr></thead>
            <tbody>${rows.map((r, idx) => {
                const currentVal = r.time_seconds != null ? formatTime(r.time_seconds) : '';
                const pendingVal = state._pendingInlineTrack[r.event_entry_id];
                const displayVal = pendingVal !== undefined ? pendingVal : currentVal;
                const savedClass = (r.time_seconds != null && pendingVal === undefined) ? 'has-value' : '';
                return `<tr>
                    <td>${r.rank || '<span class="no-rank">—</span>'}</td>
                    <td>${r.lane_number || '—'}</td>
                    <td><strong>${r.bib_number}</strong></td>
                    <td style="text-align:left;">${r.name}</td>
                    <td style="font-size:12px;text-align:left;">${r.team || ''}</td>
                    <td><input class="track-time-input ${savedClass}" data-eid="${r.event_entry_id}" data-row="${idx}"
                        value="${displayVal}" placeholder="${placeholder}"
                        onkeydown="trackInlineKeydown(event,this)" oninput="trackInlineInput(this)" onfocus="this.select()"></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
}

function trackInlineInput(inp) {
    const eid = +inp.dataset.eid;
    const existing = state.results.find(r => r.event_entry_id === eid);
    const existingVal = existing ? formatTime(existing.time_seconds) : '';
    if (inp.value.trim() !== existingVal) { state._pendingInlineTrack[eid] = inp.value; markUnsaved(); }
    else { delete state._pendingInlineTrack[eid]; if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved(); }
}

function trackInlineKeydown(e, inp) {
    if (e.key === 'Enter') { e.preventDefault(); saveSingleTrackInline(inp); }
    else if (e.key === 'Escape') {
        e.preventDefault();
        const eid = +inp.dataset.eid;
        const existing = state.results.find(r => r.event_entry_id === eid);
        inp.value = existing ? formatTime(existing.time_seconds) : '';
        delete state._pendingInlineTrack[eid];
        if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
        inp.blur();
    } else if (e.key === 'Tab' || e.key === 'ArrowDown') {
        if (inp.value.trim()) saveSingleTrackInline(inp, false);
    } else if (e.key === 'ArrowUp') {
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
        if (inp.value.trim()) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); }
        return;
    }
    inp.classList.add('saving'); inp.disabled = true;
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: eid, time_seconds: v });
        delete state._pendingInlineTrack[eid];
        if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
        if (doRerender) {
            await loadTrackHeatData();
            const allInputs = document.querySelectorAll('.track-time-input');
            for (const ni of allInputs) { if (!ni.value.trim()) { ni.focus(); break; } }
        }
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) { inp.classList.remove('saving'); inp.disabled = false; inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1500); }
}

async function saveAllTrackInline() {
    const inputs = document.querySelectorAll('.track-time-input');
    for (const inp of inputs) {
        const v = parseTimeInput(inp.value);
        if (v == null || v <= 0) continue;
        const eid = +inp.dataset.eid;
        inp.classList.add('saving'); inp.disabled = true;
        try {
            await API.upsertResult({ heat_id: state.heatId, event_entry_id: eid, time_seconds: v });
            delete state._pendingInlineTrack[eid];
        } catch (err) { inp.classList.remove('saving'); inp.disabled = false; inp.classList.add('error'); }
    }
    if (Object.keys(state._pendingInlineTrack).length === 0) clearUnsaved();
    await loadTrackHeatData();
    if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
    renderAuditLog();
}

// ============================================================
// Track Qualification (moved to bottom — openTrackQualification, openSemifinalQualification)
// ============================================================

async function approveQualification() {
    if (!confirm('결승 진출자를 확정하고 결승 라운드를 생성합니다.\n계속하시겠습니까?')) return;
    const cbs = document.querySelectorAll('#track-qual-list input[type="checkbox"]');
    const selections = Array.from(cbs).map(c => ({ event_entry_id: +c.dataset.entryId, selected: c.checked ? 1 : 0 }));
    try {
        await API.saveQualifications(state.selectedEventId, selections);
        await API.approveQualifications(state.selectedEventId);
        const res = await API.createFinal(state.selectedEventId);
        alert(`결승 생성 완료 (${res.count}명 진출)`);
        state.events = await API.getAllEvents();
        renderMatrix();
    } catch (e) { alert('결승 생성 실패: ' + (e.error || '')); }
    renderAuditLog();
}

// ============================================================
// FIELD DISTANCE DETAIL
// ============================================================
async function renderFieldDistanceDetail(evt) {
    let parentLink = '';
    if (evt.parent_event_id) {
        const pe = state.events.find(e => e.id === evt.parent_event_id);
        parentLink = `<div class="parent-link-bar"><span class="sub-event-tag">혼성 세부종목</span>
            <a href="/demo/record.html?event_id=${evt.parent_event_id}" class="btn btn-sm btn-outline">← ${pe ? pe.name : '혼성'} 현황</a></div>`;
    }

    let heatTabs = state.heats.map((h, i) =>
        `<button class="heat-tab ${i === 0 ? 'active' : ''}" data-heat-id="${h.id}" onclick="switchFieldHeat(${h.id}, this)">Heat ${h.heat_number}</button>`
    ).join('');

    document.getElementById('record-detail').innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
            <div style="display:flex;gap:6px;align-items:center;">
                <span class="context-badge">${evt.gender === 'M' ? '남자' : '여자'}</span>
                <div class="mode-toggle">
                    <button id="mode-input-btn" class="mode-btn active" onclick="setFieldMode('input')">입력</button>
                    <button id="mode-view-btn" class="mode-btn" onclick="setFieldMode('view')">조망</button>
                </div>
            </div>
        </div>
        ${parentLink}
        <div class="heat-tabs">${heatTabs}</div>
        <div id="field-content"></div>`;

    if (state.heats.length > 0) {
        state.heatId = state.heats[0].id;
        await loadFieldDistanceData();
    }
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
    renderFieldDistanceContent();
}

async function loadFieldDistanceData() {
    state.heatEntries = await API.getHeatEntriesCheckedIn(state.heatId);
    state.results = await API.getResults(state.heatId);
    renderFieldDistanceContent();
}

function renderFieldDistanceContent() {
    const entries = state.heatEntries, results = state.results;
    const isView = state.fieldMode === 'view';

    if (entries.length === 0) {
        document.getElementById('field-content').innerHTML = `
            <div class="empty-state" style="padding:30px 0;">
                <div style="font-size:24px;margin-bottom:8px;">🚫</div>
                <p style="font-weight:600;">소집이 완료된 선수가 없습니다</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">소집실에서 선수 출석 처리를 먼저 진행하세요</p>
                <a href="/demo/callroom.html?event_id=${state.selectedEventId}" class="btn btn-sm btn-primary" style="margin-top:12px;">소집실로 이동</a>
            </div>`;
        return;
    }

    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {};
        er.forEach(r => { if (r.attempt_number != null) att[r.attempt_number] = r.distance_meters; });
        const valid = Object.values(att).filter(d => d != null && d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        return { ...e, attempts: att, best };
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
        ? [...rows].sort((a, b) => { if (a.rank != null && b.rank != null) return a.rank - b.rank; if (a.rank != null) return -1; return 1; })
        : [...rows].sort((a, b) => +a.bib_number - +b.bib_number);

    const content = document.getElementById('field-content');
    content.className = isView ? 'view-mode' : '';
    content.innerHTML = `
        <div class="field-two-panel">
            <div class="field-input-panel">
                <table class="data-table field-table" id="field-distance-table">
                    <thead><tr><th>RANK</th><th>NAME / BIB</th>
                        <th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th>
                        <th>BEST</th>
                    </tr></thead>
                    <tbody>${sorted.map((r, rowIdx) => {
                        const cls = top8.has(r.event_entry_id) ? 'top8-highlight' : '';
                        let cells = '';
                        for (let i = 1; i <= 6; i++) {
                            const v = r.attempts[i];
                            const hasVal = v !== undefined && v !== null;
                            const isFoul = hasVal && v === 0;
                            const isActive = state._activeFieldCell 
                                && state._activeFieldCell.entryId === r.event_entry_id 
                                && state._activeFieldCell.attempt === i;
                            if (isActive && !isView) {
                                cells += `<td class="attempt-cell attempt-cell-editing" data-entry="${r.event_entry_id}" data-attempt="${i}">
                                    <input class="field-dist-input" type="text" data-eid="${r.event_entry_id}" data-att="${i}" data-row="${rowIdx}"
                                        value="${hasVal && !isFoul ? v.toFixed(2) : ''}" placeholder="0.00"
                                        onkeydown="fieldInlineKeydown(event,this)" onfocus="this.select()" autofocus>
                                </td>`;
                            } else {
                                let display = '';
                                if (hasVal) display = isFoul ? '<span class="foul-mark">X</span>' : v.toFixed(2);
                                const clickAttr = isView ? '' : `onclick="activateFieldCell(${r.event_entry_id},${i})"`;
                                cells += `<td class="attempt-cell" data-entry="${r.event_entry_id}" data-attempt="${i}" ${clickAttr}>${display}</td>`;
                            }
                        }
                        const best = r.best != null ? `<span class="best-mark">${r.best.toFixed(2)}</span>` : '<span class="no-rank">—</span>';
                        return `<tr class="${cls}">
                            <td>${r.rank != null ? r.rank : '<span class="no-rank">—</span>'}</td>
                            <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${r.bib_number}</span></td>
                            ${cells}<td>${best}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>
            </div>
            <div class="field-ranking-panel">
                <h3>실시간 순위</h3>
                ${ranked.length === 0 ? '<div class="empty-state">기록 없음</div>' :
                    ranked.map(r => `<div class="ranking-item ${top8.has(r.event_entry_id) ? 'top8' : ''}">
                        <span class="ranking-rank">${r.rank}</span>
                        <span class="ranking-name">${r.name} #${r.bib_number}</span>
                        <span class="ranking-best">${r.best.toFixed(2)}m</span>
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
    renderFieldDistanceContent();
}

function deactivateFieldCell() {
    if (!state._activeFieldCell) return;
    state._activeFieldCell = null;
    renderFieldDistanceContent();
}

function setupFieldClickOutside() {
    document.addEventListener('click', (e) => {
        if (!state._activeFieldCell) return;
        // If click is inside the active input or on an attempt cell, ignore
        if (e.target.closest('.field-dist-input') || e.target.closest('.attempt-cell')) return;
        deactivateFieldCell();
    });
}

function fieldInlineKeydown(e, inp) {
    const eid = +inp.dataset.eid;
    const att = +inp.dataset.att;

    if (e.key === 'Enter') {
        e.preventDefault();
        const val = inp.value.trim();
        if (!val) return;
        // Check for foul input: 'f', 'F', 'x', 'X'
        if (/^[fFxX]$/.test(val)) {
            fieldInlineFoul(eid, att);
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
            const dist = parseFloat(val);
            if (!isNaN(dist) && dist >= 0) { saveFieldInline(eid, att, dist); return; }
        }
        advanceFieldCell(eid, att, e.shiftKey);
    }
}

function advanceFieldCell(currentEntryId, currentAttempt, reverse) {
    // Build ordered list of all cells
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
        : [...rows].sort((a, b) => +a.bib_number - +b.bib_number);
}

async function saveFieldInline(entryId, attempt, distance) {
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: distance });
        state.results = await API.getResults(state.heatId);
        state._activeFieldCell = null; // close input after save
        renderFieldDistanceContent();
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) {
        console.error('saveFieldInline error:', err);
        showBanner('저장 실패', 'error');
    }
}

async function fieldInlineFoul(entryId, attempt) {
    try {
        await API.upsertResult({ heat_id: state.heatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: 0 });
        state.results = await API.getResults(state.heatId);
        state._activeFieldCell = null; // close input after save
        renderFieldDistanceContent();
        if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
        renderAuditLog();
    } catch (err) {
        console.error('fieldInlineFoul error:', err);
        showBanner('파울 저장 실패', 'error');
    }
}

// Keep modal setup for backward compat but it's no longer the primary input
let modalState = { eventEntryId: null, entry: null, attempts: {} };
function setupFieldModal() { /* No longer used — inline editing replaces modal */ }

// ============================================================
// FIELD HEIGHT DETAIL
// ============================================================
async function renderFieldHeightDetail(evt) {
    let parentLink = '';
    if (evt.parent_event_id) {
        const pe = state.events.find(e => e.id === evt.parent_event_id);
        parentLink = `<div class="parent-link-bar"><span class="sub-event-tag">혼성 세부종목</span>
            <a href="/demo/record.html?event_id=${evt.parent_event_id}" class="btn btn-sm btn-outline">← ${pe ? pe.name : '혼성'} 현황</a></div>`;
    }

    let heatTabs = state.heats.map((h, i) =>
        `<button class="heat-tab ${i === 0 ? 'active' : ''}" data-heat-id="${h.id}" onclick="switchFieldHeat(${h.id}, this)">Heat ${h.heat_number}</button>`
    ).join('');

    document.getElementById('record-detail').innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
            <span class="context-badge">${evt.gender === 'M' ? '남자' : '여자'}</span>
        </div>
        ${parentLink}
        <div class="heat-tabs">${heatTabs}</div>
        <div class="height-controls">
            <label>바 높이:</label>
            <input type="number" id="height-bar-input" step="0.01" min="0" value="${state.currentBarHeight.toFixed(2)}">
            <button class="btn btn-primary btn-sm" onclick="setBarHeight()">설정</button>
            <button class="btn btn-outline btn-sm" onclick="raiseBar()">+5cm</button>
        </div>
        <div id="height-content"></div>`;

    if (state.heats.length > 0) {
        state.heatId = state.heats[0].id;
        await loadFieldHeightData();
    }
}

function setBarHeight() {
    state.currentBarHeight = parseFloat(document.getElementById('height-bar-input').value) || 2.10;
}

function raiseBar() {
    state.currentBarHeight = Math.round((state.currentBarHeight + 0.05) * 100) / 100;
    const inp = document.getElementById('height-bar-input');
    if (inp) inp.value = state.currentBarHeight.toFixed(2);
}

async function loadFieldHeightData() {
    state.heatEntries = await API.getHeatEntriesCheckedIn(state.heatId);
    state.heightAttempts = await API.getHeightAttempts(state.heatId);
    renderHeightContent();
}

function renderHeightContent() {
    const entries = state.heatEntries, attempts = state.heightAttempts;

    if (entries.length === 0) {
        document.getElementById('height-content').innerHTML = `
            <div class="empty-state" style="padding:30px 0;">
                <div style="font-size:24px;margin-bottom:8px;">🚫</div>
                <p style="font-weight:600;">소집이 완료된 선수가 없습니다</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">소집실에서 선수 출석 처리를 먼저 진행하세요</p>
                <a href="/demo/callroom.html?event_id=${state.selectedEventId}" class="btn btn-sm btn-primary" style="margin-top:12px;">소집실로 이동</a>
            </div>`;
        return;
    }

    const heights = [...new Set(attempts.map(a => a.bar_height))].sort((a, b) => a - b);
    if (heights.length === 0) heights.push(state.currentBarHeight);

    const rows = entries.map(e => {
        const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {};
        ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
        let best = null, elim = false;
        heights.forEach(h => {
            const d = hd[h]; if (!d) return;
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

    let hdr = '<th>RANK</th><th>NAME / BIB</th>';
    heights.forEach(h => { hdr += `<th style="font-size:10px;">${h.toFixed(2)}m</th>`; });
    hdr += '<th>최고</th><th>상태</th><th class="action-col">ACTION</th>';

    document.getElementById('height-content').innerHTML = `
        <table class="data-table field-table">
            <thead><tr>${hdr}</tr></thead>
            <tbody>${rows.map(r => {
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
            }).join('')}</tbody>
        </table>`;
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
    document.getElementById('hmodal-athlete-info').textContent = `${entry.name}  #${entry.bib_number}`;
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
// COMBINED DETAIL
// ============================================================
// ============================================================
// Combined Spreadsheet State
// ============================================================
let _combinedActiveTab = 0; // sub-event order currently selected (0 = standings overview)
// Sub-event inline recording state (separate from main state to avoid conflicts)
let _subState = {
    subEvent: null, subHeats: [], subHeatId: null, subHeatEntries: [],
    subResults: [], subHeightAttempts: [], subBarHeight: 1.90,
    subFieldMode: 'input', _subActiveFieldCell: null, _subPendingTrack: {},
};

async function renderCombinedDetail(evt) {
    state.combinedEntries = await API.getEventEntries(evt.id);
    state.combinedSubEvents = await API.getCombinedSubEvents(evt.id);
    await API.syncCombinedScores(evt.id);
    state.combinedScores = await API.getCombinedScores(evt.id);

    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;

    // Recalc WA points
    for (const sc of state.combinedScores) {
        if (sc.raw_record > 0) {
            const def = subDefs.find(d => d.order === sc.sub_event_order);
            if (def) {
                const pts = calcWAPoints(def.key, sc.raw_record);
                if (pts !== sc.wa_points) {
                    await API.saveCombinedScore({ event_entry_id: sc.event_entry_id, sub_event_name: sc.sub_event_name, sub_event_order: sc.sub_event_order, raw_record: sc.raw_record, wa_points: pts });
                }
            }
        }
    }
    state.combinedScores = await API.getCombinedScores(evt.id);

    const detail = document.getElementById('record-detail');

    // Build sub-event tab buttons with Day 1 / Day 2 split
    const day1Max = evt.gender === 'M' ? 5 : 4;
    let subTabsHtml = '';
    subDefs.forEach((se, idx) => {
        if (se.order === 1) subTabsHtml += '<span class="combined-day-label">DAY 1</span>';
        if (se.order === day1Max + 1) subTabsHtml += '<span class="combined-day-label">DAY 2</span>';
        const hasData = state.combinedScores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
        const activeCls = _combinedActiveTab === se.order ? 'active' : '';
        const completedCls = hasData ? 'tab-completed' : '';
        subTabsHtml += `<button class="combined-tab-btn ${activeCls} ${completedCls}" onclick="switchCombinedTab(${se.order})">
            <span class="combined-tab-order">${se.order}</span> ${se.name}${hasData ? ' ✓' : ''}
        </button>`;
    });

    const overviewActive = _combinedActiveTab === 0 ? 'active' : '';

    detail.innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${fmtRound(evt.round_type)}</span></h3>
            <span class="context-badge">${evt.gender === 'M' ? '남자' : '여자'}</span>
        </div>
        <div class="combined-spreadsheet">
            <div class="combined-tab-bar">
                <button class="combined-tab-btn combined-tab-overview ${overviewActive}" onclick="switchCombinedTab(0)">종합 순위</button>
                ${subTabsHtml}
            </div>
            <div id="combined-tab-content"></div>
        </div>`;

    await renderCombinedTabContent();
}

async function switchCombinedTab(order) {
    _combinedActiveTab = order;
    // Update tab active state
    document.querySelectorAll('.combined-tab-btn').forEach(b => b.classList.remove('active'));
    const tabs = document.querySelectorAll('.combined-tab-btn');
    if (order === 0) tabs[0]?.classList.add('active');
    else {
        const subDefs = state.selectedEvent.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
        const idx = subDefs.findIndex(se => se.order === order);
        if (idx >= 0 && tabs[idx + 1]) tabs[idx + 1].classList.add('active');
    }
    await renderCombinedTabContent();
}

async function renderCombinedTabContent() {
    const container = document.getElementById('combined-tab-content');
    if (!container) return;

    // Show inline loading
    container.innerHTML = `<div class="loading-inline"><div class="loading-spinner"></div> 데이터 불러오는 중...</div>`;

    if (_combinedActiveTab === 0) {
        // Refresh scores for overview
        await API.syncCombinedScores(state.selectedEvent.id);
        state.combinedScores = await API.getCombinedScores(state.selectedEvent.id);
        renderCombinedOverview(container);
    } else {
        await renderCombinedSubEventInline(container, _combinedActiveTab);
    }
}

function renderCombinedOverview(container) {
    const evt = state.selectedEvent;
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;

    const headerCols = subDefs.map(se => {
        const hasData = state.combinedScores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
        return `<th class="combined-overview-th ${hasData ? 'th-completed' : ''}" title="${se.name}">${se.name}</th>`;
    }).join('');

    const rows = state.combinedEntries.map(e => {
        let total = 0;
        const pts = {}, recs = {};
        subDefs.forEach(se => {
            const sc = state.combinedScores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
            const p = sc ? sc.wa_points : 0;
            const rec = sc ? sc.raw_record : null;
            pts[se.order] = p; recs[se.order] = rec; total += p;
        });
        return { ...e, pts, recs, total };
    }).sort((a, b) => b.total - a.total);

    let rk = 1;
    rows.forEach((r, i) => { r.rank = (i > 0 && rows[i - 1].total === r.total) ? rows[i - 1].rank : rk; rk = i + 2; });

    const bodyHtml = rows.map(r => {
        let cells = '';
        subDefs.forEach(se => {
            const rec = r.recs[se.order], p = r.pts[se.order];
            let d = '<span class="combined-cell-empty">—</span>';
            if (rec && rec > 0) {
                const rs = se.unit === 's' ? formatTime(rec) : rec.toFixed(2) + 'm';
                d = `<div class="combined-cell-record">${rs}</div><div class="combined-cell-points">${p}</div>`;
            }
            cells += `<td class="combined-cell" onclick="switchCombinedTab(${se.order})">${d}</td>`;
        });
        return `<tr>
            <td class="combined-rank-cell"><strong>${r.rank}</strong></td>
            <td>${r.bib_number}</td>
            <td style="text-align:left;font-weight:600;">${r.name}</td>
            ${cells}
            <td><span class="combined-total-points">${r.total > 0 ? r.total : '—'}</span></td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="combined-overview-wrap">
            <div style="overflow-x:auto;">
                <table class="data-table combined-overview-table">
                    <thead><tr>
                        <th style="width:50px;">RANK</th><th style="width:50px;">BIB</th><th style="width:100px;">선수명</th>
                        ${headerCols}
                        <th style="width:70px;">총점</th>
                    </tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
        </div>`;
}

// ============================================================
// Combined Sub-Event: INLINE FULL RECORDING
// Renders the actual track/field/height UI inside the combined tab
// ============================================================
async function renderCombinedSubEventInline(container, subOrder) {
    const evt = state.selectedEvent;
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    const seDef = subDefs.find(se => se.order === subOrder);
    if (!seDef) { container.innerHTML = '<div class="empty-state">종목 없음</div>'; return; }

    // Find the actual DB sub-event
    const dbSub = state.combinedSubEvents[subOrder - 1];
    if (!dbSub) { container.innerHTML = '<div class="empty-state">세부 종목 DB 데이터 없음</div>'; return; }

    _subState.subEvent = await API.getEvent(dbSub.id);
    _subState.subHeats = await API.getHeats(dbSub.id);
    _subState._subPendingTrack = {};
    _subState._subActiveFieldCell = null;
    clearUnsaved();

    // Nav buttons
    const prevOrder = subOrder > 1 ? subOrder - 1 : null;
    const nextOrder = subOrder < subDefs.length ? subOrder + 1 : null;
    const catLabel = { track: 'TRACK', field_distance: 'FIELD 거리', field_height: 'FIELD 높이' }[dbSub.category] || '';

    // WA point summary for this sub-event
    const waInfo = buildSubEventWASummary(subOrder);

    container.innerHTML = `
        <div class="combined-sub-header">
            <div class="combined-sub-nav">
                ${prevOrder ? `<button class="btn btn-sm btn-outline" onclick="switchCombinedTab(${prevOrder})">← ${subDefs[prevOrder - 1].name}</button>` : '<span></span>'}
                <h3>${subOrder}. ${seDef.name} <span class="combined-sub-unit combined-cat-badge">${catLabel}</span></h3>
                ${nextOrder ? `<button class="btn btn-sm btn-outline" onclick="switchCombinedTab(${nextOrder})">${subDefs[nextOrder - 1].name} →</button>` : '<span></span>'}
            </div>
            <div class="combined-sub-hint">실제 기록을 입력하면 자동으로 WA 점수가 계산됩니다</div>
        </div>
        <div id="combined-sub-record-area"></div>
        <div id="combined-wa-summary" class="combined-wa-summary">${waInfo}</div>`;

    if (_subState.subHeats.length > 0) {
        _subState.subHeatId = _subState.subHeats[0].id;
        await loadSubEventData(dbSub.category);
    } else {
        document.getElementById('combined-sub-record-area').innerHTML = '<div class="empty-state">해당 세부 종목에 히트가 없습니다.</div>';
    }
}

function buildSubEventWASummary(subOrder) {
    const evt = state.selectedEvent;
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    const seDef = subDefs.find(se => se.order === subOrder);
    if (!seDef) return '';

    const rows = state.combinedEntries.map(e => {
        let cumPrev = 0;
        subDefs.forEach(se => {
            if (se.order < subOrder) {
                const sc = state.combinedScores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
                cumPrev += sc ? (sc.wa_points || 0) : 0;
            }
        });
        const sc = state.combinedScores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === subOrder);
        const waPoints = sc ? sc.wa_points : 0;
        const rawRec = sc ? sc.raw_record : null;
        return { ...e, cumPrev, waPoints, rawRec, cumTotal: cumPrev + waPoints };
    }).sort((a, b) => b.cumTotal - a.cumTotal);

    return `<table class="data-table" style="font-size:12px;margin-bottom:8px;">
        <thead><tr><th>순위</th><th>BIB</th><th>선수명</th><th>최고기록</th><th>WA점수</th><th>이전누적</th><th>현재누적</th></tr></thead>
        <tbody>${rows.map((r, i) => {
            const rec = r.rawRec && r.rawRec > 0 ? (seDef.unit === 's' ? formatTime(r.rawRec) : r.rawRec.toFixed(2) + 'm') : '—';
            return `<tr><td>${i + 1}</td><td>${r.bib_number}</td><td style="text-align:left;">${r.name}</td>
                <td><strong>${rec}</strong></td>
                <td class="combined-wa-cell"><span class="combined-wa-value">${r.waPoints || '—'}</span></td>
                <td>${r.cumPrev || '—'}</td>
                <td><strong>${r.cumTotal || '—'}</strong></td></tr>`;
        }).join('')}</tbody>
    </table>`;
}

async function loadSubEventData(category) {
    _subState.subHeatEntries = await API.getHeatEntriesCheckedIn(_subState.subHeatId);
    if (category === 'track') {
        _subState.subResults = await API.getResults(_subState.subHeatId);
        _subState._subPendingTrack = {};
        renderSubTrackTable();
    } else if (category === 'field_distance') {
        _subState.subResults = await API.getResults(_subState.subHeatId);
        _subState._subActiveFieldCell = null;
        renderSubFieldDistanceTable();
    } else if (category === 'field_height') {
        _subState.subHeightAttempts = await API.getHeightAttempts(_subState.subHeatId);
        renderSubHeightTable();
    }
}

// ---- Sub-event TRACK inline recording ----
function renderSubTrackTable() {
    const area = document.getElementById('combined-sub-record-area');
    const evtName = _subState.subEvent?.name || '';
    const isLong = isLongTimeEvent(evtName);
    const placeholder = isLong ? '0:00.00' : '00.00';
    const hintText = isLong ? 'M:SS.xx 형식 (예: 3:52.45). Enter=저장, Tab=다음' : 'SS.xx 형식 (예: 10.23). Enter=저장, Tab=다음';

    const rows = _subState.subHeatEntries.map(e => {
        const r = _subState.subResults.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null };
    });
    rows.sort((a, b) => {
        if (a.time_seconds == null && b.time_seconds == null) return (a.lane_number || 99) - (b.lane_number || 99);
        if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    let rk = 1;
    rows.forEach((r, i) => {
        if (r.time_seconds == null) r.rank = '';
        else { r.rank = (i > 0 && rows[i - 1].time_seconds === r.time_seconds) ? rows[i - 1].rank : rk; rk = i + 2; }
    });

    area.innerHTML = `
        <div class="track-hint">${hintText}</div>
        <table class="data-table">
            <thead><tr>
                <th style="width:50px;">RANK</th><th style="width:50px;">LANE</th>
                <th style="width:60px;">BIB</th><th>선수명</th><th>소속</th>
                <th style="width:140px;">기록</th>
            </tr></thead>
            <tbody>${rows.map((r, idx) => {
                const currentVal = r.time_seconds != null ? formatTime(r.time_seconds) : '';
                const pendingVal = _subState._subPendingTrack[r.event_entry_id];
                const displayVal = pendingVal !== undefined ? pendingVal : currentVal;
                const savedClass = (r.time_seconds != null && pendingVal === undefined) ? 'has-value' : '';
                return `<tr>
                    <td>${r.rank || '<span class="no-rank">—</span>'}</td>
                    <td>${r.lane_number || '—'}</td>
                    <td><strong>${r.bib_number}</strong></td>
                    <td style="text-align:left;">${r.name}</td>
                    <td style="font-size:12px;text-align:left;">${r.team || ''}</td>
                    <td><input class="track-time-input sub-track-input ${savedClass}" data-eid="${r.event_entry_id}" data-row="${idx}"
                        value="${displayVal}" placeholder="${placeholder}"
                        onkeydown="subTrackKeydown(event,this)" oninput="subTrackInput(this)" onfocus="this.select()"></td>
                </tr>`;
            }).join('')}</tbody>
        </table>
        <div class="track-actions">
            <button class="btn btn-outline" onclick="saveAllSubTrack()">전체 저장</button>
        </div>`;
}

function subTrackInput(inp) {
    const eid = +inp.dataset.eid;
    const existing = _subState.subResults.find(r => r.event_entry_id === eid);
    const existingVal = existing ? formatTime(existing.time_seconds) : '';
    if (inp.value.trim() !== existingVal) { _subState._subPendingTrack[eid] = inp.value; markUnsaved(); }
    else { delete _subState._subPendingTrack[eid]; if (Object.keys(_subState._subPendingTrack).length === 0) clearUnsaved(); }
}

function subTrackKeydown(e, inp) {
    if (e.key === 'Enter') { e.preventDefault(); saveSingleSubTrack(inp); }
    else if (e.key === 'Escape') {
        e.preventDefault(); const eid = +inp.dataset.eid;
        const existing = _subState.subResults.find(r => r.event_entry_id === eid);
        inp.value = existing ? formatTime(existing.time_seconds) : '';
        delete _subState._subPendingTrack[eid];
        if (Object.keys(_subState._subPendingTrack).length === 0) clearUnsaved(); inp.blur();
    } else if (e.key === 'Tab' || e.key === 'ArrowDown') {
        if (inp.value.trim()) saveSingleSubTrack(inp, false);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault(); const rowIdx = +inp.dataset.row;
        const prev = document.querySelector(`.sub-track-input[data-row="${rowIdx - 1}"]`);
        if (prev) prev.focus();
    }
}

async function saveSingleSubTrack(inp, doRerender = true) {
    const eid = +inp.dataset.eid;
    const v = parseTimeInput(inp.value);
    if (v == null || v <= 0) {
        if (inp.value.trim()) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); } return;
    }
    inp.classList.add('saving'); inp.disabled = true;
    try {
        await API.upsertResult({ heat_id: _subState.subHeatId, event_entry_id: eid, time_seconds: v });
        delete _subState._subPendingTrack[eid];
        if (Object.keys(_subState._subPendingTrack).length === 0) clearUnsaved();
        // Sync combined scores
        await syncCombinedFromSubEvent(state.selectedEvent.id);
        state.combinedScores = await API.getCombinedScores(state.selectedEvent.id);
        refreshSubWASummary();
        if (doRerender) {
            _subState.subResults = await API.getResults(_subState.subHeatId);
            renderSubTrackTable();
            const allInputs = document.querySelectorAll('.sub-track-input');
            for (const ni of allInputs) { if (!ni.value.trim()) { ni.focus(); break; } }
        }
        renderAuditLog();
    } catch (err) { inp.classList.remove('saving'); inp.disabled = false; inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1500); }
}

async function saveAllSubTrack() {
    const inputs = document.querySelectorAll('.sub-track-input');
    for (const inp of inputs) {
        const v = parseTimeInput(inp.value);
        if (v == null || v <= 0) continue;
        const eid = +inp.dataset.eid;
        inp.classList.add('saving'); inp.disabled = true;
        try {
            await API.upsertResult({ heat_id: _subState.subHeatId, event_entry_id: eid, time_seconds: v });
            delete _subState._subPendingTrack[eid];
        } catch (err) { inp.classList.remove('saving'); inp.disabled = false; inp.classList.add('error'); }
    }
    if (Object.keys(_subState._subPendingTrack).length === 0) clearUnsaved();
    await syncCombinedFromSubEvent(state.selectedEvent.id);
    state.combinedScores = await API.getCombinedScores(state.selectedEvent.id);
    refreshSubWASummary();
    _subState.subResults = await API.getResults(_subState.subHeatId);
    renderSubTrackTable();
    renderAuditLog();
}

// ---- Sub-event FIELD DISTANCE inline recording ----
function renderSubFieldDistanceTable() {
    const area = document.getElementById('combined-sub-record-area');
    const entries = _subState.subHeatEntries, results = _subState.subResults;

    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {};
        er.forEach(r => { if (r.attempt_number != null) att[r.attempt_number] = r.distance_meters; });
        const valid = Object.values(att).filter(d => d != null && d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        return { ...e, attempts: att, best };
    });

    const ranked = rows.filter(r => r.best != null).sort((a, b) => b.best - a.best);
    let cr = 1;
    ranked.forEach((r, i) => { r.rank = (i > 0 && ranked[i - 1].best === r.best) ? ranked[i - 1].rank : cr; cr = i + 2; });
    rows.forEach(r => {
        if (r.best == null) r.rank = null;
        else { const f = ranked.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
    });

    const sorted = [...rows].sort((a, b) => +a.bib_number - +b.bib_number);

    area.innerHTML = `
        <div class="track-hint">셀 클릭 → 기록 입력. X 또는 F = 파울. Enter=저장</div>
        <table class="data-table field-table" id="sub-field-distance-table">
            <thead><tr><th>RANK</th><th>NAME / BIB</th>
                <th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th>
                <th>BEST</th>
            </tr></thead>
            <tbody>${sorted.map((r, rowIdx) => {
                let cells = '';
                for (let i = 1; i <= 6; i++) {
                    const v = r.attempts[i];
                    const hasVal = v !== undefined && v !== null;
                    const isFoul = hasVal && v === 0;
                    const isActive = _subState._subActiveFieldCell
                        && _subState._subActiveFieldCell.entryId === r.event_entry_id
                        && _subState._subActiveFieldCell.attempt === i;
                    if (isActive) {
                        cells += `<td class="attempt-cell attempt-cell-editing" data-entry="${r.event_entry_id}" data-attempt="${i}">
                            <input class="field-dist-input sub-field-input" type="text" data-eid="${r.event_entry_id}" data-att="${i}" data-row="${rowIdx}"
                                value="${hasVal && !isFoul ? v.toFixed(2) : ''}" placeholder="0.00"
                                onkeydown="subFieldKeydown(event,this)" onfocus="this.select()" autofocus>
                        </td>`;
                    } else {
                        let display = '';
                        if (hasVal) display = isFoul ? '<span class="foul-mark">X</span>' : v.toFixed(2);
                        cells += `<td class="attempt-cell" data-entry="${r.event_entry_id}" data-attempt="${i}" onclick="activateSubFieldCell(${r.event_entry_id},${i})">${display}</td>`;
                    }
                }
                const best = r.best != null ? `<span class="best-mark">${r.best.toFixed(2)}</span>` : '<span class="no-rank">—</span>';
                return `<tr>
                    <td>${r.rank != null ? r.rank : '<span class="no-rank">—</span>'}</td>
                    <td style="text-align:left;"><strong>${r.name}</strong> <span style="color:var(--text-muted);font-size:11px;">#${r.bib_number}</span></td>
                    ${cells}<td>${best}</td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;

    const activeInput = area.querySelector('.sub-field-input');
    if (activeInput) setTimeout(() => activeInput.focus(), 30);
}

function activateSubFieldCell(entryId, attempt) {
    _subState._subActiveFieldCell = { entryId, attempt };
    renderSubFieldDistanceTable();
}

function subFieldKeydown(e, inp) {
    const eid = +inp.dataset.eid, att = +inp.dataset.att;
    if (e.key === 'Enter') {
        e.preventDefault(); const val = inp.value.trim(); if (!val) return;
        if (/^[fFxX]$/.test(val)) { saveSubFieldInline(eid, att, 0); return; }
        const dist = parseFloat(val);
        if (isNaN(dist) || dist < 0) { inp.classList.add('error'); setTimeout(() => inp.classList.remove('error'), 1000); return; }
        saveSubFieldInline(eid, att, dist);
    } else if (e.key === 'Escape') { e.preventDefault(); _subState._subActiveFieldCell = null; renderSubFieldDistanceTable(); }
    else if (e.key === 'Tab') {
        e.preventDefault(); const val = inp.value.trim();
        if (val) {
            if (/^[fFxX]$/.test(val)) { saveSubFieldInline(eid, att, 0); return; }
            const dist = parseFloat(val);
            if (!isNaN(dist) && dist >= 0) { saveSubFieldInline(eid, att, dist); return; }
        }
        // Advance to next cell
        const nextAtt = att < 6 ? att + 1 : null;
        if (nextAtt) { _subState._subActiveFieldCell = { entryId: eid, attempt: nextAtt }; }
        else { _subState._subActiveFieldCell = null; }
        renderSubFieldDistanceTable();
    }
}

async function saveSubFieldInline(entryId, attempt, distance) {
    try {
        await API.upsertResult({ heat_id: _subState.subHeatId, event_entry_id: entryId, attempt_number: attempt, distance_meters: distance });
        _subState.subResults = await API.getResults(_subState.subHeatId);
        _subState._subActiveFieldCell = null;
        await syncCombinedFromSubEvent(state.selectedEvent.id);
        state.combinedScores = await API.getCombinedScores(state.selectedEvent.id);
        refreshSubWASummary();
        renderSubFieldDistanceTable();
        renderAuditLog();
    } catch (err) { console.error('saveSubFieldInline error:', err); showBanner(document.createElement('div'), 'error', '저장 실패'); }
}

// ---- Sub-event FIELD HEIGHT inline recording ----
function renderSubHeightTable() {
    const area = document.getElementById('combined-sub-record-area');
    const entries = _subState.subHeatEntries, attempts = _subState.subHeightAttempts;
    const heights = [...new Set(attempts.map(a => a.bar_height))].sort((a, b) => a - b);
    if (heights.length === 0) heights.push(_subState.subBarHeight);

    const rows = entries.map(e => {
        const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {};
        ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
        let best = null, elim = false;
        heights.forEach(h => {
            const d = hd[h]; if (!d) return;
            if (Object.values(d).includes('O')) best = h;
            if (Object.values(d).filter(m => m === 'X').length >= 3) elim = true;
        });
        return { ...e, heightData: hd, bestHeight: best, eliminated: elim };
    });

    const rankedH = rows.filter(r => r.bestHeight != null).sort((a, b) => b.bestHeight - a.bestHeight);
    let rkH = 1;
    rankedH.forEach((r, i) => { r.rank = (i > 0 && rankedH[i - 1].bestHeight === r.bestHeight) ? rankedH[i - 1].rank : rkH; rkH = i + 2; });
    rows.forEach(r => {
        if (r.bestHeight == null) r.rank = null;
        else { const f = rankedH.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
    });

    let hdr = '<th>RANK</th><th>NAME / BIB</th>';
    heights.forEach(h => { hdr += `<th style="font-size:10px;">${h.toFixed(2)}m</th>`; });
    hdr += '<th>최고</th><th>상태</th><th class="action-col">ACTION</th>';

    area.innerHTML = `
        <div class="height-controls">
            <label>바 높이:</label>
            <input type="number" id="sub-height-bar-input" step="0.01" min="0" value="${_subState.subBarHeight.toFixed(2)}">
            <button class="btn btn-primary btn-sm" onclick="setSubBarHeight()">설정</button>
            <button class="btn btn-outline btn-sm" onclick="raiseSubBar()">+5cm</button>
        </div>
        <table class="data-table field-table">
            <thead><tr>${hdr}</tr></thead>
            <tbody>${rows.map(r => {
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
                    <td class="action-col"><button class="btn btn-sm btn-primary" onclick="openSubHeightEntry(${r.event_entry_id})" ${r.eliminated ? 'disabled' : ''}>입력</button></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
}

function setSubBarHeight() {
    _subState.subBarHeight = parseFloat(document.getElementById('sub-height-bar-input').value) || _subState.subBarHeight;
}

function raiseSubBar() {
    _subState.subBarHeight = Math.round((_subState.subBarHeight + 0.05) * 100) / 100;
    const inp = document.getElementById('sub-height-bar-input');
    if (inp) inp.value = _subState.subBarHeight.toFixed(2);
}

function openSubHeightEntry(eid) {
    // Use the main height modal
    heightModalState.eventEntryId = eid;
    const entry = _subState.subHeatEntries.find(e => e.event_entry_id === eid);
    if (!entry) return;
    document.getElementById('hmodal-athlete-info').textContent = `${entry.name}  #${entry.bib_number}`;
    document.getElementById('hmodal-event-info').textContent = `${_subState.subEvent.name} | ${_subState.subBarHeight.toFixed(2)}m`;
    document.getElementById('hmodal-height-input').value = _subState.subBarHeight.toFixed(2);
    const ha = _subState.subHeightAttempts.filter(a => a.event_entry_id === eid && a.bar_height === _subState.subBarHeight);
    let rH = '';
    if (ha.length === 0) rH = '<div style="color:var(--text-muted);">시도 없음</div>';
    else ha.forEach(a => { rH += `<div>${a.attempt_number}차: <span class="height-mark mark-${a.result_mark}">${a.result_mark}</span></div>`; });
    document.getElementById('hmodal-records').innerHTML = rH;
    document.getElementById('hmodal-attempt-select').value = String(ha.length > 0 ? Math.min(ha.length + 1, 3) : 1);
    document.getElementById('hmodal-error').style.display = 'none';

    // Override save behavior for combined sub-event height
    _subHeightOverride = true;
    document.getElementById('height-modal-overlay').style.display = 'flex';
}

// Flag to know if height modal is being used for sub-event
let _subHeightOverride = false;

// Patch setupHeightModal to handle sub-event saves
function setupHeightModal() {
    const ov = document.getElementById('height-modal-overlay');
    if (!ov) return;
    document.getElementById('hmodal-cancel-btn').addEventListener('click', () => { ov.style.display = 'none'; _subHeightOverride = false; });
    ov.addEventListener('click', e => { if (e.target === ov) { ov.style.display = 'none'; _subHeightOverride = false; } });
    document.querySelectorAll('.height-mark-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                const heatId = _subHeightOverride ? _subState.subHeatId : state.heatId;
                const barHeight = _subHeightOverride ? _subState.subBarHeight : state.currentBarHeight;
                await API.saveHeightAttempt({
                    heat_id: heatId, event_entry_id: heightModalState.eventEntryId,
                    bar_height: barHeight,
                    attempt_number: +document.getElementById('hmodal-attempt-select').value,
                    result_mark: btn.dataset.mark
                });
                ov.style.display = 'none';
                if (_subHeightOverride) {
                    _subHeightOverride = false;
                    _subState.subHeightAttempts = await API.getHeightAttempts(_subState.subHeatId);
                    await syncCombinedFromSubEvent(state.selectedEvent.id);
                    state.combinedScores = await API.getCombinedScores(state.selectedEvent.id);
                    refreshSubWASummary();
                    renderSubHeightTable();
                } else {
                    state.heightAttempts = await API.getHeightAttempts(state.heatId);
                    renderHeightContent();
                    if (state.selectedEvent && state.selectedEvent.parent_event_id) await syncCombinedFromSubEvent(state.selectedEvent.parent_event_id);
                }
                renderAuditLog();
            } catch (err) { document.getElementById('hmodal-error').textContent = '저장 실패'; document.getElementById('hmodal-error').style.display = 'block'; }
        });
    });
}

function refreshSubWASummary() {
    const el = document.getElementById('combined-wa-summary');
    if (el) el.innerHTML = buildSubEventWASummary(_combinedActiveTab);
    // Also update tab completed status
    const subDefs = state.selectedEvent.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    const tabs = document.querySelectorAll('.combined-tab-btn');
    subDefs.forEach((se, idx) => {
        const hasData = state.combinedScores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
        if (tabs[idx + 1]) {
            tabs[idx + 1].classList.toggle('tab-completed', hasData);
        }
    });
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
                        await API.saveCombinedScore({ event_entry_id: sc.event_entry_id, sub_event_name: sc.sub_event_name, sub_event_order: sc.sub_event_order, raw_record: sc.raw_record, wa_points: pts });
                    }
                }
            }
        }
    } catch (e) { console.error('sync:', e); }
}

// ============================================================
// ADMIN KEY — edit lock for completed events
// ============================================================
let _adminUnlocked = false;

async function checkAdminBeforeEdit(callback) {
    // If event is completed, require admin key
    if (state.selectedEvent && state.selectedEvent.round_status === 'completed' && !_adminUnlocked) {
        const key = prompt('경기가 완료된 상태입니다. 수정하려면 관리자 키를 입력하세요:');
        if (!key) return;
        try {
            await API.verifyAdmin(key);
            _adminUnlocked = true;
            callback();
        } catch (e) {
            alert('관리자 키가 올바르지 않습니다.');
        }
        return;
    }
    callback();
}

// ============================================================
// SEMIFINAL QUALIFICATION
// ============================================================
function openSemifinalQualification() {
    // Gather all heat results across heats
    _qualMode = 'semifinal';
    document.getElementById('qual-panel-title').textContent = '준결승 진출자 선택';
    document.getElementById('semi-group-section').style.display = 'block';
    document.getElementById('qual-actions-area').innerHTML = `
        <button class="btn btn-accent" onclick="approveSemifinalQualification()">준결승 확정 및 생성</button>`;

    // Show all athletes sorted by time
    renderQualList();
    document.getElementById('track-qual-section').style.display = 'block';
}

function openTrackQualification() {
    _qualMode = 'final';
    document.getElementById('qual-panel-title').textContent = '결승 진출자 선택';
    document.getElementById('semi-group-section').style.display = 'none';
    document.getElementById('qual-actions-area').innerHTML = `
        <button class="btn btn-accent" onclick="approveQualification()">결승 확정 및 생성</button>`;

    renderQualList();
    document.getElementById('track-qual-section').style.display = 'block';
}

let _qualMode = 'final'; // or 'semifinal'

function renderQualList() {
    const rows = state.heatEntries.map(e => {
        const r = state.results.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null };
    }).filter(r => r.time_seconds != null).sort((a, b) => a.time_seconds - b.time_seconds);

    document.getElementById('track-qual-list').innerHTML = rows.map((r, i) => `
        <div class="qual-checkbox-item">
            <input type="checkbox" data-entry-id="${r.event_entry_id}" ${i < 4 ? 'checked' : ''}>
            <span class="qual-rank">${i + 1}</span>
            <span class="qual-name">${r.name} #${r.bib_number}</span>
            <span class="qual-time">${formatTime(r.time_seconds)}</span>
        </div>`).join('');
}

async function approveSemifinalQualification() {
    const groupCount = parseInt(document.getElementById('semi-group-count')?.value) || 2;
    if (!confirm(`준결승 ${groupCount}개 조로 진출자를 확정하고 준결승 라운드를 생성합니다.\n계속하시겠습니까?`)) return;

    const cbs = document.querySelectorAll('#track-qual-list input[type="checkbox"]');
    const selections = Array.from(cbs).map(c => ({ event_entry_id: +c.dataset.entryId, selected: c.checked }));

    try {
        const res = await API.createSemifinal(state.selectedEventId, groupCount, selections);
        alert(`준결승 생성 완료 (${res.count}명, ${res.groups}개 조)`);
        state.events = await API.getAllEvents();
        renderMatrix();
    } catch (e) { alert('준결승 생성 실패: ' + (e.error || '')); }
    renderAuditLog();
}

// ============================================================
// ROUND COMPLETION — with judge name
// ============================================================
async function completeRound() {
    const judgeName = prompt('경기를 완료 처리합니다.\n심판 이름을 입력하세요:');
    if (!judgeName || !judgeName.trim()) return;
    const adminKey = prompt('관리자 키를 입력하세요:');
    if (!adminKey) return;

    try {
        await API.completeEvent(state.selectedEventId, judgeName.trim(), adminKey);
        alert(`경기 완료 처리됨 (심판: ${judgeName.trim()})`);
        state.events = await API.getAllEvents();
        state.selectedEvent = await API.getEvent(state.selectedEventId);
        renderMatrix();
        await renderDetail();
        renderAuditLog();
    } catch (e) { alert('완료 처리 실패: ' + (e.error || '')); }
}

// ============================================================
// 10종 경기 날짜별 분리 (Day 1 / Day 2)
// ============================================================
// Decathlon: Day 1 = events 1-5, Day 2 = events 6-10
// Heptathlon: Day 1 = events 1-4, Day 2 = events 5-7
