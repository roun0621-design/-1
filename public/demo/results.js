/**
 * PACE RISE : SCOPE — results.js v6
 * Side-by-side 남자부/여자부 results matrix
 * Added: all-groups unified download, SSE real-time, improved UI
 */

let allEvents = [];
let rSelectedEvent = null;
let rSelectedHeatId = null;

document.addEventListener('DOMContentLoaded', async () => {
    renderPageNav('results');
    allEvents = await API.getAllEvents();
    renderResultsMatrix();
    renderAuditLog();

    // If event_id in URL, auto-open
    const urlEventId = getParam('event_id');
    if (urlEventId) {
        const evt = allEvents.find(e => e.id === +urlEventId);
        if (evt) openResultDetail(evt.id);
    }
});

// ============================================================
// Side-by-side Matrix
// ============================================================
function renderResultsMatrix() {
    const container = document.getElementById('results-matrix-container');

    // Get all non-sub-events
    const maleEvents = allEvents.filter(e => e.gender === 'M' && !e.parent_event_id);
    const femaleEvents = allEvents.filter(e => e.gender === 'F' && !e.parent_event_id);

    const categories = [
        { key: 'track', label: 'TRACK' },
        { key: 'field_distance', label: 'FIELD — 거리' },
        { key: 'field_height', label: 'FIELD — 높이' },
        { key: 'combined', label: 'COMBINED' },
    ];

    // Group events by name for each gender
    function groupEvents(events) {
        const groups = {};
        events.forEach(e => {
            const gKey = e.name;
            if (!groups[gKey]) groups[gKey] = { name: e.name, category: e.category, rounds: [] };
            groups[gKey].rounds.push(e);
        });
        return groups;
    }

    const maleGroups = groupEvents(maleEvents);
    const femaleGroups = groupEvents(femaleEvents);

    let html = '';
    categories.forEach(cat => {
        const mGroups = Object.values(maleGroups).filter(g => g.category === cat.key);
        const fGroups = Object.values(femaleGroups).filter(g => g.category === cat.key);
        // Merge event names from both genders
        const allNames = new Set();
        mGroups.forEach(g => allNames.add(g.name));
        fGroups.forEach(g => allNames.add(g.name));
        if (allNames.size === 0) return;

        html += `<div class="matrix-section">
            <div class="matrix-section-title">${cat.label}</div>
            <table class="matrix-table results-unified-table">
                <thead>
                    <tr class="results-gender-header">
                        <th rowspan="2" style="width:140px;">종목</th>
                        <th colspan="3" class="gender-header-male">남자부</th>
                        <th class="gender-divider" rowspan="2"></th>
                        <th colspan="3" class="gender-header-female">여자부</th>
                    </tr>
                    <tr class="results-round-header">
                        <th class="round-col-male">예선</th>
                        <th class="round-col-male">준결승</th>
                        <th class="round-col-male">결승</th>
                        <th class="round-col-female">예선</th>
                        <th class="round-col-female">준결승</th>
                        <th class="round-col-female">결승</th>
                    </tr>
                </thead>
                <tbody>`;

        Array.from(allNames).forEach(name => {
            const mg = mGroups.find(g => g.name === name);
            const fg = fGroups.find(g => g.name === name);

            const mPrelim = mg ? mg.rounds.find(r => r.round_type === 'preliminary') : null;
            const mSemi = mg ? mg.rounds.find(r => r.round_type === 'semifinal') : null;
            const mFinal = mg ? mg.rounds.find(r => r.round_type === 'final') : null;
            const fPrelim = fg ? fg.rounds.find(r => r.round_type === 'preliminary') : null;
            const fSemi = fg ? fg.rounds.find(r => r.round_type === 'semifinal') : null;
            const fFinal = fg ? fg.rounds.find(r => r.round_type === 'final') : null;

            html += `<tr>
                <td class="event-name-cell">${name}</td>
                <td class="round-cell">${renderResultBtn(mPrelim, 'male')}</td>
                <td class="round-cell">${renderResultBtn(mSemi, 'male')}</td>
                <td class="round-cell">${renderResultBtn(mFinal, 'male')}</td>
                <td class="gender-divider-cell"></td>
                <td class="round-cell">${renderResultBtn(fPrelim, 'female')}</td>
                <td class="round-cell">${renderResultBtn(fSemi, 'female')}</td>
                <td class="round-cell">${renderResultBtn(fFinal, 'female')}</td>
            </tr>`;
        });

        html += `</tbody></table></div>`;
    });

    if (!html) html = '<div class="empty-state">종목이 없습니다.</div>';
    container.innerHTML = html;
}

