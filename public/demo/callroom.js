/**
 * PACE RISE : SCOPE — callroom.js v5
 * Dashboard-style: left panel (gender tabs fixed + event matrix scrollable)
 * Right panel: inline detail (not overlay)
 */

let allEvents = [];
let currentGender = 'M';
let crSelectedEvent = null;
let crSelectedEventId = null;
let crSelectedHeatId = null;
let crEntries = [];

document.addEventListener('DOMContentLoaded', async () => {
    renderPageNav('callroom');
    allEvents = await API.getAllEvents();
    setupGenderTabs();
    renderMatrix();
    renderAuditLog();

    // If event_id in URL, auto-select
    const urlEventId = getParam('event_id');
    if (urlEventId) {
        const evt = allEvents.find(e => e.id === +urlEventId);
        if (evt) {
            currentGender = evt.gender;
            document.querySelectorAll('.gender-tab').forEach(b =>
                b.classList.toggle('active', b.dataset.gender === currentGender));
            renderMatrix();
            await selectCallroomEvent(evt.id);
        }
    }
});

// ============================================================
// Gender Tabs
// ============================================================
function setupGenderTabs() {
    document.querySelectorAll('.gender-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.gender-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentGender = btn.dataset.gender;
            renderMatrix();
            crSelectedEventId = null;
            showCallroomPlaceholder();
        });
    });
}

