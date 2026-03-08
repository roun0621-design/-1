/**
 * PACE RISE : Node — callroom.js v6
 * Improvements: barcode/bib checkin fix, auto heat switch, cancel button,
 * all-heats modal, barcode display, sticky barcode input, relay popup, add athlete
 */

// Helper: display bib_number safely (null/undefined → '—')
function bib(val) { return val != null && val !== '' ? val : '—'; }

let allEvents = [];
let currentGender = 'M';
let crSelectedEvent = null;
let crSelectedEventId = null;
let crSelectedHeatId = null;
let crHeats = [];
let crEntries = [];

document.addEventListener('DOMContentLoaded', async () => {
    if (!(await requireCompetition())) return;
    renderPageNav('callroom');
    await renderCompInfoBar();
    allEvents = await API.getAllEvents(getCompetitionId());
    setupGenderTabs();
    renderMatrix();
    renderAuditLog();

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
// Matrix
// ============================================================
function renderMatrix() {
    const container = document.getElementById('callroom-matrix-container');
    const events = allEvents.filter(e => e.gender === currentGender && !e.parent_event_id);

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
                <thead><tr><th>종목</th><th>예선</th><th>준결승</th><th>결승</th></tr></thead>
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
    if (evt.round_status === 'completed') {
        return `<a class="round-btn status-done${activeClass} rec-round-btn" href="javascript:void(0)"
            data-event-id="${evt.id}" onclick="selectCallroomEventSafe(${evt.id})"
            title="${roundLabel} 경기완료">완</a>`;
    }
    if (evt.round_status === 'in_progress') {
        return `<a class="round-btn status-active${activeClass} rec-round-btn" href="javascript:void(0)"
            data-event-id="${evt.id}" onclick="selectCallroomEventSafe(${evt.id})"
            title="${roundLabel} 소집완료(진행중)">완</a>`;
    }
    return `<a class="round-btn ${cls}${activeClass} rec-round-btn" href="javascript:void(0)"
        data-event-id="${evt.id}" onclick="selectCallroomEventSafe(${evt.id})"
        title="${roundLabel} ${suffix}">${roundLabel} ${suffix}</a>`;
}

function getRoundStatusClass(evt) {
    if (!evt) return 'status-none';
    const st = evt.round_status;
    if (st === 'completed') return 'status-done';
    if (st === 'in_progress') return 'status-active';
    if (st === 'heats_generated') return 'status-ready';
    return 'status-created';
}

function highlightCallroomSelected() {
    document.querySelectorAll('.rec-round-btn[data-event-id]').forEach(b => {
        b.classList.toggle('rec-btn-active', +b.dataset.eventId === crSelectedEventId);
    });
}

function selectCallroomEventSafe(eventId) { selectCallroomEvent(eventId); }

function showCallroomPlaceholder() {
    document.getElementById('callroom-detail').innerHTML = `
        <div class="detail-placeholder">
            <div class="placeholder-icon">📋</div>
            <p>왼쪽에서 종목을 선택하세요</p>
        </div>`;
}

// ============================================================
// Select Event
// ============================================================
async function selectCallroomEvent(eventId) {
    const detail = document.getElementById('callroom-detail');
    detail.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div><p>소집 데이터 불러오는 중...</p></div>`;

    const evt = allEvents.find(e => e.id === eventId);
    if (!evt) { showCallroomPlaceholder(); return; }

    crSelectedEvent = evt;
    crSelectedEventId = eventId;
    highlightCallroomSelected();
    setParams({ event_id: eventId });

    const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
    const roundLabel = fmtRound(evt.round_type);

    // Update page title and header when switching events
    document.title = `PACE RISE — 소집실: ${evt.name} ${roundLabel} ${gL}`;
    const pageTitleH2 = document.querySelector('.page-title-bar h2');
    if (pageTitleH2) {
        pageTitleH2.innerHTML = `소집실 <span class="page-sub">${evt.name} ${roundLabel} ${gL}</span>`;
    }
    const heats = await API.getHeats(eventId);

    let heatTabsHtml = '';
    if (heats.length > 1) {
        heatTabsHtml = `<div class="heat-tabs" style="margin-bottom:10px;">
            ${heats.map((h, i) =>
                `<button class="heat-tab ${i === 0 ? 'active' : ''}" onclick="switchCallroomHeat(${h.id}, this)">${h.heat_number}조</button>`
            ).join('')}
        </div>`;
    }

    // Combined event info
    let combinedInfoHtml = '';
    if (evt.category === 'combined') {
        try {
            const subEvents = await API.getCombinedSubEvents(evt.id);
            if (subEvents.length > 0) {
                const day1Max = evt.gender === 'M' ? 5 : 4;
                combinedInfoHtml = `<div style="margin-bottom:12px;padding:10px;background:var(--bg);border-radius:var(--radius);font-size:12px;">
                    <strong>${evt.gender === 'M' ? '10종경기' : '7종경기'} 세부 종목</strong>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
                        <span style="font-size:11px;font-weight:700;color:#1565c0;margin-right:4px;">Day1:</span>
                        ${subEvents.filter((s,i) => i < day1Max).map(s => `<span style="background:#e3f2fd;color:#1565c0;padding:2px 8px;border-radius:10px;font-size:11px;">${s.name.replace(/\[.*?\]\s*/, '')}</span>`).join('')}
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
                        <span style="font-size:11px;font-weight:700;color:#c62828;margin-right:4px;">Day2:</span>
                        ${subEvents.filter((s,i) => i >= day1Max).map(s => `<span style="background:#fce4ec;color:#c62828;padding:2px 8px;border-radius:10px;font-size:11px;">${s.name.replace(/\[.*?\]\s*/, '')}</span>`).join('')}
                    </div>
                </div>`;
            }
        } catch(e) {}
    }

    detail.innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${roundLabel} ${gL} 명단</span></h3>
            <span class="context-badge">${gL}</span>
        </div>
        ${combinedInfoHtml}
        <!-- Sticky barcode input -->
        <div class="barcode-section" style="position:sticky;top:0;z-index:10;background:var(--white);padding:8px 0;border-bottom:1px solid var(--border);">
            <div class="barcode-input-area">
                <input type="text" id="barcode-input" placeholder="바코드 스캔 또는 배번 입력" autocomplete="off">
                <button class="btn btn-primary" id="barcode-scan-btn" title="입력한 바코드/배번으로 선수를 조회하여 출석 처리합니다">조회</button>
            </div>
            <div id="barcode-banner" class="barcode-banner" style="display:none;"></div>
        </div>
        ${heats.length === 0 ? '<div class="empty-state">조 편성이 없습니다.</div>' : `
            ${heatTabsHtml}
            <div id="callroom-heat-content"></div>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-primary" onclick="completeCallroom()" title="현재 종목의 소집을 완료하고 경기 진행 상태로 전환합니다">소집 완료</button>
                <button class="btn btn-outline" onclick="showAllHeatsModal()" title="모든 조의 선수 현황을 한 화면에서 확인합니다">전체 현황 보기</button>
                <button class="btn btn-outline" onclick="showAddAthleteModal()" title="이 조에 새 선수를 추가합니다">선수 추가</button>
            </div>
        `}`;

    crHeats = heats;

    // Setup barcode handler on the sticky input
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
    if (!heatContent) return;

    const isRelay = crSelectedEvent && crSelectedEvent.category === 'relay';

    // Build stats section
    const statsHtml = `
        <div class="callroom-stats">
            <div class="stat-card" style="border-top-color:var(--text)"><div class="stat-number">${total}</div><div class="stat-label">전체${isRelay ? '(팀)' : ''}</div></div>
            <div class="stat-card" style="border-top-color:var(--green)"><div class="stat-number" style="color:var(--green)">${cIn}</div><div class="stat-label">출석</div></div>
            <div class="stat-card" style="border-top-color:var(--danger)"><div class="stat-number" style="color:var(--danger)">${nS}</div><div class="stat-label">결석</div></div>
            <div class="stat-card" style="border-top-color:var(--warning)"><div class="stat-number" style="color:var(--warning)">${pend}</div><div class="stat-label">미확인</div></div>
        </div>
        <div class="cr-progress-bar">
            <div class="cr-progress-fill" style="width:${pctDone}%"></div>
        </div>
        <div class="cr-progress-label">${pctDone}% 출석완료</div>`;

    // Relay events: group by team, fetch actual relay members from API
    if (isRelay) {
        // Each heat entry = one team (dummy athlete with name=teamName)
        // Fetch real relay members per team from relay_member table via API
        const teamEntries = entries.map(e => ({
            teamName: e.name, // dummy athlete name = team name
            lane: e.lane_number || '',
            event_entry_id: e.event_entry_id,
            teamStatus: e.status // team-level status from event_entry
        }));

        // Fetch relay members for all teams in parallel
        const memberPromises = teamEntries.map(t =>
            API.getRelayMembers(crSelectedEventId, t.teamName).catch(() => [])
        );
        const allTeamMembers = await Promise.all(memberPromises);

        let relayHtml = `<table class="data-table">
            <thead><tr><th style="width:60px;">LANE</th><th style="text-align:left;">팀명</th><th style="width:60px;">인원</th><th style="width:80px;">상태</th><th style="width:200px;">ACTION</th></tr></thead>
            <tbody>`;

        teamEntries.forEach((team, idx) => {
            const members = allTeamMembers[idx] || [];
            const teamIdx = idx + 1;
            const teamStatus = team.teamStatus;
            const teamEntryId = team.event_entry_id;
            const escapedTeam = team.teamName.replace(/'/g, "\\'");

            relayHtml += `<tr class="${teamStatus === 'checked_in' ? 'row-checked-in' : teamStatus === 'no_show' ? 'row-no-show' : ''}" style="cursor:pointer;" onclick="toggleRelayTeamRow('relay-team-${teamIdx}')">
                <td><strong>${team.lane}</strong></td>
                <td style="text-align:left;font-weight:600;">${team.teamName} <span style="font-size:10px;color:var(--primary);">&#9660;</span></td>
                <td>${members.length}명</td>
                <td><span class="status-badge status-${teamStatus}">${fmtSt(teamStatus)}</span></td>
                <td style="white-space:nowrap;" onclick="event.stopPropagation();">
                    ${teamStatus !== 'checked_in'
                        ? `<button class="btn btn-sm btn-primary" onclick="setTeamEntryStatus([${teamEntryId}],'checked_in')" title="팀 전체 출석 처리">전체출석</button>`
                        : `<button class="btn btn-sm btn-outline" onclick="setTeamEntryStatus([${teamEntryId}],'registered')" title="팀 전체 출석 취소">취소</button>`}
                    ${teamStatus !== 'no_show'
                        ? `<button class="btn btn-sm btn-ghost" onclick="setTeamEntryStatus([${teamEntryId}],'no_show')" title="팀 전체 결석 처리">결석</button>`
                        : `<button class="btn btn-sm btn-outline" onclick="setTeamEntryStatus([${teamEntryId}],'registered')" title="결석 취소">취소</button>`}
                    <button class="btn btn-sm btn-outline" onclick="showRelayMembers('${escapedTeam}')" title="출전선수 상세보기">명단</button>
                </td>
            </tr>
            <tr id="relay-team-${teamIdx}" class="relay-member-row" style="display:none;">
                <td colspan="5" style="padding:0;">
                    <div style="background:var(--bg);padding:8px 16px;border-left:3px solid var(--primary);">
                        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;">출전 선수 명단 (${members.length}명)</div>
                        ${members.length === 0
                            ? '<p style="color:var(--text-muted);font-size:12px;padding:8px 0;">등록된 선수가 없습니다. 엑셀 재업로드 시 자동 등록됩니다.</p>'
                            : `<table class="data-table" style="font-size:12px;margin-bottom:4px;">
                            <thead><tr><th style="width:40px;">주자</th><th>BIB</th><th style="text-align:left;">선수명</th><th>성별</th></tr></thead>
                            <tbody>${members.map(m => `<tr>
                                <td style="text-align:center;font-weight:700;color:var(--primary);">${m.leg_order || '—'}</td>
                                <td><strong>${bib(m.bib_number)}</strong></td>
                                <td style="text-align:left;">${m.name}</td>
                                <td>${m.gender === 'M' ? '남' : '여'}</td>
                            </tr>`).join('')}</tbody>
                        </table>`}
                    </div>
                </td>
            </tr>`;
        });
        relayHtml += '</tbody></table>';
        heatContent.innerHTML = statsHtml + relayHtml;
    } else {
        // Normal (non-relay) table
        // Detect if any entry has sub_group (A/B) — long distance events
        const hasSubGroup = entries.some(e => e.sub_group);

        // Show lane_number as-is from DB (Excel original lane numbers: A:1-18, B:19-26)

        heatContent.innerHTML = statsHtml + `
        <table class="data-table">
            <thead><tr><th>BIB</th><th>바코드</th><th>스몰넘버</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>${hasSubGroup ? '<th>그룹</th>' : ''}<th>상태</th><th>ACTION</th></tr></thead>
            <tbody>
                ${entries.map(e => {
                    const groupLabel = hasSubGroup ? (e.sub_group || '—') : '';
                    const groupTd = hasSubGroup ? `<td><span style="font-size:11px;font-weight:700;color:${groupLabel==='A'?'#1565c0':groupLabel==='B'?'#c62828':'var(--text-muted)'}">${groupLabel}</span></td>` : '';
                    let smallNum = '';
                    if (crSelectedEvent && (crSelectedEvent.round_type === 'semifinal' || crSelectedEvent.round_type === 'final')) {
                        smallNum = e.lane_number || '';
                    }
                    return `<tr class="${e.status === 'checked_in' ? 'row-checked-in' : e.status === 'no_show' ? 'row-no-show' : ''}">
                    <td><strong>${bib(e.bib_number)}</strong></td>
                    <td style="font-size:11px;color:var(--text-muted);">${e.barcode || ''}</td>
                    <td>${smallNum}</td>
                    <td style="text-align:left;">${e.name}</td>
                    <td style="font-size:12px;text-align:left;">${e.team || ''}</td>
                    ${groupTd}
                    <td><span class="status-badge status-${e.status}">${fmtSt(e.status)}</span></td>
                    <td style="white-space:nowrap;">
                        ${e.status === 'checked_in'
                            ? `<button class="btn btn-sm btn-outline" onclick="setEntryStatus(${e.event_entry_id},'registered')" title="출석을 취소하고 미확인 상태로 되돌립니다">취소</button>`
                            : `<button class="btn btn-sm btn-primary" onclick="setEntryStatus(${e.event_entry_id},'checked_in')" title="선수를 출석 처리합니다">출석</button>`}
                        ${e.status !== 'no_show'
                            ? `<button class="btn btn-sm btn-ghost" onclick="setEntryStatus(${e.event_entry_id},'no_show')" title="선수를 결석 처리합니다">결석</button>`
                            : `<button class="btn btn-sm btn-outline" onclick="setEntryStatus(${e.event_entry_id},'registered')" title="결석을 취소하고 미확인 상태로 되돌립니다">취소</button>`}
                    </td>
                </tr>`;
                }).join('')}
            </tbody>
        </table>`;
    }
}

// ============================================================
// Relay Team Helpers
// ============================================================
function toggleRelayTeamRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

async function setTeamEntryStatus(entryIds, st) {
    const heatContent = document.getElementById('callroom-heat-content');
    const scrollTop = heatContent ? heatContent.scrollTop : 0;
    const detailPanel = document.getElementById('callroom-detail');
    const detailScroll = detailPanel ? detailPanel.scrollTop : 0;
    for (const id of entryIds) {
        await API.updateEntryStatus(id, st);
    }
    await loadCallroomHeatData();
    if (heatContent) heatContent.scrollTop = scrollTop;
    if (detailPanel) detailPanel.scrollTop = detailScroll;
    renderAuditLog();
}

// ============================================================
// Actions
// ============================================================
async function setEntryStatus(id, st) {
    const heatContent = document.getElementById('callroom-heat-content');
    const scrollTop = heatContent ? heatContent.scrollTop : 0;
    const detailPanel = document.getElementById('callroom-detail');
    const detailScroll = detailPanel ? detailPanel.scrollTop : 0;

    await API.updateEntryStatus(id, st);
    await loadCallroomHeatData();

    if (heatContent) heatContent.scrollTop = scrollTop;
    if (detailPanel) detailPanel.scrollTop = detailScroll;
    renderAuditLog();
}

// ============================================================
// Barcode / BIB processing — auto heat switch
// ============================================================
async function processBarcodeOrBib(input) {
    const banner = document.getElementById('barcode-banner');
    try {
        const res = await API.checkinBarcode(input, crSelectedEvent.id);
        if (res.already) {
            showBanner(banner, 'already', `${bib(res.athlete.bib_number)}번 ${res.athlete.name} — 이미 출석`);
        } else {
            showBanner(banner, 'success', `${bib(res.athlete.bib_number)}번 ${res.athlete.name} — 출석 완료`);
        }

        // If the athlete belongs to a different event, switch to that event
        if (res.event_id && res.event_id !== crSelectedEventId) {
            // Update gender tab if needed before switching
            const evt = allEvents.find(e => e.id === res.event_id);
            if (evt && evt.gender !== currentGender) {
                currentGender = evt.gender;
                document.querySelectorAll('.gender-tab').forEach(b =>
                    b.classList.toggle('active', b.dataset.gender === currentGender));
                renderMatrix();
            }
            await selectCallroomEvent(res.event_id);
            return;
        }

        // Auto-switch to the correct heat if the athlete is in a different heat
        if (res.heat_id && res.heat_id !== crSelectedHeatId) {
            crSelectedHeatId = res.heat_id;
            // Update heat tab buttons
            document.querySelectorAll('#callroom-detail .heat-tab').forEach(b => b.classList.remove('active'));
            const matchingBtn = [...document.querySelectorAll('#callroom-detail .heat-tab')].find(b =>
                b.textContent.trim() === `${res.heat_number}조`);
            if (matchingBtn) matchingBtn.classList.add('active');
        }

        await loadCallroomHeatData();
        renderAuditLog();
    } catch (err) {
        showBanner(banner, 'error', `"${input}" — ${err.error || '조회 실패'}`);
    }
}

// ============================================================
// All Heats Modal — view all heats in one scrollable popup
// ============================================================
async function showAllHeatsModal() {
    if (!crHeats || crHeats.length === 0) return;
    const overlay = document.createElement('div');
    overlay.id = 'all-heats-modal';
    overlay.className = 'modal-overlay';
    overlay.style.alignItems = 'flex-start';
    overlay.style.paddingTop = '60px';

    let bodyHtml = '';
    for (const heat of crHeats) {
        const entries = await API.getHeatEntries(heat.id);
        const cIn = entries.filter(e => e.status === 'checked_in').length;
        const total = entries.length;
        bodyHtml += `<div style="margin-bottom:16px;">
            <h4 style="margin:0 0 6px;font-size:14px;">${heat.heat_number}조 <span style="font-size:12px;color:var(--text-muted);">(${cIn}/${total} 출석)</span></h4>
            <table class="data-table" style="font-size:12px;">
                <thead><tr><th>BIB</th><th>바코드</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>상태</th></tr></thead>
                <tbody>${entries.map(e => `<tr class="${e.status==='checked_in'?'row-checked-in':e.status==='no_show'?'row-no-show':''}">
                    <td><strong>${bib(e.bib_number)}</strong></td>
                    <td style="font-size:11px;color:var(--text-muted);">${e.barcode || ''}</td>
                    <td style="text-align:left;">${e.name}</td>
                    <td style="font-size:11px;text-align:left;">${e.team||''}</td>
                    <td><span class="status-badge status-${e.status}">${fmtSt(e.status)}</span></td>
                </tr>`).join('')}</tbody>
            </table>
        </div>`;
    }

    overlay.innerHTML = `<div class="modal" style="width:600px;max-width:95vw;max-height:85vh;overflow-y:auto;">
        <div class="modal-header">
            <div class="modal-title">${crSelectedEvent.name} — 전체 조 현황</div>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('all-heats-modal').remove()">닫기</button>
        </div>
        <div style="padding:16px;">
            <!-- Barcode input inside modal too -->
            <div class="barcode-input-area" style="margin-bottom:12px;">
                <input type="text" id="modal-barcode-input" placeholder="바코드 스캔 또는 배번 입력" autocomplete="off">
                <button class="btn btn-primary btn-sm" onclick="modalBarcodeScan()" title="선수 소집 처리">조회</button>
            </div>
            <div id="modal-barcode-banner" class="barcode-banner" style="display:none;"></div>
            ${bodyHtml}
        </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const mInp = document.getElementById('modal-barcode-input');
    if (mInp) {
        mInp.addEventListener('keydown', e => { if (e.key === 'Enter') modalBarcodeScan(); });
        setTimeout(() => mInp.focus(), 100);
    }
}

async function modalBarcodeScan() {
    const inp = document.getElementById('modal-barcode-input');
    if (!inp) return;
    const v = inp.value.trim();
    if (!v) return;
    const banner = document.getElementById('modal-barcode-banner');
    try {
        const res = await API.checkinBarcode(v, crSelectedEvent.id);
        if (res.already) showBanner(banner, 'already', `${bib(res.athlete.bib_number)}번 ${res.athlete.name} — 이미 출석`);
        else showBanner(banner, 'success', `${bib(res.athlete.bib_number)}번 ${res.athlete.name} — 출석 완료`);
        inp.value = '';
        inp.focus();
        // Refresh modal content
        document.getElementById('all-heats-modal')?.remove();
        await showAllHeatsModal();
        await loadCallroomHeatData();
    } catch (err) {
        showBanner(banner, 'error', `"${v}" — ${err.error || '조회 실패'}`);
        inp.value = '';
        inp.focus();
    }
}

// ============================================================
// Relay Members Popup — show athletes and add/remove from relay team
// ============================================================
async function showRelayMembers(teamName) {
    if (!crSelectedEvent || !teamName) return;
    try {
        const members = await api('GET', `/api/relay-members?event_id=${crSelectedEventId}&team=${encodeURIComponent(teamName)}`);
        // Get the event_entry_id for this team
        const allEntries = await API.getHeatEntries(crSelectedHeatId);
        const teamEntry = allEntries.find(e => e.name === teamName);
        const eventEntryId = teamEntry ? teamEntry.event_entry_id : null;
        
        // Get all athletes from same team for adding
        const compId = getCompetitionId();
        let availableAthletes = [];
        try {
            availableAthletes = await api('GET', `/api/athletes?competition_id=${compId}`);
            // Filter by team name match and not already in relay
            const memberIds = new Set(members.map(m => m.id));
            // For mixed relays, show all genders; otherwise filter by event gender
            const evtGender = crSelectedEvent.gender;
            availableAthletes = availableAthletes.filter(a => {
                if (memberIds.has(a.id)) return false;
                if (evtGender !== 'X' && a.gender !== evtGender) return false;
                return true;
            });
        } catch(e) {}

        // Remove existing modal first to prevent duplicates
        document.getElementById('relay-members-modal')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'relay-members-modal';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal" style="max-width:600px;max-height:85vh;overflow-y:auto;">
            <div class="modal-header"><div class="modal-title">${teamName} 출전선수 관리</div></div>
            <div style="padding:16px;">
                <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">주자 순서를 변경한 뒤 <strong>재정렬</strong> 버튼을 눌러 반영하세요.</p>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <h4 style="font-size:13px;margin:0;">현재 구성원 (${members.length}명)</h4>
                    <button class="btn btn-sm btn-primary" onclick="applyRelayReorder('${teamName.replace(/'/g,"\\'")}')" title="변경된 순서를 저장하고 새로고침합니다">🔄 재정렬</button>
                </div>
                ${members.length === 0 ? '<p style="color:var(--text-muted);text-align:center;padding:8px;">등록된 선수가 없습니다.</p>' :
                `<table class="data-table" style="font-size:12px;margin-bottom:12px;" id="relay-member-table">
                    <thead><tr><th style="width:50px;">주자</th><th>BIB</th><th style="text-align:left;">선수명</th><th>성별</th><th></th></tr></thead>
                    <tbody>${members.map((m, i) => `<tr data-athlete-id="${m.id}">
                        <td style="text-align:center;">
                            <input type="number" min="1" max="10" value="${m.leg_order || i+1}" class="relay-leg-input" data-athlete-id="${m.id}"
                                style="width:40px;text-align:center;font-weight:700;font-size:13px;border:1.5px solid var(--gray);border-radius:4px;padding:2px 4px;color:var(--primary);" title="순서 숫자 입력">
                        </td>
                        <td><strong>${bib(m.bib_number)}</strong></td>
                        <td style="text-align:left;">${m.name}</td>
                        <td>${m.gender === 'M' ? '남' : '여'}</td>
                        <td><button class="btn btn-xs btn-danger" onclick="removeRelayMemberFromTeam(${eventEntryId},${m.id},'${teamName.replace(/'/g,"\\'")}')" title="팀에서 제거">제거</button></td>
                    </tr>`).join('')}</tbody>
                </table>`}
                ${eventEntryId ? `
                <hr style="margin:12px 0;border:none;border-top:1px solid var(--gray);">
                <h4 style="font-size:13px;margin-bottom:6px;">선수 추가</h4>
                <input type="text" id="relay-add-search" placeholder="선수명 또는 BIB 검색..." style="width:100%;padding:6px 10px;border:1.5px solid var(--gray);border-radius:var(--radius);font-size:12px;margin-bottom:8px;" oninput="filterRelayAddList()">
                <div id="relay-add-list" style="max-height:200px;overflow-y:auto;">
                    <p style="color:var(--text-muted);font-size:11px;text-align:center;padding:8px;">선수명 또는 BIB를 검색하세요</p>
                </div>` : ''}
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" onclick="closeRelayModal()">닫기</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) closeRelayModal(); });
        window._relayAvailableAthletes = availableAthletes;
        window._relayEventEntryId = eventEntryId;
        window._relayTeamName = teamName;
    } catch (err) { alert('선수 명단 로드 실패: ' + (err.error || err.message)); }
}

function _renderRelayAddList(list, eventEntryId, teamName) {
    if (list.length === 0) return '<p style="color:var(--text-muted);font-size:11px;text-align:center;">추가 가능한 선수가 없습니다.</p>';
    return `<table class="data-table" style="font-size:11px;">
        <thead><tr><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th></th></tr></thead>
        <tbody>${list.map(a => `<tr id="relay-add-${a.id}">
            <td><strong>${bib(a.bib_number)}</strong></td>
            <td style="text-align:left;">${a.name}</td>
            <td style="text-align:left;font-size:10px;">${a.team||''}</td>
            <td><button class="btn btn-xs btn-primary" onclick="addRelayMemberToTeam(${eventEntryId},${a.id},'${(teamName||'').replace(/'/g,"\\'")}')">추가</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function filterRelayAddList() {
    const q = (document.getElementById('relay-add-search')?.value || '').toLowerCase().trim();
    const el = document.getElementById('relay-add-list');
    if (!el) return;
    if (!q) {
        el.innerHTML = '<p style="color:var(--text-muted);font-size:11px;text-align:center;padding:8px;">선수명 또는 BIB를 검색하세요</p>';
        return;
    }
    const list = (window._relayAvailableAthletes || []).filter(a =>
        a.name.toLowerCase().includes(q) || (a.bib_number||'').includes(q) || (a.team||'').toLowerCase().includes(q)
    ).slice(0, 50);
    el.innerHTML = list.length > 0
        ? _renderRelayAddList(list, window._relayEventEntryId, window._relayTeamName)
        : '<p style="color:var(--text-muted);font-size:11px;text-align:center;padding:8px;">검색 결과가 없습니다.</p>';
}

function closeRelayModal() {
    const modal = document.getElementById('relay-members-modal');
    if (modal) modal.remove();
    // Refresh background heat data when closing
    loadCallroomHeatData();
}

async function applyRelayReorder(teamName) {
    const eventEntryId = window._relayEventEntryId;
    if (!eventEntryId) return;
    const inputs = document.querySelectorAll('#relay-member-table .relay-leg-input');
    const members = [];
    inputs.forEach(inp => {
        const athleteId = parseInt(inp.dataset.athleteId);
        const leg = parseInt(inp.value);
        if (athleteId && leg > 0) members.push({ athlete_id: athleteId, leg_order: leg });
    });
    if (members.length === 0) return;
    try {
        await api('PUT', '/api/relay-members/order', { event_entry_id: eventEntryId, members });
        showToast('주자 순서 재정렬 완료');
        // Refresh modal to show new order
        document.getElementById('relay-members-modal')?.remove();
        await showRelayMembers(teamName);
    } catch(e) { alert('순서 변경 실패: ' + (e.error || e.message)); }
}

async function addRelayMemberToTeam(eventEntryId, athleteId, teamName) {
    try {
        const members = await api('GET', `/api/relay-members?event_entry_id=${eventEntryId}`);
        const legOrder = (members.length || 0) + 1;
        await api('POST', '/api/relay-members', { event_entry_id: eventEntryId, athlete_id: athleteId, leg_order: legOrder });
        const row = document.getElementById(`relay-add-${athleteId}`);
        if (row) { row.style.opacity = '0.3'; row.querySelector('button').disabled = true; row.querySelector('button').textContent = '추가됨'; }
        showToast('릴레이 멤버 추가 완료');
        // Refresh modal only (not the background)
        document.getElementById('relay-members-modal')?.remove();
        await showRelayMembers(teamName);
    } catch(e) { alert('추가 실패: ' + (e.error || e.message)); }
}

async function removeRelayMemberFromTeam(eventEntryId, athleteId, teamName) {
    if (!confirm('이 선수를 릴레이 팀에서 제거하시겠습니까?')) return;
    try {
        await api('DELETE', '/api/relay-members', { event_entry_id: eventEntryId, athlete_id: athleteId });
        showToast('릴레이 멤버 제거 완료');
        // Refresh modal only (background refreshes on close)
        document.getElementById('relay-members-modal')?.remove();
        await showRelayMembers(teamName);
    } catch(e) { alert('제거 실패: ' + (e.error || e.message)); }
}

// changeRelayMemberOrder is no longer called on individual input change.
// Users now edit all inputs and press "재정렬" button to apply.
// Kept for backward compatibility if admin.html still references it.
async function changeRelayMemberOrder(eventEntryId, athleteId, newLeg, teamName) {
    const leg = parseInt(newLeg);
    if (!leg || leg < 1) return;
    try {
        await api('PUT', '/api/relay-members/order', { event_entry_id: eventEntryId, members: [{ athlete_id: athleteId, leg_order: leg }] });
        showToast(`주자 순서 → ${leg}번으로 변경`);
    } catch(e) { alert('순서 변경 실패: ' + (e.error || e.message)); }
}

// ============================================================
// Add Athlete to Heat
// ============================================================
async function showAddAthleteModal() {
    if (!crSelectedHeatId || !crSelectedEvent) return;
    const compId = getCompetitionId();
    let athletes = [];
    try { athletes = await api('GET', `/api/athletes?competition_id=${compId}`); } catch(e) {}

    // Filter by event gender (X=mixed → show all)
    const eventGender = crSelectedEvent.gender;
    if (eventGender && eventGender !== 'X') {
        athletes = athletes.filter(a => a.gender === eventGender);
    }

    // Filter out athletes already in this event's entries (any heat)
    const existingIds = new Set(crEntries.map(e => e.athlete_id));
    const available = athletes.filter(a => !existingIds.has(a.id));

    const overlay = document.createElement('div');
    overlay.id = 'add-athlete-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="width:500px;max-width:95vw;max-height:85vh;overflow-y:auto;">
        <div class="modal-header">
            <div class="modal-title">선수 추가 <span style="font-size:11px;color:var(--text-muted);font-weight:400;">(${available.length}명 추가 가능)</span></div>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('add-athlete-modal').remove()">닫기</button>
        </div>
        <div style="padding:16px;">
            <input type="text" id="add-athlete-search" placeholder="선수명 또는 BIB 검색..." style="width:100%;padding:8px 12px;border:1.5px solid var(--gray);border-radius:var(--radius);font-size:13px;margin-bottom:12px;" oninput="filterAddAthletes()">
            <div id="add-athlete-list" style="max-height:400px;overflow-y:auto;">
                ${_renderAddAthleteList(available)}
            </div>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    window._addAthleteAvailable = available;
    setTimeout(() => document.getElementById('add-athlete-search')?.focus(), 100);
}

function _renderAddAthleteList(list) {
    if (list.length === 0) return '<p style="color:var(--text-muted);text-align:center;padding:16px;">추가 가능한 선수가 없습니다.</p>';
    return `<table class="data-table" style="font-size:12px;">
        <thead><tr><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th></th></tr></thead>
        <tbody>${list.map(a => `<tr id="add-ath-row-${a.id}">
            <td><strong>${bib(a.bib_number)}</strong></td>
            <td style="text-align:left;">${a.name}</td>
            <td style="font-size:11px;text-align:left;">${a.team||''}</td>
            <td><button class="btn btn-sm btn-primary" onclick="doAddAthlete(${a.id})" title="이 선수를 현재 조에 추가합니다">추가</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function filterAddAthletes() {
    const q = (document.getElementById('add-athlete-search')?.value || '').toLowerCase().trim();
    const list = (window._addAthleteAvailable || []).filter(a =>
        !q || a.name.toLowerCase().includes(q) || (a.bib_number||'').includes(q)
    );
    const el = document.getElementById('add-athlete-list');
    if (el) el.innerHTML = _renderAddAthleteList(list);
}

async function doAddAthlete(athleteId) {
    try {
        await api('POST', '/api/heat-entries/add', { heat_id: crSelectedHeatId, athlete_id: athleteId, event_id: crSelectedEventId });
        const row = document.getElementById(`add-ath-row-${athleteId}`);
        if (row) { row.style.opacity = '0.3'; row.querySelector('button').disabled = true; row.querySelector('button').textContent = '추가됨'; }
        await loadCallroomHeatData();
    } catch (e) { alert('추가 실패: ' + (e.error || '')); }
}

// ============================================================
// Callroom Complete
// ============================================================
async function completeCallroom() {
    let judgeOptions = '<option value="">-- 담당자 선택 --</option>';
    try {
        const judges = await api('GET', '/api/registered-judges');
        judges.forEach(name => { judgeOptions += `<option value="${name}">${name}</option>`; });
        judgeOptions += `<option value="관리자">관리자</option>`;
    } catch(e) {}

    const modal = document.createElement('div');
    modal.id = 'callroom-complete-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal modal-sm">
            <div class="modal-header"><div class="modal-title">소집 완료 확인</div></div>
            <div class="modal-form">
                <div class="form-row"><label>담당자</label>
                    <select id="callroom-judge-select" style="flex:1;padding:7px 12px;border:1.5px solid var(--gray);border-radius:var(--radius);font-size:13px;">
                        ${judgeOptions}
                    </select>
                </div>
                <div id="callroom-complete-error" style="display:none;color:var(--danger);font-size:12px;margin-top:4px;font-weight:600;"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" onclick="document.getElementById('callroom-complete-modal').remove()" title="취소">취소</button>
                <button class="btn btn-primary" onclick="doCompleteCallroom()" title="소집을 완료 처리합니다">소집 완료</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('callroom-judge-select').focus(), 100);
}

async function doCompleteCallroom() {
    const judgeSelect = document.getElementById('callroom-judge-select');
    const judgeName = judgeSelect ? judgeSelect.value : '';
    const errEl = document.getElementById('callroom-complete-error');
    if (!judgeName) { errEl.textContent = '담당자를 선택하세요.'; errEl.style.display = 'block'; return; }

    const prevHeatId = crSelectedHeatId;
    try {
        await API.completeCallroom(crSelectedEventId, judgeName, crSelectedHeatId);
        document.getElementById('callroom-complete-modal').remove();
        allEvents = await API.getAllEvents(getCompetitionId());
        renderMatrix();
        if (crSelectedEventId) {
            await selectCallroomEvent(crSelectedEventId);
            if (prevHeatId && crHeats.find(h => h.id === prevHeatId)) {
                crSelectedHeatId = prevHeatId;
                document.querySelectorAll('#callroom-detail .heat-tab').forEach(b => {
                    b.classList.toggle('active', +b.textContent.replace('조','').trim() === crHeats.find(h => h.id === prevHeatId)?.heat_number);
                });
                await loadCallroomHeatData();
            }
        }
        renderAuditLog();
    } catch (e) {
        errEl.textContent = e.error || '소집 완료 실패';
        errEl.style.display = 'block';
    }
}

// ============================================================
// SSE Real-time Updates
// ============================================================
onSSE('entry_status', async (data) => {
    if (crSelectedHeatId) {
        const entry = crEntries.find(e => e.event_entry_id === data.event_entry_id);
        if (entry) await loadCallroomHeatData();
    }
});
onSSE('callroom_complete', async () => {
    allEvents = await API.getAllEvents(getCompetitionId());
    renderMatrix();
});
onSSE('event_completed', async () => {
    allEvents = await API.getAllEvents(getCompetitionId());
    renderMatrix();
});
onSSE('event_reverted', async () => {
    allEvents = await API.getAllEvents(getCompetitionId());
    renderMatrix();
});
onSSE('event_status_changed', async () => {
    allEvents = await API.getAllEvents(getCompetitionId());
    renderMatrix();
});
