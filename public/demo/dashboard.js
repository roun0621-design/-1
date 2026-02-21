/**
 * PACE RISE : SCOPE — dashboard.js v3
 * Unified dashboard: default = read-only viewer, admin mode = full access
 */

let allEvents = [];
let currentGender = 'M';
let callroomCompletedIds = new Set();
let isAdminMode = false;

document.addEventListener('DOMContentLoaded', async () => {
    // Check if admin mode is saved in session
    const savedAdmin = sessionStorage.getItem('pace_admin');
    if (savedAdmin === 'true') {
        isAdminMode = true;
    }
    updateModeUI();

    allEvents = await API.getAllEvents();
    // Load callroom completion status
    try {
        const crStatus = await API.getCallroomStatus();
        callroomCompletedIds = new Set(crStatus.completed_event_ids || []);
    } catch (e) {}
    setupGenderTabs();
    renderMatrix();
    renderAuditLog();

    // Admin key enter support
    const keyInput = document.getElementById('admin-key-input');
    if (keyInput) {
        keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') verifyAdminKey(); });
    }

    // SSE listeners for real-time dashboard updates
    onSSE('callroom_complete', async (data) => {
        callroomCompletedIds.add(data.event_id);
        allEvents = await API.getAllEvents();
        renderMatrix();
    });
    onSSE('event_completed', async () => {
        allEvents = await API.getAllEvents();
        renderMatrix();
    });
    onSSE('result_update', async () => {
        allEvents = await API.getAllEvents();
        renderMatrix();
    });
});

// ============================================================
// Admin Mode Toggle
// ============================================================
function toggleAdminMode() {
    if (isAdminMode) {
        // Logout from admin mode
        isAdminMode = false;
        sessionStorage.removeItem('pace_admin');
        updateModeUI();
        renderMatrix();
    } else {
        // Show login modal
        document.getElementById('admin-login-overlay').style.display = 'flex';
        document.getElementById('admin-key-input').value = '';
        document.getElementById('admin-login-error').style.display = 'none';
        setTimeout(() => document.getElementById('admin-key-input').focus(), 100);
    }
}

async function verifyAdminKey() {
    const key = document.getElementById('admin-key-input').value;
    try {
        await API.verifyAdmin(key);
        isAdminMode = true;
        sessionStorage.setItem('pace_admin', 'true');
        document.getElementById('admin-login-overlay').style.display = 'none';
        updateModeUI();
        renderMatrix();
    } catch (e) {
        const err = document.getElementById('admin-login-error');
        err.textContent = '관리자 키가 올바르지 않습니다.';
        err.style.display = 'block';
    }
}

function closeAdminLogin() {
    document.getElementById('admin-login-overlay').style.display = 'none';
}

function updateModeUI() {
    const modeLabel = document.getElementById('mode-label');
    const toggleBtn = document.getElementById('admin-toggle-btn');
    const modeBar = document.getElementById('admin-mode-bar');

    if (isAdminMode) {
        renderPageNav('dashboard');
        modeLabel.textContent = '관리자 모드';
        toggleBtn.textContent = '뷰어 모드로 전환';
        toggleBtn.className = 'btn btn-sm btn-danger';
        modeBar.classList.add('admin-active');
    } else {
        // Viewer mode: hide navigation
        const nav = document.getElementById('page-nav');
        if (nav) nav.innerHTML = '';
        modeLabel.textContent = '실시간 뷰어 모드';
        toggleBtn.textContent = '관리자 모드';
        toggleBtn.className = 'btn btn-sm btn-outline';
        modeBar.classList.remove('admin-active');
    }
}

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
        });
    });
}

