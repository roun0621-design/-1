/**
 * PACE RISE : Node — dashboard.js v8
 * Real-time viewer: wait → summon → result flow
 * Gender colors, competition-scoped, favorites via localStorage
 * Video modal integration on event matrix + comp header
 */

// Helper: bib() is shared from common.js (loaded before dashboard.js)

let allEvents = [];
let currentGender = 'ALL'; // 'ALL' | 'M' | 'F' | 'X'  (기본탭: 전체)
let _catFilter = 'ALL';    // 종목군 필터: 'ALL' | 'track' | 'field' | 'combined' | 'relay' | 'road' (폰 필터 패널)
const _CAT_LABEL = { track: '트랙', field: '필드', combined: '혼성경기', relay: '계주', road: '로드' };
const _GENDER_LABEL = { M: '남자', F: '여자', X: '혼성' };
let callroomCompletedIds = new Set();
let currentRole = localStorage.getItem('pace_role') || 'viewer';
let _compVideoUrl = ''; // Competition-level video URL
let _pacingMap = {}; // event_name → pacing config (for W/L Target buttons)
let _scheduleMap = {}; // event_id → { time, callroom_time, is_today } from timetable
let _timetableFull = { days: {}, start_date: null }; // 전체 시간표 (히어로 카드 표시용; 모달은 common.js openTimetable 사용)
let _isDisplayMode = false; // 노출용 대회 모드
let _displayRoster = []; // 노출용 대회 명단
let _currentDivision = '전체'; // 부별 필터

// 알림(관심) 토글 아이콘 — 종(bell) / 종-끄기(bell-off)
const _BELL_ON = '<svg class="fav-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
const _BELL_OFF = '<svg class="fav-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// ── 종목 검색 (툴바 아이콘 → 그 자리에 검색칸) ─────────────────────
let _searchQuery = '';   // 종목명 부분일치 (예: 400 → 400m·400mH·4X400mR, 멀리 → 멀리뛰기)
let _spotlightOnly = false;   // 국제대회: 관심 국가(한국) 선수 출전 종목만
// 국제대회: 선수 행에 PB·SB (있을 때만)
// 기록 옆 작은 태그 하나 (WR·AR·GR·NR·PB·SB) — 비고에서 뽑는다. 줄을 늘리지 않는다 (2026-09-24)
const _REC_TAG_ORDER = ['WR', 'AR', 'GR', 'NR', 'PB', 'SB'];
function _recTagOf(remark) { const t = String(remark || '').split(/\s+/); for (const k of _REC_TAG_ORDER) if (t.includes(k)) return k; return null; }
function _recTagHtml(tag) { return tag ? `<span class="rec-tag rec-tag-${tag}">${tag}</span>` : ''; }
function _remarkRest(remark) { return String(remark || '').split(/\s+/).filter(x => x && !_REC_TAG_ORDER.includes(x)).join(' '); }   // 진출(Q·q) 등 나머지
// 창 제목: 7종·10종 세부종목이면 '부모 · 세부종목'(라운드 없이) — '높이뛰기 결승'로 보여 개별 종목과 헷갈렸다 (2026-09-24)
function _evtTitle(evt, roundL) { if (evt && evt.parent_event_id) { const p = allEvents.find(e => e.id === evt.parent_event_id); return (p ? p.name + ' · ' : '') + String(evt.name || '').replace(/^\[.*?\]\s*/, ''); } return `${evt.name} ${roundL}`; }
function _pbSb(r) { const p = []; if (r && r.personal_best) p.push('PB ' + r.personal_best); if (r && r.season_best) p.push('SB ' + r.season_best); return p.length ? `<span class="rr-pbsb">${p.join(' · ')}</span>` : ''; }
function toggleSpotlight() {
    _spotlightOnly = !_spotlightOnly;
    const b = document.getElementById('dash-spot-btn'); if (b) { b.classList.toggle('active', _spotlightOnly); b.setAttribute('aria-pressed', String(_spotlightOnly)); }
    renderMatrix();
}
function _renderSpotlightButton() {
    const code = (allEvents.find(e => e.spotlight) || {}).spotlight;
    let b = document.getElementById('dash-spot-btn');
    if (!code) { if (b) b.remove(); _spotlightOnly = false; return; }
    if (!b) {
        const host = document.getElementById('dash-search'); if (!host) return;
        b = document.createElement('button'); b.type = 'button'; b.id = 'dash-spot-btn'; b.className = 'dash-spot-btn'; b.setAttribute('aria-pressed', 'false');
        b.onclick = toggleSpotlight; host.parentNode.insertBefore(b, host);
    }
    b.title = code === 'KOR' ? '한국 선수 출전 종목만 보기' : code + ' 선수 종목만';
    b.innerHTML = `<span class="flag">${code === 'KOR' ? PaceIcons.svg('flagKR', { size: 22 }) : code}</span><span class="lbl">${code === 'KOR' ? '한국 선수' : code}</span>`;
    b.classList.toggle('active', _spotlightOnly);
}
// 히어로 오른쪽 반쪽 '대표팀 명단' — 관심 국가(KOR)가 있는 대회에서만. 일반 대회는 시간표 카드 한 장 그대로
let _rosterCache = null, _rosterCacheAt = 0;
async function _loadRoster(force) {
    if (!force && _rosterCache && Date.now() - _rosterCacheAt < 60000) return _rosterCache;
    _rosterCache = await api('GET', `/api/competitions/${getCompetitionId()}/roster`); _rosterCacheAt = Date.now();
    return _rosterCache;
}
function _rosterSortNext(list) {
    const k = a => String(a.next_key || '');
    return list.slice().sort((p, q) => (p.next_key == null) - (q.next_key == null) || (k(p) < k(q) ? -1 : k(p) > k(q) ? 1 : 0) || String(p.name).localeCompare(String(q.name)));
}
function renderHeroRosterButton() {
    const half = document.getElementById('hero-roster'); const row = document.getElementById('hero-row'); if (!half || !row) return;
    const code = (allEvents.find(e => e.spotlight) || {}).spotlight;
    half.hidden = !code; row.classList.toggle('has-roster', !!code);
    if (!code) return;
    const title = document.getElementById('hero-roster-title'), sub = document.getElementById('hero-roster-sub'), icon = document.getElementById('hero-roster-icon');
    if (icon && !icon.innerHTML) icon.innerHTML = code === 'KOR' ? PaceIcons.svg('flagKR', { size: 26 }) : PaceIcons.svg('list', { size: 22 });
    if (title) title.textContent = code === 'KOR' ? '대표팀 명단' : code + ' 명단';
    _loadRoster().then(data => {
        const ath = data.athletes || [];
        const n = ath.length;
        const next = _rosterSortNext(ath).find(a => a.next_key != null);
        const nev = next && next.events.find(e => e.round_status !== 'completed');
        const tm = nev && (nev.scheduled_at ? nev.scheduled_at.slice(11, 16) : nev.time) || '';
        if (title) title.innerHTML = `${code === 'KOR' ? '대표팀 명단' : code + ' 명단'} <span style="display:inline-flex;align-items:center;gap:8px;"><span class="hero-day-chip">${n}명</span>${data.medals ? medalTallyHtml(data.medals, 20) : ''}</span>`;
        if (sub) sub.innerHTML = next && nev ? `다음 <strong>${_esc(next.name)}</strong> ${_esc(nev.event_name)} · ${_esc(tm)}` : `${n}명 · 출전 선수와 기록`;
    }).catch(() => { if (sub) sub.textContent = '출전 선수와 기록'; });
}
// 대표팀 명단 창 — 선수 기준: 출전 종목 · 다음 경기 · PB/SB · 결과 (GET /api/competitions/:id/roster)
// 명단 계열 창(대표팀 명단·엔트리·조 명단) 공용 상자: 폰은 아래에서 올라오는 전체 폭 시트(94vh), PC 는 가운데 창.
//   overlay 를 세 창이 공유하므로 열 때마다 정렬을 다시 정한다 (예전엔 대표팀 명단(시트) 뒤에 엔트리 창이 아래 절반에 걸쳐 열렸다)
function _rosterBox(overlay, maxWidth) {
    const mobile = window.innerWidth < 720;
    overlay.style.alignItems = mobile ? 'flex-end' : 'center';
    return { mobile, box: mobile ? 'width:100%;height:94vh;border-radius:18px 18px 0 0;' : `width:92%;max-width:${maxWidth || 560}px;max-height:88vh;border-radius:12px;`,
        handle: mobile ? '<div style="width:40px;height:4px;border-radius:2px;background:#d9d4ca;margin:8px auto 0;flex-shrink:0;"></div>' : '' };
}
let _rosterModalKind = null;  // 'team' | 'entries' | 'startlist' — 세 창이 overlay 하나를 쓰므로 어느 창인지 기억
let _rosterReturn = null;     // 대표팀 명단에서 종목 창/결과 창을 열었을 때 돌아갈 자리 { view, eventKey, scrollTop }
function _rememberTeamRoster() {
    if (_rosterModalKind !== 'team') return;
    const body = document.getElementById('roster-modal-body');
    _rosterReturn = { view: _rosterView, eventKey: _rosterEventKey, scrollTop: body ? body.scrollTop : 0 };
}
// 종목 창(엔트리·스타트 리스트)이나 결과 창을 닫을 때: 대표팀 명단에서 왔으면 그 자리로 돌아간다
function _returnToTeamRoster() {
    if (!_rosterReturn) return false;
    const r = _rosterReturn; _rosterReturn = null;
    _rosterView = r.view; _rosterEventKey = r.eventKey;
    openTeamRoster(true).then(() => { const b = document.getElementById('roster-modal-body'); if (b) b.scrollTop = r.scrollTop || 0; });
    return true;
}
let _rosterView = null;      // 'athlete'(선수별 · 다음 경기 순) | 'event'(종목별 · 칩 필터). null 이면 자동: 대회가 끝났으면 종목별
let _rosterEventKey = null;  // 종목별에서 고른 종목 (name|gender)
function setRosterSort(m) { _rosterView = m === 'event' ? 'event' : 'athlete'; openTeamRoster(true); }
function _rosterPickEvent(key) { _rosterEventKey = key; openTeamRoster(true); }
// 종목군(칩 묶음): 종목 이름으로 판단
function _eventGroupOf(name, category) {
    const n = String(name || '').replace(/[,\s]/g, '');   // 10,000m → 10000m
    if (category === 'relay' || /x\d+m?r/i.test(n)) return '계주';
    if (category === 'combined' || /종경기/.test(n)) return '혼성';
    if (/경보|kmW|마라톤/i.test(n)) return '경보·도로';
    if (/H$|허들|SC$|장애물/.test(n)) return '허들·장애물';
    if (/뛰기/.test(n)) return '도약';
    if (/던지기/.test(n)) return '투척';
    const m = n.match(/^(\d+)m/); if (m) return +m[1] <= 400 ? '단거리' : '중장거리';
    return '기타';
}
// 종목군 색 [연한 바탕, 진한 글씨] — 칩에서 묶음 라벨 대신 색으로 구분
const _GROUP_TINT = { '단거리': ['#e3f2fd', '#1565c0'], '중장거리': ['#e8f5e9', '#1b5e20'], '허들·장애물': ['#fff3e0', '#e65100'], '경보·도로': ['#e0f7fa', '#006064'], '도약': ['#f3e5f5', '#6a1b9a'], '투척': ['#f8f4ea', '#8a7640'], '혼성': ['#fce4ec', '#ad1457'], '계주': ['#ede7f6', '#4527a0'], '기타': ['#f5f5f5', '#555'] };
const _EVENT_GROUP_ORDER = ['단거리', '중장거리', '허들·장애물', '경보·도로', '도약', '투척', '혼성', '계주', '기타'];
async function openTeamRoster(keep) {
    let overlay = document.getElementById('roster-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div'); overlay.id = 'roster-modal-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s;';
        overlay.onclick = (e) => { if (e.target === overlay) closeRosterModal(); };
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex'; if (window.lockBodyScroll) lockBodyScroll();
    _rosterModalKind = 'team';
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const code = (allEvents.find(e => e.spotlight) || {}).spotlight || 'KOR';
    const teamL = code === 'KOR' ? '대한민국 육상 선수단' : code + ' 선수단';
    const { mobile, box } = _rosterBox(overlay, 600);
    const scrollTop = keep ? (document.getElementById('roster-modal-body') || {}).scrollTop : 0;
    overlay.innerHTML = `<div style="background:#fff;${box}display:flex;flex-direction:column;box-shadow:0 -10px 40px rgba(0,0,0,0.25);overflow:hidden;">
        ${mobile ? '<div style="width:40px;height:4px;border-radius:2px;background:#d9d4ca;margin:8px auto 0;flex-shrink:0;"></div>' : ''}
        <div style="display:flex;align-items:center;gap:10px;padding:${mobile ? '10px 16px 8px' : '14px 18px'};border-bottom:1px solid #eee;flex-shrink:0;">
            ${code === 'KOR' ? PaceIcons.svg('flagKR', { size: 30 }) : ''}
            <div style="flex:1;min-width:0;"><div style="font-weight:800;font-size:16px;color:#1a2a5e;line-height:1.2;" id="team-roster-title">${teamL}</div>
                 <div style="font-size:12px;color:#8a7640;margin-top:3px;" id="team-roster-sub">불러오는 중…</div></div>
            <button onclick="closeRosterModal()" aria-label="닫기" style="flex:none;width:32px;height:32px;border-radius:50%;background:#f0ede6;border:none;cursor:pointer;color:#555;display:flex;align-items:center;justify-content:center;">${PaceIcons.svg('close', { size: 16 })}</button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 16px;border-bottom:1px solid #eee;flex-shrink:0;background:#fbfaf6;"><div id="team-roster-tools"></div><button type="button" class="fav-modal-btn" id="team-roster-fav" style="margin:0;" title="우리 선수 종목의 소집·결과 알림" onclick="event.stopPropagation(); toggleSpotFavorites(this)"></button></div>
        <div id="team-roster-chips" style="flex-shrink:0;"></div>
        <div id="roster-modal-body" style="flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 0 env(safe-area-inset-bottom,0);-webkit-overflow-scrolling:touch;">${uiStateHtml('loading', { title: '선수단 명단을 불러오는 중…' })}</div></div>`;
    if (!keep && window.pushModalState) pushModalState(() => closeRosterModal());
    const body = document.getElementById('roster-modal-body');
    try {
        const data = await _loadRoster(!keep);
        const ended = allEvents.length > 0 && allEvents.every(e => e.round_status === 'completed');
        const view = _rosterView || (ended ? 'event' : 'athlete');
        document.getElementById('team-roster-tools').innerHTML = `<div class="seg-toggle" role="group" aria-label="보기">
            <button type="button" class="${view === 'athlete' ? 'on' : ''}" onclick="setRosterSort('athlete')" aria-pressed="${view === 'athlete'}">선수별</button>
            <button type="button" class="${view === 'event' ? 'on' : ''}" onclick="setRosterSort('event')" aria-pressed="${view === 'event'}">종목별</button></div>`;
        const DOW = ['일', '월', '화', '수', '목', '금', '토'];
        const when = ev => {
            const iso = ev.scheduled_at || (ev.scheduled_date ? `${ev.scheduled_date}T${ev.time || '00:00'}:00` : null);
            if (iso) { const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return `${+m[2]}/${+m[3]}(${DOW[d.getDay()]}) ${m[4]}:${m[5]}`; } }
            return ev.day != null ? `${ev.day}일차 ${ev.time || ''}` : '일정 미정';
        };
        const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' };
        const genderL = { M: '남', F: '여', X: '혼성' };
        // 결과: 순위(결승 '3위' · 예선 '2조 3위') + 기록(풍속) / 상태코드
        const mark = ev => {
            const r = ev.result; if (!r) return '';
            if (r.status_code) return `<span style="color:#b3261e;font-weight:700;">${esc(PaceRanking.statusText(r.status_code))}</span>`;
            const isFinal = ev.round_type === 'final';
            const place = r.place
                ? (isFinal && r.place <= 3 ? medalHtml(r.place, 20) + ' '
                    : `<span style="display:inline-block;min-width:22px;padding:0 5px;border-radius:9px;background:#e9edf6;color:#1a2a5e;font-weight:800;text-align:center;margin-right:5px;">${!isFinal && r.heat_count > 1 && ev.heat_number ? ev.heat_number + '조 ' : ''}${r.place}위</span>`)
                : '';
            const imp = _recTagHtml(r.tag || (r.pb_improved ? 'PB' : r.sb_improved ? 'SB' : null));
            const val = r.time_seconds != null ? formatTime(r.time_seconds) : r.distance_meters != null ? Number(r.distance_meters).toFixed(2) : '';
            if (!val) return '';
            const wind = r.time_seconds != null && r.wind != null ? ` <span style="color:#888;">(${r.wind > 0 ? '+' : ''}${Number(r.wind).toFixed(1)})</span>` : '';
            // 두 줄: 위 순위·기록(·경신), 아래 작게 PB · SB — 경기가 끝나도 PB/SB 는 남긴다
            const pbsbLine = [ev.personal_best ? 'PB ' + ev.personal_best : '', ev.season_best ? 'SB ' + ev.season_best : ''].filter(Boolean).map(esc).join(' · ');
            return `<span style="display:inline-flex;flex-direction:column;align-items:flex-end;gap:2px;"><span>${place}<b>${val}</b>${wind}${imp}</span>${pbsbLine ? `<span style="font-size:10px;color:#999;">${pbsbLine}</span>` : ''}</span>`;
        };
        const pbsb = ev => [ev.personal_best ? 'PB ' + ev.personal_best : '', ev.season_best ? 'SB ' + ev.season_best : ''].filter(Boolean).map(esc).join('<br>');   // 폰에서 종목명 자리를 남기려고 PB·SB 를 위아래로
        // 예선·준결승이 끝나면 진출/탈락 칩을 기록 옆에 (결승은 순위 배지가 이미 있음)
        const advChip = ev => { if (ev.round_type === 'final' || !ev.result || ev.result.status_code) return ''; const nextKo = ev.round_type === 'preliminary' && allEvents.some(e => e.name === ev.event_name && e.gender === ev.gender && e.round_type === 'semifinal') ? '준결승' : '결승'; if (ev.result.qual) return `<span class="spot-chip q">${nextKo} 진출</span>`; return ev.round_status === 'completed' ? `<span class="spot-chip out">${ev.round_type === 'semifinal' ? '준결승' : '예선'} 탈락</span>` : ''; };
        const stOf = ev => ev.round_status === 'completed' ? ((mark(ev) || '<span style="color:#888;">결과</span>') + advChip(ev)) : ev.round_status === 'in_progress' ? ('<span style="color:#16a34a;font-weight:800;">LIVE</span>' + advChip(ev)) : '';
        const evLine = (ev, showName) => {
            const done = ev.round_status === 'completed', live = ev.round_status === 'in_progress';
            const phone = window.innerWidth < 640;
            const right = stOf(ev) || pbsb(ev).replace('<br>', ' · ');
            const label = showName ? esc(showName) : `${ev.relay ? '<span style="font-size:10px;color:#7c3aed;margin-right:3px;">계주</span>' : ''}${esc(ev.event_name)} <span style="color:#888;font-weight:500;">${genderL[ev.gender] || ''} ${roundL[ev.round_type] || ''}</span>`;
            // 폰: 첫 줄 시각·종목, 둘째 줄 결과 또는 PB · SB (오른쪽 칸에 넣으면 잘린다)
            if (phone) return `<div onclick="openEventDetail(${ev.event_id})" style="padding:7px 0;min-height:36px;cursor:pointer;${done ? 'opacity:.75;' : ''}">
                <div style="display:flex;align-items:center;gap:8px;"><span style="flex:none;font-family:var(--font-mono);font-size:11px;color:${live ? '#16a34a' : done ? '#999' : '#1a2a5e'};min-width:92px;">${esc(when(ev))}</span><span style="flex:1;min-width:0;font-size:12px;font-weight:600;">${label}</span></div>
                ${right ? `<div style="padding-left:100px;font-family:var(--font-mono);font-size:11px;color:#555;margin-top:2px;">${right}</div>` : ''}</div>`;
            return `<div onclick="openEventDetail(${ev.event_id})" style="display:flex;align-items:center;gap:8px;padding:7px 0;min-height:36px;cursor:pointer;${done ? 'opacity:.75;' : ''}">
                <span style="flex:none;font-family:var(--font-mono);font-size:11px;color:${live ? '#16a34a' : done ? '#999' : '#1a2a5e'};min-width:92px;">${esc(when(ev))}</span>
                <span style="flex:1;min-width:0;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</span>
                <span style="flex:none;font-family:var(--font-mono);font-size:11px;color:#555;white-space:nowrap;text-align:right;line-height:1.25;">${stOf(ev) || pbsb(ev)}</span></div>`;
        };
        const compNm = (document.querySelector('.comp-info-name') || {}).textContent || '';
        const qPrefix = /아시안게임/.test(compNm) ? '아시안게임 육상 ' : '육상 ';   // 네이버 검색어: '아시안게임 육상 이름' (동명이인·타 종목 선수와 구분)
        const naverUrl = a => (window.innerWidth < 720 ? 'https://m.search.naver.com/search.naver?query=' : 'https://search.naver.com/search.naver?query=') + encodeURIComponent(qPrefix + a.name);
        // 계주 팀은 공식 명단의 영문 국가명(Republic of Korea) 대신 우리말로
        const dispName = a => { if (!(a.is_team && /republic of korea|^korea$/i.test(a.name || ''))) return a.name; const g = (a.events || []).some(e => /mixed/i.test(e.event_name || '') || e.gender === 'X') ? 'X' : a.gender; return `대한민국 계주팀${g === 'M' ? '(남)' : g === 'F' ? '(여)' : '(혼성)'}`; };   // 혼성 계주 팀은 저장 성별이 M 이라 종목으로 판단
        // 이름 줄 전체가 네이버 프로필 링크(새 탭) — 오른쪽 끝 ↗ 로 밖으로 나감을 표시. 아래 종목 줄은 엔트리/결과 창
        const nameLine = a => a.is_team
            ? `<div style="font-size:15px;font-weight:800;display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><span>${esc(dispName(a))}</span></div>`
            : `<a class="roster-name-link" href="${naverUrl(a)}" target="_blank" rel="noopener" title="네이버에서 선수 프로필 보기" onclick="event.stopPropagation()"><span class="naver-link">N</span><span class="nm">${esc(a.name)}</span>${a.name_alt ? `<span class="alt">${esc(a.name_alt)}</span>` : ''}${a.birth_year ? `<span class="alt">${a.birth_year}</span>` : ''}${PaceIcons.svg('external', { size: 13, cls: 'ext' })}</a>`;
        const membersLine = a => a.members && a.members.length ? `<div style="font-size:11px;color:#666;margin-top:1px;">${a.members.map(m => esc(m.name)).join(' · ')}</div>` : '';
        const athletes = data.athletes || [];
        const teams = (data.teams || []).map(t => ({ ...t, members: (t.events[0] && t.events[0].members) || [] }));
        const evCount = new Set(athletes.flatMap(a => a.events.filter(e => !e.relay).map(e => e.event_name + '|' + e.gender))).size;
        document.getElementById('team-roster-title').innerHTML = `${esc(teamL)} · ${athletes.length}명 ${data.medals ? medalTallyHtml(data.medals, 20) : ''}`;
        _renderSpotFavBtn(document.getElementById('team-roster-fav'));
        const chipsEl = document.getElementById('team-roster-chips');

        if (view === 'athlete') {
            // ── 선수별: 다음 경기 순 (모두 끝난 선수는 뒤로) ──
            chipsEl.innerHTML = '';
            const sorted = _rosterSortNext(athletes), teamsSorted = _rosterSortNext(teams);
            document.getElementById('team-roster-sub').textContent = `${evCount}종목${teams.length ? ` · 계주 ${teams.length}팀` : ''}${ended ? ' · 대회 종료' : ''}`;
            const row = a => `<div style="padding:10px 16px 6px;border-top:1px solid #f1f1f1;">${nameLine(a)}${membersLine(a)}
                <div style="margin-top:3px;">${a.events.map(ev => evLine(ev)).join('') || '<div style="font-size:11px;color:#999;">출전 종목 없음</div>'}</div></div>`;
            body.innerHTML = sorted.length
                ? `${sorted.map(row).join('')}${teamsSorted.length ? `<div style="padding:10px 16px 2px;font-size:11px;font-weight:800;color:#7c3aed;letter-spacing:.05em;">계주 (${teamsSorted.length})</div>${teamsSorted.map(row).join('')}` : ''}`
                : uiStateHtml('empty', { title: '선수단 명단이 아직 없습니다', hint: '공식 엔트리가 올라오면 자동으로 들어옵니다.' });
        } else {
            // ── 종목별: 종목 칩(종목군별 바둑판) → 고른 종목의 선수만, 남자/여자로 나눠 ──
            // 종목 키 = 이름 (남·여를 한 칩에) — 계주는 팀 행, 개인 종목은 선수 행
            const byEvent = new Map();   // name → { name, category, athletes: [{a, ev}], teams: [{a, ev}], done }
            const add = (bucket, a, ev) => {
                if (!byEvent.has(ev.event_name)) byEvent.set(ev.event_name, { name: ev.event_name, category: ev.category, athletes: [], teams: [], done: true, live: false });
                const b = byEvent.get(ev.event_name); b[bucket].push({ a, ev });
                if (ev.round_status !== 'completed') b.done = false; if (ev.round_status === 'in_progress') b.live = true;
            };
            athletes.forEach(a => a.events.filter(e => !e.relay).forEach(ev => add('athletes', a, ev)));
            teams.forEach(t => t.events.forEach(ev => add('teams', t, ev)));
            // 한 선수가 같은 종목에 여러 라운드면 첫(가장 이른 미완료 → 없으면 마지막) 라운드 한 줄만
            byEvent.forEach(b => {
                for (const k of ['athletes', 'teams']) {
                    const per = new Map();
                    b[k].forEach(x => { if (!per.has(x.a.id)) per.set(x.a.id, []); per.get(x.a.id).push(x); });
                    b[k] = [...per.values()].map(list => list.find(x => x.ev.round_status !== 'completed') || list[list.length - 1]);
                }
            });
            const events = [...byEvent.values()].sort((p, q) => _evSortIdx(p.name) - _evSortIdx(q.name) || p.name.localeCompare(q.name));
            if (!events.length) { chipsEl.innerHTML = ''; body.innerHTML = uiStateHtml('empty', { title: '선수단 명단이 아직 없습니다' }); return; }
            if (!_rosterEventKey || !byEvent.has(_rosterEventKey)) _rosterEventKey = events[0].name;
            const groups = new Map();
            events.forEach(e => { const g = _eventGroupOf(e.name, e.category); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); });
            // 칩: 종목군 라벨 없이 한 흐름으로 쭉 — 종목군은 색(연한 바탕·진한 글씨)으로만 구분, 고른 칩은 그 색으로 채움
            const chip = e => { const n = e.athletes.length + e.teams.length; const on = e.name === _rosterEventKey; const [bg, fg] = _GROUP_TINT[_eventGroupOf(e.name, e.category)] || _GROUP_TINT['기타'];
                return `<button type="button" onclick="_rosterPickEvent('${esc(e.name).replace(/'/g, '&#39;')}')" aria-pressed="${on}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:12px;border:1px solid ${on ? fg : 'transparent'};background:${on ? fg : bg};color:${on ? '#fff' : fg};font-size:11.5px;font-weight:${on ? 800 : 700};cursor:pointer;line-height:1.3;min-height:26px;white-space:nowrap;">${esc(e.name)}<span style="font-size:10px;font-weight:700;opacity:.75;">${n}</span>${e.live ? '<span style="width:6px;height:6px;border-radius:50%;background:#16a34a;"></span>' : e.done ? `<span style="width:6px;height:6px;border-radius:50%;background:${on ? '#fff' : '#b79f58'};"></span>` : ''}</button>`; };
            const ordered = _EVENT_GROUP_ORDER.filter(g => groups.has(g)).flatMap(g => groups.get(g));
            // 가로 스크롤 2줄 — 7줄이던 칩이 목록을 가리지 않게. 고른 칩은 보이는 위치로
            chipsEl.innerHTML = `<div class="roster-chips" style="padding:8px 14px 8px;border-bottom:1px solid #eee;overflow-x:auto;overscroll-behavior:contain;scrollbar-width:none;display:grid;grid-auto-flow:column;grid-auto-columns:max-content;grid-template-rows:repeat(2,auto);gap:6px 5px;justify-content:start;">${ordered.map(chip).join('')}</div>`;
            try { const on = chipsEl.querySelector('button[aria-pressed="true"]'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
            const sel = byEvent.get(_rosterEventKey);
            document.getElementById('team-roster-sub').textContent = `${events.length}종목${ended ? ' · 대회 종료' : ''}`;
            const gOrder = ['M', 'F', 'X'];
            const secColor = { M: '#1a2a5e', F: '#8b1a2a', X: '#6a1b9a' };   // 남=남색 · 여=버건디 · 혼성=보라 (대시보드 성별 배지와 같은 색)
            const section = (label, list, g) => list.length ? `<div style="padding:8px 16px 2px;font-size:11px;font-weight:800;color:${secColor[g] || '#555'};letter-spacing:.05em;">${label} (${list.length})</div>${list.map(({ a, ev }) => `<div style="padding:6px 16px 4px;border-top:1px solid #f4f4f4;">${nameLine(a)}${membersLine(a)}${evLine(ev, (roundL[ev.round_type] || '') + (ev.heat_number ? ` ${ev.heat_number}조` : ''))}</div>`).join('')}` : '';
            const parts = gOrder.map(g => section(g === 'M' ? '남자' : g === 'F' ? '여자' : '혼성', [...sel.athletes, ...sel.teams].filter(x => x.ev.gender === g).sort((p, q) => String(p.a.name).localeCompare(String(q.a.name))), g));
            body.innerHTML = `<div style="padding:10px 16px 0;font-size:15px;font-weight:900;color:#1a2a5e;">${esc(sel.name)}</div>${parts.join('')}`;
        }
        if (keep && scrollTop) body.scrollTop = scrollTop;
    } catch (e) { body.innerHTML = uiStateHtml('error', { title: '선수단 명단을 불러오지 못했습니다', hint: (e && (e.error || e.message)) || '' }); }
}
// ── 폰 필터 버튼: 성별 · 종목군 · 부를 패널 하나로 (칩이 잘리지 않게). PC 는 기존 칩 (dashboard.html .dash-filter-btn) ──
function renderFilterButton() {
    const btn = document.getElementById('dash-filter-btn'); if (!btn) return;
    const parts = [];
    if (currentGender !== 'ALL') parts.push(_GENDER_LABEL[currentGender] || currentGender);
    if (_catFilter !== 'ALL') parts.push(_CAT_LABEL[_catFilter] || _catFilter);
    if (_isDisplayMode && _currentDivision && _currentDivision !== '전체') parts.push(_currentDivision);
    if (_searchQuery && _searchQuery.trim()) parts.push('“' + _searchQuery.trim() + '”');
    const lbl = document.getElementById('dash-filter-lbl'); if (lbl) lbl.textContent = parts.length ? parts.join(' · ') : '전체';
    btn.classList.toggle('on', parts.length > 0);
    const panel = document.getElementById('dash-filter-panel');
    if (panel && !panel.hidden && !(document.activeElement && document.activeElement.id === 'filter-search')) _renderFilterPanel();
}
function _renderFilterPanel() {
    const panel = document.getElementById('dash-filter-panel'); if (!panel) return;
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const chip = (on, label, onclick, g) => `<button type="button" class="fc${on ? ' on' : ''}"${g ? ` data-g="${g}"` : ''} onclick="${onclick}" aria-pressed="${on}">${esc(label)}</button>`;
    const rows = [];
    // 검색 — 폰에선 툴바 돋보기 대신 여기 (종목명 부분일치: 400 → 400m·400mH·4X400mR)
    rows.push(`<div class="fs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/></svg><input id="filter-search" type="search" inputmode="search" autocomplete="off" placeholder="종목 검색 · 예) 400, 멀리" value="${esc(_searchQuery || '')}" oninput="_filterSearch(this.value)" onkeydown="if(event.key==='Escape'){this.value='';_filterSearch('');}">${_searchQuery ? `<button type="button" class="fs-x" aria-label="지우기" onclick="_filterSearch(''); _renderFilterPanel();">&times;</button>` : ''}</div>`);
    // 성별 — 종목에 있는 성별만 (행사 모드에서 성별 탭을 숨긴 대회는 줄 자체를 뺀다)
    const genderBar = document.getElementById('gender-tabs');
    const genders = [...new Set(allEvents.filter(e => !e.parent_event_id).map(e => e.gender).filter(Boolean))];
    if (!(genderBar && genderBar.style.display === 'none') && genders.length > 1) {
        rows.push(`<div class="fr"><div class="k">성별</div><div class="v">${chip(currentGender === 'ALL', '전체', "_filterGender('ALL')")}${['M', 'F', 'X'].filter(g => genders.includes(g)).map(g => chip(currentGender === g, _GENDER_LABEL[g], `_filterGender('${g}')`, g)).join('')}</div></div>`);
    }
    // 종목군 — 이 대회에 있는 것만
    const catOf = c => c === 'field_distance' || c === 'field_height' ? 'field' : c;
    const cats = ['track', 'field', 'combined', 'relay', 'road'].filter(k => allEvents.some(e => !e.parent_event_id && catOf(e.category) === k));
    if (cats.length > 1) rows.push(`<div class="fr"><div class="k">종목군</div><div class="v">${chip(_catFilter === 'ALL', '전체', "_filterCat('ALL')")}${cats.map(k => chip(_catFilter === k, _CAT_LABEL[k], `_filterCat('${k}')`)).join('')}</div></div>`);
    // 부 — 노출용 대회(부 탭이 있는 대회)만, 지금 성별에 있는 부
    if (_isDisplayMode) {
        const divs = [...new Set(allEvents.filter(e => !e.parent_event_id && (currentGender === 'ALL' || e.gender === currentGender)).map(e => e.division).filter(Boolean))].sort((a, b) => _divCompareKey(a) - _divCompareKey(b) || a.localeCompare(b));
        if (divs.length) rows.push(`<div class="fr"><div class="k">부</div><div class="v">${chip(_currentDivision === '전체', '전체', "_filterDivision('전체')")}${divs.map(d => chip(_currentDivision === d, d, `_filterDivision('${esc(d).replace(/'/g, '&#39;')}')`)).join('')}</div></div>`);
    }
    panel.innerHTML = rows.join('') + `<div class="ft"><button type="button" onclick="resetFilters()">초기화</button><button type="button" class="primary" onclick="toggleFilterPanel(false)">닫기</button></div>`;
}
function toggleFilterPanel(force) {
    const panel = document.getElementById('dash-filter-panel'), btn = document.getElementById('dash-filter-btn'); if (!panel) return;
    const open = force == null ? panel.hidden : !!force;
    if (open) _renderFilterPanel();
    panel.hidden = !open; if (btn) btn.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => document.addEventListener('click', _filterOutside, { once: true }), 0);
}
function _filterOutside(e) { const panel = document.getElementById('dash-filter-panel'); if (!panel || panel.hidden) return; if (panel.contains(e.target) || (e.target.closest && e.target.closest('#dash-filter-btn'))) { document.addEventListener('click', _filterOutside, { once: true }); return; } toggleFilterPanel(false); }
function _filterGender(g) { const btn = document.querySelector(`#gender-tabs .gender-tab-btn[data-gender="${g}"]`); switchGender(g, btn); _renderFilterPanel(); }
function _filterSearch(v) { _searchQuery = v || ''; const b = document.getElementById('dash-search-btn'); if (b) b.classList.toggle('has-query', !!_searchQuery.trim()); renderMatrix(); }
function _filterCat(k) { _catFilter = k; renderMatrix(); _renderFilterPanel(); }
function _filterDivision(d) { if (typeof switchDivision === 'function') switchDivision(d, null); else { _currentDivision = d; renderMatrix(); } _renderFilterPanel(); }
function resetFilters() { _catFilter = 'ALL'; _searchQuery = ''; const sb = document.getElementById('dash-search-btn'); if (sb) sb.classList.remove('has-query'); const sf = document.getElementById('event-search'); if (sf) sf.value = ''; if (_isDisplayMode) _currentDivision = '전체'; const btn = document.querySelector('#gender-tabs .gender-tab-btn[data-gender="ALL"]'); switchGender('ALL', btn); _renderFilterPanel(); }
function onEventSearch(v) {
    _searchQuery = v || '';
    const btn = document.getElementById('dash-search-btn');
    if (btn) btn.classList.toggle('has-query', !!_searchQuery.trim());
    renderMatrix();
}
function toggleEventSearch() {
    const field = document.getElementById('dash-search-field');
    if (!field) return;
    if (field.hidden) {
        field.hidden = false;
        document.getElementById('filter-bar').classList.add('searching');
        document.getElementById('dash-search-btn').classList.add('active');
        const inp = document.getElementById('event-search'); if (inp) { inp.focus(); inp.select(); }
    } else closeEventSearch();
}
function closeEventSearch() {
    const field = document.getElementById('dash-search-field'); if (!field) return;
    field.hidden = true;
    document.getElementById('filter-bar').classList.remove('searching');
    document.getElementById('dash-search-btn').classList.remove('active');
    const inp = document.getElementById('event-search');
    if (inp && inp.value) { inp.value = ''; onEventSearch(''); }      // 닫으면 검색도 푼다 — 필터가 남아 목록이 비어 보이는 일 방지
}
function clearEventSearch() { closeEventSearch(); }

