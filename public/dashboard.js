/**
 * PACE RISE : Node — dashboard.js v8
 * Real-time viewer: wait → summon → result flow
 * Gender colors, competition-scoped, favorites via localStorage
 * Video modal integration on event matrix + comp header
 */

// Helper: display bib_number safely (null/undefined → '—')
function bib(val) { return val != null && val !== '' ? val : '—'; }

let allEvents = [];
let currentGender = 'M';
let callroomCompletedIds = new Set();
let currentRole = localStorage.getItem('pace_role') || 'viewer';
let _compVideoUrl = ''; // Competition-level video URL
let _pacingMap = {}; // event_name → pacing config (for W/L Target buttons)
let _scheduleMap = {}; // event_id → { time, callroom_time, is_today } from timetable
let _isDisplayMode = false; // 노출용 대회 모드
let _displayRoster = []; // 노출용 대회 명단
let _currentDivision = '전체'; // 부별 필터

// Favorites: stored per-user in localStorage keyed by compId
function getFavorites() {
    const compId = getCompetitionId();
    try { return JSON.parse(localStorage.getItem(`pace_favorites_${compId}`) || '[]'); } catch { return []; }
}
function setFavorites(favs) {
    const compId = getCompetitionId();
    localStorage.setItem(`pace_favorites_${compId}`, JSON.stringify(favs));
}
function toggleFavorite(eventName) {
    const favKey = currentGender + '|' + eventName;
    let favs = getFavorites();
    if (favs.includes(favKey)) { favs = favs.filter(f => f !== favKey); }
    else { favs.push(favKey); }
    setFavorites(favs);
    renderMatrix();
}

document.addEventListener('DOMContentLoaded', async () => {
    if (!(await requireCompetition())) return;
    renderPageNav('dashboard');
    await renderCompInfoBar();
    await loadData();

    // SSE listeners
    onSSE('callroom_complete', async (data) => {
        if (_rosterModalEventId && data.event_id === _rosterModalEventId) {
            await loadRosterModalData(_rosterModalEventId);
        }
        await loadData();
    });
    onSSE('event_completed', async () => { await loadData(); });
    onSSE('event_reverted', async () => { await loadData(); });
    onSSE('event_status_changed', async () => { await loadData(); });
    onSSE('result_update', async (data) => {
        // Refresh live result if viewing this event
        if (_liveEventId && _liveHeatId === data.heat_id) await refreshLiveResult();
        // Also refresh data to update button states
        await loadData();
    });
    onSSE('height_update', async (data) => {
        if (_liveEventId && _liveHeatId === data.heat_id) await refreshLiveResult();
    });
    onSSE('combined_update', async () => {
        if (_liveEventId) await refreshLiveResult();
    });
    onSSE('wind_update', async (data) => {
        if (_liveEventId && _liveHeatId === data.heat_id) await refreshLiveResult();
    });
    onSSE('pacing_update', async () => {
        await loadData();
    });
    // Auto-refresh roster modal when heats change
    onSSE('heat_update', async (data) => {
        if (_rosterModalEventId && data.event_id === _rosterModalEventId) {
            await loadRosterModalData(_rosterModalEventId);
        }
        await loadData();
    });
    onSSE('entry_status', async (data) => {
        if (_rosterModalEventId && data.event_id === _rosterModalEventId) {
            await loadRosterModalData(_rosterModalEventId);
        }
    });
});

async function loadData() {
    const compId = getCompetitionId();
    allEvents = await API.getAllEvents(compId);
    try {
        const cs = await API.getCallroomStatus();
        callroomCompletedIds = new Set(cs.completed_event_ids);
    } catch (e) {}
    // Load competition info (video URL + mode)
    try {
        const comp = await API.getCompetition(compId);
        _compVideoUrl = comp.video_url || '';
        _isDisplayMode = comp.mode === 'display';
    } catch(e) { _compVideoUrl = ''; _isDisplayMode = false; }
    // Load display roster if display mode
    if (_isDisplayMode) {
        try {
            _displayRoster = await fetch('/api/display/roster/' + compId).then(r => r.json());
        } catch(e) { _displayRoster = []; }
    }
    // Auto-detect display mode: if events have divisions but mode isn't set, enable display mode
    if (!_isDisplayMode) {
        const hasDivisions = allEvents.some(e => !e.parent_event_id && e.division);
        if (hasDivisions) {
            _isDisplayMode = true;
            // Still try to load display roster
            try {
                _displayRoster = await fetch('/api/display/roster/' + compId).then(r => r.json());
            } catch(e) { _displayRoster = []; }
        }
    }
    // Load pacing configs for W/L Target (supports gender-separated keys like "800m (남)")
    try {
        const pConfigs = await API.getPublicPacing(compId);
        _pacingMap = {};
        pConfigs.forEach(cfg => { _pacingMap[cfg.event_name] = cfg; });
    } catch(e) { _pacingMap = {}; }
    // Load timetable schedule for time badges
    try {
        const sched = await fetch('/api/timetable/' + compId + '/event-schedule').then(r => r.json());
        _scheduleMap = sched || {};
    } catch(e) { _scheduleMap = {}; }
    renderCompVideoButton();
    // Render division filter tabs when events have divisions (regardless of mode setting)
    renderDivisionTabs();
    renderMatrix();
}

// Render competition-level video button next to comp-info-bar
function renderCompVideoButton() {
    let btn = document.getElementById('comp-video-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'comp-video-btn';
        btn.className = 'btn btn-sm btn-outline';
        btn.style.cssText = 'margin-left:auto;white-space:nowrap;font-size:12px;padding:5px 12px;display:none;';
        btn.innerHTML = '&#9654; 대회 영상';
        btn.onclick = () => {
            if (_compVideoUrl) openVideoModal(_compVideoUrl, '대회 대표 영상');
        };
        const bar = document.getElementById('comp-info-bar');
        if (bar) bar.appendChild(btn);
    }
    btn.style.display = _compVideoUrl ? '' : 'none';
}