// ============================================================
// Matrix (Left Panel — uses "예선 명단", "준결승 명단" labels)
// ============================================================
function renderMatrix() {
    const container = document.getElementById('callroom-matrix-container');
    const events = allEvents.filter(e => e.gender === currentGender && !e.parent_event_id);

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
                <td class="round-cell">${renderCallroomBtn(prelim, '명단')}</td>
                <td class="round-cell">${renderCallroomBtn(semi, '명단')}</td>
                <td class="round-cell">${renderCallroomBtn(fin, '명단')}</td>
            </tr>`;
        });

        html += `</tbody></table></div>`;
    });

    if (!html) html = '<div class="empty-state">해당 성별의 종목이 없습니다.</div>';
    container.innerHTML = html;
}

function renderCallroomBtn(evt, suffix) {
    if (!evt) return '<span class="round-btn status-none rec-round-btn">—</span>';
    const cls = getRoundStatusClass(evt);
    const activeClass = (evt.id === crSelectedEventId) ? ' rec-btn-active' : '';
    const roundLabel = fmtRound(evt.round_type);
    // Show '완' badge if event is completed (all records done)
    if (evt.round_status === 'completed') {
        return `<a class="round-btn status-done${activeClass} rec-round-btn" href="javascript:void(0)"
            data-event-id="${evt.id}" onclick="selectCallroomEventSafe(${evt.id})"
            title="${roundLabel} 경기완료">완</a>`;
    }
    return `<a class="round-btn ${cls}${activeClass} rec-round-btn" href="javascript:void(0)"
        data-event-id="${evt.id}" onclick="selectCallroomEventSafe(${evt.id})"
        title="${roundLabel} ${suffix}">${roundLabel} ${suffix}</a>`;
}

function getRoundStatusClass(evt) {
    if (!evt) return 'status-none';
    const st = evt.round_status;
    if (st === 'completed') return 'status-done';
    if (st === 'heats_generated' || st === 'in_progress') return 'status-active';
    return 'status-created';
}

function highlightCallroomSelected() {
    document.querySelectorAll('.rec-round-btn[data-event-id]').forEach(b => {
        b.classList.toggle('rec-btn-active', +b.dataset.eventId === crSelectedEventId);
    });
}

function selectCallroomEventSafe(eventId) {
    selectCallroomEvent(eventId);
}

// ============================================================
// Show placeholder
// ============================================================
function showCallroomPlaceholder() {
    document.getElementById('callroom-detail').innerHTML = `
        <div class="detail-placeholder">
            <div class="placeholder-icon">📋</div>
            <p>왼쪽에서 종목을 선택하세요</p>
        </div>`;
}

// ============================================================
// Select Event → load into right panel (inline, not overlay)
// ============================================================
async function selectCallroomEvent(eventId) {
    const detail = document.getElementById('callroom-detail');

    // Show loading
    detail.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div><p>소집 데이터 불러오는 중...</p></div>`;

    const evt = allEvents.find(e => e.id === eventId);
    if (!evt) { showCallroomPlaceholder(); return; }

    crSelectedEvent = evt;
    crSelectedEventId = eventId;
    highlightCallroomSelected();
    setParams({ event_id: eventId });

    const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
    const roundLabel = fmtRound(evt.round_type);

    // Get heats for this event
    const heats = await API.getHeats(eventId);

    let heatTabsHtml = '';
    if (heats.length > 1) {
        heatTabsHtml = `<div class="heat-tabs" style="margin-bottom:10px;">
            ${heats.map((h, i) =>
                `<button class="heat-tab ${i === 0 ? 'active' : ''}" onclick="switchCallroomHeat(${h.id}, this)">${h.heat_number}조</button>`
            ).join('')}
        </div>`;
    }

    detail.innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${roundLabel} ${gL} 명단</span></h3>
            <span class="context-badge">${gL}</span>
        </div>
        ${heats.length === 0 ? '<div class="empty-state">조 편성이 없습니다.</div>' : `
            ${heatTabsHtml}
            <div id="callroom-heat-content"></div>
            <div style="margin-top:12px;display:flex;gap:8px;">
                <button class="btn btn-primary" onclick="completeCallroom()">소집 완료</button>
            </div>
        `}`;

    if (heats.length > 0) {
        crSelectedHeatId = heats[0].id;
        await loadCallroomHeatData();
    }
}

async function switchCallroomHeat(heatId, btn) {
    crSelectedHeatId = heatId;
    document.querySelectorAll('#callroom-detail .heat-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    await loadCallroomHeatData();
}

async function loadCallroomHeatData() {
    if (!crSelectedHeatId || !crSelectedEvent) return;

    crEntries = await API.getHeatEntries(crSelectedHeatId);
    const entries = crEntries;
    const total = entries.length;
    const cIn = entries.filter(e => e.status === 'checked_in').length;
    const nS = entries.filter(e => e.status === 'no_show').length;
    const pend = entries.filter(e => e.status === 'registered').length;
    const pctDone = total > 0 ? Math.round((cIn / total) * 100) : 0;

    const heatContent = document.getElementById('callroom-heat-content');
    heatContent.innerHTML = `
        <div class="barcode-section">
            <div class="barcode-input-area">
                <input type="text" id="barcode-input" placeholder="바코드 스캔 또는 배번 입력" autocomplete="off">
                <button class="btn btn-primary" id="barcode-scan-btn">조회</button>
            </div>
            <div id="barcode-banner" class="barcode-banner" style="display:none;"></div>
        </div>

        <div class="callroom-stats">
            <div class="stat-card" style="border-top-color:var(--text)"><div class="stat-number">${total}</div><div class="stat-label">전체</div></div>
            <div class="stat-card" style="border-top-color:var(--green)"><div class="stat-number" style="color:var(--green)">${cIn}</div><div class="stat-label">출석</div></div>
            <div class="stat-card" style="border-top-color:var(--danger)"><div class="stat-number" style="color:var(--danger)">${nS}</div><div class="stat-label">결석</div></div>
            <div class="stat-card" style="border-top-color:var(--warning)"><div class="stat-number" style="color:var(--warning)">${pend}</div><div class="stat-label">미확인</div></div>
        </div>

        <div class="cr-progress-bar">
            <div class="cr-progress-fill" style="width:${pctDone}%"></div>
        </div>
        <div class="cr-progress-label">${pctDone}% 출석완료</div>

        <table class="data-table">
            <thead><tr><th>BIB</th><th>선수명</th><th>소속</th><th>상태</th><th>ACTION</th></tr></thead>
            <tbody>
                ${entries.map(e => `<tr class="${e.status === 'checked_in' ? 'row-checked-in' : e.status === 'no_show' ? 'row-no-show' : ''}">
                    <td><strong>${e.bib_number}</strong></td>
                    <td style="text-align:left;">${e.name}</td>
                    <td style="font-size:12px;text-align:left;">${e.team || ''}</td>
                    <td><span class="status-badge status-${e.status}">${fmtSt(e.status)}</span></td>
                    <td>
                        <button class="btn btn-sm btn-primary" onclick="setEntryStatus(${e.event_entry_id},'checked_in')" ${e.status === 'checked_in' ? 'disabled' : ''}>출석</button>
                        <button class="btn btn-sm btn-ghost" onclick="setEntryStatus(${e.event_entry_id},'no_show')" ${e.status === 'no_show' ? 'disabled' : ''}>결석</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;

    // Setup barcode handlers
    const inp = document.getElementById('barcode-input');
    const btn = document.getElementById('barcode-scan-btn');
    if (inp && btn) {
        const doScan = async () => {
            const v = inp.value.trim();
            if (!v) return;
            await processBarcodeOrBib(v);
            inp.value = '';
            inp.focus();
        };
        btn.addEventListener('click', doScan);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
        setTimeout(() => inp.focus(), 100);
    }
}

// ============================================================
// Actions — scroll position preserved
// ============================================================
async function setEntryStatus(id, st) {
    // Save scroll position before update
    const heatContent = document.getElementById('callroom-heat-content');
    const scrollTop = heatContent ? heatContent.scrollTop : 0;
    const detailPanel = document.getElementById('callroom-detail');
    const detailScroll = detailPanel ? detailPanel.scrollTop : 0;

    await API.updateEntryStatus(id, st);
    await loadCallroomHeatData();

    // Restore scroll position (prevent jump to top)
    if (heatContent) heatContent.scrollTop = scrollTop;
    if (detailPanel) detailPanel.scrollTop = detailScroll;

    renderAuditLog();
}

async function processBarcodeOrBib(input) {
    const banner = document.getElementById('barcode-banner');
    try {
        let bc = input;
        if (/^\d+$/.test(input) && !input.startsWith('PR')) bc = `PR2026${input}`;
        const res = await API.checkinBarcode(bc, crSelectedEvent.id);
        if (res.already) showBanner(banner, 'already', `${res.athlete.bib_number}번 ${res.athlete.name} — 이미 출석`);
        else showBanner(banner, 'success', `${res.athlete.bib_number}번 ${res.athlete.name} — 출석 완료`);
        await loadCallroomHeatData();
        renderAuditLog();
    } catch (err) {
        showBanner(banner, 'error', `"${input}" — ${err.error || '조회 실패'}`);
    }
}

// ============================================================
// Callroom Complete
// ============================================================
async function completeCallroom() {
    const judgeName = prompt('소집을 완료합니다.\n담당자 이름을 입력하세요:');
    if (!judgeName || !judgeName.trim()) return;

    try {
        await API.completeCallroom(crSelectedEventId, judgeName.trim());
        alert(`소집 완료 처리됨 (담당: ${judgeName.trim()})`);
        allEvents = await API.getAllEvents();
        renderMatrix();
        // Refresh detail to show completion badge
        if (crSelectedEventId) await selectCallroomEvent(crSelectedEventId);
        renderAuditLog();
    } catch (e) { alert('소집 완료 실패: ' + (e.error || '')); }
}

// ============================================================
// SSE Real-time Updates
// ============================================================
onSSE('entry_status', async (data) => {
    // If we're viewing the affected event, reload heat data
    if (crSelectedHeatId) {
        const entry = crEntries.find(e => e.event_entry_id === data.event_entry_id);
        if (entry) await loadCallroomHeatData();
    }
});

onSSE('callroom_complete', async (data) => {
    // Refresh events to show completion on matrix
    allEvents = await API.getAllEvents();
    renderMatrix();
});

onSSE('event_completed', async (data) => {
    // Refresh events to show '완' mark on completed events
    allEvents = await API.getAllEvents();
    renderMatrix();
});