// ── "진행 중 N" 배지 + 라이브 카드로 스크롤 ──────────────────────
function updateLiveJumpBadge(n) {
    const b = document.getElementById('live-jump-badge');
    if (!b) return;
    const c = document.getElementById('live-jump-count');
    if (c) c.textContent = n;
    b.style.display = n > 0 ? '' : 'none';
}
function jumpToLive() {
    const el = document.getElementById('live-pin') || document.querySelector('.live-pin');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 카드 전체 터치 → 종목 상세(가장 관련있는 라운드) 열기 ─────────
// 칩/토글/링크 탭은 각자 동작하도록 전파 차단.
function onCardTap(e, evtId) {
    if (e.target.closest('.round-btn, .fav-cell, .fav-toggle, a, button')) return;
    openEventDetail(evtId);
}
// ── 우리 선수 상태 칩 (카드·명단): 결승 진출(초록) · 탈락(회색 작게) · 최종 순위(메달 원 또는 회색 N위) ──
function _spotChipHtml(st) {
    if (!st) return '';
    if (st.kind === 'final') {
        const places = st.places || [];
        if (!places.length) return st.label ? `<span class="spot-chip out">${st.label}</span>` : '';
        const parts = places.slice(0, 2).map(p => p <= 3 ? medalHtml(p, 18) : `<span class="spot-chip place">${p}위</span>`);
        return `<span class="spot-chip-wrap">${parts.join('')}${places.length > 2 ? `<span class="spot-chip out">외 ${places.length - 2}</span>` : ''}</span>`;
    }
    if (st.kind === 'qualified') return `<span class="spot-chip q">${st.short}${st.count > 1 ? ' · ' + st.count : ''}</span>`;
    if (st.kind === 'out') return `<span class="spot-chip out">${st.short}</span>`;
    return '';
}
// 결과·LIVE 창: 위 '우리 선수' 블록 + 아래 '진출 규칙·진출자' 블록 (GET /api/events/:id/spotlight)
async function _spotBlocksHtml(evt) {
    try {
        if (!allEvents.some(e => e.spotlight)) return { top: '', bottom: '' };
        const d = await api('GET', `/api/events/${evt.id}/spotlight`);
        if (!d || !d.spot) return { top: '', bottom: '' };
        const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const fmt = r => r.status_code ? `<b style="color:#b3261e">${esc(PaceRanking.statusText(r.status_code))}</b>` : r.mark == null ? '' : `<b>${r.is_time ? formatTime(r.mark) : Number(r.mark).toFixed(2)}</b>`;
        const nm = r => r.is_team ? '대한민국' : esc(r.name);
        const roundKo = { preliminary: '예선', semifinal: '준결승', final: '결승' }[d.round_type] || '';
        let top = '';
        // 간단하게: 이름 · 순위(결승은 메달 원) · 기록 · 진출/탈락 — 조·레인·전체 순위는 아래 목록에서 (2026-09-24)
        const rows = (d.rows || []).map(r => {
            const place = r.place ? (d.round_type === 'final' && r.place <= 3 ? medalHtml(r.place, 20) : `<b>${r.heat_number && d.round_type !== 'final' ? r.heat_number + '조 ' : ''}${r.place}위</b>`) : '';
            // 한 명(팀)뿐이면 머리줄 칩이 같은 말을 하니 줄 칩은 생략 (기록·태그가 한 줄에 들어가게)
            const q = (d.rows || []).length <= 1 && d.status ? '' : r.qual ? `<span class="spot-chip q">${d.status && d.status.next ? d.status.next + ' 진출' : '진출'}</span>` : (d.status && d.status.kind === 'out' ? '<span class="spot-chip out">탈락</span>' : '');
            return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;flex-wrap:wrap"><span style="font-size:14px;font-weight:800">${PaceIcons.svg('flagKR', { size: 18, style: 'vertical-align:-4px;margin-right:4px' })}${nm(r)}</span>${place}<span style="font-size:14px">${fmt(r)}${_recTagHtml(r.tag)}</span>${q}${r.is_team && r.members ? `<span style="flex-basis:100%;font-size:11px;color:#666;padding-left:24px">${r.members.map(esc).join(' · ')}</span>` : ''}</div>`;
        });
        const pend = (d.pending || []).map(p => `<div style="padding:4px 0;font-size:13px">${PaceIcons.svg('flagKR', { size: 18, style: 'vertical-align:-4px;margin-right:4px' })}<b>${nm(p)}</b> <span style="color:#666">${p.heat_number ? p.heat_number + '조 ' : ''}${p.lane ? p.lane + '레인' : ''}${p.scheduled_at ? ' · ' + p.scheduled_at.slice(11, 16) + ' 출발' : ''} · 예정</span></div>`);
        if (rows.length || pend.length) {
            const head = d.status ? `<span class="spot-chip ${d.status.kind === 'out' ? 'out' : 'q'}" style="margin-left:auto">${esc(d.status.label)}</span>` : '';
            top = `<div class="spot-block"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="font-size:11px;font-weight:800;color:#8b1a2a;letter-spacing:.05em">한국 선수 · ${roundKo}</span>${head}</div>${rows.join('')}${pend.join('')}</div>`;
        }
        let bottom = '';
        if (d.rule || (d.qualified && d.qualified.length)) {
            const ql = (d.qualified || []).map(x => `<div style="display:flex;gap:8px;align-items:center;padding:3px 0;font-size:12px;${x.team === d.spot ? 'color:#8b1a2a;font-weight:800' : ''}"><span style="flex:none;width:22px;font-weight:800;color:${x.qual === 'Q' ? '#1b7f4d' : '#8a7640'}">${x.qual}</span><span style="flex:none;width:40px;font-weight:700">${x.team === d.spot ? PaceIcons.svg('flagKR', { size: 16, style: 'vertical-align:-3px' }) : esc(x.team)}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x.team === d.spot && x.is_team ? '대한민국' : esc(x.name)}</span><span style="flex:none;color:#666">${x.heat_number ? x.heat_number + '조 ' : ''}${x.place ? x.place + '위' : ''}</span><span style="flex:none;font-family:var(--font-mono)">${x.mark == null ? '' : x.is_time ? formatTime(x.mark) : Number(x.mark).toFixed(2)}</span></div>`);
            bottom = `<div class="spot-block" style="margin-top:14px">${d.rule ? `<div style="font-size:12px;color:#555;margin-bottom:6px"><b>진출 규칙</b> ${esc(d.rule.text_ko)}</div>` : ''}${ql.length ? `<div style="font-size:11px;font-weight:800;color:#8a8580;letter-spacing:.05em;margin:6px 0 2px">${d.status && d.status.next ? d.status.next : '다음 라운드'} 진출 (${ql.length})</div>${ql.join('')}` : ''}</div>`;
        }
        return { top, bottom };
    } catch (e) { return { top: '', bottom: '' }; }
}
function openEventDetail(evtId) {
    const evt = allEvents.find(e => e.id === evtId);
    if (!evt) return;
    _rememberTeamRoster();
    if (_rosterReturn && (evt.round_status === 'completed' || evt.round_status === 'in_progress' || callroomCompletedIds.has(evtId))) {
        // 결과·LIVE 창은 result-overlay(다른 층)라 명단 시트를 잠시 감춘다 — 닫으면 _returnToTeamRoster 가 다시 연다
        const ov = document.getElementById('roster-modal-overlay'); if (ov) ov.style.display = 'none';
    }
    if (evt.round_status === 'completed') { openResult(evtId); return; }
    if (evt.round_status === 'in_progress' || callroomCompletedIds.has(evtId)) { openLiveResult(evtId); return; }
    if (evt.heat_count > 0 && (evt.heat_entry_count == null || evt.heat_entry_count > 0)) { openRosterModal(evtId, evt.name); return; }
    if (evt.entry_count > 0) { openEntriesModal(evtId, evt.name); return; }
    // 예정/대기 — 표시할 상세 없음
}

// Favorites: stored per-user in localStorage keyed by compId
function getFavorites() {
    const compId = getCompetitionId();
    try { return JSON.parse(localStorage.getItem(`pace_favorites_${compId}`) || '[]'); } catch { return []; }
}
function setFavorites(favs) {
    const compId = getCompetitionId();
    localStorage.setItem(`pace_favorites_${compId}`, JSON.stringify(favs));
}
function toggleFavorite(eventName, gender) {
    // gender 는 행의 실제 성별(M/F/X) — 서버 트리거의 'event.gender|name' 키와 일치시키기 위함
    const g = gender || (currentGender !== 'ALL' ? currentGender : 'X');
    const favKey = g + '|' + eventName;
    let favs = getFavorites();
    const wasOn = favs.includes(favKey);
    if (wasOn) { favs = favs.filter(f => f !== favKey); }
    else { favs.push(favKey); }
    setFavorites(favs);
    // 관심 종목 변경 → 푸시 서버에 동기화(알림 받기 켠 경우만 실제 반영)
    try { if (window.PaceRisePush && window.PaceRisePush.syncFavorites) window.PaceRisePush.syncFavorites(); } catch (e) {}
    // 토글을 '켤 때' + 아직 알림 미허용이면 → 알림 켜기 유도 팝업(일주일 보지않기 포함)
    if (!wasOn) { try { window.PaceRisePush && window.PaceRisePush.promptToggle && window.PaceRisePush.promptToggle(); } catch (e) {} }
    renderMatrix();
}

// ── 엔트리·스타트 리스트 창 위의 '기존 기록' 줄 (WR·AR·GR·NR…) — 결과 창과 같은 칩 ──
// 국제대회(관심 국가 대회)에서는 NR(한국 기록)을 빼고 WR·AR·GR 만 — 외국 선수 결과에 한국 기록 배지가 붙지 않게
function _intlRecords(recs) { if (recs && allEvents.some(e => e.spotlight)) { const c = { ...recs }; delete c.division; delete c.competition; return c; } return recs; }   // 국제대회: WR·AR·GR·NR (부·대회 기록은 없음)
async function _recordsLineHtml(evt) {
    try {
        const normName = (typeof normalizeEventNameClient === 'function') ? normalizeEventNameClient(evt.name) : evt.name;
        const compInfo = await API.getCompetitionInfo(getCompetitionId()).catch(() => ({}));
        const recs = _intlRecords(await API.lookupEventRecords(normName, evt.gender, evt.division || null, compInfo?.series_id || null, evt.id).catch(() => null));
        const h = _buildRecordsBannerHTML(recs);
        return h ? `<div style="padding:0 12px;">${h}</div>` : '';
    } catch (e) { return ''; }
}

// ── 결과·LIVE 창 장식: 관심 국가(한국) 선수 줄 강조 + 태극기, 결승 1·2·3위는 메달 원, 배번 없는 대회는 'BIB —' 숨김 ──
function _decorateResultPanel(panel, evt) {
    try {
        const spot = (allEvents.find(e => e.spotlight) || {}).spotlight || null;
        const isFinal = evt && evt.round_type === 'final';
        panel.querySelectorAll('.rr[data-team]').forEach(row => {
            const team = row.getAttribute('data-team');
            if (spot && team === spot) {
                row.classList.add('rr-spot');
                const nm = row.querySelector('.rr-name');
                if (nm && !nm.querySelector('.ui-icon')) nm.insertAdjacentHTML('afterbegin', PaceIcons.svg('flagKR', { size: 17, style: 'margin-right:4px;vertical-align:-3px' }));
            }
            if (isFinal && evt.round_status === 'completed') {
                const rk = row.querySelector('.rr-rank:not(.rr-rank-st)');
                const n = rk ? parseInt(rk.textContent, 10) : NaN;
                if (n >= 1 && n <= 3) { rk.innerHTML = medalHtml(n, 26); rk.classList.add('rr-rank-medal'); }
            }
        });
        if (spot) panel.querySelectorAll('.rr-meta').forEach(m => { m.innerHTML = m.innerHTML.replace(/<i>·<\/i>BIB —|BIB —<i>·<\/i>|BIB —/g, ''); });
    } catch (e) { /* 장식 실패는 결과 표시를 막지 않는다 */ }
}

// ── 종목 창(엔트리·스타트 리스트·결과) 머리글의 알림 토글 — 카드의 종 아이콘을 여기로 옮김 ──
function _favBtnHtml(evt) {
    if (!evt) return '';
    const g = evt.gender || 'X', on = getFavorites().includes(g + '|' + evt.name);
    const n = String(evt.name || '').replace(/'/g, "\\'");
    return `<button type="button" class="fav-modal-btn${on ? ' on' : ''}" aria-pressed="${on}" title="${on ? '이 종목 알림 켜짐 (눌러서 해제)' : '이 종목 소집·결과 알림 받기'}" onclick="event.stopPropagation(); toggleFavoriteFromModal('${n}','${g}', this)">${on ? _BELL_ON : _BELL_OFF}<span>${on ? '알림 켜짐' : '알림'}</span></button>`;
}
function toggleFavoriteFromModal(name, gender, btn) {
    toggleFavorite(name, gender);
    const on = getFavorites().includes(gender + '|' + name);
    if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); btn.innerHTML = (on ? _BELL_ON : _BELL_OFF) + `<span>${on ? '알림 켜짐' : '알림'}</span>`; btn.title = on ? '이 종목 알림 켜짐 (눌러서 해제)' : '이 종목 소집·결과 알림 받기'; }
}
// 대표팀 명단 창: 우리 선수가 나가는 종목 전부를 한 번에 켜고 끈다 (관심 종목 = 성별|종목명, 라운드 무관)
function _spotFavKeys() { return [...new Set(allEvents.filter(e => e.spotlight && !e.parent_event_id).map(e => (e.gender || 'X') + '|' + e.name))]; }
function _spotFavState() { const keys = _spotFavKeys(); if (!keys.length) return { keys, on: 0 }; const favs = getFavorites(); return { keys, on: keys.filter(k => favs.includes(k)).length }; }
function toggleSpotFavorites(btn) {
    const { keys, on } = _spotFavState(); if (!keys.length) return;
    let favs = getFavorites();
    const turnOn = on < keys.length;
    favs = turnOn ? [...new Set([...favs, ...keys])] : favs.filter(k => !keys.includes(k));
    setFavorites(favs);
    try { if (window.PaceRisePush && window.PaceRisePush.syncFavorites) window.PaceRisePush.syncFavorites(); } catch (e) {}
    if (turnOn) { try { window.PaceRisePush && window.PaceRisePush.promptToggle && window.PaceRisePush.promptToggle(); } catch (e) {} }
    renderMatrix();
    if (btn) _renderSpotFavBtn(btn);
    if (typeof showToast === 'function') showToast(turnOn ? `한국 선수 ${keys.length}종목 알림을 켰습니다` : '한국 선수 종목 알림을 껐습니다', 'success', 2500);
}
function _renderSpotFavBtn(btn) {
    const { keys, on } = _spotFavState(); if (!btn) return;
    const all = keys.length > 0 && on === keys.length;
    btn.classList.toggle('on', all); btn.setAttribute('aria-pressed', String(all));
    btn.innerHTML = (all ? _BELL_ON : _BELL_OFF) + `<span>${all ? '전 종목 알림 켜짐' : on ? `알림 ${on}/${keys.length}` : '전 종목 알림'}</span>`;
    btn.title = all ? '한국 선수 전 종목 알림 켜짐 (눌러서 해제)' : '우리 선수가 나가는 모든 종목의 소집·결과 알림 받기';
}