// ============================================================
// Matrix
// ============================================================
function renderMatrix() {
    const container = document.getElementById('matrix-container');
    const events = allEvents.filter(e => e.gender === currentGender && !e.parent_event_id);

    const categories = [
        { key: 'track', label: 'TRACK' },
        { key: 'field_distance', label: 'FIELD \u2014 \uac70\ub9ac' },
        { key: 'field_height', label: 'FIELD \u2014 \ub192\uc774' },
        { key: 'combined', label: 'COMBINED \u2014 \ud63c\uc131' },
    ];

    const eventGroups = {};
    events.forEach(e => {
        const gKey = e.name + '|' + e.category;
        if (!eventGroups[gKey]) {
            eventGroups[gKey] = { name: e.name, category: e.category, rounds: [] };
        }
        eventGroups[gKey].rounds.push(e);
    });

    let html = '';
    categories.forEach(cat => {
        const groups = Object.values(eventGroups).filter(g => g.category === cat.key);
        if (groups.length === 0) return;

        html += `<div class="matrix-section">
            <div class="matrix-section-title">${cat.label}</div>
            <table class="matrix-table">
                <thead><tr>
                    <th style="width:200px;">\uc885\ubaa9</th>
                    <th>\uc608\uc120</th>
                    <th>\uc900\uacb0\uc2b9</th>
                    <th>\uacb0\uc2b9</th>
                </tr></thead>
                <tbody>`;

        groups.forEach(g => {
            const prelim = g.rounds.find(r => r.round_type === 'preliminary');
            const semi = g.rounds.find(r => r.round_type === 'semifinal');
            const final_ = g.rounds.find(r => r.round_type === 'final');

            html += `<tr>
                <td>${g.name}</td>
                <td class="round-cell">${renderRoundButtons(prelim)}</td>
                <td class="round-cell">${renderRoundButtons(semi)}</td>
                <td class="round-cell">${renderRoundButtons(final_)}</td>
            </tr>`;
        });

        html += `</tbody></table></div>`;
    });

    if (!html) {
        html = '<div class="empty-state">\ud574\ub2f9 \uc131\ubcc4\uc758 \uc885\ubaa9\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.</div>';
    }

    container.innerHTML = html;
}

function getRoundStatusClass(event) {
    if (!event) return 'status-none';
    const st = event.round_status;
    if (st === 'completed') return 'status-done';
    if (st === 'heats_generated' || st === 'in_progress') return 'status-active';
    return 'status-created';
}

function renderRoundButtons(event) {
    if (!event) return '<span class="round-btn status-none">\u2014</span>';
    const cls = getRoundStatusClass(event);
    const roundLabel = fmtRound(event.round_type);
    const crDone = callroomCompletedIds.has(event.id);

    if (isAdminMode) {
        // ADMIN MODE: full links to callroom, record, results pages
        let btns = '';
        if (crDone) {
            btns += `<a href="/demo/callroom.html?event_id=${event.id}" class="round-btn status-done" title="${roundLabel} \uc18c\uc9d1 \uc644\ub8cc">\uc18c\uc9d1 \u2713</a>`;
        } else {
            btns += `<a href="/demo/callroom.html?event_id=${event.id}" class="round-btn ${cls}" title="${roundLabel} \uc18c\uc9d1">\uc18c\uc9d1</a>`;
        }
        const cat = event.category;
        if (cat === 'combined') {
            btns += `<a href="/demo/record.html?event_id=${event.id}&tab=combined" class="round-btn ${cls}" title="${roundLabel} \uae30\ub85d">\uae30\ub85d</a>`;
        } else {
            const tab = cat === 'track' ? 'track' : 'field';
            btns += `<a href="/demo/record.html?event_id=${event.id}&tab=${tab}" class="round-btn ${cls}" title="${roundLabel} \uae30\ub85d">\uae30\ub85d</a>`;
        }
        btns += `<a href="/demo/results.html?event_id=${event.id}" class="round-btn ${cls}" title="${roundLabel} \uacb0\uacfc">\uacb0\uacfc</a>`;
        return btns;
    } else {
        // VIEWER MODE: read-only, click opens in-place result popup
        let status = '';
        if (event.round_status === 'completed') {
            status = '\uc644\ub8cc';
        } else if (crDone) {
            status = '\uc18c\uc9d1\uc644\ub8cc';
        } else if (event.round_status === 'in_progress') {
            status = '\uc9c4\ud589\uc911';
        } else if (event.round_status === 'heats_generated') {
            status = '\ub300\uae30';
        } else {
            status = '\uc900\ube44';
        }

        const clickable = (event.round_status === 'completed' || event.round_status === 'in_progress');
        if (clickable) {
            return `<a class="round-btn ${cls}" href="javascript:void(0)" onclick="openResultInPlace(${event.id})" title="${roundLabel} \uacb0\uacfc \ubcf4\uae30">${status}</a>`;
        } else {
            return `<span class="round-btn ${cls}">${status}</span>`;
        }
    }
}

