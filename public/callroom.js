/**
 * PACE RISE : Node — callroom.js v6
 * Improvements: barcode/bib checkin fix, auto heat switch, cancel button,
 * all-heats modal, barcode display, sticky barcode input, relay popup, add athlete
 */

// Helper: bib() is shared from common.js (loaded before callroom.js)

let allEvents = [];
let currentGender = 'M';
let crSelectedEvent = null;
let crSelectedEventId = null;
let crSelectedHeatId = null;
let crHeats = [];
let crEntries = [];
let _crScheduleMap = {};

document.addEventListener('DOMContentLoaded', async () => {
    if (!(await requireCompetition())) return;
    // Competition ended check removed — callroom stays accessible
    // so admin/ROUNKIM accounts can still operate after competition ends
    renderPageNav('callroom');
    // [정책] 종료된 대회 + 운영진(operation) → 진입 차단
    if (typeof guardEndedCompForOperation === 'function') await guardEndedCompForOperation('callroom');
    // Parallel: comp selector + info bar + events load simultaneously
    const [, , events] = await Promise.all([
        renderCompSelector('callroom'),
        renderCompInfoBar(),
        API.getAllEvents(getCompetitionId())
    ]);
    allEvents = events;
    // Load timetable schedule
    try { _crScheduleMap = await fetch('/api/timetable/' + getCompetitionId() + '/event-schedule').then(r => r.json()) || {}; } catch(e) { _crScheduleMap = {}; }
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
    const subEvents = allEvents.filter(e => e.gender === currentGender && e.parent_event_id);

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
            const schedEvt = fin ? _crScheduleMap[fin.id] : (semi ? _crScheduleMap[semi.id] : (prelim ? _crScheduleMap[prelim.id] : null));
            let timeBadge = '';
            if (schedEvt && schedEvt.time) {
                const tColor = schedEvt.is_today ? '#b79f58' : '#999';
                const crBadge = isCallRoomWindow(schedEvt.callroom_time, schedEvt.scheduled_date) ? ' <span class="ico-callroom">Call Room</span>' : '';
                timeBadge = `<span style="font-size:9px;color:${tColor};padding:1px 4px;border-radius:4px;background:${schedEvt.is_today ? '#f8f4ea' : '#f5f5f5'};margin-left:3px;font-variant-numeric:tabular-nums;" title="${schedEvt.callroom_time ? '소집 ' + schedEvt.callroom_time : ''}">${schedEvt.time}</span>${crBadge}`;
            }
            html += `<tr>
                <td class="rec-matrix-event">${g.name}${timeBadge}</td>
                <td class="round-cell">${renderCallroomBtn(prelim, '명단')}</td>
                <td class="round-cell">${renderCallroomBtn(semi, '명단')}</td>
                <td class="round-cell">${renderCallroomBtn(fin, '명단')}</td>
            </tr>`;

            // Combined sub-events (10종/7종) — expanded by default
            if (cat.key === 'combined') {
                const parentIds = g.rounds.map(r => r.id);
                const subs = subEvents.filter(se => parentIds.includes(se.parent_event_id));
                if (subs.length > 0) {
                    const subGroups = {};
                    const subOrder = [];
                    subs.forEach(se => {
                        if (!subGroups[se.name]) { subGroups[se.name] = []; subOrder.push(se.name); }
                        subGroups[se.name].push(se);
                    });
                    const parentKey = 'cr-subs-' + (parentIds[0] || g.name);
                    const doneCount = subOrder.filter(sn => subGroups[sn].some(r => r.round_status === 'completed' || r.round_status === 'in_progress')).length;
                    html += `<tr class="combined-sub-toggle-row">
                        <td colspan="4" style="padding:4px 8px;background:linear-gradient(135deg,#f8f4ea,#faf6ec);border-left:3px solid #8a7640;">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <button onclick="toggleCombinedSubs('${parentKey}')" class="btn btn-sm btn-ghost" style="font-size:11px;padding:2px 10px;" id="toggle-btn-${parentKey}">
                                    ▼ 세부종목 ${subOrder.length}개
                                </button>
                                <span style="font-size:10px;color:#8a7640;font-weight:600;">${doneCount}/${subOrder.length} 진행</span>
                            </div>
                        </td>
                    </tr>`;
                    subOrder.forEach((seName, idx) => {
                        const seRounds = subGroups[seName];
                        const seFin = seRounds.find(r => r.round_type === 'final');
                        const sePrelim = seRounds.find(r => r.round_type === 'preliminary');
                        const seSemi = seRounds.find(r => r.round_type === 'semifinal');
                        const shortName = seName.replace(/^\[.*?\]\s*/, '');
                        const isLast = idx === subOrder.length - 1;
                        const prefix = isLast ? '└' : '├';
                        const seStatus = (seFin || sePrelim || seSemi);
                        const statusDot = seStatus ? (
                            seStatus.round_status === 'completed' ? '<span style="color:#9a8548;">●</span>' :
                            seStatus.round_status === 'in_progress' ? '<span style="color:#f59e0b;">●</span>' :
                            '<span style="color:#d1d5db;">○</span>'
                        ) : '<span style="color:#d1d5db;">○</span>';
                        html += `<tr class="combined-sub-row ${parentKey}">
                            <td class="rec-matrix-event" style="padding-left:24px;font-size:12px;color:#444;">
                                <span style="color:#a78bfa;margin-right:4px;">${prefix}</span>
                                ${statusDot}
                                <strong>${shortName}</strong>
                            </td>
                            <td class="round-cell">${renderCallroomBtn(sePrelim, '명단')}</td>
                            <td class="round-cell">${renderCallroomBtn(seSemi, '명단')}</td>
                            <td class="round-cell">${renderCallroomBtn(seFin, '명단')}</td>
                        </tr>`;
                    });
                }
            }
        });
        html += `</tbody></table></div>`;
    });

    if (!html) html = '<div class="empty-state">해당 성별의 종목이 없습니다.</div>';
    container.innerHTML = html;
}