function renderResultBtn(evt, genderClass) {
    if (!evt) return '<span class="round-btn status-none">—</span>';
    const hasData = evt.round_status === 'completed' || evt.round_status === 'in_progress' || evt.round_status === 'heats_generated';
    if (!hasData) return '<span class="round-btn status-none">—</span>';
    const statusCls = getResultStatusClass(evt);
    const genderCls = genderClass === 'male' ? 'result-btn-male' : 'result-btn-female';
    const roundLabel = fmtRound(evt.round_type);
    return `<a class="round-btn ${statusCls} ${genderCls}" href="javascript:void(0)" onclick="openResultDetail(${evt.id})" title="${roundLabel} 결과">${roundLabel} 결과</a>`;
}

// ============================================================
// All-Groups Unified Download
// ============================================================
async function downloadAllGroups(format) {
    if (!rSelectedEvent) return;
    try {
        const data = await API.getFullResults(rSelectedEvent.id);
        if (!data || !data.heats || data.heats.length === 0) { alert('데이터가 없습니다.'); return; }

        const evt = data.event;
        const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';

        if (format === 'excel') {
            const wb = XLSX.utils.book_new();
            for (const heat of data.heats) {
                const sheetName = `${heat.heat_number}조`;
                const rows = buildHeatRows(evt, heat);
                const ws = XLSX.utils.aoa_to_sheet(rows);
                XLSX.utils.book_append_sheet(wb, ws, sheetName);
            }
            XLSX.writeFile(wb, `${evt.name}_${gL}_${fmtRound(evt.round_type)}_전체조.xlsx`);
        } else if (format === 'pdf') {
            // Build a unified HTML table for all heats, then print
            let allHtml = `<div style="padding:20px;font-family:sans-serif;">`;
            allHtml += `<h2 style="text-align:center;">${evt.name} ${gL} ${fmtRound(evt.round_type)} 결과 (전체 조)</h2>`;
            allHtml += `<p style="text-align:center;font-size:12px;color:#666;">2026 Pace Rise Invitational — ${new Date().toLocaleDateString('ko-KR')}</p>`;
            for (const heat of data.heats) {
                allHtml += `<h3 style="margin-top:24px;">${heat.heat_number}조</h3>`;
                allHtml += buildHeatHtmlTable(evt, heat);
            }
            allHtml += `</div>`;
            const w = window.open('', '_blank');
            w.document.write(`<html><head><title>전체 조 결과</title></head><body>${allHtml}<script>window.onload=function(){window.print();}<\/script></body></html>`);
            w.document.close();
        }
    } catch (e) { console.error(e); alert('다운로드 실패'); }
}

function buildHeatRows(evt, heat) {
    const cat = evt.category;
    if (cat === 'track') {
        const header = ['순위', '레인', 'BIB', '선수명', '소속', '기록'];
        const rows = heat.entries.map(e => {
            const r = (heat.results || []).find(r => r.event_entry_id === e.event_entry_id);
            return { ...e, time_seconds: r ? r.time_seconds : null };
        }).sort((a, b) => {
            if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
            return a.time_seconds - b.time_seconds;
        });
        let rk = 1;
        rows.forEach((r, i) => { r.rank = r.time_seconds == null ? '' : ((i > 0 && rows[i-1].time_seconds === r.time_seconds) ? rows[i-1].rank : rk); rk = i + 2; });
        return [header, ...rows.map(r => [r.rank, r.lane_number || '', r.bib_number, r.name, r.team || '', r.time_seconds != null ? formatTime(r.time_seconds) : ''])];
    } else if (cat === 'field_distance') {
        const header = ['순위', 'BIB', '선수명', '소속', '1', '2', '3', '4', '5', '6', 'BEST'];
        const rows = heat.entries.map(e => {
            const er = (heat.results || []).filter(r => r.event_entry_id === e.event_entry_id);
            const att = {}; er.forEach(r => { if (r.attempt_number) att[r.attempt_number] = r.distance_meters; });
            const valid = Object.values(att).filter(d => d > 0);
            return { ...e, att, best: valid.length > 0 ? Math.max(...valid) : null };
        }).sort((a, b) => { if (a.best == null) return 1; if (b.best == null) return -1; return b.best - a.best; });
        let rk = 1;
        rows.forEach((r, i) => { r.rank = r.best == null ? '' : ((i > 0 && rows[i-1].best === r.best) ? rows[i-1].rank : rk); rk = i + 2; });
        return [header, ...rows.map(r => {
            const cells = [r.rank, r.bib_number, r.name, r.team || ''];
            for (let i = 1; i <= 6; i++) { const v = r.att[i]; cells.push(v != null ? (v === 0 ? 'X' : v.toFixed(2)) : ''); }
            cells.push(r.best != null ? r.best.toFixed(2) : '');
            return cells;
        })];
    } else {
        return [['순위', 'BIB', '선수명', '소속']];
    }
}