function switchGender(g, btn) {
    currentGender = g;
    document.querySelectorAll('.gender-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMatrix();
}

// Division filter tabs for display mode (fixed order: 중등부→고등부→대학부→일반부→U20→국제)
const DIVISION_ORDER = ['중등부','고등부','대학부','일반부','U20','국제'];

function renderDivisionTabs() {
    let divBar = document.getElementById('division-tabs');
    if (!divBar) {
        divBar = document.createElement('div');
        divBar.id = 'division-tabs';
        divBar.style.cssText = 'display:flex;gap:0;background:var(--white);padding:4px 0;border-bottom:1px solid var(--gray);flex-wrap:wrap;';
        const genderTabs = document.getElementById('gender-tabs');
        if (genderTabs) genderTabs.after(divBar);
    }
    const existingDivs = new Set(allEvents.filter(e => !e.parent_event_id).map(e => e.division).filter(Boolean));
    if (existingDivs.size === 0) { divBar.style.display = 'none'; return; }
    divBar.style.display = 'flex';
    // Use fixed order, only show divisions that have events
    const orderedDivs = DIVISION_ORDER.filter(d => existingDivs.has(d));
    // Add any extra divisions not in the fixed order
    existingDivs.forEach(d => { if (!orderedDivs.includes(d)) orderedDivs.push(d); });
    const all = ['전체', ...orderedDivs];
    divBar.innerHTML = all.map(d => `<button class="gender-tab-btn${d===_currentDivision?' active':''}" style="flex:none;padding:6px 14px;font-size:12px;font-weight:700;color:#555;border-bottom:2px solid transparent;${d===_currentDivision?'color:#b79f58;border-bottom-color:#b79f58;background:#f8f4ea;':''}" onclick="switchDivision('${d}',this)">${d}</button>`).join('');
}

function switchDivision(div, btn) {
    _currentDivision = div;
    document.querySelectorAll('#division-tabs button').forEach(b => { b.classList.remove('active'); b.style.color='#555'; b.style.borderBottomColor='transparent'; b.style.background='none'; });
    if (btn) { btn.classList.add('active'); btn.style.color='#b79f58'; btn.style.borderBottomColor='#b79f58'; btn.style.background='#f8f4ea'; }
    renderMatrix();
}

function renderMatrix() {
    const container = document.getElementById('events-container');
    let events = allEvents.filter(e => e.gender === currentGender && !e.parent_event_id);
    // Apply division filter for display mode
    if (_isDisplayMode && _currentDivision !== '전체') {
        events = events.filter(e => e.division === _currentDivision);
    }

    const categories = [
        { key: 'track', label: 'TRACK', match: c => c === 'track' },
        { key: 'field', label: 'FIELD', match: c => c === 'field_distance' || c === 'field_height' },
        { key: 'combined', label: 'COMBINED', match: c => c === 'combined' },
        { key: 'relay', label: 'RELAY', match: c => c === 'relay' },
        { key: 'road', label: 'ROAD', match: c => c === 'road' },
    ];

    // Group events by name (+ division for display mode)
    const eventGroups = {};
    events.forEach(e => {
        const gKey = _isDisplayMode ? (e.name + '|' + e.category + '|' + (e.division||'')) : (e.name + '|' + e.category);
        if (!eventGroups[gKey]) eventGroups[gKey] = { name: e.name, category: e.category, division: e.division || '', rounds: [] };
        eventGroups[gKey].rounds.push(e);
    });

    const allGroups = [];
    const EVENT_SORT_ORDER = ['60m','100m','200m','400m','800m','1500m','3000m','5000m','10000m','60mH','100mH','110mH','400mH','3000mSC','5000mW','10000mW','10kmW','20kmW','50kmW','높이뛰기','장대높이뛰기','멀리뛰기','세단뛰기','포환던지기','원반던지기','해머던지기','창던지기','4x100mR','4x400mR','4x800mR','4x1500mR','4x400mR(믹스)','7종경기','10종경기'];
    function _evSortIdx(name) { const n=(name||'').replace(/\s/g,''); for(let i=0;i<EVENT_SORT_ORDER.length;i++){if(n===EVENT_SORT_ORDER[i]||n.startsWith(EVENT_SORT_ORDER[i]))return i;} return 999; }
    function _divSortIdx(div) { const idx=DIVISION_ORDER.indexOf(div); return idx>=0?idx:999; }
    categories.forEach(cat => {
        const groups = Object.values(eventGroups).filter(g => cat.match(g.category));
        // Sort groups by event standard order, then division
        groups.sort((a,b) => _evSortIdx(a.name) - _evSortIdx(b.name) || _divSortIdx(a.division) - _divSortIdx(b.division) || a.name.localeCompare(b.name));
        groups.forEach(g => allGroups.push({ ...g, catKey: cat.key, catLabel: cat.label }));
    });

    let html = '';

    // 종합기록지 버튼 삭제됨 — 관리자 문서 탭에서 다운로드

    // Render LIVE (in_progress) section pinned at top
    const liveGroups = allGroups.filter(g => g.rounds.some(r => r.round_status === 'in_progress'));
    if (liveGroups.length > 0) {
        html += `<div style="margin-bottom:16px;padding:12px;background:linear-gradient(135deg,#f8f4ea,#fbe9e7);border:1.5px solid #b79f58;border-radius:var(--radius);">
            <div style="font-family:var(--font-brand);font-size:13px;font-weight:400;color:#b79f58;letter-spacing:1px;margin-bottom:8px;">● LIVE • 진행중인 경기</div>`;
        html += renderCategoryTable(liveGroups, 'LIVE', true);
        html += `</div>`;
    }

    // Render by category
    categories.forEach(cat => {
        const groups = allGroups.filter(g => g.catKey === cat.key);
        if (groups.length === 0) return;
        html += renderCategoryTable(groups, cat.label);
    });

    if (!html) html = '<div style="text-align:center;padding:40px;color:var(--text-muted);">해당 성별의 종목이 없습니다.</div>';
    container.innerHTML = html;
}

function renderCategoryTable(groups, label, isLive) {
    const favs = getFavorites();
    let html = `<div class="matrix-section">
        <div class="matrix-section-title">${label}</div>
        <div class="matrix-scroll-wrap">
        <table class="matrix-table">
            <thead><tr>
                <th style="text-align:left;">종목</th>
                ${_isDisplayMode ? '<th style="width:60px;">명단</th>' : '<th style="width:52px;">W/L</th>'}
                <th style="width:72px;"><span style="color:#1565c0;">예선</span></th>
                <th style="width:72px;"><span style="color:#e65100;">준결승</span></th>
                <th style="width:72px;"><span style="color:#b71c1c;">결승</span></th>
            </tr></thead>
            <tbody>`;

    groups.forEach(g => {
        const prelim = g.rounds.find(r => r.round_type === 'preliminary');
        const semi = g.rounds.find(r => r.round_type === 'semifinal');
        const fin = g.rounds.find(r => r.round_type === 'final');
        const _gLabel = currentGender === 'M' ? '남' : currentGender === 'F' ? '여' : '혼성';
        const pacingCfg = _pacingMap[g.name + ' (' + _gLabel + ')'] || _pacingMap[g.name];
        const _pacingKey = pacingCfg ? pacingCfg.event_name : g.name;
        const wlCell = pacingCfg ? `<span class="round-btn" style="background:#f0f9ff;color:#6b6b6b;border:1px solid #c0c0c0;cursor:pointer;font-size:9px;padding:3px 6px;white-space:nowrap;" onclick="openPacingPopup('${_pacingKey.replace(/'/g, "\\'")}')">Target</span>` : '';

        // Display mode: roster button + external link buttons
        let rosterCell = '';
        if (_isDisplayMode) {
            // Check if any round has roster data
            const eventIds = g.rounds.map(r => r.id);
            const hasRoster = _displayRoster.some(dr => eventIds.includes(dr.event_id));
            if (hasRoster) {
                const firstId = eventIds[0];
                rosterCell = `<span class="round-btn" style="background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;cursor:pointer;font-size:10px;padding:3px 6px;" onclick="openDisplayRoster(${firstId},'${(g.name||'').replace(/'/g,"\\'")}','${g.division||''}')">명단</span>`;
            } else {
                rosterCell = '<span class="round-btn btn-disabled" style="font-size:10px;">—</span>';
            }
        }

        // Time badge from schedule (show time for first available round: final > semifinal > preliminary)
        const schedEvt = fin ? _scheduleMap[fin.id] : (semi ? _scheduleMap[semi.id] : (prelim ? _scheduleMap[prelim.id] : null));
        let timeBadge = '';
        if (schedEvt && schedEvt.time) {
            const tColor = schedEvt.is_today ? '#b79f58' : '#999';
            const tBg = schedEvt.is_today ? '#f8f4ea' : '#f5f5f5';
            const crBadge = isCallRoomWindow(schedEvt.callroom_time, schedEvt.scheduled_date) ? ' <span class="ico-callroom">Call Room</span>' : '';
            const dayLabel = schedEvt.day ? `<span style="font-size:8px;color:#666;background:#eee;padding:1px 3px;border-radius:3px;margin-right:2px;">Day-${schedEvt.day}</span>` : '';
            timeBadge = `${dayLabel}<span style="font-size:9px;color:${tColor};background:${tBg};padding:1px 5px;border-radius:6px;margin-left:2px;font-weight:600;font-variant-numeric:tabular-nums;" title="${schedEvt.callroom_time ? '소집 ' + schedEvt.callroom_time : ''}">${schedEvt.time}</span>${crBadge}`;
        }

        // Division badge for display mode (color-coded by division)
        const _divColors = {
            '중등부': { color: '#1565c0', bg: '#e3f2fd' },
            '고등부': { color: '#e65100', bg: '#fff3e0' },
            '대학부': { color: '#4a148c', bg: '#f3e5f5' },
            '일반부': { color: '#1b5e20', bg: '#e8f5e9' },
            'U20': { color: '#b71c1c', bg: '#ffebee' },
            '국제': { color: '#006064', bg: '#e0f7fa' }
        };
        const _dc = _divColors[g.division] || { color: '#6a1b9a', bg: '#f3e5f5' };
        const divBadge = (_isDisplayMode && g.division && _currentDivision === '전체') ? `<span style="font-size:9px;color:${_dc.color};background:${_dc.bg};padding:1px 5px;border-radius:6px;margin-left:4px;font-weight:600;">${g.division}</span>` : '';

        html += `<tr>
            <td class="event-name">${g.name}${divBadge}${timeBadge}</td>
            <td>${_isDisplayMode ? rosterCell : wlCell}</td>
            <td>${_isDisplayMode ? renderDisplayBtn(prelim) : renderViewerBtn(prelim)}</td>
            <td>${_isDisplayMode ? renderDisplayBtn(semi) : renderViewerBtn(semi)}</td>
            <td>${_isDisplayMode ? renderDisplayBtn(fin) : renderViewerBtn(fin)}</td>
        </tr>`;
    });

    html += `</tbody></table></div></div>`;
    return html;
}

/**
 * Viewer flow:
 * - created (no heats) → "대기" button (disabled)
 * - heats_generated → "명단" button (opens roster modal)
 * - in_progress → "LIVE" button (shows live results); judges also get "기록" link
 * - completed → "결과" button (shows results)
 */
function renderViewerBtn(evt) {
    if (!evt) return '<span class="round-btn btn-disabled">—</span>';

    const isAdmin = currentRole === 'admin';
    const isJudge = currentRole === 'operation' || isAdmin;
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';
    const hasHeats = evt.heat_count > 0;
    const isCallroomDone = callroomCompletedIds.has(evt.id);

    const rc = _roundColors[evt.round_type] || { color: '#555', bg: '#f5f5f5', border: '#ccc' };

    if (evt.round_status === 'completed') {
        return `<span class="round-btn" onclick="openResult(${evt.id})" title="결과 확인" style="background:${rc.bg};color:${rc.color};border:1px solid ${rc.border};cursor:pointer;font-size:10px;padding:3px 6px;font-weight:700;">완료</span>`;
    }

    // 소집 완료 또는 in_progress → LIVE (경기 진행 중)
    if (evt.round_status === 'in_progress' || isCallroomDone) {
        const compQ = getCompetitionId() ? `&comp=${getCompetitionId()}` : '';
        let btns = `<span class="round-btn btn-live" onclick="openLiveResult(${evt.id})" title="실시간 기록 보기" style="cursor:pointer;background:#f8f4ea;color:#b79f58;border:1px solid #e8dfc0;font-size:10px;padding:3px 6px;font-weight:700;">LIVE</span>`;
        if (isJudge) {
            btns += ` <a class="round-btn" href="/record.html?event_id=${evt.id}${compQ}" title="기록 입력" style="background:${rc.bg};color:${rc.color};border:1px solid ${rc.border};font-size:10px;padding:3px 6px;text-decoration:none;">기록</a>`;
        }
        return btns;
    }

    // 히트가 있고 아직 소집 전 → 명단 버튼
    if (hasHeats) {
        const eName = (evt.name || '').replace(/'/g, "\\'");
        return `<span class="round-btn" style="background:${rc.bg};color:${rc.color};border:1px solid ${rc.border};cursor:pointer;font-size:10px;padding:3px 6px;white-space:nowrap;" onclick="openRosterModal(${evt.id},'${eName}')" title="조편성 명단">명단</span>`;
    }

    // created — 대기
    return `<span class="round-btn btn-disabled" style="font-size:10px;padding:3px 6px;border:1px solid #eee;" title="대기중">대기</span>`;
}

/**
 * Display-mode button renderer:
 * - result_url exists → active link button (opens external URL)
 * - no result_url → grey disabled button
 */
// Round-type color mapping for better visual distinction
const _roundColors = {
    preliminary: { color: '#1565c0', bg: '#e3f2fd', border: '#90caf9' },
    semifinal:   { color: '#e65100', bg: '#fff3e0', border: '#ffcc80' },
    final:       { color: '#b71c1c', bg: '#ffebee', border: '#ef9a9a' }
};

function renderDisplayBtn(evt) {
    if (!evt) return '<span class="round-btn btn-disabled">—</span>';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';
    const rc = _roundColors[evt.round_type] || { color: '#1565c0', bg: '#e3f2fd', border: '#90caf9' };
    if (evt.result_url) {
        return `<a class="round-btn" href="${evt.result_url}" target="_blank" rel="noopener" style="background:${rc.bg};color:${rc.color};border:1px solid ${rc.border};cursor:pointer;font-size:10px;padding:3px 8px;text-decoration:none;font-weight:700;" title="결과 보기 (외부 링크)">${roundL || '결과'}</a>`;
    }
    return `<span class="round-btn btn-disabled" style="font-size:10px;padding:3px 6px;" title="결과 링크 없음">${roundL || '—'}</span>`;
}

/**
 * Display-mode roster popup — shows uploaded athlete list
 */
async function openDisplayRoster(eventId, eventName, division) {
    const overlay = document.getElementById('result-overlay');
    const panel = document.getElementById('result-panel');
    const compId = getCompetitionId();

    // Get all roster entries for this event and related rounds
    const evtRoster = _displayRoster.filter(dr => dr.event_id === eventId);
    // Also try to find roster for sibling events (same name + division but different rounds)
    const siblingEvents = allEvents.filter(e => e.name === eventName && (e.division || '') === (division || '') && e.gender === currentGender);
    const siblingIds = siblingEvents.map(e => e.id);
    const allRoster = _displayRoster.filter(dr => siblingIds.includes(dr.event_id));

    const gLabel = currentGender === 'M' ? '남자' : currentGender === 'F' ? '여자' : '혼성';
    const divLabel = division ? ` ${division}` : '';

    let bodyHtml = '';
    if (allRoster.length === 0) {
        bodyHtml = '<div style="text-align:center;padding:30px;color:#888;">등록된 명단이 없습니다.</div>';
    } else {
        // Group by round
        const groups = {};
        allRoster.forEach(r => {
            const key = r.round || '결승';
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        });

        Object.entries(groups).forEach(([round, athletes]) => {
            bodyHtml += `<div style="margin-bottom:16px;">
                <div style="font-size:13px;font-weight:700;padding:6px 10px;background:#f5f5f5;border-radius:4px;margin-bottom:6px;">${round} — ${athletes.length}명</div>`;
            
            // Group by heat (조별 그룹핑)
            const heats = {};
            athletes.forEach(a => {
                const hk = a.heat || 0;
                if (!heats[hk]) heats[hk] = [];
                heats[hk].push(a);
            });
            const heatKeys = Object.keys(heats).sort((a, b) => Number(a) - Number(b));
            const hasMultipleHeats = heatKeys.length > 1 || (heatKeys.length === 1 && heatKeys[0] !== '0');

            heatKeys.forEach(hk => {
                const hAthletes = heats[hk].sort((a, b) => (a.lane || 99) - (b.lane || 99));
                if (hasMultipleHeats) {
                    const hLabel = hk == 0 ? '조 미지정' : hk + '조';
                    bodyHtml += `<div style="font-size:12px;font-weight:700;color:#b79f58;padding:5px 10px;margin-top:8px;margin-bottom:4px;background:#f8f4ea;border-radius:4px;display:flex;justify-content:space-between;"><span>${hLabel}</span><span style="color:#888;font-weight:500;">${hAthletes.length}명</span></div>`;
                }
                bodyHtml += `<table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
                <colgroup><col style="width:50px"><col style="width:60px"><col style="width:auto"><col style="width:40%"></colgroup>
                <thead><tr style="border-bottom:2px solid #e5e7eb;">
                    <th style="padding:8px 4px;text-align:center;font-size:11px;color:#888;">레인</th>
                    <th style="padding:8px 4px;text-align:center;font-size:11px;color:#888;">배번</th>
                    <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;">성명</th>
                    <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;">소속</th>
                </tr></thead><tbody>`;
                hAthletes.forEach(a => {
                    bodyHtml += `<tr style="border-bottom:1px solid #f0f0f0;">
                        <td style="padding:8px 4px;text-align:center;font-weight:700;color:#b79f58;">${a.lane || '—'}</td>
                        <td style="padding:8px 4px;text-align:center;font-weight:700;">${a.bib_number || ''}</td>
                        <td style="padding:8px 12px;font-weight:600;">${a.athlete_name}</td>
                        <td style="padding:8px 12px;color:#555;">${a.team || ''}</td>
                    </tr>`;
                });
                bodyHtml += '</tbody></table>';
            });
            bodyHtml += '</div>';
        });
    }

    panel.innerHTML = `<div class="result-panel-header">
        <h3>${eventName} ${gLabel}${divLabel} — 참가선수 명단</h3>
        <button class="result-panel-close" onclick="closeResult()">&times;</button>
    </div><div class="result-panel-body">${bodyHtml}</div>`;
    overlay.classList.add('show');
    if (window.pushModalState) pushModalState(() => closeResult());
}

// ============================================================
// Result overlay
// ============================================================

async function openResult(eventId) {
    const overlay = document.getElementById('result-overlay');
    const panel = document.getElementById('result-panel');
    panel.innerHTML = '<div class="result-panel-header"><h3>결과 불러오는 중...</h3><button class="result-panel-close" onclick="closeResult()">&times;</button></div><div class="result-panel-body" style="text-align:center;padding:40px;">로딩 중...</div>';
    overlay.classList.add('show');
    if (window.pushModalState) pushModalState(() => closeResult());

    try {
        const data = await API.getFullResults(eventId);
        const evt = data.event;
        const gL = getGenderLabel(evt.gender);
        const roundL = fmtRound(evt.round_type);

        // Get video URL
        let videoUrl = '';
        try { const vr = await API.getEventVideoUrl(eventId); videoUrl = vr.video_url || ''; } catch(e){}

        let bodyHtml = '';
        bodyHtml += buildEmbedVideoHTML(videoUrl);

        if (evt.category === 'track' || evt.category === 'relay' || evt.category === 'road') {
            let relayMembers = null;
            if (evt.category === 'relay') {
                try { relayMembers = normalizeRelayMembers(await API.getRelayMembersBatch(evt.id)); } catch(e) {}
            }
            bodyHtml += renderTrackResults(data, relayMembers);
        } else if (evt.category === 'field_distance') {
            bodyHtml += renderFieldDistResults(data);
        } else if (evt.category === 'field_height') {
            bodyHtml += renderFieldHeightResults(data);
        } else if (evt.category === 'combined') {
            bodyHtml += renderCombinedResults(data);
        } else {
            bodyHtml += '<div style="color:var(--text-muted);">결과 데이터 없음</div>';
        }

        panel.innerHTML = `<div class="result-panel-header">
            <h3>${evt.name} ${roundL} ${gL}</h3>
            <button class="result-panel-close" onclick="closeResult()">&times;</button>
        </div><div class="result-panel-body">${bodyHtml}</div>`;

        if (evt.category === 'combined') {
            _loadCombinedResultsAsync(evt);
        }
    } catch (e) {
        panel.innerHTML = `<div class="result-panel-header">
            <h3>오류</h3>
            <button class="result-panel-close" onclick="closeResult()">&times;</button>
        </div><div class="result-panel-body"><div style="color:var(--danger);">결과를 불러올 수 없습니다.</div></div>`;
    }
}

function closeResult() {
    const iframe = document.querySelector('#result-panel iframe');
    if (iframe) iframe.src = '';
    document.getElementById('result-overlay').classList.remove('show');
    if (window.popModalState) popModalState();
}

// ============================================================
// Relay members normalization (API returns object, renderers expect flat array)
// ============================================================
function normalizeRelayMembers(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw; // already flat
    // Convert {event_entry_id: {members: [...]}} to flat array with event_entry_id
    const flat = [];
    Object.entries(raw).forEach(([eid, val]) => {
        const members = val.members || val;
        if (Array.isArray(members)) {
            members.forEach(m => flat.push({ ...m, event_entry_id: parseInt(eid) }));
        }
    });
    return flat.length > 0 ? flat : null;
}

// ============================================================
// Embedded Video Section (inside result/live modals)
// ============================================================
function buildEmbedVideoHTML(videoUrl) {
    if (!videoUrl) return '';
    const ytId = extractYouTubeId(videoUrl);
    if (!ytId) return '';
    const startSec = extractYouTubeStart(videoUrl);
    const startParam = startSec > 0 ? `&start=${startSec}` : '';
    const embedSrc = `https://www.youtube.com/embed/${ytId}?rel=0${startParam}`;
    return `<div id="modal-video-section" style="margin-bottom:12px;">
        <div onclick="toggleModalVideo()" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;user-select:none;">
            <span style="font-size:13px;font-weight:600;color:#374151;">\u25B6 \uC601\uC0C1 \uBCF4\uAE30</span>
            <span id="modal-video-arrow" style="font-size:11px;color:#9ca3af;">\u25B2</span>
        </div>
        <div id="modal-video-embed" style="display:block;margin-top:8px;">
            <div style="position:relative;padding-bottom:56.25%;height:0;border-radius:8px;overflow:hidden;background:#000;">
                <iframe id="modal-video-iframe" src="${embedSrc}" data-src="${embedSrc}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" allow="autoplay;encrypted-media;fullscreen" allowfullscreen></iframe>
            </div>
        </div>
    </div>`;
}
function toggleModalVideo() {
    const embed = document.getElementById('modal-video-embed');
    const arrow = document.getElementById('modal-video-arrow');
    const iframe = document.getElementById('modal-video-iframe');
    if (!embed) return;
    const isHidden = embed.style.display === 'none';
    embed.style.display = isHidden ? 'block' : 'none';
    arrow.textContent = isHidden ? '\u25B2' : '\u25BC';
    if (isHidden && iframe && !iframe.src.includes('youtube.com')) {
        iframe.src = iframe.dataset.src + '&autoplay=1';
    } else if (!isHidden && iframe) {
        iframe.src = '';
    }
}

// ============================================================
// Live Results — Real-time Dashboard
// ============================================================
let _liveEventId = null;
let _liveHeatId = null;

async function openLiveResult(eventId) {
    _liveEventId = eventId;
    const overlay = document.getElementById('result-overlay');
    const panel = document.getElementById('result-panel');
    panel.innerHTML = '<div class="result-panel-header"><h3><span style="background:#f8f4ea;color:#b79f58;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:8px;">● LIVE</span>로딩 중...</h3><button class="result-panel-close" onclick="closeLiveResult()">&times;</button></div><div class="result-panel-body" style="text-align:center;padding:40px;">실시간 기록 불러오는 중...</div>';
    overlay.classList.add('show');
    if (window.pushModalState) pushModalState(() => closeLiveResult());
    await refreshLiveResult();
}

async function refreshLiveResult() {
    if (!_liveEventId) return;
    const panel = document.getElementById('result-panel');
    try {
        const data = await API.getLiveResults(_liveEventId);
        const evt = data.event;
        const gL = getGenderLabel(evt.gender);
        const roundL = fmtRound(evt.round_type);

        // Get video URL
        let videoUrl = '';
        try { const vr = await API.getEventVideoUrl(evt.id); videoUrl = vr.video_url || ''; } catch(e){}
        // Preserve video closed state across SSE refreshes (video is open by default)
        const _prevVideoEmbed = document.getElementById('modal-video-embed');
        const _videoWasClosed = _prevVideoEmbed && _prevVideoEmbed.style.display === 'none';

        let bodyHtml = '';
        bodyHtml += buildEmbedVideoHTML(videoUrl);

        if (evt.category === 'track' || evt.category === 'relay' || evt.category === 'road') {
            let relayMembers = null;
            if (evt.category === 'relay') {
                try { relayMembers = normalizeRelayMembers(await API.getRelayMembersBatch(evt.id)); } catch(e) {}
            }
            bodyHtml += renderLiveTrackResults(data, relayMembers);
        } else if (evt.category === 'field_distance') {
            bodyHtml += renderLiveFieldDistResults(data);
        } else if (evt.category === 'field_height') {
            bodyHtml += renderLiveFieldHeightResults(data);
        } else if (evt.category === 'combined') {
            bodyHtml += renderLiveCombinedResults(data);
        } else {
            bodyHtml += '<div style="color:var(--text-muted);">결과 데이터 없음</div>';
        }

        bodyHtml += `<div style="margin-top:12px;font-size:11px;color:var(--text-muted);text-align:center;">자동 새로고침 | ${new Date().toLocaleTimeString('ko-KR')}</div>`;

        panel.innerHTML = `<div class="result-panel-header">
            <h3><span style="background:#f8f4ea;color:#b79f58;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:8px;">● LIVE</span>${evt.name} ${roundL} ${gL}</h3>
            <button class="result-panel-close" onclick="closeLiveResult()">&times;</button>
        </div><div class="result-panel-body">${bodyHtml}</div>`;
        // Restore video closed state after SSE refresh
        if (_videoWasClosed && videoUrl) {
            toggleModalVideo();
        }
    } catch (e) {
        panel.innerHTML = `<div class="result-panel-header">
            <h3>오류</h3>
            <button class="result-panel-close" onclick="closeLiveResult()">&times;</button>
        </div><div class="result-panel-body"><div style="color:var(--danger);">실시간 데이터를 불러올 수 없습니다.</div></div>`;
    }
}

function closeLiveResult() {
    _liveEventId = null;
    _liveHeatId = null;
    const iframe = document.querySelector('#result-panel iframe');
    if (iframe) iframe.src = '';
    document.getElementById('result-overlay').classList.remove('show');
    if (window.popModalState) popModalState();
}

function renderLiveTrackResults(data, relayMembers) {
    const isRelay = data.event?.category === 'relay';
    let html = '';
    // Load qualifications if available  
    const loadQuals = async () => {
        try { return await API.getQualifications(data.event.id); } catch(e) { return []; }
    };
    
    const _isFinalSingle = data.event?.round_type === 'final' && data.heats.length === 1;
    const _needsWind = requiresWindMeasurement(data.event?.name, data.event?.category);
    data.heats.forEach(h => {
        _liveHeatId = h.id; // Track latest heat for SSE
        const _hWind = h.wind != null ? parseFloat(h.wind) : null;
        const _isWindAided = _needsWind && _hWind != null && _hWind > 2.0;
        const windStr = h.wind != null ? `<span style="font-size:12px;color:${_isWindAided ? 'var(--accent)' : 'var(--text-muted)'};margin-left:8px;">풍속: ${formatWind(h.wind)} m/s</span>` : '';
        const refLabel = _isWindAided ? ' <span class="wind-ref-badge">참조기록</span>' : '';
        const _hLabel = _isFinalSingle ? '결승' : (h.heat_name || ('Heat ' + h.heat_number));
        html += `<h4 style="margin:12px 0 6px;">${_hLabel} ${windStr}${refLabel}</h4>`;
        const smallNumLabel = getSmallNumberLabel(data.event?.name, data.event?.category);
        const rows = h.entries.map(e => {
            const r = (h.results || []).find(r => r.event_entry_id === e.event_entry_id);
            return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code || '') : '', remark: r ? (r.remark || '') : '' };
        }).sort((a, b) => {
            if (a.status_code && !b.status_code) return 1;
            if (!a.status_code && b.status_code) return -1;
            if (a.time_seconds == null && b.time_seconds == null) return (a.lane_number || 99) - (b.lane_number || 99);
            if (a.time_seconds == null) return 1;
            if (b.time_seconds == null) return -1;
            return a.time_seconds - b.time_seconds;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.rank = r.status_code; return; }
            r.rank = r.time_seconds == null ? '—' : ((i > 0 && rows[i - 1].time_seconds === r.time_seconds && !rows[i - 1].status_code) ? rows[i - 1].rank : rk);
            rk = i + 2;
        });
        html += `<table class="data-table" style="font-size:13px;">
            <thead><tr><th>순위</th><th>${smallNumLabel}</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>기록</th><th>비고</th></tr></thead>
            <tbody>${rows.map(r => {
                const wMark = (_isWindAided && !r.status_code && r.time_seconds != null) ? '<span class="wind-aided-mark">w</span>' : '';
                let memberHtml = '';
                if (isRelay && relayMembers) {
                    const members = relayMembers.filter(m => m.event_entry_id === r.event_entry_id);
                    if (members.length > 0) {
                        const sorted = [...members].sort((a, b) => (a.leg_order || 99) - (b.leg_order || 99));
                        memberHtml = `<tr><td colspan="7" style="padding:2px 8px 6px 40px;background:#f8f9fa;border-bottom:2px solid #e5e7eb;">
                            <span style="font-size:10px;color:var(--text-muted);margin-right:6px;">주자:</span>
                            ${sorted.map(m => `<span style="font-size:11px;margin-right:10px;">${m.leg_order ? m.leg_order + '주 ' : ''}${m.name} <span style="color:var(--text-muted);">#${bib(m.bib_number)}</span></span>`).join('')}
                        </td></tr>`;
                    }
                }
                return `<tr style="${r.time_seconds != null ? 'background:#f0fff4;' : ''}">
                <td>${r.rank}</td><td>${r.lane_number || '—'}</td><td><strong>${bib(r.bib_number)}</strong></td>
                <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>
                <td style="font-family:monospace;font-weight:600;">${r.status_code ? `<span class="sc-badge">${r.status_code}</span>` : (r.time_seconds != null ? formatTime(r.time_seconds) + wMark : '<span style="color:var(--text-muted);">—</span>')}</td>
                <td style="font-size:11px;color:#666;">${r.remark || ''}</td>
            </tr>${memberHtml}`;
            }).join('')}</tbody></table>`;
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

function renderLiveFieldDistResults(data) {
    let html = '';
    data.heats.forEach(h => {
        _liveHeatId = h.id;
        const rows = h.entries.map(e => {
            const er = (h.results || []).filter(r => r.event_entry_id === e.event_entry_id);
            const att = {}, attWind = {};
            // Extract status_code from any result row (DNS/DNF/NM)
            let sc = '';
            er.forEach(r => {
                if (r.attempt_number) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; }
                if (r.status_code && !sc) sc = r.status_code.toUpperCase();
            });
            // Auto-NM: WA Rule 25.6 — 8명 이하면 6차시기까지, 초과면 3차시기까지 파울이어야 NM
            const allDists = Object.values(att);
            const foulCount = allDists.filter(d => d === 0).length;
            const passCount = allDists.filter(d => d === -1).length;
            const valid = allDists.filter(d => d > 0);
            const _totalAth = h.entries.length;
            const _nmThreshold = _totalAth <= 8 ? 6 : 3;
            if (!sc && (foulCount + passCount) >= _nmThreshold && valid.length === 0 && allDists.length >= _nmThreshold) sc = 'NM';
            const best = valid.length > 0 ? Math.max(...valid) : null;
            // WA: later attempt is the official record for same distance
            let bestWind = null;
            if (best != null) { for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } } }
            // Build sorted valid distances (descending) for WA tie-breaking
            const sortedValid = [];
            for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
            sortedValid.sort((a, b) => b - a);
            return { ...e, att, attWind, best, bestWind, status_code: sc, sortedValid };
        }).sort((a, b) => {
            if (a.status_code && !b.status_code) return 1;
            if (!a.status_code && b.status_code) return -1;
            if (a.best == null) return 1; if (b.best == null) return -1;
            if (b.best !== a.best) return b.best - a.best;
            // WA tie-break: 2nd best, 3rd best, etc.
            const maxLen = Math.max(a.sortedValid.length, b.sortedValid.length);
            for (let k = 1; k < maxLen; k++) {
                const aV = a.sortedValid[k] ?? -1, bV = b.sortedValid[k] ?? -1;
                if (bV !== aV) return bV - aV;
            }
            return 0;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.rank = `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>`; return; }
            if (r.best == null) { r.rank = '—'; return; }
            let isTied = i > 0 && rows[i - 1].best === r.best && !rows[i - 1].status_code;
            if (isTied) {
                const prev = rows[i - 1];
                const maxLen = Math.max(prev.sortedValid.length, r.sortedValid.length);
                for (let k = 1; k < maxLen; k++) {
                    if ((prev.sortedValid[k] ?? -1) !== (r.sortedValid[k] ?? -1)) { isTied = false; break; }
                }
            }
            r.rank = isTied ? rows[i - 1].rank : rk;
            rk = i + 2;
        });
        const needsWind = requiresWindMeasurement(data.event?.name, 'field_distance');
        if (needsWind) {
            html += `<table class="data-table field-table field-2row-table" style="font-size:12px;">
                <thead>
                    <tr><th rowspan="2">순위</th><th rowspan="2">순번</th><th style="text-align:left;">성명</th><th>배번</th>
                        <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th><th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th><th class="att-col-best" rowspan="2">기록</th><th rowspan="2">비고</th></tr>
                    <tr><th style="text-align:left;">소속</th><th></th>
                        <th class="wind-header att-col-first att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th>
                        <th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th></tr>
                </thead>
                <tbody>${rows.map(r => {
                    let distCells = '', windCells = '';
                    for (let i = 1; i <= 6; i++) {
                        const attCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                        const v = r.att[i];
                        const hasVal = v != null;
                        const isFoul = hasVal && v === 0;
                        const isPass = hasVal && v < 0;
                        distCells += `<td class="${attCls}" style="font-family:monospace;">${hasVal ? (isFoul ? '<span class="foul-mark">X</span>' : (isPass ? '<span class="pass-mark">-</span>' : formatHeight(v))) : ''}</td>`;
                        let wDisp = '';
                        if (hasVal && !isFoul && !isPass && r.attWind[i] != null) wDisp = formatWind(r.attWind[i]);
                        windCells += `<td class="wind-cell ${attCls}">${wDisp}</td>`;
                    }
                    const bestWindDisp = (r.bestWind != null) ? formatWind(r.bestWind) : '';
                    const _bestWindAided = needsWind && r.bestWind != null && parseFloat(r.bestWind) > 2.0 && r.best != null;
                    const bestWMark = _bestWindAided ? '<span class="wind-aided-mark">w</span>' : '';
                    const bestDisp = r.status_code ? '' : (r.best != null ? formatHeight(r.best) + bestWMark : '—');
                    const rankDisp = r.status_code ? '' : r.rank;
                    let remarkText = '';
                    if (r.status_code) remarkText = r.status_code;
                    else if (_bestWindAided) remarkText = '참고기록';
                    const remarkStyle = r.status_code ? 'color:var(--danger);font-weight:600;' : _bestWindAided ? 'color:var(--accent);font-weight:600;' : '';
                    return `<tr class="field-row1">
                        <td rowspan="2">${rankDisp}</td><td rowspan="2">${r.lane_number || '—'}</td>
                        <td style="text-align:left;">${r.name}</td><td><strong>${bib(r.bib_number)}</strong></td>
                        ${distCells}<td rowspan="2" class="best-cell att-col-best">${bestDisp}<div class="best-wind">${bestWindDisp}</div></td>
                        <td rowspan="2" style="font-size:11px;${remarkStyle}">${remarkText}</td>
                    </tr><tr class="field-row2">
                        <td class="team-cell">${r.team || ''}</td><td></td>${windCells}
                    </tr>`;
                }).join('')}</tbody></table>`;
        } else {
            html += `<table class="data-table field-table" style="font-size:12px;">
                <thead><tr><th>순위</th><th>순번</th><th style="text-align:left;">성명</th><th style="text-align:left;">소속</th><th>BIB</th>
                    <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th><th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th><th class="att-col-best">기록</th><th>비고</th></tr></thead>
                <tbody>${rows.map(r => {
                    let distCells = '';
                    for (let i = 1; i <= 6; i++) {
                        const attCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                        const v = r.att[i];
                        const hasVal = v != null;
                        const isFoul = hasVal && v === 0;
                        const isPass = hasVal && v < 0;
                        distCells += `<td class="${attCls}" style="font-family:monospace;">${hasVal ? (isFoul ? '<span class="foul-mark">X</span>' : (isPass ? '<span class="pass-mark">-</span>' : formatHeight(v))) : ''}</td>`;
                    }
                    const bestDisp2 = r.status_code ? '' : (r.best != null ? formatHeight(r.best) : '—');
                    const rankDisp2 = r.status_code ? '' : r.rank;
                    const remarkText2 = r.status_code || '';
                    const remarkStyle2 = r.status_code ? 'color:var(--danger);font-weight:600;' : '';
                    return `<tr>
                        <td>${rankDisp2}</td><td>${r.lane_number || '—'}</td>
                        <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td><td><strong>${bib(r.bib_number)}</strong></td>
                        ${distCells}<td class="att-col-best" style="font-weight:700;font-family:monospace;color:var(--green);">${bestDisp2}</td>
                        <td style="font-size:11px;${remarkStyle2}">${remarkText2}</td>
                    </tr>`;
                }).join('')}</tbody></table>`;
        }
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

function renderLiveFieldHeightResults(data) {
    let html = '';
    data.heats.forEach(h => {
        _liveHeatId = h.id;
        const ha = h.height_attempts || [];
        const hts = [...new Set(ha.map(a => a.bar_height))].sort((a, b) => a - b);
        const rows = h.entries.map(e => {
            const ea = ha.filter(a => a.event_entry_id === e.event_entry_id);
            const hd = {};
            ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
            let best = null, elim = false, hasAttempts = false;
            let totalFails = 0, failsAtBest = 0;
            hts.forEach(h2 => {
                const d = hd[h2]; if (!d) return;
                hasAttempts = true;
                const xCount = Object.values(d).filter(m => m === 'X').length;
                totalFails += xCount;
                if (Object.values(d).includes('O')) { best = h2; failsAtBest = xCount; }
                if (xCount >= 3) elim = true;
            });
            const isNM = elim && best == null && hasAttempts;
            return { ...e, hd, best, isNM, totalFails, failsAtBest };
        }).sort((a, b) => {
            if (a.best == null && b.best == null) return 0;
            if (a.best == null) return 1; if (b.best == null) return -1;
            if (b.best !== a.best) return b.best - a.best;
            // WA tie-break: fewer fails at best height, then fewer total fails
            if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
            return a.totalFails - b.totalFails;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.best == null) { r.rank = r.isNM ? '<span class="nm-mark">NM</span>' : '—'; return; }
            let isTied = i > 0 && rows[i - 1].best === r.best
                && rows[i - 1].failsAtBest === r.failsAtBest
                && rows[i - 1].totalFails === r.totalFails;
            r.rank = isTied ? rows[i - 1].rank : rk;
            rk = i + 2;
        });

        let thead = '<th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>';
        hts.forEach(h2 => { thead += `<th style="font-size:10px;">${formatHeight(h2)}</th>`; });
        thead += '<th>최고</th><th>비고</th>';
        html += `<table class="data-table" style="font-size:12px;">
            <thead><tr>${thead}</tr></thead>
            <tbody>${rows.map(r => {
                let c = '';
                hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const mark = d[i] === 'PASS' ? '-' : d[i]; const cls = d[i] === 'O' ? 'color:var(--green)' : d[i] === 'X' ? 'color:var(--danger)' : 'color:var(--text-muted)'; m += `<span style="${cls};font-weight:700;">${mark}</span>`; } } c += `<td style="font-size:11px;">${m}</td>`; });
                const _rkDisp = r.isNM ? '' : r.rank;
                const _bestDisp = r.best != null ? formatHeight(r.best) : '';
                const _rmk = r.isNM ? 'NM' : '';
                const _rmkSt = r.isNM ? 'color:var(--danger);font-weight:600;' : '';
                return `<tr style="${r.best != null ? 'background:#f0fff4;' : ''}"><td>${_rkDisp}</td><td><strong>${bib(r.bib_number)}</strong></td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>${c}<td style="font-weight:700;">${_bestDisp}</td><td style="font-size:11px;${_rmkSt}">${_rmk}</td></tr>`;
            }).join('')}</tbody></table>`;
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

function renderLiveCombinedResults(data) {
    // For combined events, fetch and show real-time scoreboard
    const evt = data.event;
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    const day1Max = evt.gender === 'M' ? 5 : 4;
    const day1Count = day1Max;
    const day2Count = subDefs.length - day1Max;

    // We need combined scores — make an inline fetch
    let html = `<div id="live-combined-content" style="padding:8px;">
        <div style="text-align:center;padding:20px;color:var(--text-muted);"><div class="loading-spinner"></div> 혼성 경기 결과 불러오는 중...</div>
    </div>`;

    // Async load combined data after rendering container
    setTimeout(async () => {
        try {
            await API.syncCombinedScores(evt.id);
            const scores = await API.getCombinedScores(evt.id);
            const entries = await API.getEventEntries(evt.id);

            const hdrCols = subDefs.map(se => {
                const has = scores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
                const bg = se.order <= day1Max ? 'background:#f5f9ff;' : 'background:#fef5f7;';
                return `<th style="font-size:9px;padding:2px 4px;white-space:nowrap;${bg}${has ? 'font-weight:700;' : 'color:#ccc;'}">${se.name}</th>`;
            }).join('');

            const rows = entries.map(e => {
                let total = 0; const pts = {};
                subDefs.forEach(se => {
                    const sc = scores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
                    const p = sc ? (sc.wa_points || 0) : 0;
                    pts[se.order] = { points: p, raw: sc ? sc.raw_record : null };
                    total += p;
                });
                return { ...e, pts, total };
            }).sort((a, b) => b.total - a.total);
            let rk = 1;
            rows.forEach((r, i) => { r.rank = (i > 0 && rows[i-1].total === r.total) ? rows[i-1].rank : rk; rk = i + 2; });

            const container = document.getElementById('live-combined-content');
            if (!container) return;

            container.innerHTML = `
                <div class="matrix-scroll-wrap" style="overflow-x:auto;">
                    <table class="data-table" style="font-size:11px;">
                        <thead>
                        <tr>
                            <th colspan="4" style="border-bottom:none;"></th>
                            <th colspan="${day1Count}" style="background:#f0f0f0;font-size:10px;font-weight:700;color:#6b6b6b;border-bottom:none;">Day 1</th>
                            <th colspan="${day2Count}" style="background:#f0e0e4;font-size:10px;font-weight:700;color:#8b1a2a;border-bottom:none;">Day 2</th>
                            <th style="border-bottom:none;"></th>
                        </tr>
                        <tr>
                            <th style="width:30px;">순위</th><th style="width:45px;">BIB</th>
                            <th style="width:70px;text-align:left;">선수명</th><th style="width:55px;text-align:left;">소속</th>
                            ${hdrCols}
                            <th style="width:55px;">총점</th>
                        </tr></thead>
                        <tbody>${rows.map(r => {
                            const cells = subDefs.map(se => {
                                const p = r.pts[se.order];
                                if (!p || p.raw == null)
                                    return `<td style="color:#ccc;font-size:10px;">—</td>`;
                                if (p.raw === 0 && p.points === 0)
                                    return `<td style="font-size:10px;color:var(--danger);font-weight:700;">NM</td>`;
                                if (p.raw <= 0)
                                    return `<td style="color:#ccc;font-size:10px;">—</td>`;
                                const isHt = se.key && (se.key.includes('high_jump') || se.key.includes('pole_vault'));
                                const rec = se.unit === 's' ? formatTime(p.raw) : formatHeight(p.raw);                                return `<td style="font-size:10px;"><div>${rec}</div><div style="color:var(--primary);font-size:9px;">${p.points}</div></td>`;
                            }).join('');
                            return `<tr style="${r.total > 0 ? 'background:#f0fff4;' : ''}">
                                <td><strong>${r.rank}</strong></td><td><strong>${bib(r.bib_number)}</strong></td>
                                <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:10px;">${r.team || ''}</td>
                                ${cells}
                                <td><strong style="color:var(--primary);font-size:13px;">${r.total > 0 ? r.total : '—'}</strong></td>
                            </tr>`;
                        }).join('')}</tbody>
                    </table>
                </div>
                <p style="margin-top:6px;font-size:10px;color:var(--text-muted);">실시간 WA 점수 합산 | ${evt.gender === 'M' ? '10종경기' : '7종경기'}</p>`;
        } catch (e) {
            const container = document.getElementById('live-combined-content');
            if (container) container.innerHTML = `<p style="color:var(--danger);">혼성 경기 데이터 로드 실패</p>`;
        }
    }, 100);

    return html;
}

// ── Combined Results (completed event — scoreboard) ──────────
function renderCombinedResults(data) {
    const evt = data.event;
    return `<div id="combined-result-content" style="padding:8px;">
        <div style="text-align:center;padding:20px;color:var(--text-muted);"><div class="loading-spinner"></div> ${evt.gender === 'M' ? '10종경기' : '7종경기'} 결과 불러오는 중...</div>
    </div>`;
}

async function _loadCombinedResultsAsync(evt) {
    try {
        await API.syncCombinedScores(evt.id);
        const scores = await API.getCombinedScores(evt.id);
        const entries = await API.getEventEntries(evt.id);
        const subEvents = await API.getCombinedSubEvents(evt.id);
        const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
        const day1Max = evt.gender === 'M' ? 5 : 4;

        const hdrCols = subDefs.map(se => {
            const has = scores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
            const bg = se.order <= day1Max ? 'background:#f5f9ff;' : 'background:#fef5f7;';
            return `<th style="font-size:9px;padding:2px 4px;white-space:nowrap;${bg}${has ? 'font-weight:700;' : 'color:#ccc;'}" onclick="_cResultShowSub(${se.order})" title="클릭하여 세부기록 보기" class="clickable-th">${se.name}</th>`;
        }).join('');

        const rows = entries.map(e => {
            let total = 0; const pts = {};
            subDefs.forEach(se => {
                const sc = scores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
                const p = sc ? (sc.wa_points || 0) : 0;
                pts[se.order] = { points: p, raw: sc ? sc.raw_record : null };
                total += p;
            });
            return { ...e, pts, total };
        }).sort((a, b) => b.total - a.total);
        let rk = 1;
        rows.forEach((r, i) => { r.rank = (i > 0 && rows[i-1].total === r.total) ? rows[i-1].rank : rk; rk = i + 2; });

        const container = document.getElementById('combined-result-content');
        if (!container) return;

        const day1Count = day1Max;
        const day2Count = subDefs.length - day1Max;

        // Build sub-event tab buttons grouped by day
        const day1Tabs = subDefs.filter(se => se.order <= day1Max).map(se => {
            const has = scores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
            return `<button class="btn btn-sm btn-outline cr-sub-tab" data-order="${se.order}" onclick="_cResultShowSub(${se.order})" style="font-size:10px;padding:3px 8px;border-color:${has ? 'var(--primary)' : '#ddd'};color:${has ? 'var(--primary)' : '#aaa'};${has ? 'font-weight:700;' : ''}">${se.order}. ${se.name}${has ? ' \u2713' : ''}</button>`;
        }).join('');
        const day2Tabs = subDefs.filter(se => se.order > day1Max).map(se => {
            const has = scores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
            return `<button class="btn btn-sm btn-outline cr-sub-tab" data-order="${se.order}" onclick="_cResultShowSub(${se.order})" style="font-size:10px;padding:3px 8px;border-color:${has ? '#e53935' : '#ddd'};color:${has ? '#e53935' : '#aaa'};${has ? 'font-weight:700;' : ''}">${se.order}. ${se.name}${has ? ' \u2713' : ''}</button>`;
        }).join('');

        container.innerHTML = `
            <div class="matrix-scroll-wrap" style="overflow-x:auto;">
                <table class="data-table" style="font-size:11px;">
                    <thead>
                    <tr>
                        <th colspan="4" style="border-bottom:none;"></th>
                        <th colspan="${day1Count}" style="background:#f0f0f0;font-size:10px;font-weight:700;color:#6b6b6b;border-bottom:none;">Day 1</th>
                        <th colspan="${day2Count}" style="background:#f0e0e4;font-size:10px;font-weight:700;color:#8b1a2a;border-bottom:none;">Day 2</th>
                        <th style="border-bottom:none;"></th>
                    </tr>
                    <tr>
                        <th style="width:30px;">\uc21c\uc704</th><th style="width:45px;">BIB</th>
                        <th style="width:70px;text-align:left;">\uc120\uc218\uba85</th><th style="width:55px;text-align:left;">\uc18c\uc18d</th>
                        ${hdrCols}
                        <th style="width:55px;">\ucd1d\uc810</th>
                    </tr></thead>
                    <tbody>${rows.map(r => {
                        const cells = subDefs.map(se => {
                            const p = r.pts[se.order];
                            if (!p || p.raw == null)
                                return `<td style="color:#ccc;font-size:10px;cursor:pointer;" onclick="_cResultShowSub(${se.order})">—</td>`;
                            if (p.raw === 0 && p.points === 0)
                                return `<td style="font-size:10px;cursor:pointer;color:var(--danger);font-weight:700;" onclick="_cResultShowSub(${se.order})">NM</td>`;
                            if (p.raw <= 0)
                                return `<td style="color:#ccc;font-size:10px;cursor:pointer;" onclick="_cResultShowSub(${se.order})">—</td>`;
                            const isHt = se.key && (se.key.includes('high_jump') || se.key.includes('pole_vault'));
                            const rec = se.unit === 's' ? formatTime(p.raw) : formatHeight(p.raw);
                            return `<td style="font-size:10px;cursor:pointer;" onclick="_cResultShowSub(${se.order})"><div>${rec}</div><div style="color:var(--primary);font-size:9px;">${p.points}</div></td>`;
                        }).join('');
                        return `<tr style="${r.total > 0 ? 'background:#f0fff4;' : ''}">
                            <td><strong>${r.rank}</strong></td><td><strong>${bib(r.bib_number)}</strong></td>
                            <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:10px;">${r.team || ''}</td>
                            ${cells}
                            <td><strong style="color:var(--primary);font-size:13px;">${r.total > 0 ? r.total : '—'}</strong></td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>
            </div>
            <p style="margin-top:6px;font-size:10px;color:var(--text-muted);">☆ ${evt.gender === 'M' ? '10종경기' : '7종경기'} 최종 결과 | WA 점수 합산 · 종목명 클릭 시 세부기록 표시</p>
            <div style="margin-top:12px;padding-top:10px;border-top:2px solid var(--border);">
                <div style="font-weight:700;font-size:13px;margin-bottom:6px;">종목별 세부기록</div>
                <div style="margin-bottom:4px;">
                    <div style="font-size:10px;font-weight:600;color:#6b6b6b;margin-bottom:2px;">Day 1</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">${day1Tabs}</div>
                    <div style="font-size:10px;font-weight:600;color:#8b1a2a;margin-bottom:2px;">Day 2</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;">${day2Tabs}</div>
                </div>
                <div id="cr-sub-detail" style="min-height:60px;"></div>
            </div>`;

        // Store data for sub-event detail rendering
        window._crSubData = { evt, subEvents, subDefs, entries, scores };
    } catch (e) {
        const container = document.getElementById('combined-result-content');
        if (container) container.innerHTML = `<p style="color:var(--danger);">혼성 경기 데이터 로드 실패: ${e.message || e}</p>`;
    }
}

// Show sub-event detail (track/field results with all attempts)
async function _cResultShowSub(order) {
    const area = document.getElementById('cr-sub-detail');
    if (!area || !window._crSubData) return;
    const { evt, subEvents, subDefs, entries, scores } = window._crSubData;
    const seDef = subDefs.find(s => s.order === order);
    if (!seDef) return;

    // Highlight active tab
    document.querySelectorAll('.cr-sub-tab').forEach(b => {
        b.style.background = +b.dataset.order === order ? '#f0f0f0' : '';
        b.style.fontWeight = +b.dataset.order === order ? '800' : '';
    });

    area.innerHTML = '<div style="text-align:center;padding:10px;color:var(--text-muted);"><div class="loading-spinner"></div></div>';

    try {
        // Find DB sub-event
        let dbSub = subEvents.find(s => s.sort_order === order);
        if (!dbSub) dbSub = subEvents[order - 1];
        if (!dbSub) { area.innerHTML = '<div style="color:var(--text-muted);">세부 종목을 찾을 수 없습니다.</div>'; return; }

        const heats = await API.getHeats(dbSub.id);
        if (heats.length === 0) { area.innerHTML = '<div style="color:var(--text-muted);">히트 데이터 없음</div>'; return; }

        const heatId = heats[0].id;
        const heatEntries = await API.getHeatEntries(heatId);
        const cat = dbSub.category;

        let html = `<div style="font-weight:700;font-size:13px;margin-bottom:6px;">${order}. ${seDef.name} <span style="font-size:11px;color:var(--text-muted);">(${cat})</span></div>`;

        if (cat === 'track') {
            const results = await API.getResults(heatId);
            const rows = heatEntries.map(e => {
                const r = results.find(r => r.event_entry_id === e.event_entry_id);
                return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code || '') : '' };
            }).sort((a, b) => {
                if (a.status_code && !b.status_code) return 1; if (!a.status_code && b.status_code) return -1;
                if (a.time_seconds == null && b.time_seconds == null) return 0;
                if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
                return a.time_seconds - b.time_seconds;
            });
            let rk = 1;
            rows.forEach((r, i) => { r.rank = (r.status_code || r.time_seconds == null) ? '—' : ((i > 0 && rows[i-1].time_seconds === r.time_seconds) ? rows[i-1].rank : rk); rk = i + 2; });
            // WA points from scores — match by athlete_id or bib_number since sub-event entry IDs differ from parent
            rows.forEach(r => {
                let sc = scores.find(s => s.event_entry_id === r.event_entry_id && s.sub_event_order === order);
                if (!sc) {
                    // Fallback: match by bib_number (sub-event entries have different IDs from parent)
                    sc = scores.find(s => s.bib_number === r.bib_number && s.sub_event_order === order);
                }
                r.wa_points = sc ? (sc.wa_points ?? 0) : null;
            });
            html += `<table class="data-table" style="font-size:12px;"><thead><tr>
                <th style="width:40px;">순위</th><th style="width:50px;">BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>
                <th style="width:100px;">기록</th><th style="width:60px;">WA점수</th>
            </tr></thead><tbody>${rows.map(r => `<tr style="${r.time_seconds ? 'background:#f0fff4;' : ''}">
                <td>${r.rank}</td><td><strong>${bib(r.bib_number)}</strong></td>
                <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>
                <td style="font-family:monospace;font-weight:600;">${r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.time_seconds != null ? formatTime(r.time_seconds) : '—')}</td>
                <td style="color:var(--primary);font-weight:600;">${r.wa_points != null ? r.wa_points : '—'}</td>
            </tr>`).join('')}</tbody></table>`;

        } else if (cat === 'field_distance') {
            const results = await API.getResults(heatId);
            // Group by athlete, show all attempts
            const athleteMap = {};
            heatEntries.forEach(e => { athleteMap[e.event_entry_id] = { ...e, attempts: [], best: null, status_code: '' }; });
            results.forEach(r => {
                if (athleteMap[r.event_entry_id]) {
                    athleteMap[r.event_entry_id].attempts.push(r);
                    if (r.status_code && !athleteMap[r.event_entry_id].status_code) {
                        athleteMap[r.event_entry_id].status_code = r.status_code.toUpperCase();
                    }
                    const d = r.distance_meters;
                    if (d && d > 0 && (!athleteMap[r.event_entry_id].best || d > athleteMap[r.event_entry_id].best))
                        athleteMap[r.event_entry_id].best = d;
                }
            });
            // Auto-NM: WA Rule 25.6 — 8명 이하면 6차시기까지, 초과면 3차시기까지 파울이어야 NM
            const _totalAth2 = Object.keys(athleteMap).length;
            const _nmThreshold2 = _totalAth2 <= 8 ? 6 : 3;
            Object.values(athleteMap).forEach(a => {
                if (!a.status_code) {
                    const foulCount = a.attempts.filter(att => att.distance_meters === 0).length;
                    const passCount = a.attempts.filter(att => att.distance_meters === -1).length;
                    if ((foulCount + passCount) >= _nmThreshold2 && !a.best && a.attempts.length >= _nmThreshold2) a.status_code = 'NM';
                }
            });
            const athRows = Object.values(athleteMap).sort((a, b) => {
                if (a.status_code && !b.status_code) return 1;
                if (!a.status_code && b.status_code) return -1;
                return (b.best || 0) - (a.best || 0);
            });
            let rk = 1;
            athRows.forEach((r, i) => {
                if (r.status_code) { r.rank = `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>`; return; }
                r.rank = !r.best ? '—' : ((i > 0 && athRows[i-1].best === r.best && !athRows[i-1].status_code) ? athRows[i-1].rank : rk);
                rk = i + 2;
            });
            athRows.forEach(r => {
                let sc = scores.find(s => s.event_entry_id === r.event_entry_id && s.sub_event_order === order);
                if (!sc) sc = scores.find(s => s.bib_number === r.bib_number && s.sub_event_order === order);
                r.wa_points = sc ? (sc.wa_points ?? 0) : null;
            });
            // Find max attempts
            const maxAttempts = Math.max(1, ...athRows.map(r => r.attempts.length));
            const attHdr = Array.from({length: maxAttempts}, (_, i) => {
                const attCls = (i === 0 ? 'att-col-first ' : '') + ((i + 1) % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                return `<th class="${attCls}" style="width:55px;font-size:10px;">${i+1}차</th>`;
            }).join('');
            html += `<table class="data-table field-table" style="font-size:12px;"><thead><tr>
                <th style="width:35px;">순위</th><th style="width:50px;">BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>
                ${attHdr}<th class="att-col-best" style="width:60px;">최고</th><th style="width:55px;">WA점수</th>
            </tr></thead><tbody>${athRows.map(r => {
                const attCells = Array.from({length: maxAttempts}, (_, i) => {
                    const attCls = (i === 0 ? 'att-col-first ' : '') + ((i + 1) % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                    const att = r.attempts.find(a => a.attempt_number === (i + 1));
                    if (!att) return `<td class="${attCls}" style="color:#ccc;">—</td>`;
                    if (att.distance_meters === 0) return `<td class="${attCls}"><span class="foul-mark">X</span></td>`;
                    if (att.distance_meters < 0) return `<td class="${attCls}"><span class="pass-mark">-</span></td>`;
                    return `<td class="${attCls}" style="font-family:monospace;">${att.distance_meters ? formatHeight(att.distance_meters) : '—'}</td>`;
                }).join('');
                const bestDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best ? formatHeight(r.best) : '—');
                return `<tr>
                    <td>${r.rank}</td><td><strong>${bib(r.bib_number)}</strong></td>
                    <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>
                    ${attCells}
                    <td class="att-col-best" style="font-weight:700;">${bestDisp}</td>
                    <td style="color:var(--primary);font-weight:600;">${r.wa_points != null ? r.wa_points : '—'}</td>
                </tr>`;
            }).join('')}</tbody></table>`;

        } else if (cat === 'field_height') {
            const attempts = await API.getHeightAttempts(heatId);
            // Get unique bar heights
            const heights = [...new Set(attempts.map(a => a.bar_height))].sort((a, b) => a - b);
            // Build athlete rows
            const athleteMap = {};
            heatEntries.forEach(e => { athleteMap[e.event_entry_id] = { ...e, maxCleared: null, attempts: {} }; });
            attempts.forEach(a => {
                if (!athleteMap[a.event_entry_id]) return;
                const key = a.bar_height;
                if (!athleteMap[a.event_entry_id].attempts[key]) athleteMap[a.event_entry_id].attempts[key] = [];
                athleteMap[a.event_entry_id].attempts[key].push(a.result_mark);
                if (a.result_mark === 'O' && (!athleteMap[a.event_entry_id].maxCleared || a.bar_height > athleteMap[a.event_entry_id].maxCleared))
                    athleteMap[a.event_entry_id].maxCleared = a.bar_height;
            });
            // WA tie-break: compute failsAtBest and totalFails
            Object.values(athleteMap).forEach(ath => {
                let totalFails = 0, failsAtBest = 0;
                heights.forEach(h => {
                    const marks = ath.attempts[h];
                    if (!marks) return;
                    const xCount = marks.filter(m => m === 'X').length;
                    totalFails += xCount;
                    if (marks.includes('O')) failsAtBest = xCount;
                });
                ath.totalFails = totalFails;
                ath.failsAtBest = failsAtBest;
            });
            const athRows = Object.values(athleteMap).sort((a, b) => {
                if ((b.maxCleared || 0) !== (a.maxCleared || 0)) return (b.maxCleared || 0) - (a.maxCleared || 0);
                if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
                return a.totalFails - b.totalFails;
            });
            let rk = 1;
            athRows.forEach((r, i) => {
                if (!r.maxCleared) { r.rank = '—'; rk = i + 2; return; }
                let isTied = i > 0 && athRows[i-1].maxCleared === r.maxCleared && athRows[i-1].failsAtBest === r.failsAtBest && athRows[i-1].totalFails === r.totalFails;
                r.rank = isTied ? athRows[i-1].rank : rk;
                rk = i + 2;
            });
            athRows.forEach(r => {
                let sc = scores.find(s => s.event_entry_id === r.event_entry_id && s.sub_event_order === order);
                if (!sc) sc = scores.find(s => s.bib_number === r.bib_number && s.sub_event_order === order);
                r.wa_points = sc ? (sc.wa_points ?? 0) : null;
            });
            const hHdr = heights.map(h => `<th style="font-size:10px;min-width:40px;">${formatHeight(h)}</th>`).join('');
            html += `<table class="data-table" style="font-size:12px;"><thead><tr>
                <th style="width:35px;">순위</th><th style="width:50px;">BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>
                ${hHdr}<th style="width:55px;">최고</th><th style="width:55px;">WA점수</th>
            </tr></thead><tbody>${athRows.map(r => {
                const hCells = heights.map(h => {
                    const marks = r.attempts[h];
                    if (!marks || marks.length === 0) return '<td style="color:#ccc;">—</td>';
                    const str = marks.join('');
                    const color = str.includes('O') ? '#8a7640' : '#8b1a2a';
                    return `<td style="font-size:11px;font-weight:600;color:${color};">${str}</td>`;
                }).join('');
                return `<tr style="${r.maxCleared ? 'background:#f0fff4;' : ''}">
                    <td>${r.rank}</td><td><strong>${bib(r.bib_number)}</strong></td>
                    <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>
                    ${hCells}
                    <td style="font-weight:700;">${r.maxCleared ? formatHeight(r.maxCleared) : '—'}</td>
                    <td style="color:var(--primary);font-weight:600;">${r.wa_points != null ? r.wa_points : '—'}</td>
                </tr>`;
            }).join('')}</tbody></table>`;
        }

        area.innerHTML = html;
    } catch (e) {
        area.innerHTML = `<div style="color:var(--danger);font-size:12px;">세부 기록 로드 실패: ${e.message || e}</div>`;
    }
}

function renderTrackResults(data, relayMembers) {
    const isRelay = data.event?.category === 'relay';
    let html = '';
    const _isFinalSingle2 = data.event?.round_type === 'final' && data.heats.length === 1;
    const _needsWind2 = requiresWindMeasurement(data.event?.name, data.event?.category);
    data.heats.forEach(h => {
        const _hWind2 = h.wind != null ? parseFloat(h.wind) : null;
        const _isWindAided2 = _needsWind2 && _hWind2 != null && _hWind2 > 2.0;
        const windStr = h.wind != null ? `<span style="font-size:12px;color:${_isWindAided2 ? 'var(--accent)' : 'var(--text-muted)'};margin-left:8px;">풍속: ${formatWind(h.wind)} m/s</span>` : '';
        const refLabel2 = _isWindAided2 ? ' <span class="wind-ref-badge">참조기록</span>' : '';
        const _hLabel2 = _isFinalSingle2 ? '결승' : (h.heat_name || ('Heat ' + h.heat_number));
        html += `<h4 style="margin:12px 0 6px;">${_hLabel2} ${windStr}${refLabel2}</h4>`;
        const smallNumLabel = getSmallNumberLabel(data.event?.name, data.event?.category);
        const rows = h.entries.map(e => {
            const r = (h.results || []).find(r => r.event_entry_id === e.event_entry_id);
            return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code || '') : '', remark: r ? (r.remark || '') : '' };
        }).sort((a, b) => {
            if (a.status_code && !b.status_code) return 1;
            if (!a.status_code && b.status_code) return -1;
            if (a.time_seconds == null) return 1;
            if (b.time_seconds == null) return -1;
            return a.time_seconds - b.time_seconds;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.rank = `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>`; return; }
            r.rank = r.time_seconds == null ? '—' : ((i > 0 && rows[i - 1].time_seconds === r.time_seconds && !rows[i - 1].status_code) ? rows[i - 1].rank : rk);
            rk = i + 2;
        });
        html += `<table class="data-table" style="font-size:13px;">
            <thead><tr><th>순위</th><th>${smallNumLabel}</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>기록</th><th>비고</th></tr></thead>
            <tbody>${rows.map(r => {
                const wMark2 = (_isWindAided2 && !r.status_code && r.time_seconds != null) ? '<span class="wind-aided-mark">w</span>' : '';
                let memberHtml = '';
                if (isRelay && relayMembers) {
                    const members = relayMembers.filter(m => m.event_entry_id === r.event_entry_id);
                    if (members.length > 0) {
                        const sorted = [...members].sort((a, b) => (a.leg_order || 99) - (b.leg_order || 99));
                        memberHtml = `<tr><td colspan="7" style="padding:2px 8px 6px 40px;background:#f8f9fa;border-bottom:2px solid #e5e7eb;">
                            <span style="font-size:10px;color:var(--text-muted);margin-right:6px;">주자:</span>
                            ${sorted.map(m => `<span style="font-size:11px;margin-right:10px;">${m.leg_order ? m.leg_order + '주 ' : ''}${m.name} <span style="color:var(--text-muted);">#${bib(m.bib_number)}</span></span>`).join('')}
                        </td></tr>`;
                    }
                }
                return `<tr>
                <td>${r.rank}</td><td>${r.lane_number || '—'}</td><td>${bib(r.bib_number)}</td>
                <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>
                <td style="font-family:monospace;font-weight:600;">${r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.time_seconds != null ? formatTime(r.time_seconds) + wMark2 : '<span style="color:var(--text-muted);">—</span>')}</td>
                <td style="font-size:11px;color:#666;">${r.remark || ''}</td>
            </tr>${memberHtml}`;
            }).join('')}</tbody></table>`;
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

function renderFieldDistResults(data) {
    let html = '';
    data.heats.forEach(h => {
        const rows = h.entries.map(e => {
            const er = (h.results || []).filter(r => r.event_entry_id === e.event_entry_id);
            const att = {}, attWind = {};
            let sc = '';
            er.forEach(r => {
                if (r.attempt_number) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; }
                if (r.status_code && !sc) sc = r.status_code.toUpperCase();
            });
            // Auto-NM: WA Rule 25.6 — 8명 이하면 6차시기까지, 초과면 3차시기까지
            const allDists = Object.values(att);
            const foulCount = allDists.filter(d => d === 0).length;
            const passCount2 = allDists.filter(d => d === -1).length;
            const valid = allDists.filter(d => d > 0);
            const _totalAth3 = h.entries.length;
            const _nmThreshold3 = _totalAth3 <= 8 ? 6 : 3;
            if (!sc && (foulCount + passCount2) >= _nmThreshold3 && valid.length === 0 && allDists.length >= _nmThreshold3) sc = 'NM';
            const best = valid.length > 0 ? Math.max(...valid) : null;
            let bestWind = null;
            if (best != null) { for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } } }
            // Build sorted valid distances (descending) for WA tie-breaking
            const sortedValid = [];
            for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
            sortedValid.sort((a, b) => b - a);
            return { ...e, att, attWind, best, bestWind, status_code: sc, sortedValid };
        }).sort((a, b) => {
            if (a.status_code && !b.status_code) return 1;
            if (!a.status_code && b.status_code) return -1;
            if (a.best == null) return 1; if (b.best == null) return -1;
            if (b.best !== a.best) return b.best - a.best;
            // WA tie-break: 2nd best, 3rd best, etc.
            const maxLen = Math.max(a.sortedValid.length, b.sortedValid.length);
            for (let k = 1; k < maxLen; k++) {
                const aV = a.sortedValid[k] ?? -1, bV = b.sortedValid[k] ?? -1;
                if (bV !== aV) return bV - aV;
            }
            return 0;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.rank = `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>`; return; }
            if (r.best == null) { r.rank = '—'; rk = i + 2; return; }
            let isTied = i > 0 && rows[i - 1].best === r.best && !rows[i - 1].status_code;
            if (isTied) {
                const prev = rows[i - 1];
                const maxLen = Math.max(prev.sortedValid.length, r.sortedValid.length);
                for (let k = 1; k < maxLen; k++) {
                    if ((prev.sortedValid[k] ?? -1) !== (r.sortedValid[k] ?? -1)) { isTied = false; break; }
                }
            }
            r.rank = isTied ? rows[i - 1].rank : rk;
            rk = i + 2;
        });
        const needsWind = requiresWindMeasurement(data.event?.name, 'field_distance');
        if (needsWind) {
            html += `<table class="data-table field-table field-2row-table" style="font-size:12px;">
                <thead>
                    <tr><th rowspan="2">순위</th><th rowspan="2">순번</th><th style="text-align:left;">성명</th><th>배번</th>
                        <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th><th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th><th class="att-col-best" rowspan="2">기록</th><th rowspan="2">비고</th></tr>
                    <tr><th style="text-align:left;">소속</th><th></th>
                        <th class="wind-header att-col-first att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th>
                        <th class="wind-header att-col-even">풍속</th><th class="wind-header att-col-odd">풍속</th><th class="wind-header att-col-even">풍속</th></tr>
                </thead>
                <tbody>${rows.map(r => {
                    let distCells = '', windCells = '';
                    for (let i = 1; i <= 6; i++) {
                        const attCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                        const v = r.att[i];
                        const hasVal = v != null;
                        const isFoul = hasVal && v === 0;
                        const isPass = hasVal && v < 0;
                        distCells += `<td class="${attCls}" style="font-family:monospace;">${hasVal ? (isFoul ? '<span class="foul-mark">X</span>' : (isPass ? '<span class="pass-mark">-</span>' : formatHeight(v))) : ''}</td>`;
                        let wDisp = '';
                        if (hasVal && !isFoul && !isPass && r.attWind[i] != null) wDisp = formatWind(r.attWind[i]);
                        windCells += `<td class="wind-cell ${attCls}">${wDisp}</td>`;
                    }
                    const bestWindDisp = (r.bestWind != null) ? formatWind(r.bestWind) : '';
                    const _bwa = needsWind && r.bestWind != null && parseFloat(r.bestWind) > 2.0 && r.best != null;
                    const bestWMark = _bwa ? '<span class="wind-aided-mark">w</span>' : '';
                    const bestDisp = r.status_code ? '' : (r.best != null ? formatHeight(r.best) + bestWMark : '—');
                    const rkDisp = r.status_code ? '' : r.rank;
                    let rmk = '';
                    if (r.status_code) rmk = r.status_code;
                    else if (_bwa) rmk = '참고기록';
                    const rmkSt = r.status_code ? 'color:var(--danger);font-weight:600;' : _bwa ? 'color:var(--accent);font-weight:600;' : '';
                    return `<tr class="field-row1">
                        <td rowspan="2">${rkDisp}</td><td rowspan="2">${r.lane_number || '—'}</td>
                        <td style="text-align:left;">${r.name}</td><td><strong>${bib(r.bib_number)}</strong></td>
                        ${distCells}<td rowspan="2" class="best-cell att-col-best">${bestDisp}<div class="best-wind">${bestWindDisp}</div></td>
                        <td rowspan="2" style="font-size:11px;${rmkSt}">${rmk}</td>
                    </tr><tr class="field-row2">
                        <td class="team-cell">${r.team || ''}</td><td></td>${windCells}
                    </tr>`;
                }).join('')}</tbody></table>`;
        } else {
            html += `<table class="data-table field-table" style="font-size:13px;">
                <thead><tr><th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>
                    <th class="att-col-first att-col-odd">1</th><th class="att-col-even">2</th><th class="att-col-odd">3</th><th class="att-col-even">4</th><th class="att-col-odd">5</th><th class="att-col-even">6</th><th class="att-col-best">BEST</th><th>비고</th></tr></thead>
                <tbody>${rows.map(r => {
                    let c = '';
                    for (let i = 1; i <= 6; i++) { const attCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even'); const v = r.att[i]; c += `<td class="${attCls}" style="font-family:monospace;font-size:11px;">${v != null ? (v === 0 ? '<span class="foul-mark">X</span>' : (v < 0 ? '<span class="pass-mark">-</span>' : formatHeight(v))) : ''}</td>`; }
                    const bestDisp2 = r.status_code ? '' : (r.best != null ? formatHeight(r.best) : '—');
                    const rkDisp2 = r.status_code ? '' : r.rank;
                    const rmk2 = r.status_code || '';
                    const rmkSt2 = r.status_code ? 'color:var(--danger);font-weight:600;' : '';
                    return `<tr><td>${rkDisp2}</td><td>${bib(r.bib_number)}</td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team||''}</td>${c}<td class="att-col-best" style="font-weight:700;">${bestDisp2}</td><td style="font-size:11px;${rmkSt2}">${rmk2}</td></tr>`;
                }).join('')}</tbody></table>`;
        }
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

function renderFieldHeightResults(data) {
    let html = '';
    data.heats.forEach(h => {
        const ha = h.height_attempts || [];
        const hts = [...new Set(ha.map(a => a.bar_height))].sort((a, b) => a - b);
        const rows = h.entries.map(e => {
            const ea = ha.filter(a => a.event_entry_id === e.event_entry_id);
            const hd = {};
            ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
            let best = null, totalFails = 0, failsAtBest = 0, hasAttempts = false;
            hts.forEach(h2 => {
                const d = hd[h2]; if (!d) return;
                hasAttempts = true;
                const xCount = Object.values(d).filter(m => m === 'X').length;
                totalFails += xCount;
                if (Object.values(d).includes('O')) { best = h2; failsAtBest = xCount; }
            });
            const isNM = best == null && hasAttempts && totalFails >= 3;
            return { ...e, hd, best, totalFails, failsAtBest, isNM };
        }).sort((a, b) => {
            if (a.best == null && b.best == null) return 0;
            if (a.best == null) return 1; if (b.best == null) return -1;
            if (b.best !== a.best) return b.best - a.best;
            if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
            return a.totalFails - b.totalFails;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.best == null) { r.rank = '—'; rk = i + 2; return; }
            let isTied = i > 0 && rows[i-1].best === r.best && rows[i-1].failsAtBest === r.failsAtBest && rows[i-1].totalFails === r.totalFails;
            r.rank = isTied ? rows[i-1].rank : rk;
            rk = i + 2;
        });

        let thead = '<th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>';
        hts.forEach(h2 => { thead += `<th style="font-size:10px;">${formatHeight(h2)}</th>`; });
        thead += '<th>최고</th><th>비고</th>';
        html += `<table class="data-table" style="font-size:13px;">
            <thead><tr>${thead}</tr></thead>
            <tbody>${rows.map(r => {
                let c = '';
                hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const mark = d[i] === 'PASS' ? '-' : d[i]; m += mark; } } c += `<td style="font-size:11px;">${m}</td>`; });
                const bestDisp3 = r.best != null ? formatHeight(r.best) : '';
                const rmk3 = r.isNM ? 'NM' : '';
                const rmkSt3 = rmk3 ? 'color:var(--danger);font-weight:600;' : '';
                return `<tr><td>${r.isNM ? '' : r.rank}</td><td>${bib(r.bib_number)}</td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team||''}</td>${c}<td style="font-weight:700;">${bestDisp3}</td><td style="font-size:11px;${rmkSt3}">${rmk3}</td></tr>`;
            }).join('')}</tbody></table>`;
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

// ============================================================
// Pacing Light Popup (W/L Target)
// ============================================================
const _PACING_COLOR_MAP = {
    green:  { label: 'Green',  hex: '#b79f58', textColor: '#fff' },
    red:    { label: 'Red',    hex: '#FF0000', textColor: '#fff' },
    white:  { label: 'White',  hex: '#E0E0E0', textColor: '#333' },
    blue:   { label: 'Blue',   hex: '#6b6b6b', textColor: '#fff' },
};

function _fmtPacingTime(seconds) {
    if (!seconds || seconds <= 0) return '0.00';
    if (seconds >= 3600) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds - h * 3600) / 60);
        const s = seconds - h * 3600 - m * 60;
        return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
    }
    if (seconds >= 60) {
        const m = Math.floor(seconds / 60);
        const s = seconds - m * 60;
        return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
    }
    return seconds.toFixed(2);
}

function openPacingPopup(eventName) {
    const cfg = _pacingMap[eventName];
    if (!cfg) return;

    const overlay = document.getElementById('result-overlay');
    const panel = document.getElementById('result-panel');

    let html = '';

    // Notice
    if (cfg.notice) {
        html += `<div style="background:#f8f4ea;border:1px solid #f8f4ea;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;color:#b79f58;">${cfg.notice}</div>`;
    }

    // Color cards
    if (cfg.colors && cfg.colors.length > 0) {
        cfg.colors.forEach(c => {
            const cm = _PACING_COLOR_MAP[c.color_key] || { label: c.color_key, hex: '#ccc', textColor: '#333' };
            const totalTime = c.segments.reduce((sum, seg) => sum + (seg.lap_seconds || 0), 0);

            // Build cumulative breakdown
            let cumTime = 0;
            let cumDist = 0;
            const splits = c.segments.map(seg => {
                cumTime += seg.lap_seconds || 0;
                cumDist += seg.distance_meters || 0;
                return { dist: cumDist, cum: cumTime, lap: seg.lap_seconds, segDist: seg.distance_meters };
            });

            html += `<div style="border:2px solid ${cm.hex};border-radius:8px;padding:12px;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                    <span style="background:${cm.hex};width:18px;height:18px;border-radius:50%;display:inline-block;border:2px solid rgba(0,0,0,.1);flex-shrink:0;"></span>
                    <span style="font-weight:700;font-size:15px;color:${cm.hex === '#E0E0E0' ? '#333' : cm.hex};">${cm.label}</span>
                    <span style="font-family:monospace;font-weight:700;font-size:18px;margin-left:auto;">${_fmtPacingTime(totalTime)}</span>
                    ${totalTime >= 60 ? `<span style="font-size:11px;color:var(--text-muted);margin-left:4px;">(${Math.round(totalTime)}초)</span>` : ''}
                </div>`;

            if (c.remark) {
                html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">… ${c.remark}</div>`;
            }

            // Show cumulative splits table
            if (splits.length > 1) {
                html += `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;">
                    <thead><tr style="background:${cm.hex}22;">
                        <th style="padding:3px 8px;text-align:left;font-size:11px;">구간</th>
                        <th style="padding:3px 8px;text-align:right;font-size:11px;">랩</th>
                        <th style="padding:3px 8px;text-align:right;font-size:11px;">누적</th>
                    </tr></thead><tbody>`;
                splits.forEach(sp => {
                    html += `<tr>
                        <td style="padding:3px 8px;border-bottom:1px solid #f0f0f0;">${sp.dist}m</td>
                        <td style="padding:3px 8px;text-align:right;border-bottom:1px solid #f0f0f0;font-family:monospace;">${_fmtPacingTime(sp.lap)}${sp.lap >= 60 ? `<span style="font-size:10px;color:var(--text-muted);"> (${Math.round(sp.lap)}초)</span>` : ''}</td>
                        <td style="padding:3px 8px;text-align:right;border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600;">${_fmtPacingTime(sp.cum)}${sp.cum >= 60 ? `<span style="font-size:10px;color:var(--text-muted);"> (${Math.round(sp.cum)}초)</span>` : ''}</td>
                    </tr>`;
                });
                html += `</tbody></table>`;
            }
            html += `</div>`;
        });
    } else {
        html += '<div style="color:var(--text-muted);">페이싱 설정이 없습니다.</div>';
    }

    panel.innerHTML = `<div class="result-panel-header">
        <h3>⌖ ${eventName} W/L Target</h3>
        <button class="result-panel-close" onclick="closePacingPopup()">&times;</button>
    </div><div class="result-panel-body">${html}</div>`;
    overlay.classList.add('show');
}

function closePacingPopup() {
    document.getElementById('result-overlay').classList.remove('show');
}

// 종합기록지 버튼 삭제됨 — 관리자 문서 탭에서 다운로드

// ============================================================
// 소집대기 명단 모달 (종목별 조편성 확인)
// ============================================================
let _rosterModalEventId = null;

async function openRosterModal(eventId, eventName) {
    _rosterModalEventId = eventId;
    const evt = allEvents.find(e => e.id === eventId);
    if (!evt) return;

    // Create/reuse modal overlay
    let overlay = document.getElementById('roster-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'roster-modal-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s;';
        overlay.onclick = (e) => { if (e.target === overlay) closeRosterModal(); };
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';

    const gL = evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';

    overlay.innerHTML = `<div style="background:#fff;border-radius:12px;width:92%;max-width:520px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:linear-gradient(135deg,#f5f0e0,#f1f8e9);border-bottom:1px solid #e8dfc0;flex-shrink:0;">
            <div>
                <div style="font-weight:800;font-size:15px;color:#6b5520;">소집대기 명단</div>
                <div style="font-size:12px;color:#b79f58;margin-top:2px;">${gL} ${eventName} ${roundL}</div>
            </div>
            <button onclick="closeRosterModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#999;padding:0 4px;">&times;</button>
        </div>
        <div id="roster-modal-body" style="flex:1;overflow-y:auto;padding:0;">
            <div style="padding:30px;text-align:center;color:var(--text-muted);">불러오는 중...</div>
        </div>
    </div>`;

    if (window.pushModalState) pushModalState(() => closeRosterModal());
    await loadRosterModalData(eventId);
}

function closeRosterModal() {
    const overlay = document.getElementById('roster-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    _rosterModalEventId = null;
}

async function loadRosterModalData(eventId) {
    const body = document.getElementById('roster-modal-body');
    if (!body) return;

    try {
        const evt = allEvents.find(e => e.id === eventId);
        if (!evt) { body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">종목 정보를 찾을 수 없습니다.</div>'; return; }

        const heats = await API.getHeats(eventId);
        if (heats.length === 0) {
            body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">조 편성이 아직 완료되지 않았습니다.</div>';
            return;
        }

        const isFinalSingle = evt.round_type === 'final' && heats.length === 1;
        const isField = ['field_distance', 'field_height'].includes(evt.category);
        // 소집 진행 중 여부 (heats_generated 이후 = 소집 가능 상태)
        const showCallroomStatus = (evt.round_status === 'in_progress' || evt.round_status === 'heats_generated');
        let html = '';

        for (const heat of heats) {
            const entries = await API.getHeatEntries(heat.id);
            const hLabel = isFinalSingle ? '결승' : (heat.heat_name || `${heat.heat_number}조`);

            // 소집 상태 요약
            const cntChecked = entries.filter(e => e.status === 'checked_in').length;
            const cntNoShow = entries.filter(e => e.status === 'no_show').length;
            const cntPending = entries.length - cntChecked - cntNoShow;
            const allChecked = cntChecked === entries.length && entries.length > 0;

            html += `<div style="border-bottom:1.5px solid #e8e8e8;">`;
            html += `<div style="padding:8px 14px;background:#fafafa;display:flex;align-items:center;justify-content:space-between;">`;
            html += `<span style="font-weight:700;font-size:13px;color:#333;">${hLabel}</span>`;
            // 소집 상태 뱃지
            if (showCallroomStatus) {
                if (allChecked) {
                    html += `<span style="font-size:10px;background:#b79f58;color:#fff;padding:2px 8px;border-radius:10px;font-weight:600;">소집 완료 ✓</span>`;
                } else if (cntChecked > 0 || cntNoShow > 0) {
                    html += `<span style="font-size:10px;color:#555;">`;
                    html += `<span style="color:#b79f58;font-weight:700;">출석 ${cntChecked}</span>`;
                    if (cntPending > 0) html += ` · <span style="color:#b79f58;font-weight:700;">대기 ${cntPending}</span>`;
                    if (cntNoShow > 0) html += ` · <span style="color:#f44336;font-weight:700;">불참 ${cntNoShow}</span>`;
                    html += `</span>`;
                } else {
                    html += `<span style="font-size:10px;color:#999;">대기 ${entries.length}명</span>`;
                }
            } else {
                html += `<span style="font-size:11px;color:#999;">${entries.length}명</span>`;
            }
            html += `</div>`;
            html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">`;
            html += `<thead><tr style="background:#f5f5f5;border-bottom:1px solid #e0e0e0;">`;
            html += `<th style="padding:5px 8px;text-align:center;width:42px;font-weight:600;color:#777;">${isField ? '순서' : '레인'}</th>`;
            html += `<th style="padding:5px 8px;text-align:center;width:50px;font-weight:600;color:#777;">배번</th>`;
            html += `<th style="padding:5px 8px;text-align:left;font-weight:600;color:#777;">이름</th>`;
            html += `<th style="padding:5px 8px;text-align:left;font-weight:600;color:#777;">소속</th>`;
            if (showCallroomStatus) html += `<th style="padding:5px 8px;text-align:center;width:48px;font-weight:600;color:#777;">상태</th>`;
            html += `</tr></thead><tbody>`;

            const sorted = [...entries].sort((a, b) => (a.lane_number || 999) - (b.lane_number || 999));
            for (const e of sorted) {
                // 상태별 행 배경색
                const rowBg = e.status === 'no_show' ? 'background:#fff5f5;' : e.status === 'checked_in' ? 'background:#f1f8e9;' : '';
                html += `<tr style="border-bottom:1px solid #f0f0f0;${rowBg}">`;
                html += `<td style="padding:5px 8px;text-align:center;color:#555;">${e.lane_number || '-'}</td>`;
                html += `<td style="padding:5px 8px;text-align:center;font-weight:700;">${e.bib_number || '-'}</td>`;
                html += `<td style="padding:5px 8px;text-align:left;font-weight:600;">${e.name}</td>`;
                html += `<td style="padding:5px 8px;text-align:left;color:#666;">${e.team || ''}</td>`;
                if (showCallroomStatus) {
                    let badge = '<span style="font-size:10px;color:#bbb;">—</span>';
                    if (e.status === 'checked_in') badge = '<span style="font-size:10px;color:#b79f58;font-weight:700;">출석</span>';
                    else if (e.status === 'no_show') badge = '<span style="font-size:10px;color:#f44336;font-weight:700;">불참</span>';
                    html += `<td style="padding:5px 8px;text-align:center;">${badge}</td>`;
                }
                html += `</tr>`;
            }
            html += `</tbody></table></div>`;
        }

        body.innerHTML = html || '<div style="padding:20px;text-align:center;color:var(--text-muted);">조 편성 데이터가 없습니다.</div>';

        // 운영자용 소집실/기록실 링크 추가
        const isAdmin = currentRole === 'admin';
        const isJudge = currentRole === 'operation' || isAdmin;
        if (isJudge) {
            const compQ = getCompetitionId() ? `&comp=${getCompetitionId()}` : '';
            body.innerHTML += `<div style="padding:10px 14px;border-top:1px solid #e0e0e0;display:flex;gap:8px;justify-content:center;">
                <a href="/callroom.html?event_id=${eventId}${compQ}" class="btn btn-sm btn-outline" style="font-size:11px;">소집실 이동</a>
                <a href="/record.html?event_id=${eventId}${compQ}" class="btn btn-sm btn-primary" style="font-size:11px;">기록실 이동</a>
            </div>`;
        }
    } catch (e) {
        body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger);">오류: ${e.message}</div>`;
    }
}