// ============================================================
// In-place Result View (viewer mode)
// ============================================================
async function openResultInPlace(eventId) {
    const overlay = document.getElementById('result-detail-overlay');
    const title = document.getElementById('result-modal-title');
    const content = document.getElementById('result-modal-content');

    overlay.style.display = 'flex';
    content.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div><p>\ub370\uc774\ud130 \ubd88\ub7ec\uc624\ub294 \uc911...</p></div>';

    try {
        const evt = await API.getEvent(eventId);
        const gL = { M: '\ub0a8\uc790', F: '\uc5ec\uc790', X: '\ud63c\uc131' }[evt.gender] || '';
        title.textContent = `${evt.name} ${fmtRound(evt.round_type)} ${gL}`;

        const fullData = await API.getFullResults(eventId);
        let html = '';

        fullData.heats.forEach(heat => {
            if (fullData.heats.length > 1) {
                html += `<h4 style="margin:12px 0 8px;font-size:13px;">${heat.heat_number}\uc870</h4>`;
            }

            if (evt.category === 'track') {
                html += renderViewerTrackResults(heat, evt);
            } else if (evt.category === 'field_distance') {
                html += renderViewerFieldDistanceResults(heat);
            } else if (evt.category === 'field_height') {
                html += renderViewerFieldHeightResults(heat);
            } else {
                html += '<div class="empty-state">\ud63c\uc131 \uacbd\uae30 \uacb0\uacfc\ub294 \uacb0\uacfc\ud655\uc778 \ud398\uc774\uc9c0\uc5d0\uc11c \ud655\uc778\ud558\uc138\uc694</div>';
            }
        });

        if (!html) html = '<div class="empty-state">\uacb0\uacfc \ub370\uc774\ud130\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.</div>';
        content.innerHTML = html;
    } catch (err) {
        content.innerHTML = `<div class="empty-state">\ub370\uc774\ud130\ub97c \ubd88\ub7ec\uc62c \uc218 \uc5c6\uc2b5\ub2c8\ub2e4.</div>`;
    }
}

function closeResultModal() {
    document.getElementById('result-detail-overlay').style.display = 'none';
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
    const overlay = document.getElementById('result-detail-overlay');
    if (e.target === overlay) overlay.style.display = 'none';
});