function buildHeatHtmlTable(evt, heat) {
    const rows = buildHeatRows(evt, heat);
    let html = '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%;font-size:12px;">';
    rows.forEach((row, i) => {
        html += '<tr>';
        row.forEach(cell => { html += i === 0 ? `<th style="background:#f0f0f0;padding:4px 8px;">${cell}</th>` : `<td style="padding:4px 8px;">${cell}</td>`; });
        html += '</tr>';
    });
    html += '</table>';
    return html;
}

function getResultStatusClass(evt) {
    if (!evt) return 'status-none';
    const st = evt.round_status;
    if (st === 'completed') return 'status-done';
    if (st === 'heats_generated' || st === 'in_progress') return 'status-active';
    return 'status-created';
}

// ============================================================
// Result Detail Overlay
// ============================================================
async function openResultDetail(eventId) {
    const evt = allEvents.find(e => e.id === eventId);
    if (!evt) return;
    rSelectedEvent = evt;

    const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
    document.getElementById('result-detail-title').textContent = `${evt.name} ${gL} ${fmtRound(evt.round_type)} 결과`;
    setParams({ event_id: eventId });

    const heats = await API.getHeats(eventId);
    if (heats.length > 0) {
        rSelectedHeatId = heats[0].id;

        // Add heat tabs if multiple
        let heatTabsHtml = '';
        if (heats.length > 1) {
            heatTabsHtml = `<div class="heat-tabs" style="margin-bottom:10px;">${heats.map((h, i) =>
                `<button class="heat-tab ${i === 0 ? 'active' : ''}" onclick="switchResultHeat(${h.id}, this)">${h.heat_number}조</button>`
            ).join('')}</div>`;
        }

        const contentEl = document.getElementById('result-detail-content');
        contentEl.innerHTML = heatTabsHtml + `
            <div id="results-content" class="results-content">
                <div id="results-header-area" class="results-header-area"></div>
                <table class="data-table" id="results-table">
                    <thead id="results-thead"></thead>
                    <tbody id="results-tbody"></tbody>
                </table>
            </div>`;

        await loadResultsData();
    }

    document.getElementById('result-detail-overlay').style.display = 'flex';

    // Check if event has multiple heats for all-groups download
    if (heats.length > 1) {
        document.getElementById('all-groups-download-area').style.display = 'flex';
    } else {
        document.getElementById('all-groups-download-area').style.display = 'none';
    }
}

function closeResultDetail() {
    document.getElementById('result-detail-overlay').style.display = 'none';
    setParams({ event_id: null });
}

async function switchResultHeat(heatId, btn) {
    rSelectedHeatId = heatId;
    document.querySelectorAll('.result-detail-content .heat-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    await loadResultsData();
}

// ============================================================
// Load & Render Results Data
// ============================================================
async function loadResultsData() {
    if (!rSelectedHeatId || !rSelectedEvent) return;
    const entries = await API.getHeatEntries(rSelectedHeatId);
    const cat = rSelectedEvent.category;
    const gL = { M: '남자', F: '여자', X: '혼성' }[rSelectedEvent.gender] || '';

    document.getElementById('results-header-area').innerHTML = `<h2>${rSelectedEvent.name} ${gL}</h2><p>2026 Pace Rise Invitational — ${new Date().toLocaleDateString('ko-KR')}</p>`;

    if (cat === 'track') await renderTrackResults(entries);
    else if (cat === 'field_distance') await renderFieldDistanceResults(entries);
    else if (cat === 'field_height') await renderFieldHeightResults(entries);
    else if (cat === 'combined') await renderCombinedResults();
    else {
        document.getElementById('results-thead').innerHTML = '';
        document.getElementById('results-tbody').innerHTML = '<tr><td class="empty-state">데이터 없음</td></tr>';
    }
}

// ============================================================
// Track Results
// ============================================================
async function renderTrackResults(entries) {
    const results = await API.getResults(rSelectedHeatId);
    document.getElementById('results-thead').innerHTML = '<tr><th>RANK</th><th>LANE</th><th>BIB</th><th>선수명</th><th>소속</th><th>기록</th></tr>';
    const rows = entries.map(e => {
        const r = results.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null };
    }).sort((a, b) => {
        if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    let rk = 1;
    rows.forEach((r, i) => { r.rank = r.time_seconds == null ? '—' : ((i > 0 && rows[i-1].time_seconds === r.time_seconds) ? rows[i-1].rank : rk); rk = i + 2; });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = getMedal(r.rank);
        return `<tr>
            <td>${medal}</td><td>${r.lane_number || '—'}</td><td><strong>${r.bib_number}</strong></td>
            <td style="text-align:left;">${r.name}</td><td style="font-size:12px;">${r.team || ''}</td>
            <td style="font-family:var(--font-mono);font-weight:600;">${r.time_seconds != null ? formatTime(r.time_seconds) : '—'}</td>
        </tr>`;
    }).join('');
}