// Toggle combined sub-events visibility (10종/7종)
function toggleCombinedSubs(parentKey) {
    const rows = document.querySelectorAll(`.combined-sub-row.${parentKey}`);
    const visible = rows.length > 0 && rows[0].style.display !== 'none';
    rows.forEach(r => r.style.display = visible ? 'none' : '');
    const toggleBtn = document.getElementById('toggle-btn-' + parentKey);
    if (toggleBtn) toggleBtn.innerHTML = (visible ? '▶' : '▼') + ` 세부종목 ${rows.length}개`;
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
            <div class="placeholder-icon" style="font-size:28px;color:#ccc;font-weight:700;">CR</div>
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
                        <span style="font-size:11px;font-weight:700;color:#6b6b6b;margin-right:4px;">Day1:</span>
                        ${subEvents.filter((s,i) => i < day1Max).map(s => `<span style="background:#f0f0f0;color:#6b6b6b;padding:2px 8px;border-radius:10px;font-size:11px;">${s.name.replace(/\[.*?\]\s*/, '')}</span>`).join('')}
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
                        <span style="font-size:11px;font-weight:700;color:#8b1a2a;margin-right:4px;">Day2:</span>
                        ${subEvents.filter((s,i) => i >= day1Max).map(s => `<span style="background:#f0e0e4;color:#8b1a2a;padding:2px 8px;border-radius:10px;font-size:11px;">${s.name.replace(/\[.*?\]\s*/, '')}</span>`).join('')}
                    </div>
                </div>`;
            }
        } catch(e) {}
    }

    // Joint group info — check if this event belongs to a joint group
    let jointInfoHtml = '';
    let _crJointGroup = null;
    try {
        const jointData = await api('GET', `/api/joint-groups/by-event/${eventId}`);
        if (jointData && jointData.length > 0) {
            _crJointGroup = jointData[0]; // Use first group
            const fedColors = ['#6b6b6b', '#dc2626', '#9a8548', '#ea580c', '#8a7640'];
            const memberBadges = _crJointGroup.members.map((m, i) => {
                const color = fedColors[i % fedColors.length];
                const isCurrent = m.event_id === eventId;
                return `<span style="background:${color};color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;${isCurrent ? 'outline:2px solid #000;outline-offset:1px;' : ''}">${m.federation || m.comp_name}</span>`;
            }).join(' ');
            jointInfoHtml = `<div style="margin-bottom:12px;padding:10px;background:linear-gradient(135deg,#fef3c7,#fde68a);border-radius:var(--radius);border-left:4px solid #f59e0b;font-size:12px;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <span style="font-size:11px;font-weight:700;color:#b79f58;">LINK</span>
                    <strong>합동 종목</strong>
                    <span style="font-size:10px;color:#92400e;">스코어보드 키: ${_crJointGroup.joint_scoreboard_key || '-'}</span>
                </div>
                <div style="display:flex;gap:4px;align-items:center;">
                    ${memberBadges}
                    <span style="font-size:11px;color:#92400e;margin-left:4px;">통합 소집 (각 대회 선수를 구분 표시)</span>
                </div>
            </div>`;
        }
    } catch(e) {}

    // Store joint group for use in loadCallroomHeatData
    window._crJointGroup = _crJointGroup;

    detail.innerHTML = `
        <div class="cr-detail-header">
            <h3>${evt.name} <span class="page-sub">${roundLabel} ${gL} 명단</span></h3>
            <span class="context-badge">${gL}</span>
        </div>
        ${jointInfoHtml}
        ${combinedInfoHtml}
        <!-- Event-level memo (인쇄 시 제목 하단에 큰 글씨로 표시) -->
        <div style="margin:8px 0 12px;padding:10px 14px;background:linear-gradient(135deg,#f0f0f0,#d8d8d8);border-radius:8px;border-left:4px solid #6b6b6b;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="font-size:12px;font-weight:700;color:#8a7640;">MEMO</span>
                <label style="font-size:15px;font-weight:700;color:#6b6b6b;">소집 메모</label>
                <span style="font-size:11px;color:#888;">(인쇄 시 종목 제목 하단에 큰 글씨로 출력됩니다)</span>
                <span id="event-memo-status" style="font-size:11px;color:#999;margin-left:auto;"></span>
            </div>
            <input type="text" id="callroom-event-memo" placeholder="예: 1차 콜, 제3코스 사용, 우천 시 실내 이동" 
                style="width:100%;font-size:22px;padding:10px 14px;border:2px solid #6b6b6b;border-radius:6px;font-weight:700;color:#6b6b6b;background:#fff;letter-spacing:0.5px;"
                onchange="saveCallroomEventMemo(this.value)" onkeydown="if(event.key==='Enter'){this.blur();}">
        </div>
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
                <button class="btn btn-outline" onclick="printCallroom('current')" title="현재 조를 인쇄합니다">현재 조 출력</button>
                <button class="btn btn-outline" onclick="printCallroom('all')" title="전체 조를 인쇄합니다">전체 출력</button>
                <button class="btn btn-outline" onclick="exportCallroomExcel()" title="현재 종목 전체 조를 엑셀로 다운로드합니다">엑셀 다운로드</button>
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
        // 자동 focus 제거 — 검색창을 직접 클릭해야 키보드 활성화
    }

    if (heats.length > 0) {
        crSelectedHeatId = heats[0].id;
        await loadCallroomHeatData();
    }

    // Load event-level memo
    await loadCallroomEventMemo();
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

            relayHtml += `<tr data-entry-id="${teamEntryId}" class="${teamStatus === 'checked_in' ? 'row-checked-in' : teamStatus === 'no_show' ? 'row-no-show' : ''}" style="cursor:pointer;" onclick="toggleRelayTeamRow('relay-team-${teamIdx}')">
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

        // Check for joint group — merge other competitions' entries
        let allDisplayEntries = entries.map(e => ({ ...e, _isJoint: false, _federation: '' }));
        const jointGroup = window._crJointGroup;
        if (jointGroup) {
            try {
                const jData = await api('GET', `/api/joint-groups/${jointGroup.id}/entries`);
                if (jData && jData.entries) {
                    // 중복 방지: 이미 allDisplayEntries에 있는 event_entry_id는 추가하지 않음
                    // (서버에서 이미 dedupe 되지만, current event entries 와의 겹침은 클라이언트에서 처리)
                    const seenEntryIds = new Set(allDisplayEntries.map(e => e.event_entry_id));
                    // 추가 안전장치: (athlete_id, source_event_id) 키로 동일 선수 중복도 방지
                    const seenAth = new Set(
                        allDisplayEntries.map(e => `${e.athlete_id}|${e.event_id || crSelectedEventId}`)
                    );
                    const otherEntries = jData.entries.filter(e => e.source_event_id !== crSelectedEventId);
                    otherEntries.forEach(e => {
                        if (seenEntryIds.has(e.event_entry_id)) return;
                        const ak = `${e.athlete_id}|${e.source_event_id}`;
                        if (seenAth.has(ak)) return;
                        seenEntryIds.add(e.event_entry_id);
                        seenAth.add(ak);
                        allDisplayEntries.push({
                            ...e,
                            _isJoint: true,
                            _federation: e.federation || e.comp_name || '',
                        });
                    });
                    // Tag current entries with federation
                    const currentMember = jointGroup.members.find(m => m.event_id === crSelectedEventId);
                    const currentFed = currentMember ? (currentMember.federation || currentMember.comp_name || '') : '';
                    allDisplayEntries.forEach(e => {
                        if (!e._isJoint) e._federation = currentFed;
                    });
                }
            } catch(e) { console.error('Joint entries load failed:', e); }
        }
        // 통계 카운터를 합동 뷰의 실제 표시 row 기준으로 동기화 (없으면 0)
        window._crDisplayCount = allDisplayEntries.length;
        window._crDisplayCheckedIn = allDisplayEntries.filter(e => e.status === 'checked_in').length;
        window._crDisplayNoShow = allDisplayEntries.filter(e => e.status === 'no_show').length;
        window._crDisplayPending = allDisplayEntries.filter(e => e.status === 'registered').length;
        const hasJoint = allDisplayEntries.some(e => e._isJoint);
        const fedColors = { };
        if (hasJoint) {
            const feds = [...new Set(allDisplayEntries.map(e => e._federation))];
            const colors = ['#6b6b6b', '#dc2626', '#9a8548', '#ea580c', '#8a7640', '#0891b2'];
            feds.forEach((f, i) => { fedColors[f] = colors[i % colors.length]; });
        }

        // 합동 모드일 때는 통계 카운터를 합산 entries 기준으로 다시 계산해서 statsHtml을 교체
        let finalStatsHtml = statsHtml;
        if (hasJoint) {
            const t = allDisplayEntries.length;
            const ci = allDisplayEntries.filter(e => e.status === 'checked_in').length;
            const ns = allDisplayEntries.filter(e => e.status === 'no_show').length;
            const pe = allDisplayEntries.filter(e => e.status === 'registered').length;
            const pct = t > 0 ? Math.round((ci / t) * 100) : 0;
            finalStatsHtml = `
                <div class="callroom-stats">
                    <div class="stat-card" style="border-top-color:var(--text)"><div class="stat-number">${t}</div><div class="stat-label">전체</div></div>
                    <div class="stat-card" style="border-top-color:var(--green)"><div class="stat-number" style="color:var(--green)">${ci}</div><div class="stat-label">출석</div></div>
                    <div class="stat-card" style="border-top-color:var(--danger)"><div class="stat-number" style="color:var(--danger)">${ns}</div><div class="stat-label">결석</div></div>
                    <div class="stat-card" style="border-top-color:var(--warning)"><div class="stat-number" style="color:var(--warning)">${pe}</div><div class="stat-label">미확인</div></div>
                </div>
                <div class="cr-progress-bar"><div class="cr-progress-fill" style="width:${pct}%"></div></div>
                <div class="cr-progress-label">${pct}% 출석완료</div>`;
        }
        heatContent.innerHTML = finalStatsHtml + `
        <table class="data-table">
            <thead><tr>${hasJoint ? '<th>대회</th>' : ''}<th>BIB</th><th>바코드</th><th>스몰넘버</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>${hasSubGroup ? '<th>그룹</th>' : ''}<th>상태</th><th>ACTION</th></tr></thead>
            <tbody>
                ${allDisplayEntries.map(e => {
                    const groupLabel = hasSubGroup ? (e.sub_group || '—') : '';
                    const groupTd = hasSubGroup ? `<td><span style="font-size:11px;font-weight:700;color:${groupLabel==='A'?'#6b6b6b':groupLabel==='B'?'#8b1a2a':'var(--text-muted)'}">${groupLabel}</span></td>` : '';
                    let smallNum = e.lane_number || '';
                    const fedBadge = hasJoint ? `<td><span style="background:${fedColors[e._federation] || '#888'};color:#fff;padding:0 4px;border-radius:3px;font-size:9px;font-weight:600;">${e._federation}</span></td>` : '';
                    const jointRowStyle = e._isJoint ? 'background:#fffbeb;' : '';
                    return `<tr data-entry-id="${e.event_entry_id}" class="${e.status === 'checked_in' ? 'row-checked-in' : e.status === 'no_show' ? 'row-no-show' : ''}" style="${jointRowStyle}">
                    ${fedBadge}
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
// Stats Counter Update (DOM patch — no layout change)
// ============================================================
function _updateCallroomStats() {
    const entries = crEntries;
    const total = entries.length;
    const cIn = entries.filter(e => e.status === 'checked_in').length;
    const nS = entries.filter(e => e.status === 'no_show').length;
    const pend = entries.filter(e => e.status === 'registered').length;
    const pctDone = total > 0 ? Math.round((cIn / total) * 100) : 0;

    const stats = document.querySelectorAll('.callroom-stats .stat-card .stat-number');
    if (stats.length >= 4) {
        stats[0].textContent = total;
        stats[1].textContent = cIn;
        stats[2].textContent = nS;
        stats[3].textContent = pend;
    }
    const fill = document.querySelector('.cr-progress-fill');
    if (fill) fill.style.width = pctDone + '%';
    const label = document.querySelector('.cr-progress-label');
    if (label) label.textContent = pctDone + '% 출석완료';
}

// ============================================================
// Callroom Memo Save
// ============================================================
async function saveCallroomMemo(entryId, memo) {
    try {
        await API.saveMemo(entryId, memo);
        // Also update local crEntries cache
        const e = crEntries.find(x => x.event_entry_id === entryId);
        if (e) e.callroom_memo = memo;
    } catch (err) {
        console.error('Memo save failed:', err);
    }
}

// ============================================================
// Event-level Callroom Memo Save/Load
// ============================================================
async function saveCallroomEventMemo(memo) {
    if (!crSelectedEventId) return;
    const statusEl = document.getElementById('event-memo-status');
    try {
        await API.saveEventMemo(crSelectedEventId, memo);
        if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(() => { statusEl.textContent = ''; }, 2000); }
    } catch (err) {
        console.error('Event memo save failed:', err);
        if (statusEl) statusEl.textContent = 'Error';
    }
}

async function loadCallroomEventMemo() {
    if (!crSelectedEventId) return;
    try {
        const res = await API.getEventMemo(crSelectedEventId);
        const inp = document.getElementById('callroom-event-memo');
        if (inp) inp.value = res.memo || '';
    } catch (err) {
        console.error('Event memo load failed:', err);
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
    // Optimistic DOM patch for relay
    for (const id of entryIds) {
        _patchEntryRow(id, st);
    }
    for (const id of entryIds) {
        await API.updateEntryStatus(id, st);
    }
    renderAuditLog();
}

// ============================================================
// Actions
// ============================================================
async function setEntryStatus(id, st) {
    // Optimistic DOM patch — update immediately before API call
    _patchEntryRow(id, st);

    await API.updateEntryStatus(id, st);
    renderAuditLog();
}

// Shared DOM-patch helper: updates a single row + stats without rebuilding the table
function _patchEntryRow(entryId, newStatus) {
    // Update local cache
    const entry = crEntries.find(e => e.event_entry_id === entryId);
    if (entry) entry.status = newStatus;

    const row = document.querySelector(`tr[data-entry-id="${entryId}"]`);
    if (!row) return;

    // 1) Row CSS class
    row.className = newStatus === 'checked_in' ? 'row-checked-in' : newStatus === 'no_show' ? 'row-no-show' : '';

    // 2) Status badge
    const badge = row.querySelector('.status-badge');
    if (badge) {
        badge.className = `status-badge status-${newStatus}`;
        badge.textContent = fmtSt(newStatus);
    }

    // 3) Action buttons (non-relay only — relay rows don't have individual action buttons here)
    const isRelay = crSelectedEvent && crSelectedEvent.category === 'relay';
    const actionTd = row.querySelector('td:last-child');
    if (actionTd && !isRelay) {
        if (newStatus === 'checked_in') {
            actionTd.innerHTML = `<button class="btn btn-sm btn-outline" onclick="setEntryStatus(${entryId},'registered')" title="출석을 취소하고 미확인 상태로 되돌립니다">취소</button>`
                + `<button class="btn btn-sm btn-ghost" onclick="setEntryStatus(${entryId},'no_show')" title="선수를 결석 처리합니다">결석</button>`;
        } else if (newStatus === 'no_show') {
            actionTd.innerHTML = `<button class="btn btn-sm btn-primary" onclick="setEntryStatus(${entryId},'checked_in')" title="선수를 출석 처리합니다">출석</button>`
                + `<button class="btn btn-sm btn-outline" onclick="setEntryStatus(${entryId},'registered')" title="결석을 취소하고 미확인 상태로 되돌립니다">취소</button>`;
        } else {
            actionTd.innerHTML = `<button class="btn btn-sm btn-primary" onclick="setEntryStatus(${entryId},'checked_in')" title="선수를 출석 처리합니다">출석</button>`
                + `<button class="btn btn-sm btn-ghost" onclick="setEntryStatus(${entryId},'no_show')" title="선수를 결석 처리합니다">결석</button>`;
        }
    }

    // 4) Update stats
    _updateCallroomStats();
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
                    <button class="btn btn-sm btn-primary" onclick="applyRelayReorder('${teamName.replace(/'/g,"\\'")}')" title="변경된 순서를 저장하고 새로고침합니다">재정렬</button>
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
    if (!crSelectedHeatId || !crSelectedEventId) return;

    // Check if this update is for our current heat
    const entry = crEntries.find(e => e.event_entry_id === data.event_entry_id);
    if (!entry) {
        // Maybe it's a new entry added to this heat — do a full reload only if same event
        if (data.event_id === crSelectedEventId) await loadCallroomHeatData();
        return;
    }

    const newStatus = data.status;
    if (newStatus === entry.status) return; // No change

    // DOM Patch via shared helper
    _patchEntryRow(data.event_entry_id, newStatus);

    // Brief highlight animation for remote changes
    const row = document.querySelector(`tr[data-entry-id="${data.event_entry_id}"]`);
    if (row) {
        row.style.transition = 'background-color 0.5s ease';
        row.style.backgroundColor = newStatus === 'checked_in' ? 'rgba(183,159,88,0.25)' : newStatus === 'no_show' ? 'rgba(244,67,54,0.25)' : 'rgba(255,193,7,0.25)';
        setTimeout(() => { row.style.backgroundColor = ''; }, 1200);
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

// SSE reconnect: reload current heat data to catch changes missed while disconnected
onSSEReconnect(async () => {
    if (crSelectedHeatId && crSelectedEventId) {
        await loadCallroomHeatData();
    }
});

// ============================================================
// Print Callroom — 조별 또는 전체 출력
// ============================================================
async function printCallroom(mode) {
    if (!crSelectedEvent || !crHeats || crHeats.length === 0) return;

    const evt = crSelectedEvent;
    const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
    const roundLabel = fmtRound(evt.round_type);
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    // ─── 인쇄 헤더 자동 생성 — 대회명 + 종목명 + 경기시간 ──────────────
    // 종이 출력 시 "남자 200m 예선" 만으로는 어느 대회(대학/실업/초등)인지 식별 불가하므로
    // 대회명과 시간표 시간을 함께 표시. 합동종목은 모든 대회명 함께 표시.
    let compNamesLabel = '';
    try {
        const comps = await API.getCompetitions();
        const jointGroup = window._crJointGroup || null;
        if (jointGroup && Array.isArray(jointGroup.members) && jointGroup.members.length > 1) {
            // 합동 종목: 모든 대회 표시 (각 대회별 짧은 라벨/소속연맹 우선)
            const labels = jointGroup.members.map(m => {
                const c = comps.find(x => x.id === m.competition_id);
                return m.federation || m.comp_name || (c && c.name) || '';
            }).filter(Boolean);
            compNamesLabel = [...new Set(labels)].join(' / ');
        } else {
            const comp = comps.find(c => c.id === evt.competition_id);
            compNamesLabel = comp ? (comp.name || '') : '';
        }
    } catch(e) { /* best-effort: 대회명을 못 가져와도 인쇄는 진행 */ }

    // 시간표 연동 — 경기시간/소집시간/날짜
    let scheduleLabel = '';
    try {
        if (!_crScheduleMap || Object.keys(_crScheduleMap).length === 0) {
            _crScheduleMap = await fetch('/api/timetable/' + getCompetitionId() + '/event-schedule').then(r => r.json()) || {};
        }
        const sch = _crScheduleMap && _crScheduleMap[evt.id];
        if (sch) {
            const parts = [];
            if (sch.scheduled_date) parts.push(sch.scheduled_date);
            if (sch.time) parts.push('경기 ' + sch.time);
            if (sch.callroom_time) parts.push('소집 ' + sch.callroom_time);
            scheduleLabel = parts.join(' · ');
        }
    } catch(e) {}

    // Get event-level memo
    let eventMemo = '';
    try {
        const memoRes = await API.getEventMemo(crSelectedEventId);
        eventMemo = memoRes.memo || '';
    } catch(e) {}

    // Determine which heats to print
    const heatsToPrint = mode === 'all'
        ? crHeats
        : crHeats.filter(h => h.id === crSelectedHeatId);

    let tablesHtml = '';
    for (const heat of heatsToPrint) {
        const entries = await API.getHeatEntries(heat.id);
        const cIn = entries.filter(e => e.status === 'checked_in').length;
        const nS = entries.filter(e => e.status === 'no_show').length;
        const total = entries.length;

        const isRelay = evt.category === 'relay';

        // === 그룹(A/B) 분리: 5000m/10000m 등 장거리 그룹 결승은 같은 조 안에서 A/B 가 따로 출발하므로
        //     각 그룹별로 별도 표를 만들어 소집/출석을 분리해서 본다. ===
        const hasSubGroup = entries.some(e => e.sub_group);
        // 그룹 순서: A → B → (그 외 알파벳 순) → 그룹 없음(null) 마지막
        const groupOrder = hasSubGroup
            ? [...new Set(entries.map(e => e.sub_group || ''))]
                .sort((a, b) => {
                    if (a === '' && b !== '') return 1;
                    if (b === '' && a !== '') return -1;
                    return a.localeCompare(b);
                })
            : [''];

        tablesHtml += `<div class="print-heat-block">
            <h3 style="margin:0 0 4px;font-size:15px;border-bottom:2px solid #333;padding-bottom:4px;">
                ${heat.heat_number}조
                <span style="font-size:12px;font-weight:400;color:#666;margin-left:8px;">
                    출석 ${cIn}/${total} | 결석 ${nS}
                </span>
            </h3>`;

        for (const grp of groupOrder) {
            const grpEntries = hasSubGroup
                ? entries.filter(e => (e.sub_group || '') === grp)
                : entries;
            if (grpEntries.length === 0) continue;

            const gIn = grpEntries.filter(e => e.status === 'checked_in').length;
            const gNS = grpEntries.filter(e => e.status === 'no_show').length;
            const gTotal = grpEntries.length;

            // 그룹 헤더 (A/B 가 있을 때만)
            if (hasSubGroup) {
                const groupLabel = grp ? `${grp} 그룹` : '미지정';
                tablesHtml += `<div style="margin-top:8px;padding:4px 8px;background:#f0f0f0;border-left:4px solid ${grp==='A'?'#555':grp==='B'?'#8b1a2a':'#bbb'};font-size:13px;font-weight:700;">
                    ${groupLabel}
                    <span style="font-size:11px;font-weight:400;color:#666;margin-left:8px;">
                        출석 ${gIn}/${gTotal} | 결석 ${gNS}
                    </span>
                </div>`;
            }

            tablesHtml += `<table class="print-table">
                <thead><tr>
                    <th style="width:50px;">레인</th>
                    <th style="width:60px;">BIB</th>
                    ${hasSubGroup ? '<th style="width:50px;">그룹</th>' : ''}
                    <th style="text-align:left;">선수명</th>
                    <th style="text-align:left;">소속</th>
                    <th style="width:70px;">상태</th>
                    <th style="width:80px;">서명</th>
                </tr></thead>
                <tbody>
                    ${grpEntries.map((e, i) => `<tr>
                        <td><strong>${e.lane_number || ''}</strong></td>
                        <td><strong>${bib(e.bib_number)}</strong></td>
                        ${hasSubGroup ? `<td><strong style="color:${e.sub_group==='A'?'#555':e.sub_group==='B'?'#8b1a2a':'#999'};">${e.sub_group || '—'}</strong></td>` : ''}
                        <td style="text-align:left;">${e.name}</td>
                        <td style="text-align:left;font-size:11px;">${e.team || ''}</td>
                        <td>${e.status === 'checked_in' ? '출석' : e.status === 'no_show' ? '결석' : '—'}</td>
                        <td></td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
        }

        tablesHtml += `</div>`;
    }

    // Open print window
    const printWin = window.open('', '_blank', 'width=800,height=600');
    printWin.document.write(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>소집 명단 — ${evt.name} ${roundLabel} ${gL}</title>
<style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Malgun Gothic','맑은 고딕',sans-serif; font-size:12px; padding:20px; color:#000; }
    .print-header { text-align:center; margin-bottom:16px; border-bottom:3px double #333; padding-bottom:10px; }
    .print-header h1 { font-size:20px; margin-bottom:2px; }
    .print-header h2 { font-size:15px; font-weight:400; color:#333; }
    .print-header .print-comp { font-size:14px; font-weight:700; color:#000; margin-top:4px; letter-spacing:0.3px; }
    .print-header .print-schedule { font-size:13px; color:#333; margin-top:3px; font-weight:600; }
    .print-header .print-date { font-size:11px; color:#666; margin-top:4px; }
    .print-header .print-event-memo { font-size:24px; font-weight:700; color:#6b6b6b; margin-top:8px; padding:8px 12px; border:2px solid #6b6b6b; border-radius:6px; background:#f0f0f0; }
    .print-heat-block { margin-bottom:20px; page-break-inside:avoid; }
    .print-table { width:100%; border-collapse:collapse; font-size:12px; }
    .print-table th, .print-table td { border:1px solid #999; padding:5px 8px; text-align:center; }
    .print-table th { background:#eee; font-size:11px; font-weight:700; }
    .print-table td { height:28px; }
    .print-footer { margin-top:24px; border-top:1px solid #ccc; padding-top:10px; display:flex; justify-content:space-between; font-size:11px; color:#666; }
    .sign-area { margin-top:30px; display:flex; gap:60px; justify-content:flex-end; }
    .sign-area div { text-align:center; }
    .sign-area .sign-line { border-bottom:1px solid #333; width:100px; height:30px; margin-bottom:4px; }
    @media print {
        body { padding:10px; }
        .no-print { display:none !important; }
    }
</style>
</head>
<body>
    <div class="print-header">
        <h1>소집 명단</h1>
        ${compNamesLabel ? `<div class="print-comp">${compNamesLabel}</div>` : ''}
        <h2>${gL} ${evt.name} ${roundLabel}</h2>
        ${scheduleLabel ? `<div class="print-schedule">${scheduleLabel}</div>` : ''}
        <div class="print-date">출력일시: ${dateStr}</div>
        ${eventMemo ? `<div class="print-event-memo">${eventMemo}</div>` : ''}
    </div>
    ${tablesHtml}
    <div class="sign-area">
        <div><div class="sign-line"></div><span>소집 담당</span></div>
        <div><div class="sign-line"></div><span>확인</span></div>
    </div>
    <div class="print-footer">
        <span>PACE RISE Competition OS</span>
        <span>${mode === 'all' ? '전체 조' : heatsToPrint[0].heat_number + '조'} | 총 ${heatsToPrint.length}개 조</span>
    </div>
    <div class="no-print" style="text-align:center;margin-top:20px;">
        <button onclick="window.print()" style="padding:10px 30px;font-size:14px;cursor:pointer;">인쇄하기</button>
        <button onclick="window.close()" style="padding:10px 30px;font-size:14px;cursor:pointer;margin-left:10px;">닫기</button>
    </div>
</body>
</html>`);
    printWin.document.close();
}

// ============================================================
// Excel Export — download callroom data as .xlsx
// ============================================================
async function exportCallroomExcel() {
    if (!crSelectedEvent || !crHeats || crHeats.length === 0) return;
    if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리를 불러올 수 없습니다.'); return; }

    const evt = crSelectedEvent;
    const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
    const roundLabel = fmtRound(evt.round_type);

    const rows = [];

    // ─── 자동 헤더: 대회명 + 종목/부/라운드 + 시간표 시각 ─────────────────
    let compNamesLabel = '';
    try {
        const comps = await API.getCompetitions();
        const jointGroup = window._crJointGroup || null;
        if (jointGroup && Array.isArray(jointGroup.members) && jointGroup.members.length > 1) {
            const labels = jointGroup.members.map(m => {
                const c = comps.find(x => x.id === m.competition_id);
                return m.federation || m.comp_name || (c && c.name) || '';
            }).filter(Boolean);
            compNamesLabel = [...new Set(labels)].join(' / ');
        } else {
            const comp = comps.find(c => c.id === evt.competition_id);
            compNamesLabel = comp ? (comp.name || '') : '';
        }
    } catch(e) {}
    let scheduleLabel = '';
    try {
        if (!_crScheduleMap || Object.keys(_crScheduleMap).length === 0) {
            _crScheduleMap = await fetch('/api/timetable/' + getCompetitionId() + '/event-schedule').then(r => r.json()) || {};
        }
        const sch = _crScheduleMap && _crScheduleMap[evt.id];
        if (sch) {
            const parts = [];
            if (sch.scheduled_date) parts.push(sch.scheduled_date);
            if (sch.time) parts.push('경기 ' + sch.time);
            if (sch.callroom_time) parts.push('소집 ' + sch.callroom_time);
            scheduleLabel = parts.join(' · ');
        }
    } catch(e) {}

    if (compNamesLabel) rows.push([compNamesLabel]);
    rows.push([`${gL} ${evt.name} ${roundLabel}`]);
    if (scheduleLabel) rows.push([scheduleLabel]);
    rows.push([]); // blank row

    // Get event-level memo
    let eventMemo = '';
    try {
        const memoRes = await API.getEventMemo(crSelectedEventId);
        eventMemo = memoRes.memo || '';
    } catch(e) {}

    // Event memo row (if set)
    if (eventMemo) {
        rows.push(['소집 메모: ' + eventMemo]);
        rows.push([]); // blank row
    }

    // 그룹(A/B) 컬럼은 데이터가 있을 때만 노출
    //   — 5000m/10000m 등 장거리 그룹 결승에서만 의미가 있음
    let hasSubGroupAny = false;
    const heatEntriesCache = [];
    for (const heat of crHeats) {
        const entries = await API.getHeatEntries(heat.id);
        heatEntriesCache.push({ heat, entries });
        if (entries.some(e => e.sub_group)) hasSubGroupAny = true;
    }

    // Header row
    if (hasSubGroupAny) {
        rows.push(['조', '그룹', 'BIB', '바코드', '스몰넘버', '선수명', '소속', '상태']);
    } else {
        rows.push(['조', 'BIB', '바코드', '스몰넘버', '선수명', '소속', '상태']);
    }

    for (const { heat, entries } of heatEntriesCache) {
        // 그룹이 있을 땐 그룹별로 정렬 (A → B → null)
        const sortedEntries = hasSubGroupAny
            ? [...entries].sort((a, b) => {
                const ga = a.sub_group || 'Z'; // null 은 마지막
                const gb = b.sub_group || 'Z';
                if (ga !== gb) return ga.localeCompare(gb);
                return (a.lane_number || 999) - (b.lane_number || 999);
            })
            : entries;
        sortedEntries.forEach((e, i) => {
            const statusText = e.status === 'checked_in' ? '출석'
                : e.status === 'no_show' ? '결석' : '미확인';
            if (hasSubGroupAny) {
                rows.push([
                    heat.heat_number + '조',
                    e.sub_group || '',
                    e.bib_number || '',
                    e.barcode || '',
                    i + 1,
                    e.name,
                    e.team || '',
                    statusText
                ]);
            } else {
                rows.push([
                    heat.heat_number + '조',
                    e.bib_number || '',
                    e.barcode || '',
                    i + 1,
                    e.name,
                    e.team || '',
                    statusText
                ]);
            }
        });
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Column widths
    ws['!cols'] = hasSubGroupAny ? [
        { wch: 6 },  // 조
        { wch: 6 },  // 그룹
        { wch: 8 },  // BIB
        { wch: 12 }, // 바코드
        { wch: 10 }, // 스몰넘버
        { wch: 12 }, // 선수명
        { wch: 16 }, // 소속
        { wch: 8 },  // 상태
    ] : [
        { wch: 6 },  // 조
        { wch: 8 },  // BIB
        { wch: 12 }, // 바코드
        { wch: 10 }, // 스몰넘버
        { wch: 12 }, // 선수명
        { wch: 16 }, // 소속
        { wch: 8 },  // 상태
        { wch: 20 }, // 메모
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '소집명단');
    const fileName = `소집_${evt.name}_${gL}_${roundLabel}.xlsx`;
    XLSX.writeFile(wb, fileName);
}
