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
let currentRole = sessionStorage.getItem('pace_role') || 'viewer';
let _compVideoUrl = ''; // Competition-level video URL
let _pacingMap = {}; // event_name → pacing config (for W/L Target buttons)

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
    onSSE('callroom_complete', async () => { await loadData(); });
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
});

async function loadData() {
    const compId = getCompetitionId();
    allEvents = await API.getAllEvents(compId);
    try {
        const cs = await API.getCallroomStatus();
        callroomCompletedIds = new Set(cs.completed_event_ids);
    } catch (e) {}
    // Load competition video URL
    try {
        const comp = await API.getCompetition(compId);
        _compVideoUrl = comp.video_url || '';
    } catch(e) { _compVideoUrl = ''; }
    // Load pacing configs for W/L Target (supports gender-separated keys like "800m (남)")
    try {
        const pConfigs = await API.getPublicPacing(compId);
        _pacingMap = {};
        pConfigs.forEach(cfg => { _pacingMap[cfg.event_name] = cfg; });
    } catch(e) { _pacingMap = {}; }
    renderCompVideoButton();
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
        btn.innerHTML = '▶ 대회 영상';
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

function renderMatrix() {
    const container = document.getElementById('events-container');
    const events = allEvents.filter(e => e.gender === currentGender && !e.parent_event_id);
    const favs = getFavorites();

    const categories = [
        { key: 'track', label: 'TRACK', match: c => c === 'track' },
        { key: 'field', label: 'FIELD', match: c => c === 'field_distance' || c === 'field_height' },
        { key: 'combined', label: 'COMBINED', match: c => c === 'combined' },
        { key: 'relay', label: 'RELAY', match: c => c === 'relay' },
        { key: 'road', label: 'ROAD', match: c => c === 'road' },
    ];

    // Group events by name
    const eventGroups = {};
    events.forEach(e => {
        const gKey = e.name + '|' + e.category;
        if (!eventGroups[gKey]) eventGroups[gKey] = { name: e.name, category: e.category, rounds: [] };
        eventGroups[gKey].rounds.push(e);
    });

    // Separate favorites from non-favorites
    const allGroups = [];
    categories.forEach(cat => {
        const groups = Object.values(eventGroups).filter(g => cat.match(g.category));
        groups.forEach(g => allGroups.push({ ...g, catKey: cat.key, catLabel: cat.label }));
    });

    // Gender-scoped favorites: stored as "M|800m", "F|800m", etc.
    const genderFavs = favs.filter(f => f.startsWith(currentGender + '|')).map(f => f.substring(2));
    // Also support legacy favorites (no gender prefix) for backward compatibility
    const legacyFavs = favs.filter(f => !f.includes('|'));
    const effectiveFavs = [...new Set([...genderFavs, ...legacyFavs])];
    const favGroups = allGroups.filter(g => effectiveFavs.includes(g.name));
    const nonFavGroups = allGroups.filter(g => !effectiveFavs.includes(g.name));

    let html = '';

    // Render LIVE (in_progress) section pinned at top
    const liveGroups = allGroups.filter(g => g.rounds.some(r => r.round_status === 'in_progress'));
    if (liveGroups.length > 0) {
        html += `<div style="margin-bottom:16px;padding:12px;background:linear-gradient(135deg,#fff3e0,#fbe9e7);border:1.5px solid #e65100;border-radius:var(--radius);">
            <div style="font-family:var(--font-brand);font-size:13px;font-weight:400;color:#e65100;letter-spacing:1px;margin-bottom:8px;">● LIVE • 진행중인 경기</div>`;
        html += renderCategoryTable(liveGroups, 'LIVE', true);
        html += `</div>`;
    }

    // Render favorites section if any
    if (favGroups.length > 0) {
        html += renderCategoryTable(favGroups, '★ FAVORITES');
    }

    // Render by category
    categories.forEach(cat => {
        const groups = nonFavGroups.filter(g => g.catKey === cat.key);
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
                <th style="width:24px;"></th>
                <th style="text-align:left;">종목</th>
                <th style="width:52px;">W/L</th>
                <th style="width:56px;">예선</th>
                <th style="width:56px;">준결승</th>
                <th style="width:56px;">결승</th>
            </tr></thead>
            <tbody>`;

    groups.forEach(g => {
        const prelim = g.rounds.find(r => r.round_type === 'preliminary');
        const semi = g.rounds.find(r => r.round_type === 'semifinal');
        const fin = g.rounds.find(r => r.round_type === 'final');
        const favKey = currentGender + '|' + g.name;
        const isFav = favs.includes(favKey) || (favs.some(f => !f.includes('|') && f === g.name));
        const starStyle = isFav ? 'color:#e5a100;' : 'color:#ddd;';
        const _gLabel = currentGender === 'M' ? '남' : currentGender === 'F' ? '여' : '혼성';
        const pacingCfg = _pacingMap[g.name + ' (' + _gLabel + ')'] || _pacingMap[g.name];
        const _pacingKey = pacingCfg ? pacingCfg.event_name : g.name;
        const wlCell = pacingCfg ? `<span class="round-btn" style="background:#f0f9ff;color:#1565C0;border:1px solid #90caf9;cursor:pointer;font-size:9px;padding:3px 6px;white-space:nowrap;" onclick="openPacingPopup('${_pacingKey.replace(/'/g, "\\'")}')">Target</span>` : '';

        html += `<tr>
            <td style="cursor:pointer;font-size:16px;${starStyle}" onclick="toggleFavorite('${g.name.replace(/'/g, "\\'")}')" title="즐겨찾기">${isFav ? '★' : '☆'}</td>
            <td class="event-name">${g.name}</td>
            <td>${wlCell}</td>
            <td>${renderViewerBtn(prelim)}</td>
            <td>${renderViewerBtn(semi)}</td>
            <td>${renderViewerBtn(fin)}</td>
        </tr>`;
    });

    html += `</tbody></table></div></div>`;
    return html;
}