// ============================================================
// Field Distance Results
// ============================================================
async function renderFieldDistanceResults(entries) {
    const results = await API.getResults(rSelectedHeatId);
    document.getElementById('results-thead').innerHTML = '<tr><th>RANK</th><th>BIB</th><th>선수명</th><th>소속</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>BEST</th></tr>';
    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {}; er.forEach(r => { if (r.attempt_number) att[r.attempt_number] = r.distance_meters; });
        const valid = Object.values(att).filter(d => d > 0);
        return { ...e, att, best: valid.length > 0 ? Math.max(...valid) : null };
    }).sort((a, b) => { if (a.best == null) return 1; if (b.best == null) return -1; return b.best - a.best; });
    let rk = 1;
    rows.forEach((r, i) => { r.rank = r.best == null ? '—' : ((i > 0 && rows[i-1].best === r.best) ? rows[i-1].rank : rk); rk = i + 2; });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = getMedal(r.rank);
        let c = '';
        for (let i = 1; i <= 6; i++) { const v = r.att[i]; c += `<td style="font-family:var(--font-mono);font-size:12px;">${v != null ? (v === 0 ? '<span class="foul-mark">X</span>' : v.toFixed(2)) : ''}</td>`; }
        return `<tr><td>${medal}</td><td><strong>${r.bib_number}</strong></td><td style="text-align:left;">${r.name}</td><td style="font-size:12px;">${r.team || ''}</td>${c}<td style="font-weight:700;font-family:var(--font-mono);color:var(--green);">${r.best != null ? r.best.toFixed(2) : '—'}</td></tr>`;
    }).join('');
}

// ============================================================
// Field Height Results
// ============================================================
async function renderFieldHeightResults(entries) {
    const ha = await API.getHeightAttempts(rSelectedHeatId);
    const hts = [...new Set(ha.map(a => a.bar_height))].sort((a, b) => a - b);
    let h = '<tr><th>RANK</th><th>BIB</th><th>선수명</th><th>소속</th>';
    hts.forEach(h2 => { h += `<th style="font-size:10px;">${h2.toFixed(2)}</th>`; });
    h += '<th>최고</th></tr>';
    document.getElementById('results-thead').innerHTML = h;
    const rows = entries.map(e => {
        const ea = ha.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {}; ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
        let best = null; hts.forEach(h2 => { const d = hd[h2]; if (d && Object.values(d).includes('O')) best = h2; });
        return { ...e, hd, best };
    }).sort((a, b) => { if (a.best == null) return 1; if (b.best == null) return -1; return b.best - a.best; });
    let rk = 1;
    rows.forEach((r, i) => { r.rank = r.best == null ? '—' : ((i > 0 && rows[i-1].best === r.best) ? rows[i-1].rank : rk); rk = i + 2; });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = getMedal(r.rank);
        let c = ''; hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const cls = d[i] === 'O' ? 'mark-O' : d[i] === 'X' ? 'mark-X' : 'mark-PASS'; m += `<span class="height-mark ${cls}">${d[i]}</span>`; } } c += `<td style="font-size:11px;">${m}</td>`; });
        return `<tr><td>${medal}</td><td><strong>${r.bib_number}</strong></td><td style="text-align:left;">${r.name}</td><td style="font-size:12px;">${r.team || ''}</td>${c}<td style="font-weight:700;">${r.best != null ? r.best.toFixed(2) + 'm' : '—'}</td></tr>`;
    }).join('');
}