// ── 행사(event) 화이트라벨 — /e/<slug> 진입 시 대회 세팅 + 브랜딩 적용 ──
async function _eventBrandBootstrap() {
    const m = location.pathname.match(/^\/e\/([^\/?#]+)/);
    if (!m) return;
    try {
        // 어떤 경우에도(서비스워커/네트워크 hang 포함) 대시보드 전체가
        // '로딩 중' 에서 멈추지 않도록 5초 타임아웃을 건다.
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 5000) : null;
        let res;
        try {
            res = await fetch('/api/event/' + encodeURIComponent(decodeURIComponent(m[1])),
                ctrl ? { signal: ctrl.signal } : undefined);
        } finally { if (timer) clearTimeout(timer); }
        if (!res.ok) return;
        const ev = await res.json();
        if (ev && ev.id) {
            if (typeof setCompetitionId === 'function') setCompetitionId(ev.id);
            else localStorage.setItem('pace_competition_id', ev.id);
            window.__EVENT_MODE = true;
            window.__EVENT_SLUG = ev.event_slug || '';
            // 노출 override(관리자 설정) — 없으면 자동
            if (Array.isArray(ev.genders)) window.__EVENT_GENDERS = ev.genders;
            if (Array.isArray(ev.rounds)) window.__EVENT_ROUNDS = ev.rounds;
            _applyEventBrand(ev);
        }
    } catch (e) { /* 조용히 무시 */ }
}
// 포인트 컬러 한 개에서 전체 팔레트(배경/라인/소프트 틴트/강조)를 자동 생성한다.
// 사용자가 색 하나만 고르면 대시보드 톤이 통째로 그 색에 맞춰지도록.
function _hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (isNaN(n) || h.length !== 6) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
// w = 흰색 쪽으로 섞는 비율(0=원색, 1=흰색). 옅은 틴트 생성용.
function _tint(rgb, w) {
    const m = (c) => Math.round(c + (255 - c) * w);
    const hx = (c) => ('0' + m(c).toString(16)).slice(-2);
    return '#' + hx(rgb.r) + hx(rgb.g) + hx(rgb.b);
}
function _applyEventBrand(ev) {
    const b = (ev && ev.brand) || {};
    const P = b.point && _hexToRgb(b.point) ? b.point : null;
    const rgb = P ? _hexToRgb(P) : null;
    let css = '';
    if (rgb) {
        // 단일 포인트 → 조화 팔레트. 강조는 원색, 라인/배경은 옅은 틴트로 밸런스.
        const vars = {
            '--green':        P,                 // 핵심 강조(활성 탭/LIVE/주요 버튼)
            '--green-light':  _tint(rgb, 0.90),  // 아주 옅은 채움/hover
            '--green-soft':   _tint(rgb, 0.74),  // 소프트 보더
            '--gray':         _tint(rgb, 0.82),  // 일반 라인/테두리 — 은은한 톤
            '--gray-light':   _tint(rgb, 0.93),  // 옅은 채움
            '--bg':           _tint(rgb, 0.955), // 페이지 배경(금색기 제거, 거의 흰색의 미세 틴트)
            '--bg-dark':      _tint(rgb, 0.88),
            '--accent':       P,                 // 보조 강조도 브랜드 색으로
            '--accent-light': _tint(rgb, 0.90)
        };
        css += ':root{' + Object.keys(vars).map(k => k + ':' + vars[k] + ';').join('') + '}';
        // 인라인/하드코딩된 금색(#b79f58) 잔재도 전부 브랜드 색으로 (색 자동화)
        css += '.header-colon,.header-scope{color:' + P + ';}'
            + 'body.event-brand .fav-toggle.on{background:' + P + '!important;}'
            + 'body.event-brand .round-btn.btn-summon{background:' + _tint(rgb, 0.90) + '!important;color:' + P + '!important;}'
            + 'body.event-brand .gender-tab-btn[data-gender="X"]{color:' + P + '!important;}'
            + 'body.event-brand .gender-tab-btn.active[data-gender="X"]{border-bottom-color:' + P + '!important;background:' + _tint(rgb, 0.90) + '!important;}';
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = P;
    }
    // 워터마크: 콘텐츠 뒤 고정 레이어 + 본문/카드를 살짝 투과시켜 은은하게 보이게.
    if (b.watermark) {
        let wm = document.getElementById('event-watermark');
        if (!wm) {
            wm = document.createElement('div');
            wm.id = 'event-watermark';
            document.body.insertBefore(wm, document.body.firstChild);
        }
        wm.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;'
            + 'background-image:url("' + b.watermark + '");background-repeat:no-repeat;'
            + 'background-position:center 48%;background-size:min(62vw,500px);opacity:.09;';
        // 본문은 워터마크 위, 카드 배경은 반투명으로 워터마크가 비쳐 보이도록(행사 모드 한정)
        css += '.header,.main-content{position:relative;z-index:1;}'
            + 'body.event-brand .live-pin{background:rgba(255,255,255,.62)!important;}'
            + 'body.event-brand .matrix-table{background:rgba(255,255,255,.78)!important;}'
            + 'body.event-brand .matrix-table th,body.event-brand .matrix-section-title{background:rgba(255,255,255,.55)!important;}'
            + 'body.event-brand .matrix-table tbody tr:hover{background:rgba(255,255,255,.45)!important;}';
    }
    document.body.classList.add('event-brand');
    if (css) { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }
    if (b.logo) {
        const h = document.querySelector('.header-title');
        if (h) h.innerHTML = '<img src="' + b.logo + '" alt="" style="height:30px;max-width:220px;vertical-align:middle;object-fit:contain;">';
    }
    if (ev.name) document.title = ev.name;
}

document.addEventListener('DOMContentLoaded', async () => {
    await _eventBrandBootstrap();
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
    _loadSortMode();
    try {
        allEvents = await API.getAllEvents(compId);
    } catch (e) {
        // 서버·네트워크 실패: 빈 화면 대신 원인과 다음 행동
        uiState('events-container', 'error', { title: '종목을 불러오지 못했습니다', hint: (e && (e.error || e.message)) || '네트워크나 서버 상태를 확인하세요.' });
        throw e;
    }
    try {
        const cs = await API.getCallroomStatus();
        callroomCompletedIds = new Set(cs.completed_event_ids);
    } catch (e) {}
    // Load competition info (video URL + mode)
    let _compMode = 'operation';
    try {
        const comp = await API.getCompetition(compId);
        _compVideoUrl = comp.video_url || '';
        _compMode = comp.mode || 'operation';
        _isDisplayMode = comp.mode === 'display';
    } catch(e) { _compVideoUrl = ''; _isDisplayMode = false; }
    // Load display roster if display mode
    if (_isDisplayMode) {
        try {
            _displayRoster = await fetch('/api/display/roster/' + compId).then(r => r.json());
        } catch(e) { _displayRoster = []; }
    }
    // Auto-detect display mode: 부(division)만 보고 노출모드로 강제하지 않는다.
    // ★ 운영(operation) 대회는 부가 있어도 운영 대시보드(명단→LIVE→결과)로 둔다.
    //    노출 대회는 관리자에서 mode='display' 로 명시하면 위 라인에서 이미 잡힌다.
    //    (mode 가 명시적으로 operation 이 아닌 레거시 대회만 부 기반 자동 노출 유지)
    if (!_isDisplayMode && _compMode !== 'operation') {
        const hasDivisions = allEvents.some(e => !e.parent_event_id && e.division);
        if (hasDivisions) {
            _isDisplayMode = true;
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
    // Load full timetable (for hero card + modal)
    try {
        const tt = await fetch('/api/timetable/' + compId).then(r => r.json());
        _timetableFull = tt || { days: {}, start_date: null };
    } catch(e) { _timetableFull = { days: {}, start_date: null }; }
    renderCompVideoButton();
    // 대회별 공지 팝업: [공지] 버튼 표시 + 진입 시 자동 노출 (common.js)
    if (typeof initCompNoticePopup === 'function') initCompNoticePopup();
    renderHeroSchedule();
    // Render division filter tabs when events have divisions (regardless of mode setting)
    renderDivisionTabs();
    renderMatrix();
    // Auto-refresh hero card every 30s (live status)
    if (!window._heroRefreshTimer) {
        window._heroRefreshTimer = setInterval(renderHeroSchedule, 30000);
    }
}

// ═══════════════════════════════════════════════════════════
// HERO SCHEDULE CARD + TIMETABLE MODAL
// ═══════════════════════════════════════════════════════════

// 시간 문자열 "HH:MM" → 분 단위 변환
function _ttToMin(t) {
    if (!t) return -1;
    const m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return -1;
    return parseInt(m[1],10)*60 + parseInt(m[2],10);
}

// 오늘 날짜 기준 day 번호 계산 (start_date가 있으면 사용)
function _ttGetTodayDay() {
    const sd = _timetableFull.start_date;
    if (!sd) return null;
    const start = new Date(sd + 'T00:00:00');
    const today = new Date();
    today.setHours(0,0,0,0);
    const diff = Math.floor((today - start) / 86400000);
    return diff >= 0 ? diff + 1 : null;
}

// 시간표 행을 평탄화해서 시간순으로 반환
function _ttFlattenDay(dayNum) {
    const day = (_timetableFull.days || {})[dayNum];
    if (!day) return [];
    const all = [];
    ['track','field'].forEach(sec => {
        (day[sec] || []).forEach(r => all.push({ ...r, section: sec }));
    });
    all.sort((a,b) => _ttToMin(a.time) - _ttToMin(b.time) || (a.sort_order||0) - (b.sort_order||0));
    return all;
}

// 일차의 마지막 경기 시작시각(분)을 반환 (없으면 -1)
function _ttLastEventMin(dayNum) {
    const items = _ttFlattenDay(dayNum);
    let last = -1;
    for (const it of items) {
        const m = _ttToMin(it.time);
        if (m > last) last = m;
    }
    return last;
}

// 히어로 카드 전환 임계값(분): 마지막 경기 시작시각 + 이 분만큼 지나면 다음 일차로
const _HERO_NEXT_DAY_OFFSET_MIN = 30;
// 히어로 카드의 일차 칩: 'DAY 2' 대신 '9/24(목) · 2일차' (날짜를 알 때)
function _heroDayChip(day) {
    const dd = (_timetableFull.days || {})[day] || {};
    const first = [...(dd.track || []), ...(dd.field || [])].find(x => x.scheduled_date);
    let date = first ? first.scheduled_date : null;
    if (!date && _timetableFull.start_date) { const b = new Date(_timetableFull.start_date + 'T00:00:00'); b.setDate(b.getDate() + (Number(day) - 1)); date = isFinite(b) ? `${b.getFullYear()}-${String(b.getMonth() + 1).padStart(2, '0')}-${String(b.getDate()).padStart(2, '0')}` : null; }
    if (!date) return `<span class="hero-day-chip">DAY ${day}</span>`;
    const dt = new Date(date + 'T00:00:00');
    return `<span class="hero-day-chip">${dt.getMonth() + 1}/${dt.getDate()}(${'일월화수목금토'[dt.getDay()]}) · ${day}일차</span>`;
}

// 현재 시각 기준 화면에 보여줄 day 번호 결정
// 규칙: 오늘이 N일차이고 (오늘 마지막 경기 시작시각 + 30분)이 지났으면 N+1일차로 전환.
//       마지막 N일차 + 30분이 지나면 null (대회 종료) 반환.
// 대회 시작 전이면 1일차(또는 가장 빠른 일차).
function _ttGetTargetDay() {
    const days = _timetableFull.days || {};
    const dayKeys = Object.keys(days).map(Number).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
    if (dayKeys.length === 0) return null;

    const todayDay = _ttGetTodayDay();
    // 대회 시작 전 (todayDay == null 또는 dayKeys[0]보다 작음)
    if (todayDay == null || todayDay < dayKeys[0]) return dayKeys[0];

    // 오늘이 대회 일차 범위 안에 있는 경우
    if (days[todayDay]) {
        const now = new Date();
        const nowMin = now.getHours()*60 + now.getMinutes();
        const lastMin = _ttLastEventMin(todayDay);
        // 마지막 경기 시작 + 30분이 지나면 다음 일차로
        if (lastMin >= 0 && nowMin >= lastMin + _HERO_NEXT_DAY_OFFSET_MIN) {
            // 다음 일차 찾기
            const nextDay = dayKeys.find(d => d > todayDay);
            if (nextDay) return nextDay;
            // 다음 일차 없음 → 대회 종료
            return null;
        }
        return todayDay;
    }

    // 오늘이 대회 일차에 없는 경우 (예: 휴식일 또는 대회 끝난 후)
    // 오늘보다 큰 일차가 남아있으면 그걸 보여주고, 없으면 종료
    const futureDay = dayKeys.find(d => d >= todayDay);
    return futureDay || null;
}

// 히어로 시간표 카드 갱신
function renderHeroSchedule() {
    const card = document.getElementById('hero-schedule');
    if (!card) return;
    const days = _timetableFull.days || {};
    const dayKeys = Object.keys(days).map(Number).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
    const row = document.getElementById('hero-row') || card;
    if (dayKeys.length === 0) {
        // 시간표 없음 → 카드 숨김
        row.style.display = 'none';
        return;
    }

    // 4시간 전환 규칙으로 보여줄 일차 결정 (null이면 대회 종료)
    const targetDay = _ttGetTargetDay();
    if (targetDay == null) {
        // 모든 경기 종료 → 히어로 카드 숨김
        row.style.display = 'none';
        return;
    }
    row.style.display = 'flex';

    const dayItems = _ttFlattenDay(targetDay);

    // 현재 시각 기준 진행중/다음 종목 찾기
    const now = new Date();
    const nowMin = now.getHours()*60 + now.getMinutes();
    const todayDay = _ttGetTodayDay();
    const isToday = (todayDay === targetDay);

    let liveItem = null, nextItem = null;
    if (isToday) {
        for (const it of dayItems) {
            const tMin = _ttToMin(it.time);
            if (tMin < 0) continue;
            // 진행중 판정: 현재 시각이 종목 시간 ~ +25분 사이
            if (tMin <= nowMin && nowMin < tMin + 25) {
                if (!liveItem) liveItem = it;
            } else if (tMin > nowMin && !nextItem) {
                nextItem = it;
            }
        }
    }
    // 다음 경기 못 찾았으면(혹은 다음 날로 전환된 경우) 해당 일차 첫 경기
    if (!nextItem && dayItems.length > 0) nextItem = dayItems[0];

    const totalCount = dayItems.length;
    const titleEl = document.getElementById('hero-title');
    const subEl = document.getElementById('hero-sub');
    const iconEl = document.getElementById('hero-icon');

    row.classList.toggle('live', !!liveItem);
    if (liveItem) {
        card.classList.add('live');
        iconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#dc2626;" class="ui-emoji"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>';
        titleEl.innerHTML = `<span class="hero-live-dot"></span> LIVE 진행중 ${_heroDayChip(targetDay)}`;
        const nextTxt = nextItem ? ` · 다음 <strong>${_esc(nextItem.event_name)}</strong> ${nextItem.time}` : '';
        subEl.innerHTML = `<strong>${_esc(liveItem.event_name)}</strong> ${_esc(liveItem.round||'')} · ${liveItem.time}${nextTxt}`;
    } else if (isToday && nextItem) {
        card.classList.remove('live');
        iconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ui-emoji"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
        titleEl.innerHTML = `오늘의 시간표 ${_heroDayChip(targetDay)}`;
        subEl.innerHTML = `다음 <strong>${_esc(nextItem.event_name)}</strong> ${_esc(nextItem.round||'')} · ${nextItem.time} · 총 ${totalCount}경기`;
    } else {
        card.classList.remove('live');
        iconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ui-emoji"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
        titleEl.innerHTML = `시간표 ${_heroDayChip(targetDay)}`;
        const subTxt = nextItem
            ? `다음 <strong>${_esc(nextItem.event_name)}</strong> ${_esc(nextItem.round||'')} · ${nextItem.time} · 총 ${totalCount}경기`
            : `총 ${totalCount}경기 예정`;
        subEl.innerHTML = subTxt;
    }
}

function _esc(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 시간표 모달 진입은 common.js의 openTimetable()을 그대로 사용 (기존 시간표 기능 보존)

// Render competition-level video button next to comp-info-bar
function renderCompVideoButton() {
    let btn = document.getElementById('comp-video-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'comp-video-btn';
        // 기록지/공지 버튼과 동일 규격(그라데이션·13px·패딩 7/16). 이모지 제거. 간격은 actions gap 담당.
        btn.style.cssText = 'white-space:nowrap;font-size:12px;font-weight:600;padding:3px 13px;border:none;border-radius:999px;color:#fff;cursor:pointer;transition:all 0.15s;letter-spacing:0.2px;background:linear-gradient(135deg,#2a3a6e,#1a2a5e);box-shadow:0 2px 6px rgba(26,42,94,0.3);display:none;';
        btn.textContent = '영상';
        btn.onmouseover = () => { btn.style.transform = 'translateY(-1px)'; };
        btn.onmouseout = () => { btn.style.transform = ''; };
        btn.onclick = () => {
            if (_compVideoUrl) openVideoModal(_compVideoUrl, '대회 대표 영상');
        };
        const bar = document.getElementById('comp-info-actions') || document.getElementById('comp-info-bar');
        if (bar) bar.appendChild(btn);
    }
    btn.style.display = _compVideoUrl ? '' : 'none';
}

function switchGender(g, btn) {
    currentGender = g;
    // 성별 탭 active 표시는 #gender-tabs 안의 버튼에만 적용 (division-tabs 가 .gender-tab-btn 클래스를
    // 재사용하므로 전역 querySelectorAll 로 잡으면 division 탭의 active 도 같이 풀려버림)
    document.querySelectorAll('#gender-tabs .gender-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // 선택된 성별을 data-active-gender 속성으로 노출 (ALL | M | F | X)
    // CSS 가 직접 사용하진 않지만 디버깅 / 통합 테스트에서 유용하게 활용
    try {
        const tabsEl = document.getElementById('gender-tabs');
        if (tabsEl) tabsEl.setAttribute('data-active-gender', g);
        const mainEl = document.querySelector('main.main-content');
        if (mainEl) mainEl.setAttribute('data-active-gender', g);
    } catch (_) { /* noop */ }
    // <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#eab308;" class="ui-emoji"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/></svg> FIX: 성별 변경 시 division 탭 목록도 새 성별에 맞게 다시 렌더링
    //    (남자 탭에서 여자/혼성 division 이 보이던 버그 수정)
    if (typeof renderDivisionTabs === 'function') renderDivisionTabs();
    renderMatrix();
}

// Division filter tabs for display mode
// 연령군 우선 → 성별 보조 (초·중·고·대·일반·U18·U20·선수권·국제). 신규 라벨은 자동으로 마지막에 붙음.
const DIVISION_ORDER = [
    '초등부','남초','여초',
    '중등부','남중','여중',
    '고등부','남고','여고',
    'U18','U18(남)','U18(여)','U18(혼)',
    'U20','U20(남)','U20(여)','U20(혼)',
    '대학부','대학(남)','대학(여)',
    '일반부','일반(남)','일반(여)',
    '선수권','선수권(남)','선수권(여)','선수권(혼)',
    '국제'
];

// 동적 라벨도 합리적 위치에 정렬되도록 연령군 점수를 부여
function _ageGroupScore(d) {
    const s = (d || '').replace(/\s/g, '');
    if (!s) return 900;
    const gr = (s.match(/(\d)학년/) || [])[1] | 0;      // 학년부는 같은 학교급 안에서 학년 순
    if (/초/.test(s)) return 100 + gr;
    if (/중/.test(s)) return 200 + gr;
    if (/고/.test(s)) return 300 + gr;
    if (/U18/i.test(s)) return 350;
    if (/U20/i.test(s)) return 400;
    if (/대학|대$/.test(s)) return 500;
    if (/일반|실업/.test(s)) return 600;
    if (/선수권/.test(s)) return 700;
    if (/마스터즈|master/i.test(s)) return 800;
    if (/국제|inter/i.test(s)) return 850;
    return 900;
}
function _genderScore(d) {
    const s = (d || '').replace(/\s/g, '');
    if (/혼/.test(s)) return 3;
    if (/여/.test(s)) return 2;
    if (/남/.test(s)) return 1;
    return 0;
}
function _divCompareKey(d) {
    const idx = DIVISION_ORDER.indexOf(d);
    if (idx >= 0) return idx;
    return 1000 + _ageGroupScore(d) + _genderScore(d);
}

function renderDivisionTabs() {
    let divBar = document.getElementById('division-tabs');
    if (!divBar) {
        divBar = document.createElement('div');
        divBar.id = 'division-tabs';
        divBar.style.cssText = 'display:flex;gap:0;background:var(--white);padding:4px 0;border-bottom:1px solid var(--gray);flex-wrap:wrap;';
        const genderTabs = document.getElementById('gender-tabs');
        if (genderTabs) genderTabs.after(divBar);
    }
    // <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#eab308;" class="ui-emoji"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/></svg> FIX: 현재 성별 탭(M/F/X)에 해당하는 events 만 division 목록 추출
    //    이전엔 모든 events 의 division 합집합을 보여줘서 "남자" 탭에서도 "선수권(여)" 등이 표시됨.
    //    'ALL' 탭은 전 성별 합집합으로 보여줌 (사용자가 전체 division 을 한눈에 볼 수 있게)
    const existingDivs = [...new Set(
        allEvents
            .filter(e => !e.parent_event_id)
            .filter(e => currentGender === 'ALL' ? true : e.gender === currentGender)
            .map(e => e.division)
            .filter(Boolean)
    )];
    if (existingDivs.length === 0) { divBar.style.display = 'none'; return; }
    divBar.style.display = 'flex';
    // 일반화된 정렬: 사전 정의 순서 → 연령군 점수 → 성별 점수
    const orderedDivs = existingDivs.slice().sort((a, b) => _divCompareKey(a) - _divCompareKey(b) || a.localeCompare(b));
    const all = ['전체', ...orderedDivs];
    // 현재 활성 division 이 새 성별 탭의 목록에 없으면 '전체'로 폴백
    if (_currentDivision !== '전체' && !orderedDivs.includes(_currentDivision)) {
        _currentDivision = '전체';
    }
    // 부가 많은 대회(학년별 대회: 10개 이상)는 탭 대신 목록 상자 — 폰에서 탭이 네 줄씩 차지하지 않게
    if (orderedDivs.length >= 10) {
        const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        divBar.innerHTML = `<label style="display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:12px;font-weight:700;color:#555;">부
            <select onchange="switchDivision(this.value, null)" style="padding:6px 10px;border:1px solid var(--gray);border-radius:6px;font-size:13px;font-weight:600;color:#333;background:#fff;">
                ${all.map(d => `<option value="${esc(d)}" ${d === _currentDivision ? 'selected' : ''}>${esc(d)}</option>`).join('')}
            </select></label>`;
        return;
    }
    divBar.innerHTML = all.map(d => `<button class="gender-tab-btn${d===_currentDivision?' active':''}" style="flex:none;padding:6px 14px;font-size:12px;font-weight:700;color:#555;border-bottom:2px solid transparent;${d===_currentDivision?'color:#b79f58;border-bottom-color:#b79f58;background:#f8f4ea;':''}" onclick="switchDivision('${d.replace(/'/g,"\\'")}',this)">${d}</button>`).join('');
}

function switchDivision(div, btn) {
    _currentDivision = div;
    document.querySelectorAll('#division-tabs button').forEach(b => { b.classList.remove('active'); b.style.color='#555'; b.style.borderBottomColor='transparent'; b.style.background='none'; });
    if (btn) { btn.classList.add('active'); btn.style.color='#b79f58'; btn.style.borderBottomColor='#b79f58'; btn.style.background='#f8f4ea'; }
    renderMatrix();
}

// ── 행사(event) 모드 레이아웃 제어 — 노출 라운드 열 / 성별 탭 ──
// 우선순위: 관리자 override(window.__EVENT_ROUNDS / __EVENT_GENDERS) > 자동(데이터 기반)
let _colRounds = { wl: true, preliminary: true, semifinal: true, final: true };
function _computeColRounds(allGroups) {
    // 일반/노출 모드는 모든 열 유지(기존 동작 불변)
    if (!window.__EVENT_MODE) return { wl: true, preliminary: true, semifinal: true, final: true };
    const ov = window.__EVENT_ROUNDS; // 예: ['wl','final'] / undefined=자동
    if (Array.isArray(ov) && ov.length) {
        return { wl: ov.includes('wl'), preliminary: ov.includes('preliminary'), semifinal: ov.includes('semifinal'), final: ov.includes('final') };
    }
    // 자동: 실제 데이터에 존재하는 라운드 열만 노출
    const has = { preliminary: false, semifinal: false, final: false };
    (allGroups || []).forEach(g => (g.rounds || []).forEach(r => { if (r.round_type in has) has[r.round_type] = true; }));
    if (!has.preliminary && !has.semifinal && !has.final) has.final = true; // 안전장치
    // W/L 자동: 페이싱(Target) 설정이 하나라도 있으면 노출(트레드밀 행사 등은 없음 → 숨김)
    const wlAuto = !!(typeof _pacingMap === 'object' && _pacingMap && Object.keys(_pacingMap).length);
    return { wl: wlAuto, preliminary: has.preliminary, semifinal: has.semifinal, final: has.final };
}
function _applyEventGenderBar() {
    if (!window.__EVENT_MODE) return;
    const bar = document.getElementById('gender-tabs');
    const gv = window.__EVENT_GENDERS; // 예: ['M','F'] subset / undefined / ['ALL']=자동(숨김)
    const explicit = Array.isArray(gv) && gv.length && !(gv.length === 1 && gv[0] === 'ALL');
    if (explicit) {
        if (bar) {
            bar.style.display = '';
            bar.querySelectorAll('.gender-tab-btn').forEach(btn => {
                const g = btn.getAttribute('data-gender');
                btn.style.display = (g === 'ALL' || gv.includes(g)) ? '' : 'none';
            });
        }
    } else {
        // 자동/전체만 → 성별 탭 바 숨김, '전체' 고정 (깔끔)
        if (bar) bar.style.display = 'none';
        currentGender = 'ALL';
    }
}

// ── 종목 정렬 순서 (대시보드 카드 · 대표팀 명단 창 공용) ──
// WA 표준 순서: 단거리 → 중거리 → 장거리 → 허들 → 장애물 → 트랙경보 → 도로경보 → 도로 → 점프 → 투척 → 혼성 → 릴레이
const EVENT_SORT_ORDER = [
    '60m','100m','200m','400m',
    '800m','1500m',
    '3000m','5000m','10000m',
    '60mH','100mH','110mH','400mH',
    '2000mSC','3000mSC',
    '3000mW','5000mW','10000mW',
    '10kmW','20kmW','35kmW','50kmW',
    '하프마라톤','마라톤',
    '높이뛰기','장대높이뛰기',
    '멀리뛰기','세단뛰기',
    '포환던지기','원반던지기','해머던지기','창던지기',
    '5종경기','7종경기','10종경기',
    '4x100mR','4x400mR','4x400mR(혼성)','4x400mR(믹스)','4x800mR','4x1500mR'
];
// 종목명 정규화 (공백·콤마 제거, ×→x, Mixed→혼성, 허들/경보/장애물 표기 통일)
function _normEv(s) {
    if (!s) return '';
    let t = String(s).trim().toLowerCase().replace(/[\s\u3000,]/g,'').replace(/[×✕✖＊*]/g,'x');
    t = t.replace(/(\d+)x(\d+)m?릴레이/g, '$1x$2mr');
    t = t.replace(/(\d+)x(\d+)r(?![a-z0-9])/g, '$1x$2mr');
    t = t.replace(/mixed/g, '혼성').replace(/\(mix\)/g, '(혼성)');
    t = t.replace(/혼성(\d+x\d+mr)/g, '$1(혼성)');
    t = t.replace(/(\d+)\s*km\s*(?:경보|w)\b/gi, '$1kmw');
    t = t.replace(/(\d+)\s*m\s*(?:경보|w)\b/gi, '$1mw');
    t = t.replace(/(\d+)m?허들/g, '$1mh').replace(/허들/g, 'h');
    t = t.replace(/(\d+)m?장애물/g, '$1msc').replace(/장애물/g, 'sc');
    t = t.replace(/하프\s*마라톤|halfmarathon/g, '하프마라톤').replace(/marathon/g, '마라톤');
    return t;
}
function _evSortIdx(name) {
    const target = _normEv(name);
    if (!target) return 999;
    // 1) 정확매칭
    for (let i=0; i<EVENT_SORT_ORDER.length; i++) {
        if (_normEv(EVENT_SORT_ORDER[i]) === target) return i;
    }
    // 2) 카테고리 패턴 매칭 (100mH가 100m에 잡히는 사고 방지)
    const patterns = [
        { re: /^(\d+)mw$/, probe: m => `${m[1]}mw` },
        { re: /^(\d+)kmw$/, probe: m => `${m[1]}kmw` },
        { re: /^(\d+)mh$/, probe: m => `${m[1]}mh` },
        { re: /^(\d+)msc$/, probe: m => `${m[1]}msc` },
        { re: /^(\d+)x(\d+)mr(\(혼성\))?$/, probe: m => `${m[1]}x${m[2]}mr${m[3]||''}` },
        { re: /^(\d+)m$/, probe: m => `${m[1]}m` },
    ];
    for (const p of patterns) {
        const mt = target.match(p.re);
        if (!mt) continue;
        const probe = p.probe(mt);
        for (let i=0; i<EVENT_SORT_ORDER.length; i++) {
            if (_normEv(EVENT_SORT_ORDER[i]) === probe) return i;
        }
    }
    return 999;
}

// 시간별 보기로 처음 열 때: 지금 시각에 가장 가까운(아직 안 끝난) 종목 카드로 부드럽게 스크롤(화면 중앙) — 표시는 NEXT 칩·LIVE 깜빡임(_markNext)
let _scrolledToNow = false;     // 세션당 한 번 (실제로 움직인 뒤에 true)
let _nowFlashUntil = 0, _nowFlashKey = null;   // 다시 그려져도(데이터가 뒤늦게 더 오면 카드가 통째로 교체된다) 같은 카드를 다시 찾아 위치를 유지
function _nowRows() { return [...document.querySelectorAll('#events-container tr[data-sched]:not([data-combined])')]; }   // 7종·10종은 며칠 내내 LIVE 라 제외
function _nowKeyOf(r) { const n = r.querySelector('.event-name'); return r.getAttribute('data-sched') + '|' + (n ? n.textContent.trim().slice(0, 30) : ''); }
function _pickNowRow(rows) {
    const now = new Date(); const pad = n => String(n).padStart(2, '0');
    const nowKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // 진행 중 > 지금 이후 첫 종목 > (다 지났으면) 마지막 종목
    return rows.find(r => r.querySelector('.status-live'))
        || rows.find(r => !r.hasAttribute('data-done') && r.getAttribute('data-sched') >= nowKey)
        || rows.find(r => !r.hasAttribute('data-done'))
        || rows[rows.length - 1] || null;
}
// 카드가 화면 세로 중앙에 오도록 (폰: 화면 중간 기준)
function _scrollRowTo(target, behavior) {
    const scroller = document.getElementById('events-scroll-region');
    const rect = target.getBoundingClientRect();
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 4) {
        const y = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop - (scroller.clientHeight - rect.height) / 2;
        scroller.scrollTo({ top: Math.max(0, y), behavior });
    } else {
        const y = rect.top + window.scrollY - (window.innerHeight - rect.height) / 2;
        window.scrollTo({ top: Math.max(0, y), behavior });
    }
}
// 깜빡임은 JS 가 .blink-on 을 켜고 끈다 (iOS '동작 줄이기'가 CSS 애니메이션을 끄기 때문). 대상: LIVE 배지 · NEXT 칩
let _blinkTimer = null, _blinkPhase = false;
function _ensureBlinker() {
    if (_blinkTimer) return;
    _blinkTimer = setInterval(() => { _blinkPhase = !_blinkPhase; document.querySelectorAll('.blinker').forEach(el => el.classList.toggle('blink-on', _blinkPhase)); }, 600);
}
// 렌더 뒤: '지금' 종목에 표시 — 진행 중이면 LIVE 배지가 깜빡, 아니면 시간 칩 옆에 NEXT 칩(깜빡). 종목별·시간별 공통, 7종·10종 제외
function _markNext() {
    document.querySelectorAll('.chip-next').forEach(el => el.remove());
    document.querySelectorAll('.status-live').forEach(el => el.classList.add('blinker'));
    const target = _pickNowRow(_nowRows());
    if (target && !target.querySelector('.status-live')) {
        const chip = document.createElement('span'); chip.className = 'card-chip chip-next blinker'; chip.textContent = 'NEXT';
        const t = target.querySelector('.chip-time'); const wrap = target.querySelector('.card-chips');
        if (t) t.insertAdjacentElement('afterend', chip); else if (wrap) wrap.appendChild(chip);
    }
    _ensureBlinker();
}
function _scrollToNow() {
    if (_scrolledToNow) return;
    if (!_nowRows().length) return;
    _scrolledToNow = true;
    setTimeout(() => {
        const target = _pickNowRow(_nowRows());    // 그 사이 다시 그려졌을 수 있으니 지금 DOM 에서 다시 고른다
        if (!target) return;
        _nowFlashKey = _nowKeyOf(target); _nowFlashUntil = Date.now() + 4000;
        _scrollRowTo(target, 'smooth');
    }, 300);
}
// 렌더 직후: 방금 '지금' 카드로 옮겼는데 다시 그려졌다면 같은 카드를 찾아 위치를 이어간다
function _keepNowAfterRender() {
    if (!_nowFlashKey || Date.now() > _nowFlashUntil) return;
    const target = _nowRows().find(r => _nowKeyOf(r) === _nowFlashKey);
    if (target) _scrollRowTo(target, 'auto');
}
// 정렬 모드: 종목별(WA 순서) / 시간별(다음 경기 시각순, 날짜 묶음) — 대회별로 기억
let _sortMode = 'event';
function _loadSortMode() { try { const v = localStorage.getItem('pace_sort_mode_' + getCompetitionId()); _sortMode = v === 'event' ? 'event' : 'time'; } catch (e) { _sortMode = 'time'; } }   // 기본 시간별(2026-09-24) — 시간표 없는 대회는 renderMatrix 가 종목별로 되돌린다
function setSortMode(m) { _sortMode = m === 'time' ? 'time' : 'event'; try { localStorage.setItem('pace_sort_mode_' + getCompetitionId(), _sortMode); } catch (e) {} renderMatrix(); }
// 홀짝 버튼 모양의 정렬 토글 (대시보드·명단 창 공용)
function segToggleHtml(mode, onclickFn, opts) {
    const o = opts || {};
    return `<div class="seg-toggle" role="group" aria-label="정렬"${o.style ? ` style="${o.style}"` : ''}>
        <button type="button" class="${mode === 'event' ? 'on' : ''}" onclick="${onclickFn}('event')" aria-pressed="${mode === 'event'}">종목별</button>
        <button type="button" class="${mode === 'time' ? 'on' : ''}" onclick="${onclickFn}('time')" aria-pressed="${mode === 'time'}">시간별</button></div>`;
}
// 그룹(종목)의 다음 경기 시각 키: 아직 안 끝난 첫 라운드 → 없으면 결승/준결승/예선. 시간표 없으면 null
function _groupScheduleKey(g) {
    const by = t => g.rounds.find(r => r.round_type === t);
    const order = [by('preliminary'), by('semifinal'), by('final')].filter(Boolean);
    const pending = order.filter(r => _scheduleMap[r.id] && r.round_status !== 'completed');
    const pick = pending[0] || order.slice().reverse().find(r => _scheduleMap[r.id]);
    const sc = pick && _scheduleMap[pick.id]; if (!sc || !sc.time) return null;
    return { key: `${sc.scheduled_date || ('D' + String(sc.day || 0).padStart(2, '0'))}T${sc.time}`, date: sc.scheduled_date || null, day: sc.day || null, is_today: !!sc.is_today };
}

function renderMatrix() {
    _sortToggleDone = false;
    _applyEventGenderBar();
    const container = document.getElementById('events-container');
    // 'ALL' 탭이면 성별 필터 해제 → 남/여/혼성 모든 종목을 종목순으로 통합 표시
    let events = allEvents.filter(e => !e.parent_event_id);
    _renderSpotlightButton();
    renderHeroRosterButton();
    renderFilterButton();
    if (_spotlightOnly) {
        const spotBases = new Set(allEvents.filter(e => e.spotlight && !e.parent_event_id).map(e => (e.name + '|' + e.gender)));   // 세부종목(7종 높이뛰기)이 개별 종목(높이뛰기)을 끌어오지 않게
        events = events.filter(e => spotBases.has(e.name + '|' + e.gender));
    }
    if (_searchQuery && _searchQuery.trim()) {
        const norm = x => String(x || '').toLowerCase().replace(/[×x]/g, 'x').replace(/[\s,]/g, '');
        const q = norm(_searchQuery);
        events = events.filter(e => norm(e.name).includes(q) || norm(e.division).includes(q));
    }
    if (currentGender !== 'ALL') {
        events = events.filter(e => e.gender === currentGender);
    }
    // FIX: 노출(display) 모드에서는 부별이 비어있는 "미지정" 종목을 화면에서 제외
    // (단, 혼성 릴레이처럼 의도적으로 gender='X'인 종목은 division이 채워져 있으므로 영향 없음)
    if (_isDisplayMode) {
        events = events.filter(e => (e.division && e.division.trim()) || e.gender === 'X');
    }
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

    // Group events by name + gender (+ division for display mode)
    // gender 를 그룹키에 포함해야 '전체' 탭에서 남자 100m / 여자 100m 가 서로 다른 행으로 분리됨
    const eventGroups = {};
    events.forEach(e => {
        const gKey = _isDisplayMode
            ? (e.name + '|' + e.category + '|' + e.gender + '|' + (e.division||''))
            : (e.name + '|' + e.category + '|' + e.gender);
        if (!eventGroups[gKey]) eventGroups[gKey] = { name: e.name, category: e.category, gender: e.gender, division: e.division || '', rounds: [], spotlight: null };
        eventGroups[gKey].rounds.push(e);
        if (e.spotlight) eventGroups[gKey].spotlight = e.spotlight;      // 국제대회: 관심 국가(KOR) 선수 출전 종목
        if (e.spot_status) { const pr = { final: 3, semifinal: 2, preliminary: 1 }[e.round_type] || 0; const cur = eventGroups[gKey]._spotPr || 0; if (pr >= cur) { eventGroups[gKey].spot_status = e.spot_status; eventGroups[gKey]._spotPr = pr; } }
    });

    const allGroups = [];
    function _divSortIdx(div) { return _divCompareKey(div); }
    // 성별 정렬 점수: 남(0) < 여(1) < 혼성(2)
    function _genderSortIdx(g) { return g === 'M' ? 0 : g === 'F' ? 1 : g === 'X' ? 2 : 3; }
    categories.filter(cat => _catFilter === 'ALL' || cat.key === _catFilter).forEach(cat => {   // 폰 필터 패널의 종목군
        const groups = Object.values(eventGroups).filter(g => cat.match(g.category));
        // 종목순 → 성별순(M<F<X) → 부별순  ('전체' 탭에서 남100m → 여100m → 남200m → 여200m ... 흐름)
        groups.sort((a,b) =>
            _evSortIdx(a.name) - _evSortIdx(b.name)
            || _genderSortIdx(a.gender) - _genderSortIdx(b.gender)
            || _divSortIdx(a.division) - _divSortIdx(b.division)
            || a.name.localeCompare(b.name)
        );
        groups.forEach(g => allGroups.push({ ...g, catKey: cat.key, catLabel: cat.label }));
    });

    let html = '';

    // 행사모드: 노출할 라운드 열 계산(자동 또는 override) — 렌더 전에 1회
    _colRounds = _computeColRounds(allGroups);

    // 종합기록지 버튼 삭제됨 — 관리자 문서 탭에서 다운로드

    // Render LIVE (in_progress) section pinned at top
    // 종합경기(10종/7종)는 이틀 내내 '진행 중'이라 상단 LIVE 묶음·"진행 중 N" 배지에서 제외 (COMBINED 섹션의 자기 카드에만 상태 표시)
    const liveGroups = allGroups.filter(g => g.catKey !== 'combined' && g.rounds.some(r => r.round_status === 'in_progress'));
    if (liveGroups.length > 0) {
        html += `<div class="live-pin" id="live-pin" style="margin-bottom:16px;padding:12px;background:linear-gradient(135deg,var(--green-light),var(--green-soft));border:1.5px solid var(--green);border-radius:var(--radius);">
            <div style="font-family:var(--font-brand);font-size:13px;font-weight:400;color:var(--green);letter-spacing:1px;margin-bottom:8px;">● LIVE • 진행중인 경기</div>`;
        html += renderCategoryTable(liveGroups, 'LIVE', true);
        html += `</div>`;
    }

    // 정렬 토글 (홀짝 버튼) — 종목이 있을 때만
    // 시간표가 하나도 없는 대회는 토글을 숨긴다 (시간별 정렬이 의미 없음)
    const _hasSchedule = Object.keys(_scheduleMap || {}).length > 0;
    if (!_hasSchedule && _sortMode === 'time') _sortMode = 'event';
    // 정렬 토글은 필터 줄 오른쪽 끝(#dash-sort-slot) — 시간표 없는 대회는 숨김
    { const slot = document.getElementById('dash-sort-slot'); if (slot) slot.innerHTML = allGroups.length && _hasSchedule ? segToggleHtml(_sortMode, 'setSortMode') : ''; }
    _sortToggleInTitle = false;

    if (_sortMode === 'time') {
        // 시간별: 날짜(일차)별로 묶고 그 안은 다음 경기 시각순. 시간표에 없는 종목은 맨 아래 '시간 미정'
        const keyed = allGroups.map(g => ({ g, sk: _groupScheduleKey(g) }));
        keyed.sort((a, b) => (a.sk == null) - (b.sk == null) || (a.sk && b.sk ? (a.sk.key < b.sk.key ? -1 : a.sk.key > b.sk.key ? 1 : 0) : 0) || _evSortIdx(a.g.name) - _evSortIdx(b.g.name) || _genderSortIdx(a.g.gender) - _genderSortIdx(b.g.gender));
        const buckets = [];
        keyed.forEach(({ g, sk }) => {
            g._sk = sk;
            const label = !sk ? '시간 미정' : sk.date ? (() => { const dt = new Date(sk.date + 'T00:00:00'); return isFinite(dt) ? `${dt.getMonth() + 1}/${dt.getDate()}(${'일월화수목금토'[dt.getDay()]})${sk.is_today ? ' · 오늘' : ''}` : sk.date; })() : sk.day ? `${sk.day}일차` : '시간 미정';
            let b = buckets[buckets.length - 1]; if (!b || b.label !== label) { b = { label, groups: [] }; buckets.push(b); }
            b.groups.push(g);
        });
        buckets.forEach(b => { html += renderCategoryTable(b.groups, b.label); });
    } else {
        // Render by category
        categories.forEach(cat => {
            const groups = allGroups.filter(g => g.catKey === cat.key);
            if (groups.length === 0) return;
            html += renderCategoryTable(groups, cat.label);
        });
    }

    if (!html) {
        const isAdmin = (localStorage.getItem('pace_role') || '') === 'admin';
        html = (currentGender !== 'ALL' || _catFilter !== 'ALL' || _spotlightOnly || (_searchQuery && _searchQuery.trim()))
            ? uiStateHtml('empty', { title: '조건에 맞는 종목이 없습니다', hint: '필터를 풀거나 바꿔 보세요.', action: { label: '필터 초기화', onclick: 'resetFilters()' } })
            : uiStateHtml('empty', { title: '등록된 종목이 없습니다', hint: '관리자에서 종목을 만들거나 연맹 명단을 올리면 여기에 나타납니다.', action: isAdmin ? { label: '관리자 열기', onclick: `location.href='/admin.html?comp=${getCompetitionId()}'` } : null });
    }
    container.innerHTML = html;
    updateLiveJumpBadge(liveGroups.length);
    _markNext();
    if (_sortMode === 'time') { _scrollToNow(); _keepNowAfterRender(); }
}

let _sortToggleInTitle = false, _sortToggleDone = false;
function renderCategoryTable(groups, label, isLive) {
    const favs = getFavorites();
    // 정렬 토글은 첫 섹션 제목 줄에만 (LIVE 묶음 제외) — 한 줄을 따로 차지하지 않게
    const tog = _sortToggleInTitle && !isLive && !_sortToggleDone ? (_sortToggleDone = true, segToggleHtml(_sortMode, 'setSortMode')) : '';
    let html = `<div class="matrix-section">
        <div class="matrix-section-title" style="display:flex;align-items:center;justify-content:space-between;"><span>${label}</span>${tog}</div>
        <div class="matrix-scroll-wrap">
        <table class="matrix-table${_isDisplayMode ? ' matrix-display' : ''}">
            <thead><tr>
                <th style="text-align:left;">종목</th>
                ${_isDisplayMode ? '<th style="width:64px;">영상</th><th style="width:60px;">명단</th>' : (_colRounds.wl ? '<th style="width:52px;">W/L</th>' : '')}
                ${_colRounds.preliminary ? '<th style="width:72px;"><span style="color:#1565c0;">예선</span></th>' : ''}
                ${_colRounds.semifinal ? '<th style="width:72px;"><span style="color:#e65100;">준결승</span></th>' : ''}
                ${_colRounds.final ? '<th style="width:72px;"><span style="color:#b71c1c;">결승</span></th>' : ''}
            </tr></thead>
            <tbody>`;

    groups.forEach(g => {
        const prelim = g.rounds.find(r => r.round_type === 'preliminary');
        const semi = g.rounds.find(r => r.round_type === 'semifinal');
        const fin = g.rounds.find(r => r.round_type === 'final');
        // 행 단위 성별 — 그룹의 gender(M/F/X) 를 우선, 폴백으로 currentGender (개별 탭일 때 동일값)
        const _rowGender = g.gender || (currentGender !== 'ALL' ? currentGender : 'X');
        const _gLabel = _rowGender === 'M' ? '남' : _rowGender === 'F' ? '여' : '혼성';
        // 종목명 앞 작은 성별 배지 (남/여/혼)
        const _badgeText = _rowGender === 'M' ? '남' : _rowGender === 'F' ? '여' : '혼';
        const genderBadge = `<span class="gender-badge" data-g="${_rowGender}" aria-label="${_gLabel}">${_badgeText}</span>`;
        const pacingCfg = _pacingMap[g.name + ' (' + _gLabel + ')'] || _pacingMap[g.name];
        const _pacingKey = pacingCfg ? pacingCfg.event_name : g.name;
        const wlCell = pacingCfg ? `<span class="round-btn" style="background:#f0f9ff;color:#6b6b6b;border:1px solid #c0c0c0;cursor:pointer;font-size:11px;padding:3px 6px;white-space:nowrap;" onclick="openPacingPopup('${_pacingKey.replace(/'/g, "\\'")}')">Target</span>` : '';

        // Display mode: video button (종목당 1개, 결승 > 준결승 > 예선 우선순위)
        let videoCell = '';
        if (_isDisplayMode) {
            const vidEvt = [fin, semi, prelim].find(r => r && r.video_url && String(r.video_url).trim());
            if (vidEvt) {
                const _vName = (g.name || '').replace(/'/g, "\\'");
                videoCell = `<span class="round-btn" style="background:#f3e8ff;color:#7c3aed;border:1px solid #d8b4fe;cursor:pointer;font-size:10px;padding:3px 6px;font-weight:700;white-space:nowrap;" onclick="openEventVideoModal(${vidEvt.id},'${_vName}')">▶ 영상</span>`;
            } else {
                videoCell = ''; // 없으면 빈 칸(모바일 숨김) — '—' 제거
            }
        }

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
                rosterCell = ''; // 없으면 빈 칸(모바일 숨김) — '—' 제거
            }
        }

        // Time badge from schedule (show time for first available round: final > semifinal > preliminary)
        // 스케줄이 '있는' 라운드를 결승→준결승→예선 순으로 선택.
        // (결승 이벤트가 자동생성됐지만 시간표에 결승이 없을 때, 준결승/예선 시간으로 폴백)
        // 다음에 열리는 라운드의 시간: 아직 끝나지 않은 첫 라운드(예선 → 준결승 → 결승), 다 끝났으면 결승
        const _pending = [prelim, semi, fin].filter(r => r && _scheduleMap[r.id] && r.round_status !== 'completed');
        const schedEvt = (_pending[0] && _scheduleMap[_pending[0].id]) || (fin && _scheduleMap[fin.id]) || (semi && _scheduleMap[semi.id]) || (prelim && _scheduleMap[prelim.id]) || null;
        let timeBadge = '';
        if (schedEvt && schedEvt.time) {
            const tColor = schedEvt.is_today ? '#b79f58' : '#999';
            const tBg = schedEvt.is_today ? '#f8f4ea' : '#f5f5f5';
            const crBadge = isCallRoomWindow(schedEvt.callroom_time, schedEvt.scheduled_date) ? ' <span class="ico-callroom">Call Room</span>' : '';
            // 상태·Day·시간 칩은 .card-chips(공통 간격/높이)로 묶어 렌더 — 크기·여백을 통일해 다닥다닥 붙지 않게
            // 날짜 칩: 'Day-2' 대신 '9/24(목)', 오늘이면 '오늘' (날짜를 모르면 일차)
            const dayLabel = schedEvt.is_today ? `<span class="card-chip chip-day" style="color:#b79f58;border-color:#e8dfc0;">오늘</span>`
                : schedEvt.scheduled_date ? (() => { const dt = new Date(schedEvt.scheduled_date + 'T00:00:00'); return isFinite(dt) ? `<span class="card-chip chip-day">${dt.getMonth() + 1}/${dt.getDate()}(${'일월화수목금토'[dt.getDay()]})</span>` : ''; })()
                : schedEvt.day ? `<span class="card-chip chip-day">${schedEvt.day}일차</span>` : '';
            const tBorder = schedEvt.is_today ? '#e8dfc0' : '#e2e4e8';
            const _doneAll = g.rounds.length > 0 && g.rounds.every(r => r.round_status === 'completed');
            const _timeChip = `<span class="card-chip chip-time num-display" style="color:${tColor};background:${tBg};border-color:${tBorder};" title="${schedEvt.callroom_time ? '소집 ' + schedEvt.callroom_time : ''}">${schedEvt.time}</span>${crBadge}`;
            timeBadge = _doneAll ? (_sortMode === 'time' ? '' : dayLabel) : (_sortMode === 'time' ? _timeChip : dayLabel + _timeChip);
        }

        // Division badge for display mode (color-coded by age group)
        // 연령군별 베이스 색상 → 정확 라벨이 없어도 자동 매칭
        function _divColorOf(div) {
            const exact = {
                '중등부': { color: '#1565c0', bg: '#e3f2fd' },
                '고등부': { color: '#e65100', bg: '#fff3e0' },
                '대학부': { color: '#4a148c', bg: '#f3e5f5' },
                '일반부': { color: '#1b5e20', bg: '#e8f5e9' },
                '국제':   { color: '#006064', bg: '#e0f7fa' }
            };
            if (exact[div]) return exact[div];
            const s = (div || '').replace(/\s/g, '');
            if (/초/.test(s))           return { color: '#00695c', bg: '#e0f2f1' }; // 초등 - 청록
            if (/중/.test(s))           return { color: '#1565c0', bg: '#e3f2fd' }; // 중등 - 파랑
            if (/고/.test(s))           return { color: '#e65100', bg: '#fff3e0' }; // 고등 - 주황
            if (/U18/i.test(s))         return { color: '#c62828', bg: '#ffebee' }; // U18 - 빨강
            if (/U20/i.test(s))         return { color: '#b71c1c', bg: '#ffcdd2' }; // U20 - 진빨강
            if (/대학|대$/.test(s))     return { color: '#4a148c', bg: '#f3e5f5' }; // 대학 - 보라
            if (/일반|실업/.test(s))    return { color: '#1b5e20', bg: '#e8f5e9' }; // 일반 - 녹색
            if (/선수권/.test(s))       return { color: '#5d4037', bg: '#efebe9' }; // 선수권 - 갈색
            if (/마스터즈|master/i.test(s)) return { color: '#37474f', bg: '#eceff1' };
            if (/국제|inter/i.test(s))  return { color: '#006064', bg: '#e0f7fa' };
            return { color: '#6a1b9a', bg: '#f3e5f5' };
        }
        const _dc = _divColorOf(g.division);
        const divBadge = (_isDisplayMode && g.division && _currentDivision === '전체') ? `<span style="font-size:11px;color:${_dc.color};background:${_dc.bg};padding:1px 5px;border-radius:6px;margin-left:4px;font-weight:600;">${g.division}</span>` : '';

        // ── 카드 상태 배지 (예정 / ● 진행 중(라운드) / 종료) — 모든 카드에 1개 ──
        // 소집 완료 목록(callroomCompletedIds)은 경기 완료 후에도 남으므로, 완료된 라운드는 LIVE 판정에서 제외
        //   (완료 처리했는데 배지가 "진행 중 · 결승"으로 남던 문제 — 버튼은 completed 를 먼저 봐서 "결과"였음)
        const _liveR = g.rounds.find(r => r.round_status === 'in_progress')
            || g.rounds.find(r => r.round_status !== 'completed' && callroomCompletedIds.has(r.id));
        const _allDone = g.rounds.length > 0 && g.rounds.every(r => r.round_status === 'completed');
        let statusBadge = '';
        if (_liveR) {
            const _rl = { preliminary: '예선', semifinal: '준결승', final: '결승' }[_liveR.round_type] || '';
            statusBadge = `<span class="status-badge status-live">진행 중${_rl ? ' · ' + _rl : ''}</span>`;
        }
        // '종료'·'예정' 배지는 뺐다(2026-09-24) — 라운드 버튼(결과/스타트 리스트/엔트리)이 이미 말해 준다. 끝난 종목은 날짜만, 앞으로 할 종목은 날짜+시간

        // ── 비활성(존재하지 않는) 라운드 표기 통일: '—' 박스 대신 메타라인 "○○ 없음" ──
        const _cols = [];
        if (_colRounds.preliminary) _cols.push(['예선', prelim]);
        if (_colRounds.semifinal) _cols.push(['준결승', semi]);
        if (_colRounds.final) _cols.push(['결승', fin]);
        const _missing = _cols.filter(([, e]) => !e).map(([l]) => l);
        const metaMissing = '';   // '예선·준결승 없음' 줄은 뺐다(2026-09-24) — 없는 라운드는 칸이 안 보이는 것으로 충분

        // 라운드 셀: 없으면 빈 칸(모바일 라벨도 숨김) — '—' 제거
        const _roundCell = (evt, label) => {
            const content = _isDisplayMode ? renderDisplayBtn(evt) : renderViewerBtn(evt);
            return `<td data-label="${label}" class="${content ? '' : 'cell-empty'}">${content}</td>`;
        };

        // 카드 전체 터치 대상 (운영/뷰어 모드) — 가장 관련있는 라운드로 이동
        const _doneR = [fin, semi, prelim].find(r => r && r.round_status === 'completed');
        const _heatR = g.rounds.find(r => r.heat_count > 0);
        const _primary = _liveR || _doneR || _heatR || fin || semi || prelim || g.rounds[0];
        const _primaryId = _primary ? _primary.id : 0;
        const _tapAttr = (!_isDisplayMode && _primaryId) ? ` onclick="onCardTap(event,${_primaryId})"` : '';

        // data-label: 모바일 카드 레이아웃(@media max-width:640px)에서 각 칸 앞에
        // "예선/준결승/결승" 라벨을 붙이기 위함. PC(표 모드)에서는 사용되지 않음.
        // 알림 토글: 종 아이콘 + "알림" 라벨 (켜짐=bell 강조 / 꺼짐=bell-off muted), 탭영역 ≥44×44
        const _isFav = favs.includes(_rowGender + '|' + g.name);
        // 알림 토글은 카드에서 빼고 종목 창(엔트리·스타트 리스트·결과) 머리글로 옮겼다 (2026-09-22) — 카드 제목 줄이 밀리지 않게
        const favCell = '';
        html += `<tr data-row-gender="${_rowGender}"${_tapAttr}${g._sk ? ` data-sched="${g._sk.key}"` : ''}${g.rounds.every(r => r.round_status === 'completed') ? ' data-done="1"' : ''}${g.catKey === 'combined' ? ' data-combined="1"' : ''}>
            ${favCell}
            <td class="event-name">${genderBadge}${g.name}${divBadge}<span class="name-tail">${g.spotlight ? `<span class="spot-badge" title="${g.spotlight === 'KOR' ? '한국 선수 출전' : g.spotlight + ' 출전'}">${g.spotlight === 'KOR' ? PaceIcons.svg('flagKR', { size: 22 }) : g.spotlight}</span>${_spotChipHtml(g.spot_status)}` : ''}<span class="card-chips">${statusBadge}${timeBadge}</span></span>${metaMissing}</td>
            ${_isDisplayMode ? `<td data-label="영상" class="${videoCell ? '' : 'cell-empty'}">${videoCell}</td>` : ''}
            ${(_isDisplayMode || _colRounds.wl) ? `<td data-label="${_isDisplayMode ? '명단' : 'W/L'}" class="${(_isDisplayMode ? rosterCell : wlCell) ? '' : 'cell-empty'}">${_isDisplayMode ? rosterCell : wlCell}</td>` : ''}
            ${_colRounds.preliminary ? _roundCell(prelim, '예선') : ''}
            ${_colRounds.semifinal ? _roundCell(semi, '준결승') : ''}
            ${_colRounds.final ? _roundCell(fin, '결승') : ''}
        </tr>`;
    });

    html += `</tbody></table></div></div>`;
    return html;
}

/**
 * Viewer flow:
 * - created (no heats) → "대기" button (disabled)
 * - heats_generated → "스타트 리스트" button (opens roster modal)
 * - in_progress → "LIVE" button (shows live results); judges also get "기록" link
 * - completed → "결과" button (shows results)
 */
function renderViewerBtn(evt) {
    if (!evt) return ''; // 존재하지 않는 라운드 — '—' 대신 빈 칸(메타라인 "○○ 없음"으로 통일)

    const isAdmin = currentRole === 'admin';
    const isJudge = currentRole === 'operation' || isAdmin;
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';
    // 조가 있어도 레인 배정이 하나도 없으면(국제대회: 조는 일정에서 먼저 생김) 아직 '스타트 리스트'가 아니다
    const hasHeats = evt.heat_count > 0 && (evt.heat_entry_count == null || evt.heat_entry_count > 0);
    const isCallroomDone = callroomCompletedIds.has(evt.id);

    const rc = _roundColors[evt.round_type] || { color: '#555', bg: '#f5f5f5', border: '#ccc' };

    if (evt.round_status === 'completed') {
        // 완료 라운드 — 클릭 시 결과 화면으로 이동하므로 라벨도 "결과"로 표기 (일관성)
        // round-btn-result 클래스가 부모 tr[data-row-gender] 에 따라 성별색(네이비/버건디/골드)으로 override됨
        return `<span class="round-btn round-btn-result" onclick="openResult(${evt.id})" title="결과 확인 (기록 입력됨)" style="background:${rc.color};color:#fff;border:1px solid ${rc.color};cursor:pointer;font-size:10px;padding:3px 7px;font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.12);">결과</span>`;
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

    // 히트가 있고 아직 소집 전 → 스타트 리스트 버튼
    if (hasHeats) {
        const eName = (evt.name || '').replace(/'/g, "\\'");
        // 스타트 리스트 — 레인·조까지 확정된 단계. 엔트리(점선)와 달리 실선 초록 채움으로 "바뀌었다"가 보이게
        return `<span class="round-btn round-btn-start" style="background:#1b7f4d;color:#fff;border:1px solid #1b7f4d;cursor:pointer;font-size:10px;padding:3px 7px;white-space:nowrap;font-weight:700;" onclick="openRosterModal(${evt.id},'${eName}')" title="스타트 리스트 (조·레인 확정, 기록 미입력)">스타트 리스트</span>`;
    }

    // 조가 아직 없지만 출전 명단은 있는 종목(국제대회: 조편성 전) → 엔트리
    if (evt.entry_count > 0) {
        const eName = (evt.name || '').replace(/'/g, "\\'");
        return `<span class="round-btn" style="background:#fff;color:${rc.color};border:1px dashed ${rc.color};cursor:pointer;font-size:10px;padding:3px 6px;white-space:nowrap;font-weight:500;" onclick="openEntriesModal(${evt.id},'${eName}')" title="출전 선수 (조편성 전)">엔트리 ${evt.entry_count}</span>`;
    }
    // created — 대기
    return `<span class="round-btn btn-disabled" style="font-size:10px;padding:3px 6px;border:1px solid #eee;" title="대기중">대기</span>`;
}

// ── 엔트리 창 (조편성 전 출전 선수) — 국제대회: 관심 국가(한국) 선수 맨 위, 한글 이름·PB/SB, 나머지는 국가 코드순 ──
async function openEntriesModal(eventId, eventName) {
    const evt = allEvents.find(e => e.id === eventId); if (!evt) return;
    let overlay = document.getElementById('roster-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div'); overlay.id = 'roster-modal-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s;';
        overlay.onclick = (e) => { if (e.target === overlay) closeRosterModal(); };
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex'; if (window.lockBodyScroll) lockBodyScroll();
    _rosterModalKind = 'entries';
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const gL = evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';
    const sched = _scheduleMap[evt.id];
    const _rb = _rosterBox(overlay, 560);
    overlay.innerHTML = `<div style="background:#fff;${_rb.box}display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;">${_rb.handle}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:linear-gradient(135deg,#f5f0e0,#eef2f9);border-bottom:1px solid #e8dfc0;flex-shrink:0;">
            <div style="flex:1;min-width:0;"><div style="font-weight:800;font-size:15px;color:#1a2a5e;" id="entries-modal-title">엔트리</div>
                 <div style="font-size:12px;color:#8a7640;margin-top:2px;">${gL} ${esc(eventName)} ${roundL}${sched && sched.time ? ` · ${sched.scheduled_date || ''} ${sched.time}` : ''}</div></div>
            ${_favBtnHtml(evt)}
            <button onclick="closeRosterModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#999;padding:0 4px;">&times;</button>
        </div>
        <div id="roster-modal-body" style="flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 0 env(safe-area-inset-bottom,0);">${uiStateHtml('loading', { title: '출전 선수를 불러오는 중…' })}</div></div>`;
    if (window.pushModalState) pushModalState(() => closeRosterModal());
    const body = document.getElementById('roster-modal-body');
    try {
        const entries = await API.getEventEntries(evt.id);
        const isRelay = evt.category === 'relay';
        let members = {};
        if (isRelay) { try { members = await api('GET', `/api/relay-members/batch?event_id=${evt.id}`); } catch (e) { members = {}; } }
        const spot = (allEvents.find(e => e.spotlight) || {}).spotlight || null;
        const rows = entries.slice().sort((a, b) => ((b.team === spot) - (a.team === spot)) || String(a.team || '').localeCompare(String(b.team || '')) || String(a.name).localeCompare(String(b.name)));
        const year = d => (String(d || '').match(/^\d{4}/) || [''])[0];
        const flag = t => t === spot && spot === 'KOR' ? PaceIcons.svg('flagKR', { size: 22, style: 'vertical-align:-5px' }) : '';
        const line = e => {
            const pb = [e.personal_best ? 'PB ' + e.personal_best : '', e.season_best ? 'SB ' + e.season_best : ''].filter(Boolean).join(' · ');
            const mem = isRelay && members[e.event_entry_id] ? `<div style="font-size:11px;color:#666;margin-top:2px;">${members[e.event_entry_id].members.map(m => esc(m.name)).join(' · ')}</div>` : '';
            const phone = window.innerWidth < 640;   // 폰: PB·SB 는 이름 아래 한 줄 (오른쪽 칸에선 잘린다)
            const pbUnder = phone && pb ? `<div style="font-family:var(--font-mono);font-size:10.5px;color:#666;margin-top:2px;white-space:nowrap;">${esc(pb)}</div>` : '';
            return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 14px;border-top:1px solid #f1f1f1;${e.team === spot ? 'background:#fff6f6;' : ''}">
                <div style="flex:none;width:52px;font-weight:800;font-size:12px;color:${e.team === spot ? '#8b1a2a' : '#555'};">${e.team === spot && spot === 'KOR' ? flag(e.team) : esc(e.team || '')}</div>
                <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:${e.team === spot ? 700 : 500};">${esc(isRelay ? (e.name || '') : e.name)}${e.name_alt ? `<span style="font-size:11px;color:#888;margin-left:6px;">${esc(e.name_alt)}</span>` : ''}${year(e.date_of_birth) ? `<span style="font-size:11px;color:#999;margin-left:6px;">${year(e.date_of_birth)}</span>` : ''}</div>${mem}${pbUnder}</div>
                ${phone ? '' : `<div style="flex:none;font-family:var(--font-mono);font-size:11px;color:#555;white-space:nowrap;">${esc(pb)}</div>`}</div>`;
        };
        const korRows = rows.filter(e => spot && e.team === spot), rest = rows.filter(e => !(spot && e.team === spot));
        document.getElementById('entries-modal-title').textContent = `엔트리 · ${rows.length}${isRelay ? '팀' : '명'}`;
        const _recLine = await _recordsLineHtml(evt);
        body.innerHTML = _recLine + (rows.length ? `${korRows.length ? `<div style="padding:8px 14px 2px;font-size:11px;font-weight:800;color:#8b1a2a;letter-spacing:.05em;">한국 (${korRows.length})</div>${korRows.map(line).join('')}` : ''}
            ${rest.length ? `<div style="padding:10px 14px 2px;font-size:11px;font-weight:800;color:#888;letter-spacing:.05em;">${korRows.length ? '다른 국가' : '출전'} (${rest.length}) · 국가 코드순</div>${rest.map(line).join('')}` : ''}`
            : uiStateHtml('empty', { title: '출전 선수가 아직 없습니다', hint: '공식 엔트리가 올라오면 자동으로 들어옵니다.' }));
    } catch (e) { body.innerHTML = uiStateHtml('error', { title: '출전 선수를 불러오지 못했습니다', hint: (e && (e.error || e.message)) || '' }); }
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
    if (!evt) return ''; // 존재하지 않는 라운드 — '—' 대신 빈 칸(메타라인으로 통일)
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';
    const rc = _roundColors[evt.round_type] || { color: '#1565c0', bg: '#e3f2fd', border: '#90caf9' };
    if (evt.result_url) {
        // 노출용: 외부(연맹) 사이트로 넘어가는 칩 → external-link(↗) 아이콘 표시
        const extIco = '<svg class="ext-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>';
        return `<a class="round-btn round-btn-ext" href="${evt.result_url}" target="_blank" rel="noopener" style="background:${rc.bg};color:${rc.color};border:1px solid ${rc.border};cursor:pointer;font-size:10px;padding:3px 8px;text-decoration:none;font-weight:700;" title="결과 보기 (외부 링크로 이동)">${roundL || '결과'}${extIco}</a>`;
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
    // 'ALL' 탭에서도 정확한 sibling 그룹을 찾기 위해 클릭된 event 자체의 gender 를 사용
    // (currentGender === 'ALL' 일 때 e.gender === 'ALL' 필터는 모든 행을 제외시켜 빈 명단 버그 유발)
    const _clickedEvt = allEvents.find(e => e.id === eventId);
    const _evtGender = _clickedEvt ? _clickedEvt.gender : currentGender;
    // Also try to find roster for sibling events (same name + division but different rounds)
    const siblingEvents = allEvents.filter(e => e.name === eventName && (e.division || '') === (division || '') && e.gender === _evtGender);
    const siblingIds = siblingEvents.map(e => e.id);
    const allRoster = _displayRoster.filter(dr => siblingIds.includes(dr.event_id));

    const gLabel = _evtGender === 'M' ? '남자' : _evtGender === 'F' ? '여자' : '혼성';
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
        <h3>${eventName} ${gLabel}${divLabel} — 스타트 리스트</h3>
        <button class="result-panel-close" onclick="closeResult()">&times;</button>
    </div><div class="result-panel-body">${bodyHtml}</div>`;
    overlay.classList.add('show');
    if (window.pushModalState) pushModalState(() => closeResult());
}

// ============================================================
// Event video modal (노출 모드 — 종목별 영상 보기)
// ============================================================
async function openEventVideoModal(eventId, title) {
    const overlay = document.getElementById('result-overlay');
    const panel = document.getElementById('result-panel');
    if (!overlay || !panel) return;
    let videoUrl = '';
    try { const vr = await API.getEventVideoUrl(eventId); videoUrl = vr.video_url || ''; } catch (e) {}
    const embed = buildEmbedVideoHTML(videoUrl);
    const body = embed || '<div style="text-align:center;padding:30px;color:#888;">등록된 영상이 없습니다.</div>';
    panel.innerHTML = `<div class="result-panel-header">
        <h3>${title} — 영상</h3>
        <button class="result-panel-close" onclick="closeResult()">&times;</button>
    </div><div class="result-panel-body">${body}</div>`;
    overlay.classList.add('show');
    if (window.pushModalState) pushModalState(() => closeResult());
}

// ============================================================
// Result overlay
// ============================================================

async function openResult(eventId) {
    const overlay = document.getElementById('result-overlay');
    const panel = document.getElementById('result-panel');
    panel.innerHTML = `<div class="result-panel-header"><h3>결과 불러오는 중…</h3><button class="result-panel-close" onclick="closeResult()">&times;</button></div>
        <div class="result-panel-body" style="padding:20px;">
            <div class="skeleton-block" style="box-shadow:none;padding:0;">
                <div class="skeleton skeleton-title"></div>
                <div class="skeleton skeleton-text"></div>
                <div class="skeleton skeleton-text" style="width:90%;"></div>
                <div class="skeleton skeleton-text" style="width:75%;"></div>
                <div class="skeleton skeleton-text" style="width:85%;"></div>
            </div>
        </div>`;
    overlay.classList.add('show');
    if (window.pushModalState) pushModalState(() => closeResult());

    try {
        const data = await API.getFullResults(eventId);
        const evt = data.event;
        const gL = getGenderLabel(evt.gender);
        const roundL = fmtRound(evt.round_type);

        // ─── 신기록 비교용: NR/DR/CR 미리 로드 (비고 CR 표기용) ───
        try {
            const normName = (typeof normalizeEventNameClient === 'function') ? normalizeEventNameClient(evt.name) : evt.name;
            const compInfo = await API.getCompetitionInfo(getCompetitionId()).catch(() => ({}));
            window._liveRecords = _intlRecords(await API.lookupEventRecords(normName, evt.gender, evt.division || null, compInfo?.series_id || null, evt.id).catch(() => null));
            window._liveRecDir = (typeof recordDirectionForCategoryClient === 'function') ? recordDirectionForCategoryClient(evt.category) : null;
        } catch(e) { window._liveRecords = null; window._liveRecDir = null; }

        // Get video URL
        let videoUrl = '';
        try { const vr = await API.getEventVideoUrl(eventId); videoUrl = vr.video_url || ''; } catch(e){}

        let bodyHtml = '';
        bodyHtml += buildEmbedVideoHTML(videoUrl);
        // 기존 기록(WR·AR·GR·NR·DR·CR) 줄 — 완료 결과 창에도 (LIVE 창과 같은 모양)
        bodyHtml += _buildRecordsBannerHTML(window._liveRecords);
        const _spot = await _spotBlocksHtml(evt);
        bodyHtml += _spot.top;

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

        bodyHtml += _spot.bottom;
        panel.innerHTML = `<div class="result-panel-header">
            <h3>${_evtTitle(evt, roundL)} ${gL}</h3>
            ${_favBtnHtml(evt)}
            <button class="result-panel-close" onclick="closeResult()">&times;</button>
        </div><div class="result-panel-body">${bodyHtml}</div>`;
        _decorateResultPanel(panel, evt);

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
    // 🐛 BUGFIX (2026-06): iframe.src='' 가 iOS Safari 에서 about:blank 새 창처럼
    // 보이는 문제 → iframe 자체를 DOM 에서 제거하여 navigation 이벤트 자체를 차단.
    // (이전 코드: if (iframe) iframe.src = '';)
    const iframes = document.querySelectorAll('#result-panel iframe');
    iframes.forEach(f => f.parentNode && f.parentNode.removeChild(f));

    const overlay = document.getElementById('result-overlay');
    if (overlay) overlay.classList.remove('show');

    // 중복 호출 방지: overlay 가 이미 안 보이면 popModalState 도 skip.
    // popstate 로 인해 closeResult 가 호출된 경우 _modalStack 은 이미 pop 됨.
    if (window.popModalState) popModalState();
    _returnToTeamRoster();
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
    panel.innerHTML = `<div class="result-panel-header"><h3><span style="background:#f8f4ea;color:#b79f58;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:8px;">● LIVE</span>로딩 중…</h3><button class="result-panel-close" onclick="closeLiveResult()">&times;</button></div>
        <div class="result-panel-body" style="padding:20px;">
            <div class="skeleton-block" style="box-shadow:none;padding:0;">
                <div class="skeleton skeleton-title"></div>
                <div class="skeleton skeleton-text"></div>
                <div class="skeleton skeleton-text" style="width:90%;"></div>
                <div class="skeleton skeleton-text" style="width:75%;"></div>
            </div>
        </div>`;
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

        // ─── 신기록 비교용: NR/DR/CR 미리 로드 ─────────────────────
        let liveRecords = null, liveRecDir = null;
        try {
            const normName = (typeof normalizeEventNameClient === 'function') ? normalizeEventNameClient(evt.name) : evt.name;
            const compInfo = await API.getCompetitionInfo(getCompetitionId()).catch(() => ({}));
            liveRecords = await API.lookupEventRecords(
                normName, evt.gender,
                evt.division || null,
                compInfo?.series_id || null, evt.id
            ).catch(() => null);
            liveRecDir = (typeof recordDirectionForCategoryClient === 'function')
                ? recordDirectionForCategoryClient(evt.category) : null;
        } catch(e) {}
        liveRecords = _intlRecords(liveRecords);
        window._liveRecords = liveRecords;
        window._liveRecDir = liveRecDir;

        let bodyHtml = '';
        bodyHtml += buildEmbedVideoHTML(videoUrl);
        // 기존 기록 배너 (NR/DR/CR 미리 보기)
        bodyHtml += _buildRecordsBannerHTML(liveRecords);
        const _spotL = await _spotBlocksHtml(evt);
        bodyHtml += _spotL.top;

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

        bodyHtml += _spotL.bottom;
        bodyHtml += `<div style="margin-top:12px;font-size:11px;color:var(--text-muted);text-align:center;">자동 새로고침 | ${new Date().toLocaleTimeString('ko-KR')}</div>`;

        panel.innerHTML = `<div class="result-panel-header">
            <h3><span style="background:#f8f4ea;color:#b79f58;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:8px;">● LIVE</span>${_evtTitle(evt, roundL)} ${gL}</h3>
            ${_favBtnHtml(evt)}
            <button class="result-panel-close" onclick="closeLiveResult()">&times;</button>
        </div><div class="result-panel-body">${bodyHtml}</div>`;
        _decorateResultPanel(panel, evt);
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
    _returnToTeamRoster();
}

// ─── 신기록 배너 / 배지 헬퍼 (results.js 와 동일 디자인 톤) ─────
// 기존 기록 띠: 칩은 '라벨 기록'만 — 탭하면 아래 한 줄로 보유자·팀·연도(같은 칩 다시 탭하면 접힘). 공간 아끼기 (2026-09-24)
const _REC_LABEL_KO = { WR: '세계기록', AR: '아시아기록', GR: '대회기록', NR: '한국기록', DR: '부 기록', CR: '대회기록' };
function _recBannerToggle(el) {
    const banner = el.closest('.record-banner-mobile'); if (!banner) return;
    const line = banner.querySelector('.record-detail-line'); if (!line) return;
    const was = el.classList.contains('on');
    banner.querySelectorAll('.record-chip.on').forEach(c => c.classList.remove('on'));
    if (was) { line.hidden = true; return; }
    el.classList.add('on');
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const d = el.dataset;
    const parts = [d.holder, d.team, d.year].filter(Boolean).map(esc);   // 이름 · 팀 · 연도 — 한 줄에 맞게 (장소·날짜는 뺀다)
    if (d.prev) parts.push('<span style="color:#999">종전 ' + esc(d.prev) + '</span>');   // 이 대회에서 세운 기록이면 종전 기록도
    line.innerHTML = `<span style="color:${d.color};font-weight:800;margin-right:6px">${esc(d.label)}</span><span style="color:#666">${_REC_LABEL_KO[d.label] || ''}</span>${parts.length ? ' · ' + parts.join(' · ') : ''}`;
    line.hidden = false;
}
function _buildRecordsBannerHTML(records) {
    if (!records) return '';
    const attr = v => String(v == null ? '' : v).replace(/"/g, '&quot;');
    const chip = (label, color, rec) => rec
        ? `<span role="button" tabindex="0" onclick="_recBannerToggle(this)" data-label="${label}" data-color="${color}" data-holder="${attr(rec.holder_name)}" data-team="${attr(rec.holder_team)}" data-venue="${attr(rec.venue)}" data-date="${attr(rec.record_date)}" data-year="${attr(rec.record_year)}" data-prev="${attr(rec.prev || '')}" class="record-chip${rec.new_here ? ' record-chip-new' : ''}" style="${rec.new_here ? `background:${color};border:1px solid ${color};color:#fff;` : `background:${color}15;border:1px solid ${color}55;color:${color};`}" title="${rec.new_here ? '이 대회에서 세운 기록' : ''}"><b>${label}</b>${(rec.record_value||'').toString()}</span>` : '';
    const parts = [
        chip('WR', '#6a1b9a', records.world),
        chip('AR', '#0d47a1', records.area),
        chip('GR', '#b8860b', records.games),
        chip('NR', '#c0392b', records.national),
        chip('DR', '#2980b9', records.division),
        chip('CR', '#27ae60', records.competition)
    ].filter(Boolean);
    if (parts.length === 0) return '';
    return `<div class="record-banner-mobile" style="margin:8px 0 12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;padding:8px 12px;background:#fffbea;border:1px solid #f1d68a;border-radius:8px;">
        <span style="color:var(--text-muted);font-weight:600;white-space:nowrap;">기존 기록</span>
        <span class="record-chips${parts.length < 3 ? ' few' : ''}">${parts.join('')}</span>
        <div class="record-detail-line" hidden style="flex-basis:100%;font-size:11px;line-height:1.4;padding-top:4px;border-top:1px dashed #ead9a0;word-break:keep-all;"></div>
    </div>`;
}
// 기록 값 옆 괄호 신기록 표기 (예: " (CR)" / " (NR, CR)")
function _buildRecordBadgesHTML(newValNum) {
    const lbl = _recLabelText(newValNum);
    if (!lbl) return '';
    return ` <span style="color:#27ae60;font-weight:700;">(${lbl.replace(/ /g, ', ')})</span>`;
}

// 비고란용 신기록 라벨 텍스트 (예: "CR" 또는 "NR DR CR") — 깬 기록 전부
function _recLabelText(newValNum) {
    if (!window._liveRecords || !window._liveRecDir) return '';
    if (allEvents.some(e => e.spotlight)) return '';   // 국제대회: 태그는 비고(_recTagOf)에서만
    if (newValNum == null || !isFinite(newValNum)) return '';
    if (typeof detectBrokenRecordsClient !== 'function') return '';
    const broken = detectBrokenRecordsClient(newValNum, window._liveRecords, window._liveRecDir);
    return (broken && broken.length) ? broken.join(' ') : '';
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
            { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
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
        // ── 완료 결과(renderTrackResults)와 같은 두 줄 행 — LIVE 는 공유 카드(data-sc) 없음, 기록 들어온 행만 살짝 강조 ──
        //   (LIVE 와 결과 팝업이 다른 함수라 "어떨 땐 두 줄, 어떨 땐 표"로 보이던 문제)
        html += `<div class="rr-list rr-live">${rows.map(r => {
            const hasRec = !r.status_code && r.time_seconds != null;
            const wMark = (_isWindAided && hasRec) ? '<span class="rr-w">w</span>' : '';
            const recBadges = (hasRec && !_isWindAided) ? _rrRecordBadges(r.time_seconds) : '';
            let memberHtml = '';
            if (isRelay && relayMembers) {
                const members = relayMembers.filter(m => m.event_entry_id === r.event_entry_id);
                if (members.length > 0) {
                    const sorted = [...members].sort((a, b) => (a.leg_order || 99) - (b.leg_order || 99));
                    memberHtml = `<div class="rr-members">${sorted.map(m => `<span>${m.leg_order ? m.leg_order + '주 ' : ''}${m.name}${m.bib_number ? `<i>#${m.bib_number}</i>` : ''}</span>`).join('')}</div>`;
                }
            }
            const rankHtml = r.status_code
                ? `<div class="rr-rank rr-rank-st sc-${r.status_code}">${r.status_code}</div>`
                : `<div class="rr-rank${r.rank === 1 ? ' rr-rank-1' : ''}${r.rank === '—' ? ' rr-rank-wait' : ''}">${r.rank}</div>`;
            const meta = [
                `${smallNumLabel} ${r.lane_number || '—'}`,
                `BIB ${bib(r.bib_number)}`,
                r.sub_group ? `${r.sub_group}그룹` : '',
                _isWindAided && hasRec ? '<b>참고기록</b>' : '',
                _remarkRest(r.remark) ? `<b>${_remarkRest(r.remark)}</b>` : '',
            ].filter(Boolean).join('<i>·</i>');
            const recHtml = r.status_code
                ? `<div class="rr-rec rr-rec-st">${r.status_code}</div>`
                : (hasRec ? `<div class="rr-rec">${formatTime(r.time_seconds)}${wMark}${recBadges}${_recTagHtml(_recTagOf(r.remark))}</div>` : '<div class="rr-rec rr-rec-st">—</div>');
            return `<div class="rr rr-nocard${hasRec ? ' rr-has-rec' : ''}" data-team="${r.team || ''}">
                ${rankHtml}
                <div class="rr-who"><span class="rr-name">${r.name}${r.name_alt ? `<span class="rr-alt">${r.name_alt}</span>` : ''}</span>${isRelay ? '' : `<span class="rr-team">${r.team || ''}${_pbSb(r)}</span>`}</div>
                <div class="rr-meta">${meta}</div>
                <div class="rr-pbsb-row">${_pbSb(r)}</div>
                ${recHtml}
                <div class="rr-go" aria-hidden="true"></div>
                ${memberHtml}
            </div>`;
        }).join('')}</div>`;
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

function renderLiveFieldDistResults(data) {
    let html = '';
    data.heats.forEach(h => {
        _liveHeatId = h.id;
        const rows = h.entries.map(e => {
            const er = (h.results || []).filter(r => r.event_entry_id === e.event_entry_id);
            const att = {}, attWind = {}; let bestOnly = null, bestOnlyWind = null;
            // Extract status_code from any result row (DNS/DNF/NM)
            let sc = '';
            er.forEach(r => {
                if (r.attempt_number) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; }
                else if (r.distance_meters != null && r.distance_meters > 0) { bestOnly = r.distance_meters; bestOnlyWind = r.wind; }   // 시기 없이 최고 기록만(국제대회 동기화)
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
            const best = valid.length > 0 ? Math.max(...valid) : bestOnly;
            // WA: later attempt is the official record for same distance
            let bestWind = valid.length > 0 ? null : bestOnlyWind;
            if (best != null && valid.length > 0) { for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } } }
            // Build sorted valid distances (descending) for WA tie-breaking
            const sortedValid = [];
            for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
            sortedValid.sort((a, b) => b - a);
            const remark = ((er.find(r => r.attempt_number == null && r.remark) || {}).remark) || '';
            return { ...e, att, attWind, best, bestWind, status_code: sc, sortedValid, remark };
        }).sort((a, b) => {
            { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
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
        html += '<div class="rr-field-desktop">';   // ≥900px: 6차시기 표 / <900px: 두 줄+시기 스트립 (_rrFieldDistList)
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
                    // 신기록 배지 (풍속 초과 시 미표시)
                    const _recBadges = (!_bestWindAided && !r.status_code && r.best != null) ? _buildRecordBadgesHTML(r.best) : '';
                    const bestDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? formatHeight(r.best) + bestWMark + _recBadges : '—');
                    const rankDisp = r.status_code ? '' : r.rank;
                    let remarkText = '';
                    if (_bestWindAided) remarkText = '참고기록';  // 상태코드는 기록칸에, 신기록은 기록칸 괄호로
                    const remarkStyle = _bestWindAided ? 'color:var(--accent);font-weight:600;' : '';
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
                    const _recBadges2 = (!r.status_code && r.best != null) ? _buildRecordBadgesHTML(r.best) : '';
                    const bestDisp2 = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? formatHeight(r.best) + _recBadges2 : '—');
                    const rankDisp2 = r.status_code ? '' : r.rank;
                    const remarkText2 = '';  // 신기록은 기록칸 괄호로 표시
                    const remarkStyle2 = remarkText2 ? 'color:#27ae60;font-weight:700;' : '';
                    return `<tr>
                        <td>${rankDisp2}</td><td>${r.lane_number || '—'}</td>
                        <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td><td><strong>${bib(r.bib_number)}</strong></td>
                        ${distCells}<td class="att-col-best" style="font-weight:700;font-family:monospace;color:var(--green);">${bestDisp2}</td>
                        <td style="font-size:11px;${remarkStyle2}">${remarkText2}</td>
                    </tr>`;
                }).join('')}</tbody></table>`;
        }
        html += '</div>' + _rrFieldDistList(rows, needsWind, { live: true, event: data.event });
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
            // 순위 규칙은 공용 모듈(public/lib/ranking.js, WA TR 26.2·26.8)
            const _hs = PaceRanking.heightStats(hd, hts);
            const best = _hs.best, totalFails = _hs.totalFails, failsAtBest = _hs.failsAtBest;
            const isNM = _hs.isNM;
            const status_code = ((h.results || []).find(r => r.event_entry_id === e.event_entry_id && PaceRanking.isStatus(r.status_code)) || {}).status_code || '';
            const _bestOnly = ea.length ? null : (((h.results || []).find(r => r.event_entry_id === e.event_entry_id && r.attempt_number == null && r.distance_meters > 0) || {}).distance_meters || null);   // 시기 없이 최고 높이만(국제대회 동기화)
            return { ...e, hd, remark: (((h.results || []).find(r => r.event_entry_id === e.event_entry_id && r.attempt_number == null) || {}).remark) || '', best: status_code ? null : (best != null ? best : _bestOnly), isNM: _bestOnly ? false : isNM, totalFails, failsAtBest, status_code };
        }).sort((a, b) => {
            { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
            if (a.best == null && b.best == null) return 0;
            if (a.best == null) return 1; if (b.best == null) return -1;
            if (b.best !== a.best) return b.best - a.best;
            // 같은 높이 → 수동 순위(순위결정전) 우선
            if (a.manual_rank != null && b.manual_rank != null) return a.manual_rank - b.manual_rank;
            // WA tie-break: fewer fails at best height, then fewer total fails
            if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
            return a.totalFails - b.totalFails;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code && r.status_code !== 'NM') { r.rank = `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>`; return; }
            if (r.best == null) { r.rank = r.isNM ? '<span class="nm-mark">NM</span>' : '—'; return; }
            let isTied = i > 0 && rows[i - 1].best === r.best
                && rows[i - 1].failsAtBest === r.failsAtBest
                && rows[i - 1].totalFails === r.totalFails;
            r.rank = isTied ? rows[i - 1].rank : rk;
            rk = i + 2;
        });
        // 수동 순위(순위결정전) override
        rows.forEach(r => { if (r.manual_rank != null) r.rank = r.manual_rank; });

        let thead = '<th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>';
        hts.forEach(h2 => { thead += `<th style="font-size:10px;">${formatHeight(h2)}</th>`; });
        thead += '<th>최고</th><th>비고</th>';
        html += `<div class="rr-field-desktop"><table class="data-table" style="font-size:12px;">
            <thead><tr>${thead}</tr></thead>
            <tbody>${rows.map(r => {
                let c = '';
                hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const mark = d[i] === 'PASS' ? '-' : d[i]; const cls = d[i] === 'O' ? 'color:var(--green)' : d[i] === 'X' ? 'color:var(--danger)' : 'color:var(--text-muted)'; m += `<span style="${cls};font-weight:700;">${mark}</span>`; } } c += `<td style="font-size:11px;">${m}</td>`; });
                const _rkDisp = r.isNM ? '' : r.rank;
                const _hRecBadges = (!r.isNM && r.best != null) ? _buildRecordBadgesHTML(r.best) : '';
                const _bestDisp = r.best != null ? (formatHeight(r.best) + _hRecBadges) : (r.isNM ? '<span class="sc-badge sc-NM">NM</span>' : '');
                const _rmk = '';  // 신기록은 기록칸 괄호로 표시
                const _rmkSt = _rmk ? 'color:#27ae60;font-weight:700;' : '';
                return `<tr style="${r.best != null ? 'background:#f0fff4;' : ''}"><td>${_rkDisp}</td><td><strong>${bib(r.bib_number)}</strong></td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>${c}<td style="font-weight:700;">${_bestDisp}</td><td style="font-size:11px;${_rmkSt}">${_rmk}</td></tr>`;
            }).join('')}</tbody></table></div>` + _rrFieldHeightList(rows, hts, { live: true, event: data.event });
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

// ── Helper: format API error for display ─────────────────────
// api() in common.js throws plain objects: { status, error, ... } — NOT Error instances.
// Template-literal `${e}` on plain objects yields "[object Object]".
// This helper extracts a human-readable message from any thrown value.
function _formatApiError(e) {
    if (e == null) return '알 수 없는 오류';
    if (typeof e === 'string') return e;
    if (e.error) return String(e.error) + (e.status ? ` (HTTP ${e.status})` : '');
    if (e.message) return String(e.message);
    try { return JSON.stringify(e); } catch (_) { return String(e); }
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
        <div class="skeleton-block" style="margin:8px;">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-text" style="width:85%;"></div>
            <div class="skeleton skeleton-text" style="width:70%;"></div>
            <div style="text-align:center;padding:8px 0 0;color:var(--text-muted);font-size:11px;">혼성 경기 결과 불러오는 중…</div>
        </div>
    </div>`;

    // Async load combined data after rendering container
    setTimeout(async () => {
        try {
            if (localStorage.getItem('pace_admin_key')) { try { await API.syncCombinedScores(evt.id); } catch (e) { console.warn('[combined live] sync skipped:', e && (e.error || e.message)); } }
            const scores = await API.getCombinedScores(evt.id);
            const entries = await API.getEventEntries(evt.id);

            const hdrCols = subDefs.map(se => {
                const has = scores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
                const bg = se.order <= day1Max ? 'background:#f5f9ff;' : 'background:#fef5f7;';
                return `<th style="font-size:11px;padding:2px 4px;white-space:nowrap;${bg}${has ? 'font-weight:700;' : 'color:#ccc;'}">${se.name}</th>`;
            }).join('');

            const rows = entries.map(e => {
                let total = 0; const pts = {};
                subDefs.forEach(se => {
                    const sc = scores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
                    const p = sc ? (sc.wa_points || 0) : 0;
                    // <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#dc2626;" class="ui-emoji"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg> status_code (DNS/DNF/DQ/NM) 을 함께 보관 — 0점이어도 DNF/DNS 는 그대로 표시
                    pts[se.order] = { points: p, raw: sc ? sc.raw_record : null, status_code: sc ? (sc.status_code || '') : '' };
                    total += p;
                });
                return { ...e, pts, total };
            }).sort((a, b) => b.total - a.total);
            let rk = 1;
            rows.forEach((r, i) => { r.rank = (i > 0 && rows[i-1].total === r.total) ? rows[i-1].rank : rk; rk = i + 2; });

            const container = document.getElementById('live-combined-content');
            if (!container) return;

            container.innerHTML = `
                ${_rrCombinedList(rows, subDefs, day1Max, { live: true, evt })}
                <div class="rr-field-desktop"><div class="matrix-scroll-wrap" style="overflow-x:auto;">
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
                                // <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#dc2626;" class="ui-emoji"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg> status_code (DNS/DNF/DQ/NM) 이 있으면 우선 표시.
                                //     'X'/'PASS'/'-' 등 시도 마크 는 status_code 가 아닌 일부 레거시 데이터 이므로 화이트리스트만 채택.
                                if (p.status_code && ['DNS','DNF','DQ','NM'].includes(p.status_code)) {
                                    const _sc = p.status_code;
                                    const _scColor = (_sc === 'DQ') ? '#a02050' : 'var(--danger)';
                                    return `<td style="font-size:10px;color:${_scColor};font-weight:700;"><div>${_sc}</div><div style="color:var(--text-muted);font-size:11px;font-weight:400;">${p.points}pt</div></td>`;
                                }
                                if (p.raw === 0 && p.points === 0)
                                    return `<td style="font-size:10px;color:var(--danger);font-weight:700;">NM</td>`;
                                if (p.raw <= 0)
                                    return `<td style="color:#ccc;font-size:10px;">—</td>`;
                                const isHt = se.key && (se.key.includes('high_jump') || se.key.includes('pole_vault'));
                                const rec = se.unit === 's' ? formatTime(p.raw) : formatHeight(p.raw);                                return `<td style="font-size:10px;"><div>${rec}</div><div style="color:var(--primary);font-size:11px;">${p.points}</div></td>`;
                            }).join('');
                            return `<tr style="${r.total > 0 ? 'background:#f0fff4;' : ''}">
                                <td><strong>${r.rank}</strong></td><td><strong>${bib(r.bib_number)}</strong></td>
                                <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:10px;">${r.team || ''}</td>
                                ${cells}
                                <td><strong style="color:var(--primary);font-size:13px;">${r.total > 0 ? r.total : '—'}</strong></td>
                            </tr>`;
                        }).join('')}</tbody>
                    </table>
                </div></div>
                <p style="margin-top:6px;font-size:10px;color:var(--text-muted);">실시간 WA 점수 합산 | ${evt.name || (evt.gender === 'M' ? '10종경기' : '7종경기')}</p>`;
        } catch (e) {
            console.error('[combined live] 데이터 로드 실패:', e);
            const container = document.getElementById('live-combined-content');
            if (container) container.innerHTML = `<p style="color:var(--danger);padding:12px;">혼성 경기 데이터 로드 실패: ${_formatApiError(e)}</p>`;
        }
    }, 100);

    return html;
}

// ── Combined Results (completed event — scoreboard) ──────────
function renderCombinedResults(data) {
    const evt = data.event;
    return `<div id="combined-result-content" style="padding:8px;">
        <div class="skeleton-block" style="margin:8px;">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-text" style="width:85%;"></div>
            <div class="skeleton skeleton-text" style="width:70%;"></div>
            <div style="text-align:center;padding:8px 0 0;color:var(--text-muted);font-size:11px;">${evt.name || (evt.gender === 'M' ? '10종경기' : '7종경기')} 결과 불러오는 중…</div>
        </div>
    </div>`;
}

async function _loadCombinedResultsAsync(evt) {
    try {
        // 점수 재계산(POST)은 운영키가 있을 때만 — 관람객은 저장된 점수를 그대로 본다 (쓰기 가드가 키 없는 POST 를 403 으로 막는다)
        if (localStorage.getItem('pace_admin_key')) { try { await API.syncCombinedScores(evt.id); } catch (e) { console.warn('[combined] sync skipped:', e && (e.error || e.message)); } }
        const scores = await API.getCombinedScores(evt.id);
        const entries = await API.getEventEntries(evt.id);
        const subEvents = await API.getCombinedSubEvents(evt.id);
        const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
        const day1Max = evt.gender === 'M' ? 5 : 4;

        const hdrCols = subDefs.map(se => {
            const has = scores.some(s => s.sub_event_order === se.order && s.raw_record > 0);
            const bg = se.order <= day1Max ? 'background:#f5f9ff;' : 'background:#fef5f7;';
            return `<th style="font-size:11px;padding:2px 4px;white-space:nowrap;${bg}${has ? 'font-weight:700;' : 'color:#ccc;'}" onclick="_cResultShowSub(${se.order})" title="클릭하여 세부기록 보기" class="clickable-th">${se.name}</th>`;
        }).join('');

        const rows = entries.map(e => {
            let total = 0; const pts = {};
            subDefs.forEach(se => {
                const sc = scores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
                const p = sc ? (sc.wa_points || 0) : 0;
                // <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#dc2626;" class="ui-emoji"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg> status_code (DNS/DNF/DQ/NM) 을 함께 보관 — 0점이어도 DNF/DNS 는 그대로 표시
                pts[se.order] = { points: p, raw: sc ? sc.raw_record : null, status_code: sc ? (sc.status_code || '') : '' };
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
            ${_rrCombinedList(rows, subDefs, day1Max, { live: false, evt, scAttr: r => _scAttr(evt, r, r.total > 0 ? String(r.total) : '', r.rank, { marks: subDefs.map(se => { const p = r.pts[se.order]; if (!p || p.raw == null) return '—'; if (p.status_code && ['DNS','DNF','DQ','NM'].includes(p.status_code)) return p.status_code; if (p.raw === 0 && p.points === 0) return 'NM'; if (p.raw <= 0) return '—'; return se.unit === 's' ? formatTime(p.raw) : formatHeight(p.raw); }), marksPerRow: day1Max }) })}
            <div class="rr-field-desktop"><div class="matrix-scroll-wrap" style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
                <table class="data-table sticky-leading" style="font-size:11px;">
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
                            // <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#dc2626;" class="ui-emoji"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg> status_code 는 화이트리스트(DNS/DNF/DQ/NM)만 인정.
                            if (p.status_code && ['DNS','DNF','DQ','NM'].includes(p.status_code)) {
                                const _sc = p.status_code;
                                const _scColor = (_sc === 'DQ') ? '#a02050' : 'var(--danger)';
                                return `<td style="font-size:10px;cursor:pointer;color:${_scColor};font-weight:700;" onclick="_cResultShowSub(${se.order})"><div>${_sc}</div><div style="color:var(--text-muted);font-size:11px;font-weight:400;">${p.points}pt</div></td>`;
                            }
                            if (p.raw === 0 && p.points === 0)
                                return `<td style="font-size:10px;cursor:pointer;color:var(--danger);font-weight:700;" onclick="_cResultShowSub(${se.order})">NM</td>`;
                            if (p.raw <= 0)
                                return `<td style="color:#ccc;font-size:10px;cursor:pointer;" onclick="_cResultShowSub(${se.order})">—</td>`;
                            const isHt = se.key && (se.key.includes('high_jump') || se.key.includes('pole_vault'));
                            const rec = se.unit === 's' ? formatTime(p.raw) : formatHeight(p.raw);
                            return `<td style="font-size:10px;cursor:pointer;" onclick="_cResultShowSub(${se.order})"><div>${rec}</div><div style="color:var(--primary);font-size:11px;">${p.points}</div></td>`;
                        }).join('');
                        // SNS 카드용: 세부 기록을 종목명 없이 순서대로만 (표 셀과 같은 판정 순서)
                        const scMarks = subDefs.map(se => {
                            const p = r.pts[se.order];
                            if (!p || p.raw == null) return '—';
                            if (p.status_code && ['DNS','DNF','DQ','NM'].includes(p.status_code)) return p.status_code;
                            if (p.raw === 0 && p.points === 0) return 'NM';
                            if (p.raw <= 0) return '—';
                            return se.unit === 's' ? formatTime(p.raw) : formatHeight(p.raw);
                        });
                        const scAttr = _scAttr(evt, r, r.total > 0 ? String(r.total) : '', r.rank,
                            { marks: scMarks, marksPerRow: day1Max });
                        return `<tr style="${r.total > 0 ? 'background:#f0fff4;' : ''}"${scAttr}>
                            <td><strong>${r.rank}</strong></td><td><strong>${bib(r.bib_number)}</strong></td>
                            <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:10px;">${r.team || ''}</td>
                            ${cells}
                            <td><strong style="color:var(--primary);font-size:13px;">${r.total > 0 ? r.total : '—'}</strong></td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>
            </div></div>
            <p style="margin-top:6px;font-size:10px;color:var(--text-muted);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ui-emoji"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> ${evt.name || (evt.gender === 'M' ? '10종경기' : '7종경기')} 최종 결과 | WA 점수 합산 · 종목명 클릭 시 세부기록 표시</p>
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
        console.error('[combined result] 데이터 로드 실패:', e);
        const container = document.getElementById('combined-result-content');
        if (container) container.innerHTML = `<p style="color:var(--danger);padding:12px;">혼성 경기 데이터 로드 실패: ${_formatApiError(e)}</p>`;
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

    area.innerHTML = `<div class="skeleton-block" style="margin:0;">
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text" style="width:90%;"></div>
        <div class="skeleton skeleton-text" style="width:75%;"></div>
    </div>`;

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
                { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
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
                { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
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
                const _hs = PaceRanking.heightStats(ath.attempts, heights);   // 공용 모듈 (WA TR 26.8)
                ath.totalFails = _hs.totalFails;
                ath.failsAtBest = _hs.failsAtBest;
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

// ============================================================
// SNS 기록 카드 — 결과표 행에 카드용 데이터를 실어둔다
// share-card.js 의 openShareCard() 가 이 payload 를 그대로 받는다.
// 기록이 없는 행(미출전/실격)은 카드를 만들지 않는다.
// ============================================================
function _scAttr(evt, r, record, rank, extra) {
    if (!record || !r || !r.name) return '';
    if (allEvents.some(e => e.spotlight)) return '';   // 국제대회: 기록 카드(SNS 공유) 없음 — 국내 대회용 카드라 외국 선수 줄에 붙는 게 어색 (2026-09-25)
    const isRelay = evt?.category === 'relay';
    const payload = {
        eventName: evt?.name || '',
        division: [getGenderLabel(evt?.gender), evt?.division].filter(Boolean).join(' '),
        record: record,
        name: r.name || '',
        // 계주는 athlete 행 자체가 팀(더미 선수)이라 name 에 이미 팀명이 들어있다.
        // 소속까지 찍으면 같은 글자가 두 번 나오므로 비운다.
        team: isRelay ? '' : (r.team || ''),
        rank: (typeof rank === 'number' && rank > 0) ? rank : null,
        laneLabel: getSmallNumberLabel(evt?.name, evt?.category),
        laneNumber: r.lane_number || null,
        competition: (document.querySelector('.comp-info-name')?.textContent || '').trim(),
        compDate: (document.querySelector('.comp-info-dates')?.textContent || '').trim()
    };
    if (extra) Object.assign(payload, extra);
    // 신기록(NR/DR/CR) — 결과표 배지와 같은 판정(_recLabelText)을 카드에도 싣는다. 추풍(w) 기록은 참고기록이라 제외.
    if (!payload.records && !(extra && extra.windAided)) {
        const num = (extra && extra.recNum != null) ? extra.recNum : (r.time_seconds ?? r.best ?? r.total);
        const lbl = (num != null && isFinite(num)) ? _recLabelText(Number(num)) : '';
        if (lbl) payload.records = lbl.split(' ').filter(Boolean).map(code => ({ code, label: _scRecordLabel(code, evt) }));
    }
    delete payload.windAided; delete payload.recNum;
    return ` data-sc="${encodeURIComponent(JSON.stringify(payload))}"`;
}
// 카드용 신기록 한글 표기: NR 한국신기록 / CR 대회신기록 / DR 한국{부문}신기록 (대학·실업·고등…)
function _scRecordLabel(code, evt) {
    if (code === 'NR') return '한국신기록';
    if (code === 'CR') return '대회신기록';
    if (code === 'DR') {
        const d = String(evt?.division || '').replace(/부$/, '');
        const nm = d === '일반' ? '실업' : d;
        return nm ? `한국${nm}신기록` : '부문신기록';
    }
    return code;
}

// (안내문 "기록을 누르면 공유 카드를…" 은 제거 — 힌트는 두 줄 행 오른쪽의 골드 › 와 첫 열람 숨쉬기 애니메이션뿐)

// 결과표 행 클릭 → 카드 팝업 (재렌더링돼도 유지되도록 document 위임)
document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    // 트랙 결과는 두 줄 div 행(.rr), 필드·종합은 아직 tr — 둘 다 data-sc 로 잡는다
    const row = e.target.closest('[data-sc]');
    if (!row || typeof openShareCard !== 'function') return;
    // 행 안에 자체 동작이 있는 요소(혼성 표의 세부기록 셀 등)를 누른 경우엔 양보한다.
    const own = e.target.closest('[onclick], a, button, input, select, label');
    if (own && row.contains(own)) return;
    try {
        openShareCard(JSON.parse(decodeURIComponent(row.getAttribute('data-sc'))));
    } catch (err) { /* 잘못된 payload 는 무시 */ }
});

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
            { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
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
        // ── 두 줄 에디토리얼 행 (2026-09) ──
        //   상단: 순위 · 이름 · 소속 / 하단 왼쪽: LANE · BIB · 그룹 · 비고 / 하단 오른쪽: 기록(+w·신기록 배지)
        //   표 헤더·세로선 없음. 행 전체가 공유 카드 버튼이고, 눌린다는 표시는 오른쪽 골드 › 하나.
        //   비고는 하단 메타에 흡수되므로 "대회신기록" 같은 자유 입력이 들어와도 기록·배지와 안 섞인다.
        html += `<div class="rr-list${_rrFirstOpen ? ' rr-first' : ''}">${rows.map(r => {
            const hasRec = !r.status_code && r.time_seconds != null;
            const wMark2 = (_isWindAided2 && hasRec) ? '<span class="rr-w">w</span>' : '';
            const recBadges = (hasRec && !_isWindAided2) ? _rrRecordBadges(r.time_seconds) : '';
            let memberHtml = '';
            if (isRelay && relayMembers) {
                const members = relayMembers.filter(m => m.event_entry_id === r.event_entry_id);
                if (members.length > 0) {
                    const sorted = [...members].sort((a, b) => (a.leg_order || 99) - (b.leg_order || 99));
                    memberHtml = `<div class="rr-members">${sorted.map(m => `<span>${m.leg_order ? m.leg_order + '주 ' : ''}${m.name}${m.bib_number ? `<i>#${m.bib_number}</i>` : ''}</span>`).join('')}</div>`;
                }
            }
            const _scRec = hasRec ? formatTime(r.time_seconds) : '';
            const scAttr = _scAttr(data.event, r, _scRec, typeof r.rank === 'number' ? r.rank : null, { windAided: _isWindAided2 });
            const rankHtml = r.status_code
                ? `<div class="rr-rank rr-rank-st sc-${r.status_code}">${r.status_code}</div>`
                : `<div class="rr-rank${r.rank === 1 ? ' rr-rank-1' : ''}">${r.rank}</div>`;
            const meta = [
                `${smallNumLabel} ${r.lane_number || '—'}`,
                `BIB ${bib(r.bib_number)}`,
                r.sub_group ? `${r.sub_group}그룹` : '',
                _remarkRest(r.remark) ? `<b>${_remarkRest(r.remark)}</b>` : '',
            ].filter(Boolean).join('<i>·</i>');
            const recHtml = r.status_code
                ? `<div class="rr-rec rr-rec-st">${r.status_code}</div>`
                : (hasRec ? `<div class="rr-rec">${formatTime(r.time_seconds)}${wMark2}${recBadges}${_recTagHtml(_recTagOf(r.remark))}</div>` : '<div class="rr-rec rr-rec-st">—</div>');
            return `<div class="rr${scAttr ? '' : ' rr-nocard'}"${scAttr} data-team="${r.team || ''}">
                ${rankHtml}
                <div class="rr-who"><span class="rr-name">${r.name}${r.name_alt ? `<span class="rr-alt">${r.name_alt}</span>` : ''}</span>${isRelay ? '' : `<span class="rr-team">${r.team || ''}${_pbSb(r)}</span>`}</div>
                <div class="rr-meta">${meta}</div>
                <div class="rr-pbsb-row">${_pbSb(r)}</div>
                ${recHtml}
                <div class="rr-go" aria-hidden="true">${scAttr ? '›' : ''}</div>
                ${memberHtml}
            </div>`;
        }).join('')}</div>`;
    });
    _rrFirstOpen = false;
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

// 결과 팝업 첫 열람 여부 — 이 기기에서 처음 연 결과표에서만 › 가 두 번 숨 쉬듯 흐르고 멈춘다 (계속 깜빡이지 않음)
let _rrFirstOpen = (() => {
    try {
        if (localStorage.getItem('rr_hint_done') === '1') return false;
        localStorage.setItem('rr_hint_done', '1');
    } catch (e) {}
    return true;
})();

// ── 필드 종목 모바일(<900px) 두 줄 행 + 3줄 시기 스트립 ──
//   거리: 6칸 고정(차수·기록·풍속), 최고 시기 골드, 파울 ×, 패스 –, 미실시 연하게
//   높이: 시도한 높이만 칩으로 가로 스크롤, 통과 최고 높이 골드, O 초록 / X 빨강
//   완료 결과는 행 전체가 공유 카드(data-sc), LIVE 는 공유 없음 + 기록 들어온 행 연한 강조
function _rrFieldRankHtml(status, rankNum) {
    if (status) return `<div class="rr-rank rr-rank-st sc-${status}">${status}</div>`;
    return `<div class="rr-rank${rankNum === 1 ? ' rr-rank-1' : ''}${rankNum == null ? ' rr-rank-wait' : ''}">${rankNum == null ? '—' : rankNum}</div>`;
}
function _rrFieldDistList(rows, needsWind, opts) {
    const live = !!(opts && opts.live), evt = opts && opts.event;
    const items = rows.map(r => {
        const hasRec = !r.status_code && r.best != null;
        const rankNum = typeof r.rank === 'number' ? r.rank : null;
        const bwa = needsWind && hasRec && r.bestWind != null && parseFloat(r.bestWind) > 2.0;
        const badges = ((hasRec && !bwa) ? _rrRecordBadges(r.best) : '') + (hasRec ? _recTagHtml(_recTagOf(r.remark)) : '');
        let bestIdx = 0;
        if (hasRec) { for (let i = 6; i >= 1; i--) { if (r.att[i] === r.best) { bestIdx = i; break; } } }
        const recHtml = r.status_code
            ? `<div class="rr-rec rr-rec-st">${r.status_code}</div>`
            : (hasRec ? `<div class="rr-rec">${formatHeight(r.best)}${(needsWind && r.bestWind != null) ? `<span class="rr-w">${formatWind(r.bestWind)}${bwa ? ' w' : ''}</span>` : ''}${badges}</div>` : '<div class="rr-rec rr-rec-st">—</div>');
        const meta = [`순번 ${r.lane_number || '—'}`, `BIB ${bib(r.bib_number)}`, bwa ? '<b>참고기록</b>' : ''].filter(Boolean).join('<i>·</i>');
        let cells = '';
        for (let i = 1; i <= 6; i++) {
            const v = r.att[i];
            const has = v != null, foul = has && v === 0, pass = has && v < 0;
            const cls = ['rr-att-c', i === bestIdx ? 'best' : '', foul ? 'x' : '', pass ? 'pass' : '', !has ? 'empty' : ''].filter(Boolean).join(' ');
            const val = has ? (foul ? '×' : (pass ? '–' : formatHeight(v))) : '–';
            const wind = needsWind ? `<small>${(has && !foul && !pass && r.attWind[i] != null) ? formatWind(r.attWind[i]) : '&nbsp;'}</small>` : '';
            cells += `<div class="${cls}"><span class="n">${i}</span>${val}${wind}</div>`;
        }
        const scAttr = (!live && hasRec) ? _scAttr(evt, r, formatHeight(r.best), rankNum, { windAided: bwa }) : '';
        return `<div class="rr${scAttr ? '' : ' rr-nocard'}${live && hasRec ? ' rr-has-rec' : ''}"${scAttr} data-team="${r.team || ''}">
            ${_rrFieldRankHtml(r.status_code, rankNum)}
            <div class="rr-who"><span class="rr-name">${r.name}${r.name_alt ? `<span class="rr-alt">${r.name_alt}</span>` : ''}</span><span class="rr-team">${r.team || ''}${_pbSb(r)}</span></div>
            <div class="rr-meta">${meta}</div>
                <div class="rr-pbsb-row">${_pbSb(r)}</div>
            ${recHtml}
            <div class="rr-go" aria-hidden="true">${scAttr ? '›' : ''}</div>
            <div class="rr-att">${cells}</div>
        </div>`;
    }).join('');
    return `<div class="rr-field-mobile"><div class="rr-list${live ? ' rr-live' : ''}">${items}</div></div>`;
}
function _rrFieldHeightList(rows, hts, opts) {
    const live = !!(opts && opts.live), evt = opts && opts.event;
    const items = rows.map(r => {
        const status = r.isNM ? 'NM' : (r.status_code || '');
        const hasRec = !status && r.best != null;
        const rankNum = typeof r.rank === 'number' ? r.rank : null;
        const badges = hasRec ? _rrRecordBadges(r.best) + _recTagHtml(_recTagOf(r.remark)) : '';
        const recHtml = status ? `<div class="rr-rec rr-rec-st">${status}</div>` : (hasRec ? `<div class="rr-rec">${formatHeight(r.best)}${badges}</div>` : '<div class="rr-rec rr-rec-st">—</div>');
        const meta = [`순번 ${r.lane_number || '—'}`, `BIB ${bib(r.bib_number)}`].join('<i>·</i>');
        let chips = '';
        hts.forEach(h2 => {
            const d = r.hd[h2]; if (!d) return;
            let marks = '';
            for (let i = 1; i <= 3; i++) {
                if (!d[i]) continue;
                const m = d[i] === 'PASS' ? '–' : d[i];
                marks += `<i class="${m === 'O' ? 'o' : (m === 'X' ? 'xx' : 'p')}">${m}</i>`;
            }
            chips += `<div class="rr-hj-c${h2 === r.best ? ' best' : ''}"><b>${formatHeight(h2)}</b><span>${marks || '&nbsp;'}</span></div>`;
        });
        const scAttr = (!live && hasRec) ? _scAttr(evt, r, formatHeight(r.best), rankNum) : '';
        return `<div class="rr${scAttr ? '' : ' rr-nocard'}${live && hasRec ? ' rr-has-rec' : ''}"${scAttr} data-team="${r.team || ''}">
            ${_rrFieldRankHtml(status, rankNum)}
            <div class="rr-who"><span class="rr-name">${r.name}${r.name_alt ? `<span class="rr-alt">${r.name_alt}</span>` : ''}</span><span class="rr-team">${r.team || ''}${_pbSb(r)}</span></div>
            <div class="rr-meta">${meta}</div>
                <div class="rr-pbsb-row">${_pbSb(r)}</div>
            ${recHtml}
            <div class="rr-go" aria-hidden="true">${scAttr ? '›' : ''}</div>
            ${chips ? `<div class="rr-hj">${chips}</div>` : ''}
        </div>`;
    }).join('');
    return `<div class="rr-field-mobile"><div class="rr-list${live ? ' rr-live' : ''}">${items}</div></div>`;
}

// ── 종합경기(10종/7종) 모바일(<900px) 카드 ──
//   1줄 순위·이름·소속 / 2줄 BIB·1일차·2일차 소계 / 오른쪽 총점 + 선두 차이
//   3·4줄: 1일차 한 줄, 2일차 한 줄 종목 그리드(약칭·기록·점수). 칸 높이는 항상 3줄 고정(DNF/미실시도 같은 크기).
//   LIVE: 상단 진행 바(끝난 종목 골드·현재 초록), 현재 종목 칸 초록, 미실시 '–'.
const _RR_CMB_SHORT = { '100m': '100m', '멀리뛰기': '멀리', '포환던지기': '포환', '높이뛰기': '높이', '400m': '400m', '110m 허들': '110mH', '원반던지기': '원반', '장대높이뛰기': '장대', '창던지기': '창', '1500m': '1500m', '100m 허들': '100mH', '200m': '200m', '800m': '800m' };
function _rrCombinedList(rows, subDefs, day1Max, opts) {
    const live = !!(opts && opts.live);
    const fmtPts = n => (n || 0).toLocaleString('ko-KR');
    // 진행 중 종목: 누구든 값이 들어온 가장 뒤 차수
    let nowOrder = 0;
    rows.forEach(r => subDefs.forEach(se => { const p = r.pts[se.order]; if (p && (p.raw != null || p.status_code)) nowOrder = Math.max(nowOrder, se.order); }));
    const allDoneNow = nowOrder > 0 && rows.every(r => { const p = r.pts[nowOrder]; return p && (p.raw != null || p.status_code); });
    const finished = nowOrder === subDefs.length && allDoneNow;
    const leaderTotal = rows.reduce((m, r) => Math.max(m, r.total || 0), 0);
    const canDetail = !live && typeof _cResultShowSub === 'function';

    let prog = '';
    if (live && subDefs.length) {
        const dots = subDefs.map(se => `<i class="${se.order < nowOrder || (se.order === nowOrder && allDoneNow) ? 'd' : (se.order === nowOrder ? 'now' : '')}"></i>`).join('');
        const cur = subDefs.find(se => se.order === nowOrder);
        const txt = nowOrder === 0 ? '시작 전' : (finished ? `${subDefs.length}/${subDefs.length} · 전 종목 종료` : `${nowOrder}/${subDefs.length} · <b>${cur ? cur.name : ''}</b> ${allDoneNow ? '종료' : '진행 중'}`);
        prog = `<div class="rr-cmb-prog"><span class="dots">${dots}</span><span>${txt}</span></div>`;
    }

    const items = rows.map(r => {
        const codes = subDefs.map(se => (r.pts[se.order] || {}).status_code).filter(c => ['DNF', 'DNS', 'DQ'].includes(c));
        const status = codes.length ? codes[codes.length - 1] : '';
        const rankNum = (r.total > 0 && !status) ? r.rank : null;
        let d1 = 0, d2 = 0, bestOrder = 0, bestPts = -1;
        subDefs.forEach(se => {
            const p = r.pts[se.order] || {};
            const pts = p.points || 0;
            if (se.order <= day1Max) d1 += pts; else d2 += pts;
            if (p.raw != null && pts > bestPts) { bestPts = pts; bestOrder = se.order; }
        });
        let sub = '';
        if (status) sub = `<small>${status}</small>`;
        else if (r.total > 0 && rankNum === 1) { const b = _rrRecordBadges(r.total); sub = b ? `<small class="lead">${b}</small>` : (live ? '<small class="lead">선두</small>' : '<small>&nbsp;</small>'); }
        else if (r.total > 0) sub = `<small>−${fmtPts(leaderTotal - r.total)}</small>`;
        else sub = '<small>&nbsp;</small>';
        const cell = se => {
            const p = r.pts[se.order] || {};
            const has = p.raw != null || !!p.status_code;
            const isNow = live && se.order === nowOrder && !finished;
            let cls = 'rr-cmb-c', mark = '–', pts = '&nbsp;';
            if (p.status_code && ['DNS', 'DNF', 'DQ', 'NM', 'NH'].includes(p.status_code)) { cls += ' x'; mark = p.status_code; pts = '0'; }
            else if (has && p.raw === 0 && !p.points) { cls += ' x'; mark = 'NM'; pts = '0'; }
            else if (has && p.raw > 0) { mark = se.unit === 's' ? formatTime(p.raw) : formatHeight(p.raw); pts = String(p.points || 0); if (se.order === bestOrder) cls += ' best'; }
            else cls += ' wait';
            if (isNow) cls += ' now';
            const click = canDetail ? ` onclick="event.stopPropagation();_cResultShowSub(${se.order})"` : '';
            return `<div class="${cls}"${click}><span class="l">${_RR_CMB_SHORT[se.name] || se.name}</span><span class="m">${mark}</span><span class="p">${pts}</span></div>`;
        };
        const day1 = subDefs.filter(se => se.order <= day1Max), day2 = subDefs.filter(se => se.order > day1Max);
        // 두 줄 칸 폭 동일: 칸 수가 적은 줄(7종 2일차 3종목)도 같은 열 수로 깔고 빈칸을 둔다
        const cols = Math.max(day1.length, day2.length);
        const scAttr = (!live && r.total > 0 && opts && opts.scAttr) ? opts.scAttr(r) : '';
        return `<div class="rr rr-cmb${scAttr ? '' : ' rr-nocard'}${live && r.total > 0 ? ' rr-has-rec' : ''}"${scAttr} data-team="${r.team || ''}">
            ${_rrFieldRankHtml(status, rankNum)}
            <div class="rr-who"><span class="rr-name">${r.name}${r.name_alt ? `<span class="rr-alt">${r.name_alt}</span>` : ''}</span><span class="rr-team">${r.team || ''}${_pbSb(r)}</span></div>
            <div class="rr-meta">BIB ${bib(r.bib_number)}<i>·</i><span class="d1">1일차 ${fmtPts(d1)}</span><i>·</i><span class="d2">2일차 ${d2 || nowOrder > day1Max ? fmtPts(d2) : '–'}</span></div>
            <div class="rr-tot"><b>${r.total > 0 ? fmtPts(r.total) : '—'}</b>${sub}</div>
            <div class="rr-go" aria-hidden="true">${scAttr ? '›' : ''}</div>
            <div class="rr-cmb-ev d1 c${cols}">${day1.map(cell).join('')}</div>
            <div class="rr-cmb-ev d2 c${cols}">${day2.map(cell).join('')}</div>
        </div>`;
    }).join('');
    return `<div class="rr-field-mobile">${prog}<div class="rr-list${live ? ' rr-live' : ''}">${items}</div></div>`;
}

// 신기록 배지 (NR/DR/CR) — 두 줄 행의 기록 옆 작은 알약
function _rrRecordBadges(newValNum) {
    const lbl = _recLabelText(newValNum);
    if (!lbl) return '';
    return lbl.split(' ').map(l => `<span class="rr-badge rr-badge-${l}">${l}</span>`).join('');
}

function renderFieldDistResults(data) {
    let html = '';
    data.heats.forEach(h => {
        const rows = h.entries.map(e => {
            const er = (h.results || []).filter(r => r.event_entry_id === e.event_entry_id);
            const att = {}, attWind = {}; let bestOnly = null, bestOnlyWind = null;
            let sc = '';
            er.forEach(r => {
                if (r.attempt_number) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; }
                else if (r.distance_meters != null && r.distance_meters > 0) { bestOnly = r.distance_meters; bestOnlyWind = r.wind; }   // 시기 없이 최고 기록만(국제대회 동기화)
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
            const best = valid.length > 0 ? Math.max(...valid) : bestOnly;
            let bestWind = valid.length > 0 ? null : bestOnlyWind;
            if (best != null && valid.length > 0) { for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } } }
            // Build sorted valid distances (descending) for WA tie-breaking
            const sortedValid = [];
            for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
            sortedValid.sort((a, b) => b - a);
            const remark = ((er.find(r => r.attempt_number == null && r.remark) || {}).remark) || '';
            return { ...e, att, attWind, best, bestWind, status_code: sc, sortedValid, remark };
        }).sort((a, b) => {
            { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
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
        html += '<div class="rr-field-desktop">';   // ≥900px: 6차시기 표 / <900px: 두 줄+시기 스트립 (_rrFieldDistList)
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
                    // 상태코드는 기록(결과) 칸에, 신기록(NR/DR/CR)은 기록 값 옆 괄호로
                    const _recP = (!_bwa && !r.status_code && r.best != null) ? _buildRecordBadgesHTML(r.best) : '';
                    const bestDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? formatHeight(r.best) + bestWMark + _recP : '—');
                    const rkDisp = r.status_code ? '' : r.rank;
                    let rmk = '';
                    if (_bwa) rmk = '참고기록';
                    const rmkSt = _bwa ? 'color:var(--accent);font-weight:600;' : '';
                    const _scRec = (!r.status_code && r.best != null) ? formatHeight(r.best) : '';
                    return `<tr class="field-row1"${_scAttr(data.event, r, _scRec, typeof r.rank === 'number' ? r.rank : null, { windAided: _bwa })}>
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
                    const bestDisp2 = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? formatHeight(r.best) + _buildRecordBadgesHTML(r.best) : '—');
                    const rkDisp2 = r.status_code ? '' : r.rank;
                    const rmk2 = '';  // 신기록은 기록칸 괄호로 표시
                    const rmkSt2 = rmk2 ? 'color:#27ae60;font-weight:700;' : '';
                    const _scRec2 = (!r.status_code && r.best != null) ? formatHeight(r.best) : '';
                    return `<tr${_scAttr(data.event, r, _scRec2, typeof r.rank === 'number' ? r.rank : null)}><td>${rkDisp2}</td><td>${bib(r.bib_number)}</td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team||''}</td>${c}<td class="att-col-best" style="font-weight:700;">${bestDisp2}</td><td style="font-size:11px;${rmkSt2}">${rmk2}</td></tr>`;
                }).join('')}</tbody></table>`;
        }
        html += '</div>' + _rrFieldDistList(rows, needsWind, { live: false, event: data.event });
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
            const _hs = PaceRanking.heightStats(hd, hts);   // 공용 모듈 (WA TR 26.2·26.8)
            const best = _hs.best, totalFails = _hs.totalFails, failsAtBest = _hs.failsAtBest, isNM = _hs.isNM;
            const status_code = ((h.results || []).find(r => r.event_entry_id === e.event_entry_id && PaceRanking.isStatus(r.status_code)) || {}).status_code || '';
            const _bestOnly = ea.length ? null : (((h.results || []).find(r => r.event_entry_id === e.event_entry_id && r.attempt_number == null && r.distance_meters > 0) || {}).distance_meters || null);   // 시기 없이 최고 높이만(국제대회 동기화)
            return { ...e, hd, remark: (((h.results || []).find(r => r.event_entry_id === e.event_entry_id && r.attempt_number == null) || {}).remark) || '', best: status_code ? null : (best != null ? best : _bestOnly), totalFails, failsAtBest, isNM: _bestOnly ? false : isNM, status_code };
        }).sort((a, b) => {
            { const st = PaceRanking.compareStatus(a, b); if (st != null) return st; }     // 상태코드는 뒤로 (NM → DNF → DQ → DNS)
            if (a.best == null && b.best == null) return 0;
            if (a.best == null) return 1; if (b.best == null) return -1;
            if (b.best !== a.best) return b.best - a.best;
            // 같은 높이 → 수동 순위(순위결정전) 우선
            if (a.manual_rank != null && b.manual_rank != null) return a.manual_rank - b.manual_rank;
            if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
            return a.totalFails - b.totalFails;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.rank = `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>`; return; }
            if (r.best == null) { r.rank = '—'; rk = i + 2; return; }
            let isTied = i > 0 && rows[i-1].best === r.best && rows[i-1].failsAtBest === r.failsAtBest && rows[i-1].totalFails === r.totalFails;
            r.rank = isTied ? rows[i-1].rank : rk;
            rk = i + 2;
        });
        // 수동 순위(순위결정전) override
        rows.forEach(r => { if (r.manual_rank != null) r.rank = r.manual_rank; });

        let thead = '<th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>';
        hts.forEach(h2 => { thead += `<th style="font-size:10px;">${formatHeight(h2)}</th>`; });
        thead += '<th>최고</th><th>비고</th>';
        html += `<div class="rr-field-desktop"><table class="data-table" style="font-size:13px;">
            <thead><tr>${thead}</tr></thead>
            <tbody>${rows.map(r => {
                let c = '';
                hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const mark = d[i] === 'PASS' ? '-' : d[i]; m += mark; } } c += `<td style="font-size:11px;">${m}</td>`; });
                const bestDisp3 = r.best != null ? (formatHeight(r.best) + _buildRecordBadgesHTML(r.best)) : (r.isNM ? '<span class="sc-badge sc-NM">NM</span>' : '');
                const rmk3 = '';  // 신기록은 기록칸 괄호로 표시
                const rmkSt3 = rmk3 ? 'color:#27ae60;font-weight:700;' : '';
                const _scRec3 = (!r.isNM && r.best != null) ? formatHeight(r.best) : '';
                return `<tr${_scAttr(data.event, r, _scRec3, typeof r.rank === 'number' ? r.rank : null)}><td>${r.isNM ? '' : r.rank}</td><td>${bib(r.bib_number)}</td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team||''}</td>${c}<td style="font-weight:700;">${bestDisp3}</td><td style="font-size:11px;${rmkSt3}">${rmk3}</td></tr>`;
            }).join('')}</tbody></table></div>` + _rrFieldHeightList(rows, hts, { live: false, event: data.event });
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

// ============================================================
// Pacing Light Popup (W/L Target)
// ============================================================
// hex = 점/테두리(실제 라이트 색), ink = 흰 카드 위 글자색(가독성용)
const _PACING_COLOR_MAP = {
    green:  { label: 'Green',  hex: '#22c55e', textColor: '#fff',     ink: '#15803d' },
    red:    { label: 'Red',    hex: '#ef4444', textColor: '#fff',     ink: '#dc2626' },
    white:  { label: 'White',  hex: '#ffffff', textColor: '#111827', ink: '#475569' },
    blue:   { label: 'Blue',   hex: '#2563eb', textColor: '#fff',     ink: '#1d4ed8' },
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
        html += `<div style="width:100%;box-sizing:border-box;background:#f8f4ea;border:1px solid #f8f4ea;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;color:#b79f58;">${cfg.notice}</div>`;
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

            const popupBorder = cm.hex === '#ffffff' ? '#cbd5e1' : cm.hex;
            const popupDotBorder = cm.hex === '#ffffff' ? '#9ca3af' : 'rgba(0,0,0,.1)';
            // width:100%+box-sizing — overflow-x:auto 컨테이너(result-panel-body) 안에서
            // iOS Safari 가 카드를 내용 폭으로 줄여(shrink-wrap) 우측 여백이 생기는 문제 방지
            html += `<div style="width:100%;box-sizing:border-box;border:2px solid ${popupBorder};border-radius:8px;padding:12px;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                    <span style="background:${cm.hex};width:18px;height:18px;border-radius:50%;display:inline-block;border:2px solid ${popupDotBorder};flex-shrink:0;"></span>
                    <span style="font-weight:700;font-size:15px;color:${cm.ink || cm.hex};">${cm.label}</span>
                    <span style="font-family:monospace;font-weight:700;font-size:18px;margin-left:auto;">${_fmtPacingTime(totalTime)}</span>
                    ${totalTime >= 60 ? `<span style="font-size:11px;color:var(--text-muted);margin-left:4px;">(${Math.round(totalTime)}초)</span>` : ''}
                </div>`;

            if (c.remark) {
                html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">… ${c.remark}</div>`;
            }

            // Show cumulative splits table
            if (splits.length > 1) {
                const headerBg = cm.hex === '#ffffff' ? '#e5e7eb' : `${cm.hex}22`;
                html += `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;">
                    <thead><tr style="background:${headerBg};">
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
        <h3><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ui-emoji"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> ${eventName} W/L Target</h3>
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
    overlay.style.display = 'flex'; if (window.lockBodyScroll) lockBodyScroll();
    _rosterModalKind = 'startlist';

    const gL = evt.gender === 'M' ? '남자' : evt.gender === 'F' ? '여자' : '혼성';
    const roundL = { preliminary: '예선', semifinal: '준결승', final: '결승' }[evt.round_type] || '';

    const _rb = _rosterBox(overlay, 520);
    overlay.innerHTML = `<div style="background:#fff;${_rb.box}display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;">${_rb.handle}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:linear-gradient(135deg,#f5f0e0,#f1f8e9);border-bottom:1px solid #e8dfc0;flex-shrink:0;">
            <div>
                <div style="font-weight:800;font-size:15px;color:#6b5520;">스타트 리스트</div>
                <div style="font-size:12px;color:#b79f58;margin-top:2px;">${gL} ${eventName} ${roundL}</div>
            </div>
            ${_favBtnHtml(evt)}
            <button onclick="closeRosterModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#999;padding:0 4px;">&times;</button>
        </div>
        <div id="roster-modal-body" style="flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 0 env(safe-area-inset-bottom,0);">
            <div style="padding:30px;text-align:center;color:var(--text-muted);">불러오는 중...</div>
        </div>
    </div>`;

    if (window.pushModalState) pushModalState(() => closeRosterModal());
    await loadRosterModalData(eventId);
}

function closeRosterModal() {
    if (_rosterModalKind !== 'team' && _rosterReturn) { _rosterModalEventId = null; _returnToTeamRoster(); return; }
    _rosterModalKind = null; _rosterReturn = null;
    const overlay = document.getElementById('roster-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    if (window.unlockBodyScroll) unlockBodyScroll();
    _rosterModalEventId = null;
}

async function loadRosterModalData(eventId) {
    const body = document.getElementById('roster-modal-body');
    if (!body) return;

    try {
        const evt = allEvents.find(e => e.id === eventId);
        if (!evt) { body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">종목 정보를 찾을 수 없습니다.</div>'; return; }

        let heats = await API.getHeats(eventId);
        // 종합경기(7종·10종): 부모에는 조가 없고 세부종목마다 조가 있다 → 세부종목 순서대로 모아 보여준다 (조 이름 앞에 세부종목명)
        let subOf = new Map();
        if (evt.category === 'combined' && heats.length === 0) {
            const subs = allEvents.filter(e => e.parent_event_id === evt.id).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            for (const sub of subs) {
                const hs = await API.getHeats(sub.id);
                hs.forEach(h => { subOf.set(h.id, sub); });
                heats = heats.concat(hs);
            }
        }
        if (heats.length === 0) {
            body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">조 편성이 아직 완료되지 않았습니다.</div>';
            return;
        }

        const isFinalSingle = evt.round_type === 'final' && heats.length === 1;
        const isFieldEvt = ['field_distance', 'field_height'].includes(evt.category);
        // 국제대회(관심 국가): 국가 코드 열·태극기·영문명·출생년·PB/SB, 우리 선수 줄은 연한 붉은 배경 — 엔트리 창과 같은 규칙
        const spot = (allEvents.find(e => e.spotlight) || {}).spotlight || null;
        const escT = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const yearOf = d => (String(d || '').match(/^\d{4}/) || [''])[0];
        const pbsbOf = e => [e.personal_best ? 'PB ' + e.personal_best : '', e.season_best ? 'SB ' + e.season_best : ''].filter(Boolean).map(escT).join('<br>');
        // 소집 진행 중 여부 (heats_generated 이후 = 소집 가능 상태)
        const showCallroomStatus = (evt.round_status === 'in_progress' || evt.round_status === 'heats_generated');
        let html = '';

        const _heatEntries = new Map();
        for (const heat of heats) _heatEntries.set(heat.id, await API.getHeatEntries(heat.id));
        const anyFilled = [..._heatEntries.values()].some(l => l.length > 0);
        // ── PB 기준 순번 (국제대회): 조 안 순번·전체 순번 — 참고치. 7종·10종은 제외. 진출 규칙(각 조 N위)이 있으면 그 안이면 초록 ──
        const _pbRank = new Map();   // event_entry_id → { heat, all, n_heat, n_all }
        let _qHeat = 0, _pbNote = '';
        if (spot && evt.category !== 'combined' && !subOf.size) {
            const higher = ['field_distance', 'field_height'].includes(evt.category);
            const num = e => { const v = parseRecordValueClient(e.personal_best); return v == null || !(v > 0) ? null : v; };
            const rankList = list => { const withPb = list.filter(e => num(e) != null).sort((a, b) => higher ? num(b) - num(a) : num(a) - num(b)); const r = new Map(); let rk = 0; withPb.forEach((e, i) => { if (i === 0 || num(e) !== num(withPb[i - 1])) rk = i + 1; r.set(e.event_entry_id, rk); }); return { r, n: withPb.length }; };
            const allEntries = [..._heatEntries.values()].flat();
            const all = rankList(allEntries);
            // PB 가 절반도 안 채워진 명단(계주 팀 등)은 순번이 의미 없다 → 표시 안 함
            if (all.n < 3 || all.n * 2 < allEntries.length) { /* skip */ } else
            for (const heat of heats) { const hl = rankList(_heatEntries.get(heat.id) || []); for (const e of (_heatEntries.get(heat.id) || [])) _pbRank.set(e.event_entry_id, { heat: hl.r.get(e.event_entry_id) || null, n_heat: hl.n, all: all.r.get(e.event_entry_id) || null, n_all: all.n, heat_number: heat.heat_number }); }
            if (evt.round_type !== 'final') { try { const d = await api('GET', `/api/events/${evt.id}/spotlight`); const m = String((d && d.rule && d.rule.text) || '').match(/first\s+(\d+)/i); if (m) _qHeat = parseInt(m[1], 10); _pbNote = d && d.rule && d.rule.text_ko ? d.rule.text_ko : ''; } catch (e) {} }
        }
        const _rankTag = e => { const r = _pbRank.get(e.event_entry_id); if (!r) return ''; const isFinalR = evt.round_type === 'final' || heats.length === 1; const n = isFinalR ? r.all : r.heat; if (!n) return ''; const good = isFinalR ? n <= 3 : (_qHeat ? n <= _qHeat : n <= 3); return `<span class="pb-rank${good ? ' good' : ''}" title="PB 기준 ${isFinalR ? '전체' : '조'} 순번">#${n}</span>`; };
        for (const heat of heats) {
            const entries = _heatEntries.get(heat.id);
            if (entries.length === 0 && anyFilled) continue;   // 공식 일정엔 8조였다가 4조로 줄어든 경우 등: 명단 없는 조는 숨긴다
            const _sub = subOf.get(heat.id);
            const hLabel = _sub ? `${_sub.name} ${heat.heat_name || (heat.heat_number + '조')}` : (isFinalSingle ? '결승' : (heat.heat_name || `${heat.heat_number}조`));

            // 소집 상태 요약
            const cntChecked = entries.filter(e => e.status === 'checked_in').length;
            const cntNoShow = entries.filter(e => e.status === 'no_show').length;
            const cntPending = entries.length - cntChecked - cntNoShow;
            const allChecked = cntChecked === entries.length && entries.length > 0;

            // === 그룹(A/B) 분리: 5000m/10000m 등 장거리 그룹 결승은 같은 조 안에서 A/B 따로 출발 ===
            const hasSubGroup = entries.some(e => e.sub_group);
            const hasBib = entries.some(e => e.bib_number);   // 국제대회는 배번이 없어 열을 뺀다

            html += `<div style="border-bottom:1.5px solid #e8e8e8;">`;
            html += `<div style="padding:8px 14px;background:#fafafa;display:flex;align-items:center;justify-content:space-between;">`;
            html += `<span style="font-weight:700;font-size:13px;color:#333;">${hLabel}</span>`;
            // 소집 상태 뱃지
            if (showCallroomStatus) {
                if (allChecked) {
                    html += `<span style="font-size:10px;background:#b79f58;color:#fff;padding:2px 8px;border-radius:10px;font-weight:600;">소집 완료 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:#16a34a;" class="ui-emoji"><polyline points="20 6 9 17 4 12"/></svg></span>`;
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
            // table-layout:fixed + 열폭 고정 → 조가 여러 테이블이어도 열 위치 정렬 통일.
            //   소속은 남은 폭을 차지하고, 긴 팀명은 줄바꿈(word-break)으로 다음 줄로.
            html += `<table class="fill-table" style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;">`;
            html += `<thead><tr style="background:#f5f5f5;border-bottom:1px solid #e0e0e0;">`;
            const isField = _sub ? ['field_distance', 'field_height'].includes(_sub.category) : isFieldEvt;
            html += `<th style="padding:5px 8px;text-align:center;width:42px;font-weight:600;color:#777;">${isField ? '순서' : '레인'}</th>`;
            if (hasBib) html += `<th style="padding:5px 8px;text-align:center;width:50px;font-weight:600;color:#777;">배번</th>`;
            if (hasSubGroup) html += `<th style="padding:5px 8px;text-align:center;width:42px;font-weight:600;color:#777;">그룹</th>`;
            //   이름은 keep-all 만 두면 폭을 넘는 긴 이름(외국인 선수 등)이 소속 열 위로 겹쳐 그려짐
            //   → 이름 열을 표 폭의 24%(데스크톱 ≈125px, 9자까지 한 줄)로 넓히고, 그래도 넘치면
            //     overflow-wrap:anywhere 로 셀 안에서 줄바꿈. 소속은 남은 폭(≈250px)이라 상태 열을 침범하지 않음.
            if (spot) {
                const phone = window.innerWidth < 640;   // 폰: PB·SB 를 이름 아래 한 줄로 (열이 좁아 두 줄로 잘리던 것)
                html += `<th style="padding:5px 6px;text-align:left;width:${phone ? 46 : 54}px;font-weight:600;color:#777;">국가</th>`;
                html += `<th style="padding:5px 8px;text-align:left;font-weight:600;color:#777;">이름</th>`;
                if (!phone) html += `<th style="padding:5px 8px;text-align:right;width:92px;font-weight:600;color:#777;">PB · SB</th>`;
            } else {
                html += `<th style="padding:5px 8px;text-align:left;width:24%;font-weight:600;color:#777;">이름</th>`;
                html += `<th style="padding:5px 8px;text-align:left;font-weight:600;color:#777;">소속</th>`;
            }
            if (showCallroomStatus) html += `<th style="padding:5px 8px;text-align:center;width:48px;font-weight:600;color:#777;">상태</th>`;
            html += `</tr></thead><tbody>`;

            // 정렬: 그룹 있으면 A → B → null, 같은 그룹 안에선 레인 순
            const sorted = [...entries].sort((a, b) => {
                if (hasSubGroup) {
                    const ga = a.sub_group || 'Z';
                    const gb = b.sub_group || 'Z';
                    if (ga !== gb) return ga.localeCompare(gb);
                }
                return (a.lane_number || 999) - (b.lane_number || 999);
            });

            // 그룹 경계 표시: 그룹이 바뀔 때마다 얇은 구분선
            let prevGroup = null;
            for (const e of sorted) {
                const curGroup = hasSubGroup ? (e.sub_group || '') : null;
                // 그룹 경계 행 (A → B 사이)
                if (hasSubGroup && prevGroup !== null && curGroup !== prevGroup) {
                    html += `<tr><td colspan="${(hasBib ? 4 : 3) + (spot ? 1 : 0) + (showCallroomStatus?1:0) + (hasSubGroup?1:0)}" style="padding:3px 8px;background:#fafafa;border-top:1.5px dashed #d0c89a;font-size:10px;color:#8b6914;text-align:left;font-weight:700;">${curGroup ? curGroup + ' 그룹' : '미지정'}</td></tr>`;
                } else if (hasSubGroup && prevGroup === null) {
                    // 첫 그룹도 라벨 표시
                    html += `<tr><td colspan="${(hasBib ? 4 : 3) + (spot ? 1 : 0) + (showCallroomStatus?1:0) + (hasSubGroup?1:0)}" style="padding:3px 8px;background:#fafafa;border-top:1.5px solid #d0c89a;font-size:10px;color:#8b6914;text-align:left;font-weight:700;">${curGroup ? curGroup + ' 그룹' : '미지정'}</td></tr>`;
                }
                prevGroup = curGroup;

                // 상태별 행 배경색
                const isSpot = !!(spot && e.team === spot);
                const rowBg = e.status === 'no_show' ? 'background:#fff5f5;' : e.status === 'checked_in' ? 'background:#f1f8e9;' : isSpot ? 'background:#fff6f6;' : '';
                html += `<tr style="border-bottom:1px solid #f0f0f0;${rowBg}">`;
                html += `<td style="padding:5px 8px;text-align:center;color:#555;">${e.lane_number || '-'}</td>`;
                if (hasBib) html += `<td style="padding:5px 8px;text-align:center;font-weight:700;">${e.bib_number || '-'}</td>`;
                if (hasSubGroup) {
                    const g = e.sub_group;
                    const gColor = g === 'A' ? '#555' : g === 'B' ? '#8b1a2a' : '#999';
                    html += `<td style="padding:5px 8px;text-align:center;font-weight:800;color:${gColor};">${g || '—'}</td>`;
                }
                // 모바일에서 lib/responsive.css 가 모든 td 에 white-space:nowrap 을 걸어 줄바꿈이 원천 차단됨
                //   → 긴 이름(비웨사다니엘가사마)이 소속 열에 겹침. 인라인 white-space:normal 로 되돌리고(인라인이 우선)
                //   폭이 모자라면 음절 단위로 줄바꿈(word-break:normal + overflow-wrap:anywhere).
                if (spot) {
                    html += `<td style="padding:7px 6px;text-align:left;font-weight:800;font-size:11px;color:${isSpot ? '#8b1a2a' : '#555'};white-space:nowrap;">${isSpot && spot === 'KOR' ? PaceIcons.svg('flagKR', { size: 22, style: 'vertical-align:-5px' }) : escT(e.team || '')}</td>`;
                    html += `<td style="padding:7px 8px;text-align:left;font-weight:${isSpot ? 800 : 600};white-space:normal;word-break:normal;overflow-wrap:anywhere;line-height:1.3;">${escT(e.name)}${e.name_alt ? `<span style="font-size:10px;color:#888;margin-left:5px;font-weight:500;">${escT(e.name_alt)}</span>` : ''}${yearOf(e.date_of_birth) ? `<span style="font-size:10px;color:#999;margin-left:5px;font-weight:500;">${yearOf(e.date_of_birth)}</span>` : ''}${window.innerWidth < 640 && (e.personal_best || e.season_best) ? `<div style="font-family:var(--font-mono);font-size:10.5px;color:#666;font-weight:500;margin-top:3px;white-space:nowrap;">${[e.personal_best ? 'PB ' + escT(e.personal_best) : '', e.season_best ? 'SB ' + escT(e.season_best) : ''].filter(Boolean).join(' · ')}${_rankTag(e)}</div>` : ''}</td>`;
                    if (window.innerWidth >= 640) html += `<td style="padding:5px 8px;text-align:right;font-family:var(--font-mono);font-size:10.5px;color:#555;white-space:nowrap;line-height:1.25;">${pbsbOf(e)}${_rankTag(e)}</td>`;
                } else {
                    html += `<td style="padding:5px 8px;text-align:left;font-weight:600;white-space:normal;word-break:normal;overflow-wrap:anywhere;line-height:1.25;">${e.name}</td>`;
                    html += `<td style="padding:5px 8px;text-align:left;color:#666;white-space:normal;word-break:normal;overflow-wrap:anywhere;line-height:1.25;">${e.team || ''}</td>`;
                }
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

        // 한국 선수 블록: 이름 · 조·레인 · PB · 조 순번 / 전체 순번 (PB 기준, 참고치)
        let spotTop = '';
        if (spot && _pbRank.size) {
            const mine = []; for (const heat of heats) for (const e of (_heatEntries.get(heat.id) || [])) if (e.team === spot) mine.push({ e, heat });
            if (mine.length) {
                const isFinalR = evt.round_type === 'final' || heats.length === 1;
                const isField = ['field_distance', 'field_height'].includes(evt.category);
                const lines = mine.map(({ e, heat }) => { const r = _pbRank.get(e.event_entry_id) || {}; const where = `${isFinalR ? '' : heat.heat_number + '조 '}${e.lane_number ? e.lane_number + (isField ? '번' : '레인') : ''}`.trim();
                    const rk = !e.personal_best ? '<span style="color:#999">PB 없음</span>' : isFinalR ? `<b>전체 ${r.all ? r.all + '번째' : '—'}</b> <span style="color:#888">(${r.n_all}명)</span>` : `<b>${r.heat ? '조 ' + r.heat + '번째' : '—'}</b> <span style="color:#888">/ 전체 ${r.all ? r.all + '번째' : '—'} (${r.n_all}명)</span>`;
                    const good = r.heat && (isFinalR ? r.all <= 3 : (_qHeat ? r.heat <= _qHeat : r.heat <= 3));
                    return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap;font-size:13px"><span style="font-weight:800;font-size:14px">${PaceIcons.svg('flagKR', { size: 18, style: 'vertical-align:-4px;margin-right:4px' })}${evt.category === 'relay' && spot === 'KOR' ? '대한민국' : escT(e.name)}</span><span style="color:#666">${where}</span>${e.personal_best ? `<span style="font-family:var(--font-mono)">PB ${escT(e.personal_best)}</span>` : ''}<span>${rk}${good ? '<span class="pb-dot" title="진출 범위 안(PB 기준)"></span>' : ''}</span></div>`; });
                spotTop = `<div class="spot-block"><div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span style="font-size:11px;font-weight:800;color:#8b1a2a;letter-spacing:.05em">한국 선수 · 스타트 리스트</span><span style="margin-left:auto;font-size:10px;color:#999">PB 기준 순번 · 참고</span></div>${lines.join('')}${_pbNote ? `<div style="font-size:11px;color:#888;margin-top:4px">진출 규칙 ${escT(_pbNote)}</div>` : ''}</div>`;
            }
        }
        body.innerHTML = (await _recordsLineHtml(evt)) + spotTop + (html || '<div style="padding:20px;text-align:center;color:var(--text-muted);">조 편성 데이터가 없습니다.</div>');

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