/**
 * Viewer flow:
 * - created / heats_generated → "대기" button (disabled)
 * - in_progress (callroom done) → "소집" button (shows callroom info; for judge: links to callroom page)
 * - completed → "결과" button (shows results)
 */
function renderViewerBtn(evt) {
    if (!evt) return '<span class="round-btn btn-disabled">—</span>';

    const isAdmin = currentRole === 'admin';
    const isJudge = currentRole === 'operation' || isAdmin;

    if (evt.round_status === 'completed') {
        // Result button — always active after round ends
        return `<span class="round-btn btn-result" onclick="openResult(${evt.id})" title="결과 확인">결과</span>`;
    }

    if (evt.round_status === 'in_progress') {
        // Callroom complete → show summon status; judges can go to record; anyone can view live
        const compQ = getCompetitionId() ? `&comp=${getCompetitionId()}` : '';
        let btns = `<span class="round-btn btn-live" onclick="openLiveResult(${evt.id})" title="실시간 기록 보기" style="cursor:pointer;background:#fff3e0;color:#e65100;border-color:#ffcc80;">LIVE</span>`;
        if (isJudge) {
            btns += ` <a class="round-btn btn-summon" href="/record.html?event_id=${evt.id}${compQ}" title="기록 입력" style="font-size:10px;">기록</a>`;
        }
        return btns;
    }

    // created or heats_generated — waiting
    if (isJudge) {
        const compQ2 = getCompetitionId() ? `&comp=${getCompetitionId()}` : '';
        return `<a class="round-btn btn-wait" href="/callroom.html?event_id=${evt.id}${compQ2}" title="소집 대기중" style="cursor:pointer;color:#666;">대기</a>`;
    }
    return `<span class="round-btn btn-wait" title="대기중">대기</span>`;
}

// ============================================================
// Result overlay
// ============================================================
// Show landscape overlay on portrait mobile when modal opens
function _showLandscapeHint() {
    const lo = document.getElementById('landscape-overlay');
    if (!lo) return;
    const isPortrait = window.innerHeight > window.innerWidth && window.innerWidth <= 768;
    if (isPortrait) lo.style.display = 'flex';
}
function _hideLandscapeHint() {
    const lo = document.getElementById('landscape-overlay');
    if (lo) lo.style.display = 'none';
}