function renderViewerTrackResults(heat, evt) {
    const results = heat.results || [];
    const entries = heat.entries || [];

    const rows = entries.map(e => {
        const r = results.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null };
    });
    rows.sort((a, b) => {
        if (a.time_seconds == null && b.time_seconds == null) return 0;
        if (a.time_seconds == null) return 1;
        if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    let rk = 1;
    rows.forEach((r, i) => {
        if (r.time_seconds == null) r.rank = '';
        else { r.rank = (i > 0 && rows[i - 1].time_seconds === r.time_seconds) ? rows[i - 1].rank : rk; rk = i + 2; }
    });

    return `<table class="data-table" style="font-size:12px;">
        <thead><tr><th>RANK</th><th>LANE</th><th>BIB</th><th>\uc120\uc218\uba85</th><th>\uc18c\uc18d</th><th>\uae30\ub85d</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
            <td>${r.rank || '\u2014'}</td>
            <td>${r.lane_number || '\u2014'}</td>
            <td><strong>${r.bib_number}</strong></td>
            <td style="text-align:left;">${r.name}</td>
            <td style="text-align:left;font-size:11px;">${r.team || ''}</td>
            <td>${r.time_seconds != null ? formatTime(r.time_seconds) : '\u2014'}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function renderViewerFieldDistanceResults(heat) {
    const results = heat.results || [];
    const entries = heat.entries || [];

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

    const sorted = [...rows].sort((a, b) => {
        if (a.rank != null && b.rank != null) return a.rank - b.rank;
        if (a.rank != null) return -1; return 1;
    });

    return `<table class="data-table" style="font-size:12px;">
        <thead><tr><th>RANK</th><th>\uc120\uc218</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>BEST</th></tr></thead>
        <tbody>${sorted.map(r => {
            let cells = '';
            for (let i = 1; i <= 6; i++) {
                const v = r.attempts[i];
                if (v !== undefined && v !== null) {
                    cells += v === 0 ? '<td><span style="color:var(--danger);">X</span></td>' : `<td>${v.toFixed(2)}</td>`;
                } else { cells += '<td>\u2014</td>'; }
            }
            return `<tr>
                <td>${r.rank || '\u2014'}</td>
                <td style="text-align:left;"><strong>${r.name}</strong> #${r.bib_number}</td>
                ${cells}
                <td><strong>${r.best != null ? r.best.toFixed(2) : '\u2014'}</strong></td>
            </tr>`;
        }).join('')}</tbody>
    </table>`;
}

function renderViewerFieldHeightResults(heat) {
    const attempts = heat.height_attempts || [];
    const entries = heat.entries || [];
    const heights = [...new Set(attempts.map(a => a.bar_height))].sort((a, b) => a - b);

    const rows = entries.map(e => {
        const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {};
        ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
        let best = null;
        heights.forEach(h => { const d = hd[h]; if (d && Object.values(d).includes('O')) best = h; });
        return { ...e, heightData: hd, bestHeight: best };
    });

    const rankedH = rows.filter(r => r.bestHeight != null).sort((a, b) => b.bestHeight - a.bestHeight);
    let rkH = 1;
    rankedH.forEach((r, i) => { r.rank = (i > 0 && rankedH[i - 1].bestHeight === r.bestHeight) ? rankedH[i - 1].rank : rkH; rkH = i + 2; });
    rows.forEach(r => {
        if (r.bestHeight == null) r.rank = null;
        else { const f = rankedH.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; }
    });

    let hdr = '<th>RANK</th><th>\uc120\uc218</th>';
    heights.forEach(h => { hdr += `<th style="font-size:10px;">${h.toFixed(2)}m</th>`; });
    hdr += '<th>\ucd5c\uace0</th>';

    return `<table class="data-table" style="font-size:12px;">
        <thead><tr>${hdr}</tr></thead>
        <tbody>${rows.map(r => {
            let cells = '';
            heights.forEach(h => {
                const hd = r.heightData[h] || {};
                let marks = '';
                for (let i = 1; i <= 3; i++) { const m = hd[i]; if (m) marks += `<span class="height-mark mark-${m}">${m}</span>`; }
                cells += `<td style="font-size:10px;">${marks}</td>`;
            });
            return `<tr>
                <td>${r.rank || '\u2014'}</td>
                <td style="text-align:left;"><strong>${r.name}</strong> #${r.bib_number}</td>
                ${cells}
                <td><strong>${r.bestHeight != null ? r.bestHeight.toFixed(2) + 'm' : '\u2014'}</strong></td>
            </tr>`;
        }).join('')}</tbody>
    </table>`;
}