// ============================================================
// Combined Results
// ============================================================
async function renderCombinedResults() {
    const evt = rSelectedEvent;
    await API.syncCombinedScores(evt.id);
    const scores = await API.getCombinedScores(evt.id);
    const subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
    const allEntries = await API.getEventEntries(evt.id);
    for (const sc of scores) {
        if (sc.raw_record > 0) {
            const def = subDefs.find(d => d.order === sc.sub_event_order);
            if (def && calcWAPoints(def.key, sc.raw_record) !== sc.wa_points) {
                await API.saveCombinedScore({ event_entry_id: sc.event_entry_id, sub_event_name: sc.sub_event_name, sub_event_order: sc.sub_event_order, raw_record: sc.raw_record, wa_points: calcWAPoints(def.key, sc.raw_record) });
            }
        }
    }
    const fresh = await API.getCombinedScores(evt.id);
    let hdr = '<tr><th>RANK</th><th>BIB</th><th>선수명</th>';
    subDefs.forEach(se => { hdr += `<th style="font-size:9px;padding:3px 2px;writing-mode:vertical-lr;max-width:26px;">${se.name}</th>`; });
    hdr += '<th>총점</th></tr>';
    document.getElementById('results-thead').innerHTML = hdr;
    const rows = allEntries.map(e => {
        let t = 0; const pts = {}, recs = {};
        subDefs.forEach(se => { const sc = fresh.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order); pts[se.order] = sc ? sc.wa_points : 0; recs[se.order] = sc ? sc.raw_record : null; t += pts[se.order]; });
        return { ...e, pts, recs, total: t };
    }).sort((a, b) => b.total - a.total);
    let rk = 1; rows.forEach((r, i) => { r.rank = (i > 0 && rows[i-1].total === r.total) ? rows[i-1].rank : rk; rk = i + 2; });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = getMedal(r.rank);
        let c = ''; subDefs.forEach(se => { const rec = r.recs[se.order], p = r.pts[se.order]; let d = '—'; if (rec && rec > 0) { const rs = se.unit === 's' ? formatTime(rec) : rec.toFixed(2) + 'm'; d = `<div style="font-size:10px;">${rs}</div><div style="font-size:10px;color:var(--green);font-weight:700;">${p}</div>`; } c += `<td style="padding:2px 3px;line-height:1.2;">${d}</td>`; });
        return `<tr><td>${medal}</td><td><strong>${r.bib_number}</strong></td><td style="text-align:left;">${r.name}</td>${c}<td><span class="combined-total-points">${r.total > 0 ? r.total : '—'}</span></td></tr>`;
    }).join('');
}

// ============================================================
// Helpers
// ============================================================
function getMedal(rank) {
    if (rank === 1) return '<span class="medal gold">1</span>';
    if (rank === 2) return '<span class="medal silver">2</span>';
    if (rank === 3) return '<span class="medal bronze">3</span>';
    return rank || '—';
}

// ============================================================
// Export
// ============================================================
function exportExcel() {
    const t = document.getElementById('results-table');
    if (!t) return;
    const wb = XLSX.utils.table_to_book(t, { sheet: 'Results' });
    XLSX.writeFile(wb, `${rSelectedEvent ? rSelectedEvent.name : 'results'}_results.xlsx`);
}
async function exportPNG() {
    const el = document.getElementById('results-content');
    if (!el) return;
    try { const c = await html2canvas(el, { scale: 2, backgroundColor: '#fff' }); const a = document.createElement('a'); a.download = `${rSelectedEvent ? rSelectedEvent.name : 'results'}.png`; a.href = c.toDataURL('image/png'); a.click(); } catch (e) { alert('이미지 생성 실패'); }
}
async function exportPDF() {
    const el = document.getElementById('results-content');
    if (!el) return;
    try { const c = await html2canvas(el, { scale: 2, backgroundColor: '#fff' }); const w = window.open('', '_blank'); w.document.write(`<html><head><title>Results</title></head><body style="margin:0;padding:20px;"><img src="${c.toDataURL('image/png')}" style="max-width:100%;"><script>window.onload=function(){window.print();}<\/script></body></html>`); w.document.close(); } catch (e) { alert('PDF 생성 실패'); }
}