async function openResult(eventId) {
    const overlay = document.getElementById('result-overlay');
    const panel = document.getElementById('result-panel');
    panel.innerHTML = '<div class="result-panel-header"><h3>결과 불러오는 중...</h3><button class="result-panel-close" onclick="closeResult()">&times;</button></div><div class="result-panel-body" style="text-align:center;padding:40px;">로딩 중...</div>';
    overlay.classList.add('show');
    _showLandscapeHint();
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
    _hideLandscapeHint();
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
    panel.innerHTML = '<div class="result-panel-header"><h3><span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:8px;">● LIVE</span>로딩 중...</h3><button class="result-panel-close" onclick="closeLiveResult()">&times;</button></div><div class="result-panel-body" style="text-align:center;padding:40px;">실시간 기록 불러오는 중...</div>';
    overlay.classList.add('show');
    _showLandscapeHint();
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
            <h3><span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:8px;">● LIVE</span>${evt.name} ${roundL} ${gL}</h3>
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
    _hideLandscapeHint();
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
    
    data.heats.forEach(h => {
        _liveHeatId = h.id; // Track latest heat for SSE
        const windStr = h.wind != null ? `<span style="font-size:12px;color:${h.wind > 2.0 ? 'var(--danger)' : 'var(--text-muted)'};margin-left:8px;">풍속: ${formatWind(h.wind)} m/s</span>` : '';
        html += `<h4 style="margin:12px 0 6px;">${h.heat_name || ('Heat ' + h.heat_number)} ${windStr}</h4>`;
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
                <td style="font-family:monospace;font-weight:600;">${r.status_code ? `<span class="sc-badge">${r.status_code}</span>` : (r.time_seconds != null ? formatTime(r.time_seconds) : '<span style="color:var(--text-muted);">—</span>')}</td>
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
            // Auto-NM: 3 fouls (distance=0) with no valid distance
            const allDists = Object.values(att);
            const foulCount = allDists.filter(d => d === 0).length;
            const valid = allDists.filter(d => d > 0);
            if (!sc && foulCount >= 3 && valid.length === 0) sc = 'NM';
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
                        <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th><th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th><th class="att-col-best" rowspan="2">기록</th></tr>
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
                        distCells += `<td class="${attCls}" style="font-family:monospace;">${hasVal ? (isFoul ? '<span class="foul-mark">X</span>' : (isPass ? '<span class="pass-mark">-</span>' : v.toFixed(2))) : ''}</td>`;
                        let wDisp = '';
                        if (hasVal && !isFoul && !isPass && r.attWind[i] != null) wDisp = formatWind(r.attWind[i]);
                        windCells += `<td class="wind-cell ${attCls}">${wDisp}</td>`;
                    }
                    const bestWindDisp = (r.bestWind != null) ? formatWind(r.bestWind) : '';
                    const bestDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? r.best.toFixed(2) : '—');
                    return `<tr class="field-row1">
                        <td rowspan="2">${r.rank}</td><td rowspan="2">${r.lane_number || '—'}</td>
                        <td style="text-align:left;">${r.name}</td><td><strong>${bib(r.bib_number)}</strong></td>
                        ${distCells}<td rowspan="2" class="best-cell att-col-best">${bestDisp}<div class="best-wind">${bestWindDisp}</div></td>
                    </tr><tr class="field-row2">
                        <td class="team-cell">${r.team || ''}</td><td></td>${windCells}
                    </tr>`;
                }).join('')}</tbody></table>`;
        } else {
            html += `<table class="data-table field-table" style="font-size:12px;">
                <thead><tr><th>순위</th><th>순번</th><th style="text-align:left;">성명</th><th style="text-align:left;">소속</th><th>BIB</th>
                    <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th><th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th><th class="att-col-best">기록</th></tr></thead>
                <tbody>${rows.map(r => {
                    let distCells = '';
                    for (let i = 1; i <= 6; i++) {
                        const attCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even');
                        const v = r.att[i];
                        const hasVal = v != null;
                        const isFoul = hasVal && v === 0;
                        const isPass = hasVal && v < 0;
                        distCells += `<td class="${attCls}" style="font-family:monospace;">${hasVal ? (isFoul ? '<span class="foul-mark">X</span>' : (isPass ? '<span class="pass-mark">-</span>' : v.toFixed(2))) : ''}</td>`;
                    }
                    const bestDisp2 = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? r.best.toFixed(2) : '—');
                    return `<tr>
                        <td>${r.rank}</td><td>${r.lane_number || '—'}</td>
                        <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td><td><strong>${bib(r.bib_number)}</strong></td>
                        ${distCells}<td class="att-col-best" style="font-weight:700;font-family:monospace;color:var(--green);">${bestDisp2}</td>
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
        hts.forEach(h2 => { thead += `<th style="font-size:10px;">${h2.toFixed(2)}</th>`; });
        thead += '<th>최고</th>';
        html += `<table class="data-table" style="font-size:12px;">
            <thead><tr>${thead}</tr></thead>
            <tbody>${rows.map(r => {
                let c = '';
                hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const mark = d[i] === 'PASS' ? '-' : d[i]; const cls = d[i] === 'O' ? 'color:var(--green)' : d[i] === 'X' ? 'color:var(--danger)' : 'color:var(--text-muted)'; m += `<span style="${cls};font-weight:700;">${mark}</span>`; } } c += `<td style="font-size:11px;">${m}</td>`; });
                return `<tr style="${r.best != null ? 'background:#f0fff4;' : ''}"><td>${r.rank}</td><td><strong>${bib(r.bib_number)}</strong></td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>${c}<td style="font-weight:700;">${r.best != null ? r.best.toFixed(2) + 'm' : (r.isNM ? '<span class="nm-mark">NM</span>' : '—')}</td></tr>`;
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
                            <th colspan="${day1Count}" style="background:#e3f2fd;font-size:10px;font-weight:700;color:#1565c0;border-bottom:none;">Day 1</th>
                            <th colspan="${day2Count}" style="background:#fce4ec;font-size:10px;font-weight:700;color:#c62828;border-bottom:none;">Day 2</th>
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
                                const rec = se.unit === 's' ? formatTime(p.raw) : p.raw.toFixed(2);
                                return `<td style="font-size:10px;"><div>${rec}</div><div style="color:var(--primary);font-size:9px;">${p.points}</div></td>`;
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
                <p style="margin-top:6px;font-size:10px;color:var(--text-muted);">💡 실시간 WA 점수 합산 | ${evt.gender === 'M' ? '10종경기' : '7종경기'}</p>`;
        } catch (e) {
            const container = document.getElementById('live-combined-content');
            if (container) container.innerHTML = `<p style="color:var(--danger);">혼성 경기 데이터 로드 실패</p>
                <a href="/results.html?event_id=${evt.id}" class="btn btn-primary btn-sm" style="margin-top:8px;">결과확인 →</a>`;
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
                        <th colspan="${day1Count}" style="background:#e3f2fd;font-size:10px;font-weight:700;color:#1565c0;border-bottom:none;">Day 1</th>
                        <th colspan="${day2Count}" style="background:#fce4ec;font-size:10px;font-weight:700;color:#c62828;border-bottom:none;">Day 2</th>
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
                            const rec = se.unit === 's' ? formatTime(p.raw) : p.raw.toFixed(2);
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
                <div style="font-weight:700;font-size:13px;margin-bottom:6px;">📋 종목별 세부기록</div>
                <div style="margin-bottom:4px;">
                    <div style="font-size:10px;font-weight:600;color:#1565c0;margin-bottom:2px;">Day 1</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">${day1Tabs}</div>
                    <div style="font-size:10px;font-weight:600;color:#c62828;margin-bottom:2px;">Day 2</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;">${day2Tabs}</div>
                </div>
                <div id="cr-sub-detail" style="min-height:60px;"></div>
            </div>`;

        // Store data for sub-event detail rendering
        window._crSubData = { evt, subEvents, subDefs, entries, scores };
    } catch (e) {
        const container = document.getElementById('combined-result-content');
        if (container) container.innerHTML = `<p style="color:var(--danger);">혼성 경기 데이터 로드 실패: ${e.message || e}</p>
            <a href="/results.html?event_id=${evt.id}" class="btn btn-primary btn-sm" style="margin-top:8px;">결과확인 →</a>`;
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
        b.style.background = +b.dataset.order === order ? '#e3f2fd' : '';
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
            // Auto-NM: 3 fouls with no valid distance
            Object.values(athleteMap).forEach(a => {
                if (!a.status_code) {
                    const foulCount = a.attempts.filter(att => att.distance_meters === 0).length;
                    if (foulCount >= 3 && !a.best) a.status_code = 'NM';
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
                    return `<td class="${attCls}" style="font-family:monospace;">${att.distance_meters ? att.distance_meters.toFixed(2) : '—'}</td>`;
                }).join('');
                const bestDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best ? r.best.toFixed(2) + 'm' : '—');
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
            const athRows = Object.values(athleteMap).sort((a, b) => (b.maxCleared || 0) - (a.maxCleared || 0));
            let rk = 1;
            athRows.forEach((r, i) => { r.rank = !r.maxCleared ? '—' : ((i > 0 && athRows[i-1].maxCleared === r.maxCleared) ? athRows[i-1].rank : rk); rk = i + 2; });
            athRows.forEach(r => {
                let sc = scores.find(s => s.event_entry_id === r.event_entry_id && s.sub_event_order === order);
                if (!sc) sc = scores.find(s => s.bib_number === r.bib_number && s.sub_event_order === order);
                r.wa_points = sc ? (sc.wa_points ?? 0) : null;
            });
            const hHdr = heights.map(h => `<th style="font-size:10px;min-width:40px;">${h.toFixed(2)}</th>`).join('');
            html += `<table class="data-table" style="font-size:12px;"><thead><tr>
                <th style="width:35px;">순위</th><th style="width:50px;">BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>
                ${hHdr}<th style="width:55px;">최고</th><th style="width:55px;">WA점수</th>
            </tr></thead><tbody>${athRows.map(r => {
                const hCells = heights.map(h => {
                    const marks = r.attempts[h];
                    if (!marks || marks.length === 0) return '<td style="color:#ccc;">—</td>';
                    const str = marks.join('');
                    const color = str.includes('O') ? '#2e7d32' : '#c62828';
                    return `<td style="font-size:11px;font-weight:600;color:${color};">${str}</td>`;
                }).join('');
                return `<tr style="${r.maxCleared ? 'background:#f0fff4;' : ''}">
                    <td>${r.rank}</td><td><strong>${bib(r.bib_number)}</strong></td>
                    <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team || ''}</td>
                    ${hCells}
                    <td style="font-weight:700;">${r.maxCleared ? r.maxCleared.toFixed(2) + 'm' : '—'}</td>
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
    data.heats.forEach(h => {
        const windStr = h.wind != null ? `<span style="font-size:12px;color:${h.wind > 2.0 ? 'var(--danger)' : 'var(--text-muted)'};margin-left:8px;">풍속: ${formatWind(h.wind)} m/s</span>` : '';
        html += `<h4 style="margin:12px 0 6px;">${h.heat_name || ('Heat ' + h.heat_number)} ${windStr}</h4>`;
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
                <td style="font-family:monospace;font-weight:600;">${r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.time_seconds != null ? formatTime(r.time_seconds) : '<span style="color:var(--text-muted);">—</span>')}</td>
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
            const allDists = Object.values(att);
            const foulCount = allDists.filter(d => d === 0).length;
            const valid = allDists.filter(d => d > 0);
            if (!sc && foulCount >= 3 && valid.length === 0) sc = 'NM';
            const best = valid.length > 0 ? Math.max(...valid) : null;
            let bestWind = null;
            if (best != null) { for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } } }
            return { ...e, att, attWind, best, bestWind, status_code: sc };
        }).sort((a, b) => {
            if (a.status_code && !b.status_code) return 1;
            if (!a.status_code && b.status_code) return -1;
            if (a.best == null) return 1; if (b.best == null) return -1; return b.best - a.best;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.rank = `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>`; return; }
            r.rank = r.best == null ? '—' : ((i > 0 && rows[i - 1].best === r.best && !rows[i - 1].status_code) ? rows[i - 1].rank : rk);
            rk = i + 2;
        });
        const needsWind = requiresWindMeasurement(data.event?.name, 'field_distance');
        if (needsWind) {
            html += `<table class="data-table field-table field-2row-table" style="font-size:12px;">
                <thead>
                    <tr><th rowspan="2">순위</th><th rowspan="2">순번</th><th style="text-align:left;">성명</th><th>배번</th>
                        <th class="att-col-first att-col-odd">1차시기</th><th class="att-col-even">2차시기</th><th class="att-col-odd">3차시기</th><th class="att-col-even">4차시기</th><th class="att-col-odd">5차시기</th><th class="att-col-even">6차시기</th><th class="att-col-best" rowspan="2">기록</th></tr>
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
                        distCells += `<td class="${attCls}" style="font-family:monospace;">${hasVal ? (isFoul ? '<span class="foul-mark">X</span>' : (isPass ? '<span class="pass-mark">-</span>' : v.toFixed(2))) : ''}</td>`;
                        let wDisp = '';
                        if (hasVal && !isFoul && !isPass && r.attWind[i] != null) wDisp = formatWind(r.attWind[i]);
                        windCells += `<td class="wind-cell ${attCls}">${wDisp}</td>`;
                    }
                    const bestWindDisp = (r.bestWind != null) ? formatWind(r.bestWind) : '';
                    const bestDisp = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? r.best.toFixed(2) : '—');
                    return `<tr class="field-row1">
                        <td rowspan="2">${r.rank}</td><td rowspan="2">${r.lane_number || '—'}</td>
                        <td style="text-align:left;">${r.name}</td><td><strong>${bib(r.bib_number)}</strong></td>
                        ${distCells}<td rowspan="2" class="best-cell att-col-best">${bestDisp}<div class="best-wind">${bestWindDisp}</div></td>
                    </tr><tr class="field-row2">
                        <td class="team-cell">${r.team || ''}</td><td></td>${windCells}
                    </tr>`;
                }).join('')}</tbody></table>`;
        } else {
            html += `<table class="data-table field-table" style="font-size:13px;">
                <thead><tr><th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>
                    <th class="att-col-first att-col-odd">1</th><th class="att-col-even">2</th><th class="att-col-odd">3</th><th class="att-col-even">4</th><th class="att-col-odd">5</th><th class="att-col-even">6</th><th class="att-col-best">BEST</th></tr></thead>
                <tbody>${rows.map(r => {
                    let c = '';
                    for (let i = 1; i <= 6; i++) { const attCls = (i === 1 ? 'att-col-first ' : '') + (i % 2 === 1 ? 'att-col-odd' : 'att-col-even'); const v = r.att[i]; c += `<td class="${attCls}" style="font-family:monospace;font-size:11px;">${v != null ? (v === 0 ? '<span class="foul-mark">X</span>' : (v < 0 ? '<span class="pass-mark">-</span>' : v.toFixed(2))) : ''}</td>`; }
                    const bestDisp2 = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : (r.best != null ? r.best.toFixed(2) : '—');
                    return `<tr><td>${r.rank}</td><td>${bib(r.bib_number)}</td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team||''}</td>${c}<td class="att-col-best" style="font-weight:700;">${bestDisp2}</td></tr>`;
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
            let best = null;
            hts.forEach(h2 => { const d = hd[h2]; if (d && Object.values(d).includes('O')) best = h2; });
            return { ...e, hd, best };
        }).sort((a, b) => { if (a.best == null) return 1; if (b.best == null) return -1; return b.best - a.best; });
        let rk = 1;
        rows.forEach((r, i) => { r.rank = r.best == null ? '—' : ((i > 0 && rows[i - 1].best === r.best) ? rows[i - 1].rank : rk); rk = i + 2; });

        let thead = '<th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>';
        hts.forEach(h2 => { thead += `<th style="font-size:10px;">${h2.toFixed(2)}</th>`; });
        thead += '<th>최고</th>';
        html += `<table class="data-table" style="font-size:13px;">
            <thead><tr>${thead}</tr></thead>
            <tbody>${rows.map(r => {
                let c = '';
                hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const mark = d[i] === 'PASS' ? '-' : d[i]; m += mark; } } c += `<td style="font-size:11px;">${m}</td>`; });
                return `<tr><td>${r.rank}</td><td>${bib(r.bib_number)}</td><td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:11px;">${r.team||''}</td>${c}<td style="font-weight:700;">${r.best != null ? r.best.toFixed(2) + 'm' : '—'}</td></tr>`;
            }).join('')}</tbody></table>`;
    });
    return html || '<div style="color:var(--text-muted);">결과 없음</div>';
}

// ============================================================
// Pacing Light Popup (W/L Target)
// ============================================================
const _PACING_COLOR_MAP = {
    green:  { label: 'Green',  hex: '#03C75A', textColor: '#fff' },
    red:    { label: 'Red',    hex: '#FF0000', textColor: '#fff' },
    white:  { label: 'White',  hex: '#E0E0E0', textColor: '#333' },
    blue:   { label: 'Blue',   hex: '#1565C0', textColor: '#fff' },
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
        html += `<div style="background:#fffde7;border:1px solid #fff9c4;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;color:#f57f17;">📢 ${cfg.notice}</div>`;
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
                        <td style="padding:3px 8px;text-align:right;border-bottom:1px solid #f0f0f0;font-family:monospace;">${_fmtPacingTime(sp.lap)}</td>
                        <td style="padding:3px 8px;text-align:right;border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600;">${_fmtPacingTime(sp.cum)}</td>
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
    _showLandscapeHint();
}

function closePacingPopup() {
    _hideLandscapeHint();
    document.getElementById('result-overlay').classList.remove('show');
}
