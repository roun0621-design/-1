/**
 * PACE RISE : Node — results.js v6
 * Side-by-side 남자부/여자부 results matrix
 * Added: all-groups unified download, SSE real-time, improved UI
 */

// Helper: display bib_number safely (null/undefined → '—')
function bib(val) { return val != null && val !== '' ? val : '—'; }

let allEvents = [];
let rSelectedEvent = null;
let rSelectedHeatId = null;

document.addEventListener('DOMContentLoaded', async () => {
    if (!(await requireCompetition())) return;
    renderPageNav('results');
    // Parallel: info bar + events load simultaneously
    const [, events] = await Promise.all([
        renderCompInfoBar(),
        API.getAllEvents(getCompetitionId())
    ]);
    allEvents = events;
    renderResultsMatrix();
    renderAuditLog();

    // If event_id in URL, auto-open
    const urlEventId = getParam('event_id');
    if (urlEventId) {
        const evt = allEvents.find(e => e.id === +urlEventId);
        if (evt) openResultDetail(evt.id);
    }

    // SSE listeners for real-time updates
    onSSE('event_completed', async () => {
        allEvents = await API.getAllEvents(getCompetitionId());
        renderResultsMatrix();
        if (rSelectedEvent && rSelectedHeatId) await loadResultsData();
    });
    onSSE('result_update', async () => {
        if (rSelectedEvent && rSelectedHeatId) await loadResultsData();
    });
    onSSE('height_update', async () => {
        if (rSelectedEvent && rSelectedHeatId) await loadResultsData();
    });
    onSSE('combined_update', async () => {
        if (rSelectedEvent && rSelectedEvent.category === 'combined') await loadResultsData();
    });
    onSSE('event_reverted', async () => {
        allEvents = await API.getAllEvents(getCompetitionId());
        renderResultsMatrix();
    });
});

// ============================================================
// Side-by-side Matrix
// ============================================================
function renderResultsMatrix() {
    const container = document.getElementById('results-matrix-container');

    // Get all non-sub-events
    const maleEvents = allEvents.filter(e => e.gender === 'M' && !e.parent_event_id);
    const femaleEvents = allEvents.filter(e => e.gender === 'F' && !e.parent_event_id);
    // Sub-events for combined
    const maleSubEvents = allEvents.filter(e => e.gender === 'M' && e.parent_event_id);
    const femaleSubEvents = allEvents.filter(e => e.gender === 'F' && e.parent_event_id);

    const categories = [
        { key: 'track', label: 'TRACK', match: c => c === 'track' },
        { key: 'field', label: 'FIELD', match: c => c === 'field_distance' || c === 'field_height' },
        { key: 'combined', label: 'COMBINED', match: c => c === 'combined' },
        { key: 'relay', label: 'RELAY', match: c => c === 'relay' },
        { key: 'road', label: 'ROAD', match: c => c === 'road' },
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
        const mGroups = Object.values(maleGroups).filter(g => cat.match(g.category));
        const fGroups = Object.values(femaleGroups).filter(g => cat.match(g.category));
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

            // Combined sub-events (10종/7종) — expanded by default
            if (cat.key === 'combined') {
                const mParentIds = mg ? mg.rounds.map(r => r.id) : [];
                const fParentIds = fg ? fg.rounds.map(r => r.id) : [];
                const mSubs = maleSubEvents.filter(se => mParentIds.includes(se.parent_event_id));
                const fSubs = femaleSubEvents.filter(se => fParentIds.includes(se.parent_event_id));
                // Merge sub-event names preserving order
                const subNames = [];
                const subNameSet = new Set();
                [...mSubs, ...fSubs].forEach(s => { if (!subNameSet.has(s.name)) { subNameSet.add(s.name); subNames.push(s.name); } });
                if (subNames.length > 0) {
                    const parentKey = 'res-subs-' + (mParentIds[0] || fParentIds[0] || name);
                    const doneCount = subNames.filter(sn => {
                        const mS = mSubs.find(s => s.name === sn);
                        const fS = fSubs.find(s => s.name === sn);
                        return (mS && (mS.round_status === 'completed' || mS.round_status === 'in_progress')) ||
                               (fS && (fS.round_status === 'completed' || fS.round_status === 'in_progress'));
                    }).length;
                    html += `<tr class="combined-sub-toggle-row">
                        <td colspan="8" style="padding:4px 8px;background:linear-gradient(135deg,#f8f4ea,#faf6ec);border-left:3px solid #8a7640;">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <button onclick="toggleCombinedSubs('${parentKey}')" class="btn btn-sm btn-ghost" style="font-size:11px;padding:2px 10px;" id="toggle-btn-${parentKey}">
                                    ▼ 세부종목 ${subNames.length}개
                                </button>
                                <span style="font-size:10px;color:#8a7640;font-weight:600;">${doneCount}/${subNames.length} 진행</span>
                            </div>
                        </td>
                    </tr>`;
                    subNames.forEach((seName, idx) => {
                        const mSe = mSubs.find(s => s.name === seName);
                        const fSe = fSubs.find(s => s.name === seName);
                        const shortName = seName.replace(/^\[.*?\]\s*/, '');
                        const isLast = idx === subNames.length - 1;
                        const prefix = isLast ? '└' : '├';
                        const seStatus = mSe || fSe;
                        const statusDot = seStatus ? (
                            seStatus.round_status === 'completed' ? '<span style="color:#9a8548;">●</span>' :
                            seStatus.round_status === 'in_progress' ? '<span style="color:#f59e0b;">●</span>' :
                            '<span style="color:#d1d5db;">○</span>'
                        ) : '<span style="color:#d1d5db;">○</span>';
                        html += `<tr class="combined-sub-row ${parentKey}">
                            <td class="event-name-cell" style="padding-left:24px;font-size:12px;color:#444;">
                                <span style="color:#a78bfa;margin-right:4px;">${prefix}</span>
                                ${statusDot}
                                <strong>${shortName}</strong>
                            </td>
                            <td class="round-cell">${renderResultBtn(null, 'male')}</td>
                            <td class="round-cell">${renderResultBtn(null, 'male')}</td>
                            <td class="round-cell">${renderResultBtn(mSe, 'male')}</td>
                            <td class="gender-divider-cell"></td>
                            <td class="round-cell">${renderResultBtn(null, 'female')}</td>
                            <td class="round-cell">${renderResultBtn(null, 'female')}</td>
                            <td class="round-cell">${renderResultBtn(fSe, 'female')}</td>
                        </tr>`;
                    });
                }
            }
        });

        html += `</tbody></table></div>`;
    });

    if (!html) html = '<div class="empty-state">종목이 없습니다.</div>';
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

function renderResultBtn(evt, genderClass) {
    if (!evt) return '<span class="round-btn status-none">—</span>';
    const hasData = evt.round_status === 'completed' || evt.round_status === 'in_progress' || evt.round_status === 'heats_generated';
    if (!hasData) return '<span class="round-btn status-none">—</span>';
    const statusCls = getResultStatusClass(evt);
    const genderCls = genderClass === 'male' ? 'result-btn-male' : 'result-btn-female';
    const roundLabel = fmtRound(evt.round_type);
    // Combined events: show 종합순위 + Day 1 + Day 2 buttons
    if (evt.category === 'combined') {
        return `<div style="display:flex;flex-direction:column;gap:3px;align-items:center;">
            <a class="round-btn ${statusCls} ${genderCls}" href="javascript:void(0)" onclick="openResultDetail(${evt.id})" title="종합순위" style="font-size:11px;padding:3px 8px;">종합순위</a>
            <a class="round-btn status-active ${genderCls}" href="javascript:void(0)" onclick="openResultDetail(${evt.id})" title="Day 1" style="font-size:10px;padding:2px 6px;background:#e8ecf4;color:#1a2a5e;">Day 1</a>
            <a class="round-btn status-active ${genderCls}" href="javascript:void(0)" onclick="openResultDetail(${evt.id})" title="Day 2" style="font-size:10px;padding:2px 6px;background:#f4e8ec;color:#8b1a2a;">Day 2</a>
        </div>`;
    }
    return `<a class="round-btn ${statusCls} ${genderCls}" href="javascript:void(0)" onclick="openResultDetail(${evt.id})" title="${roundLabel} 결과">${roundLabel} 결과</a>`;
}

// ============================================================
// All-Groups Unified Download — Phase 7: single sheet, comp info
// ============================================================
async function downloadAllGroups(format) {
    if (!rSelectedEvent) return;
    try {
        const data = await API.getFullResults(rSelectedEvent.id);
        if (!data || !data.heats || data.heats.length === 0) { alert('데이터가 없습니다.'); return; }

        const evt = data.event;
        const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
        const compInfo = await API.getCompetitionInfo(getCompetitionId()).catch(() => ({ name: '', venue: '' }));
        const compName = compInfo.name || 'Competition';
        const venue = compInfo.venue || '';
        const roundLabel = fmtRound(evt.round_type);
        const fileName = `${compName}_${gL}_${evt.name}_${roundLabel}`;

        if (format === 'excel') {
            const wb = XLSX.utils.book_new();
            // Single sheet with all heats — Phase 7
            const allRows = [];
            // Competition header rows
            allRows.push([`대회명: ${compName}`]);
            allRows.push([`장소: ${venue}`]);
            allRows.push([`부별: ${gL}`, `종목: ${evt.name}`, `라운드: ${roundLabel}`]);
            allRows.push([`출력일: ${new Date().toLocaleDateString('ko-KR')}`]);
            allRows.push([]); // empty row

            for (const heat of data.heats) {
                if (data.heats.length > 1) {
                    allRows.push([`— ${heat.heat_number}조 —`]);
                }
                const rows = buildHeatRows(evt, heat);
                allRows.push(...rows);
                allRows.push([]); // separator
            }

            const ws = XLSX.utils.aoa_to_sheet(allRows);
            XLSX.utils.book_append_sheet(wb, ws, '전체 결과');
            XLSX.writeFile(wb, `${fileName}.xlsx`);
        } else if (format === 'pdf') {
            let allHtml = `<div style="padding:20px;font-family:sans-serif;">`;
            allHtml += `<h2 style="text-align:center;">${compName}</h2>`;
            allHtml += `<p style="text-align:center;font-size:12px;color:#666;">${venue} | ${gL} | ${evt.name} ${roundLabel} | ${new Date().toLocaleDateString('ko-KR')}</p>`;
            for (const heat of data.heats) {
                if (data.heats.length > 1) allHtml += `<h3 style="margin-top:24px;">${heat.heat_number}조</h3>`;
                allHtml += buildHeatHtmlTable(evt, heat);
            }
            allHtml += `</div>`;
            const w = window.open('', '_blank');
            w.document.write(`<html><head><title>${fileName}</title></head><body>${allHtml}<script>window.onload=function(){window.print();}<\/script></body></html>`);
            w.document.close();
        }
    } catch (e) { console.error(e); alert('다운로드 실패'); }
}

function buildHeatRows(evt, heat) {
    const cat = evt.category;
    if (cat === 'track' || cat === 'relay') {
        const header = ['순위', '레인', 'BIB', '선수명', '소속', '기록', '비고'];
        const rows = heat.entries.map(e => {
            const r = (heat.results || []).find(r => r.event_entry_id === e.event_entry_id);
            return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code || '') : '', remark: r ? (r.remark || '') : '' };
        }).sort((a, b) => {
            if (a.status_code && !b.status_code) return 1;
            if (!a.status_code && b.status_code) return -1;
            if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
            return a.time_seconds - b.time_seconds;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.rank = ''; return; }
            r.rank = r.time_seconds == null ? '' : ((i > 0 && rows[i-1].time_seconds === r.time_seconds && !rows[i-1].status_code) ? rows[i-1].rank : rk); rk = i + 2;
        });
        const _rdfmtE = isRoadEvent(rSelectedEvent?.name) ? { noDecimal: true } : undefined;
        return [header, ...rows.map(r => [r.rank, r.lane_number || '', bib(r.bib_number), r.name, r.team || '', r.status_code ? '' : (r.time_seconds != null ? formatTime(r.time_seconds, _rdfmtE) : ''), r.status_code || (r.remark || '')])];
    } else if (cat === 'field_distance') {
        const header = ['순위', 'BIB', '선수명', '소속', '1', '2', '3', '4', '5', '6', 'BEST'];
        const rows = heat.entries.map(e => {
            const er = (heat.results || []).filter(r => r.event_entry_id === e.event_entry_id);
            const att = {}; er.forEach(r => { if (r.attempt_number) att[r.attempt_number] = r.distance_meters; });
            const valid = Object.values(att).filter(d => d > 0);
            const sortedValid = [];
            for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
            sortedValid.sort((a, b) => b - a);
            return { ...e, att, best: valid.length > 0 ? Math.max(...valid) : null, sortedValid };
        }).sort((a, b) => {
            if (a.best == null) return 1; if (b.best == null) return -1;
            if (b.best !== a.best) return b.best - a.best;
            const maxLen = Math.max(a.sortedValid.length, b.sortedValid.length);
            for (let k = 1; k < maxLen; k++) {
                const aV = a.sortedValid[k] ?? -1, bV = b.sortedValid[k] ?? -1;
                if (bV !== aV) return bV - aV;
            }
            return 0;
        });
        let rk = 1;
        rows.forEach((r, i) => {
            if (r.best == null) { r.rank = ''; rk = i + 2; return; }
            let isTied = i > 0 && rows[i-1].best === r.best;
            if (isTied) {
                const prev = rows[i-1];
                const maxLen = Math.max(prev.sortedValid.length, r.sortedValid.length);
                for (let k = 1; k < maxLen; k++) {
                    if ((prev.sortedValid[k] ?? -1) !== (r.sortedValid[k] ?? -1)) { isTied = false; break; }
                }
            }
            r.rank = isTied ? rows[i-1].rank : rk;
            rk = i + 2;
        });
        return [header, ...rows.map(r => {
            const cells = [r.rank, bib(r.bib_number), r.name, r.team || ''];
            for (let i = 1; i <= 6; i++) { const v = r.att[i]; cells.push(v != null ? (v === 0 ? 'X' : (v < 0 ? '-' : formatHeight(v))) : ''); }
            cells.push(r.best != null ? formatHeight(r.best) : '');
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
    if (st === 'in_progress') return 'status-active';
    if (st === 'heats_generated') return 'status-ready';
    return 'status-created';
}

// ============================================================
// Result Detail Overlay
// ============================================================
let _resultHeats = [];

async function openResultDetail(eventId) {
    const evt = allEvents.find(e => e.id === eventId);
    if (!evt) return;
    rSelectedEvent = evt;

    const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
    document.getElementById('result-detail-title').textContent = `${evt.name} ${gL} ${fmtRound(evt.round_type)} 결과`;
    setParams({ event_id: eventId });

    _resultHeats = await API.getHeats(eventId);
    const isTrackType = (evt.category === 'track' || evt.category === 'relay' || evt.category === 'road');
    const isMultiHeat = _resultHeats.length > 1;

    if (_resultHeats.length > 0) {
        // For multi-heat track events, show unified + group view by default
        if (isMultiHeat && isTrackType) {
            rSelectedHeatId = '__all__'; // new: show all (unified + groups)
        } else if (isMultiHeat) {
            rSelectedHeatId = _resultHeats[0].id;
        } else {
            rSelectedHeatId = _resultHeats[0].id;
        }

        // Build tabs for multi-heat events
        let heatTabsHtml = '';
        if (isMultiHeat) {
            let allTab = isTrackType ? `<button class="heat-tab active" onclick="switchResultHeat('__all__', this)" style="font-weight:700;">전체보기</button>` : '';
            let unifiedTab = isTrackType ? `<button class="heat-tab" onclick="switchResultHeat('__unified__', this)">종합순위만</button>` : '';
            heatTabsHtml = `<div class="heat-tabs" style="margin-bottom:10px;">${allTab}${unifiedTab}${_resultHeats.map((h, i) =>
                `<button class="heat-tab ${!isTrackType && i === 0 ? 'active' : ''}" onclick="switchResultHeat(${h.id}, this)">${h.heat_number}조</button>`
            ).join('')}</div>`;
        }

        const contentEl = document.getElementById('result-detail-content');
        contentEl.innerHTML = heatTabsHtml + `
            <div id="results-content" class="results-content">
                <div id="results-header-area" class="results-header-area"></div>
                <div id="results-all-area"></div>
                <table class="data-table" id="results-table" style="display:none;">
                    <thead id="results-thead"></thead>
                    <tbody id="results-tbody"></tbody>
                </table>
            </div>`;

        await loadResultsData();
    }

    document.getElementById('result-detail-overlay').style.display = 'flex';

    // Check if event has multiple heats for all-groups download
    if (isMultiHeat) {
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
    document.querySelectorAll('.heat-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    await loadResultsData();
}

// ============================================================
// Load & Render Results Data
// ============================================================
async function loadResultsData() {
    if (!rSelectedHeatId || !rSelectedEvent) return;
    const cat = rSelectedEvent.category;
    const gL = { M: '남자', F: '여자', X: '혼성' }[rSelectedEvent.gender] || '';

    const compInfo = await API.getCompetitionInfo(getCompetitionId()).catch(() => ({ name: '' }));
    // Video buttons
    let videoHtml = '';
    try {
        const vRes = await API.getEventVideoUrl(rSelectedEvent.id);
        if (vRes.video_url) videoHtml += `<button class="btn btn-sm btn-outline" onclick="openVideoModal('${vRes.video_url.replace(/'/g,"\\'")}', '${rSelectedEvent.name.replace(/'/g,"\\'")}')">▶ 영상</button> `;
    } catch(e){}
    if (compInfo.video_url) videoHtml += `<button class="btn btn-sm btn-outline" onclick="openVideoModal('${compInfo.video_url.replace(/'/g,"\\'")}', '대회 대표 영상')">▶ 대회 영상</button>`;
    // Wind info for track events (heat-level wind)
    let windInfoHtml = '';
    if ((cat === 'track') && rSelectedHeatId !== '__all__' && rSelectedHeatId !== '__unified__') {
        const needsWind = requiresWindMeasurement(rSelectedEvent?.name, cat);
        if (needsWind) {
            const currentHeat = _resultHeats.find(h => h.id === rSelectedHeatId);
            if (currentHeat && currentHeat.wind != null) {
                const wVal = parseFloat(currentHeat.wind);
                if (!isNaN(wVal)) {
                    const isOverLimit = wVal > 2.0;
                    const windClass = isOverLimit ? 'color:var(--accent);font-weight:700;' : 'color:var(--green);font-weight:600;';
                    const waMark = isOverLimit ? ' <span class="wind-ref-badge">참조기록</span>' : '';
                    windInfoHtml = `<div style="margin-top:4px;font-size:13px;"><span class="ico ico-wind">WIND</span> 풍속: <span style="${windClass}">${formatWind(wVal)} m/s</span>${waMark}</div>`;
                }
            }
        }
    }
    document.getElementById('results-header-area').innerHTML = `<h2>${rSelectedEvent.name} ${gL}</h2><p>${compInfo.name || ''} — ${new Date().toLocaleDateString('ko-KR')}</p>${windInfoHtml}${videoHtml ? `<div style="margin-top:6px;">${videoHtml}</div>` : ''}`;

    const allArea = document.getElementById('results-all-area');
    const tableEl = document.getElementById('results-table');

    // __all__ mode: show unified ranking at top + each group below
    if (rSelectedHeatId === '__all__') {
        tableEl.style.display = 'none';
        allArea.style.display = 'block';
        await renderAllGroupsView(allArea);
        return;
    }

    // Unified-only view for track events with multiple heats
    if (rSelectedHeatId === '__unified__') {
        tableEl.style.display = 'table';
        allArea.style.display = 'none';
        await renderUnifiedTrackResults();
        return;
    }

    // Single heat view
    tableEl.style.display = 'table';
    tableEl.classList.remove('field-2row-table');
    allArea.style.display = 'none';
    const entries = await API.getHeatEntries(rSelectedHeatId);
    if (cat === 'track' || cat === 'relay' || cat === 'road') await renderTrackResults(entries);
    else if (cat === 'field_distance') await renderFieldDistanceResults(entries);
    else if (cat === 'field_height') await renderFieldHeightResults(entries);
    else if (cat === 'combined') await renderCombinedResults();
    else {
        document.getElementById('results-thead').innerHTML = '';
        document.getElementById('results-tbody').innerHTML = '<tr><td class="empty-state">데이터 없음</td></tr>';
    }
}

// ============================================================
// All Groups View (Unified + Individual Groups)
// ============================================================
async function renderAllGroupsView(container) {
    if (!rSelectedEvent || _resultHeats.length === 0) return;
    const _rdfmt = isRoadEvent(rSelectedEvent?.name) ? { noDecimal: true } : undefined;
    const heats = _resultHeats;
    // WA wind check for track events
    const needsWind = requiresWindMeasurement(rSelectedEvent?.name, rSelectedEvent?.category);
    const heatWindMap = {};
    if (needsWind) {
        heats.forEach(h => {
            if (h.wind != null) { const w = parseFloat(h.wind); if (!isNaN(w)) heatWindMap[h.id] = w; }
        });
    }

    // Load Q/q badges
    let quals = [];
    if (rSelectedEvent.round_type === 'preliminary' || rSelectedEvent.round_type === 'semifinal') {
        try { quals = await API.getQualifications(rSelectedEvent.id); } catch(e) {}
    }

    // Collect all entries+results from all heats
    const allRows = [];
    const heatData = {};
    for (const heat of heats) {
        const entries = await API.getHeatEntries(heat.id);
        const results = await API.getResults(heat.id);
        const heatRows = [];
        entries.forEach(e => {
            const r = results.find(r => r.event_entry_id === e.event_entry_id);
            const q = quals.find(q => q.event_entry_id === e.event_entry_id && q.selected);
            const row = { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code || '') : '', remark: r ? (r.remark || '') : '', heat_number: heat.heat_number, heat_id: heat.id, qualType: q ? (q.qualification_type || '') : '' };
            allRows.push(row);
            heatRows.push(row);
        });
        heatData[heat.id] = { heat, rows: heatRows };
    }

    // Sort all by time for unified ranking
    const unified = [...allRows].sort((a, b) => {
        if (a.status_code && !b.status_code) return 1;
        if (!a.status_code && b.status_code) return -1;
        if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    let rk = 1;
    unified.forEach((r, i) => {
        if (r.status_code) { r.rank = ''; return; }
        r.rank = r.time_seconds == null ? '—' : ((i > 0 && unified[i-1].time_seconds === r.time_seconds && !unified[i-1].status_code) ? unified[i-1].rank : rk);
        rk = i + 2;
    });

    let html = '';

    // === Section 1: Unified Ranking ===
    const windColHdr = needsWind ? '<th>풍속</th>' : '';
    html += `<div style="margin-bottom:24px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:8px;padding:8px 12px;background:var(--green-light);border-radius:var(--radius);border-left:4px solid var(--green);color:var(--green);">종합순위 (전체 조 통합)</h3>
        <table class="data-table">
            <thead><tr><th>RANK</th><th>조</th><th>${getSmallNumberLabel(rSelectedEvent?.name, rSelectedEvent?.category)}</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>기록</th>${windColHdr}<th>비고</th></tr></thead>
            <tbody>`;
    unified.forEach(r => {
        const medal = getMedal(r.rank, rSelectedEvent?.round_type);
        const display = r.status_code ? '' : (r.time_seconds != null ? formatTime(r.time_seconds, _rdfmt) : '—');
        const heatW = heatWindMap[r.heat_id];
        const isWindAided = needsWind && heatW != null && heatW > 2.0 && !r.status_code && r.time_seconds != null;
        const wMark = isWindAided ? '<span class="wind-aided-mark">w</span>' : '';
        const windCell = needsWind ? `<td style="font-size:11px;font-family:var(--font-mono);${heatW != null && heatW > 2.0 ? 'font-weight:700;' : ''}">${heatW != null ? formatWind(heatW) : ''}</td>` : '';
        // 비고: status_code(DNF/DQ 등), Q/q, 풍속 초과 시 참고기록
        let uRemarkText = '';
        if (r.status_code) uRemarkText = r.status_code;
        else if (isWindAided) uRemarkText = '참고기록';
        else if (r.qualType) uRemarkText = r.qualType;
        else uRemarkText = r.remark || '';
        const uRemarkStyle = r.status_code ? 'color:var(--danger);font-weight:600;font-size:11px;'
            : isWindAided ? 'color:var(--accent);font-weight:600;font-size:11px;'
            : (r.qualType === 'Q' ? 'color:#0066CC;font-weight:700;font-size:12px;' : r.qualType === 'q' ? 'color:#0066CC;font-size:12px;' : 'font-size:11px;color:var(--text-muted);');
        html += `<tr>
            <td>${medal}</td>
            <td style="font-size:11px;color:var(--text-muted);">${r.heat_number}조</td>
            <td>${r.lane_number || '—'}</td>
            <td><strong>${bib(r.bib_number)}</strong></td>
            <td style="text-align:left;">${r.name}</td>
            <td style="font-size:12px;">${r.team || ''}</td>
            <td style="font-family:var(--font-mono);font-weight:600;">${display}${wMark}</td>${windCell}
            <td style="${uRemarkStyle}">${uRemarkText}</td>
        </tr>`;
    });
    html += `</tbody></table></div>`;

    // === Section 2: Individual Group Results ===
    html += `<div style="margin-bottom:12px;">
        <h3 style="font-size:14px;font-weight:700;margin-bottom:12px;padding:6px 12px;background:var(--blue-light);border-radius:var(--radius);border-left:4px solid var(--blue);color:var(--accent);">조별 결과</h3>`;

    for (const heat of heats) {
        const hd = heatData[heat.id];
        const rows = [...hd.rows].sort((a, b) => {
            if (a.status_code && !b.status_code) return 1;
            if (!a.status_code && b.status_code) return -1;
            if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
            return a.time_seconds - b.time_seconds;
        });
        let grk = 1;
        rows.forEach((r, i) => {
            if (r.status_code) { r.groupRank = ''; return; }
            r.groupRank = r.time_seconds == null ? '—' : ((i > 0 && rows[i-1].time_seconds === r.time_seconds && !rows[i-1].status_code) ? rows[i-1].groupRank : grk);
            grk = i + 2;
        });

        // Per-group wind info
        const groupWind = heatWindMap[heat.id];
        const groupWindHtml = needsWind && groupWind != null ? ` <span style="font-size:11px;font-weight:400;color:${groupWind > 2.0 ? 'var(--accent)' : 'var(--green)'};"> WIND ${formatWind(groupWind)} m/s</span>${groupWind > 2.0 ? ' <span class="wind-ref-badge">참조기록</span>' : ''}` : '';
        html += `<div style="margin-bottom:16px;">
            <div style="font-size:13px;font-weight:700;margin-bottom:6px;padding:4px 8px;background:var(--gray-light);border-radius:4px;">${heat.heat_number}조 (${rows.length}명)${groupWindHtml}</div>
            <table class="data-table" style="margin-bottom:0;">
                <thead><tr><th>순위</th><th>LANE</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>기록</th><th>비고</th><th style="font-size:10px;">종합</th></tr></thead>
                <tbody>`;
        rows.forEach(r => {
            // Find the unified rank for this entry
            const unifiedEntry = unified.find(u => u.event_entry_id === r.event_entry_id);
            const unifiedRank = unifiedEntry ? unifiedEntry.rank : '—';
            const medal = getMedal(r.groupRank, rSelectedEvent?.round_type);
            const isWindAided = needsWind && groupWind != null && groupWind > 2.0 && !r.status_code && r.time_seconds != null;
            const wMark = isWindAided ? '<span class="wind-aided-mark">w</span>' : '';
            // 비고: status_code(DNF/DQ 등), Q/q, 풍속 초과 시 참고기록
            let grpRemarkText = '';
            if (r.status_code) grpRemarkText = r.status_code;
            else if (isWindAided) grpRemarkText = '참고기록';
            else if (r.qualType) grpRemarkText = r.qualType;
            else grpRemarkText = r.remark || '';
            const grpRemarkStyle = r.status_code ? 'color:var(--danger);font-weight:600;font-size:11px;'
                                 : isWindAided ? 'color:var(--accent);font-weight:600;font-size:11px;'
                                 : r.qualType ? 'color:var(--blue);font-weight:600;font-size:11px;'
                                 : 'font-size:11px;color:var(--text-muted);';
            const grpDisplay = r.status_code ? '' : (r.time_seconds != null ? formatTime(r.time_seconds, _rdfmt) + wMark : '—');
            html += `<tr>
                <td>${medal}</td>
                <td>${r.lane_number || '—'}</td>
                <td><strong>${bib(r.bib_number)}</strong></td>
                <td style="text-align:left;">${r.name}</td>
                <td style="font-size:12px;">${r.team || ''}</td>
                <td style="font-family:var(--font-mono);font-weight:600;">${grpDisplay}</td>
                <td style="${grpRemarkStyle}">${grpRemarkText}</td>
                <td style="font-size:11px;color:var(--accent);font-weight:700;">${typeof unifiedRank === 'number' ? '#' + unifiedRank : '—'}</td>
            </tr>`;
        });
        html += `</tbody></table></div>`;
    }
    html += `</div>`;

    container.innerHTML = html;
}

// ============================================================
// Track Results
// ============================================================
async function renderTrackResults(entries) {
    const results = await API.getResults(rSelectedHeatId);
    const _rdfmt = isRoadEvent(rSelectedEvent?.name) ? { noDecimal: true } : undefined;
    // Load Q/q badges for preliminary/semifinal events
    let quals = [];
    if (rSelectedEvent && (rSelectedEvent.round_type === 'preliminary' || rSelectedEvent.round_type === 'semifinal')) {
        try { quals = await API.getQualifications(rSelectedEvent.id); } catch(e) {}
    }
    // Check wind for WA reference record marking
    const needsWind = requiresWindMeasurement(rSelectedEvent?.name, rSelectedEvent?.category);
    let heatWind = null, isWindOverLimit = false;
    if (needsWind) {
        const currentHeat = _resultHeats.find(h => h.id === rSelectedHeatId);
        if (currentHeat && currentHeat.wind != null) {
            heatWind = parseFloat(currentHeat.wind);
            if (!isNaN(heatWind)) isWindOverLimit = heatWind > 2.0;
            else heatWind = null;
        }
    }
    document.getElementById('results-thead').innerHTML = `<tr><th>RANK</th><th>${getSmallNumberLabel(rSelectedEvent?.name, rSelectedEvent?.category)}</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>기록</th><th>비고</th></tr>`;
    const rows = entries.map(e => {
        const r = results.find(r => r.event_entry_id === e.event_entry_id);
        const q = quals.find(q => q.event_entry_id === e.event_entry_id && q.selected);
        return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code || '') : '', remark: r ? (r.remark || '') : '', qualType: q ? (q.qualification_type || '') : '' };
    }).sort((a, b) => {
        // Status codes at bottom
        if (a.status_code && !b.status_code) return 1;
        if (!a.status_code && b.status_code) return -1;
        if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    let rk = 1;
    rows.forEach((r, i) => {
        if (r.status_code) { r.rank = ''; return; }
        r.rank = r.time_seconds == null ? '—' : ((i > 0 && rows[i-1].time_seconds === r.time_seconds && !rows[i-1].status_code) ? rows[i-1].rank : rk); rk = i + 2;
    });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = getMedal(r.rank, rSelectedEvent?.round_type);
        const display = r.status_code ? '' : (r.time_seconds != null ? formatTime(r.time_seconds, _rdfmt) : '—');
        // WA: wind > +2.0 → append 'w' to performance (valid but not record-eligible)
        const isWA = isWindOverLimit && !r.status_code && r.time_seconds != null;
        const wMark = isWA ? '<span class="wind-aided-mark">w</span>' : '';
        // 비고: status_code(DNF/DQ 등), Q/q, 풍속 초과 시 참고기록
        let remarkText = '';
        if (r.status_code) remarkText = r.status_code;
        else if (isWA) remarkText = '참고기록';
        else if (r.qualType) remarkText = r.qualType;
        else remarkText = r.remark || '';
        const remarkStyle = r.status_code ? 'color:var(--danger);font-weight:600;font-size:11px;'
                          : isWA ? 'color:var(--accent);font-weight:600;font-size:11px;'
                          : r.qualType ? 'color:var(--blue);font-weight:600;font-size:11px;'
                          : 'font-size:11px;color:var(--text-muted);';
        return `<tr>
            <td>${medal}</td><td>${r.lane_number || '—'}</td><td><strong>${bib(r.bib_number)}</strong></td>
            <td style="text-align:left;">${r.name}</td><td style="font-size:12px;">${r.team || ''}</td>
            <td style="font-family:var(--font-mono);font-weight:600;">${display}${wMark}</td>
            <td style="${remarkStyle}">${remarkText}</td>
        </tr>`;
    }).join('');
}

// ============================================================
// Unified Track Results (Time Race / Multi-heat combined ranking)
// ============================================================
async function renderUnifiedTrackResults() {
    if (!rSelectedEvent) return;
    const _rdfmt = isRoadEvent(rSelectedEvent?.name) ? { noDecimal: true } : undefined;
    const needsWind = requiresWindMeasurement(rSelectedEvent?.name, rSelectedEvent?.category);
    const heats = await API.getHeats(rSelectedEvent.id);
    // Build per-heat wind map
    const heatWindMap = {};
    if (needsWind) {
        heats.forEach(h => {
            if (h.wind != null) {
                const w = parseFloat(h.wind);
                if (!isNaN(w)) heatWindMap[h.id] = w;
            }
        });
    }
    // Collect all entries+results from all heats
    const allRows = [];
    for (const heat of heats) {
        const entries = await API.getHeatEntries(heat.id);
        const results = await API.getResults(heat.id);
        entries.forEach(e => {
            const r = results.find(r => r.event_entry_id === e.event_entry_id);
            allRows.push({ ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? (r.status_code || '') : '', remark: r ? (r.remark || '') : '', heat_number: heat.heat_number, heat_id: heat.id });
        });
    }
    // Sort all by time
    allRows.sort((a, b) => {
        if (a.status_code && !b.status_code) return 1;
        if (!a.status_code && b.status_code) return -1;
        if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    // Assign unified ranks
    let rk = 1;
    allRows.forEach((r, i) => {
        if (r.status_code) { r.rank = ''; return; }
        r.rank = r.time_seconds == null ? '—' : ((i > 0 && allRows[i-1].time_seconds === r.time_seconds && !allRows[i-1].status_code) ? allRows[i-1].rank : rk);
        rk = i + 2;
    });

    const windColHdr = needsWind ? '<th>풍속</th>' : '';
    document.getElementById('results-thead').innerHTML = `<tr><th>RANK</th><th>조</th><th>${getSmallNumberLabel(rSelectedEvent?.name, rSelectedEvent?.category)}</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>기록</th>${windColHdr}<th>비고</th></tr>`;
    document.getElementById('results-tbody').innerHTML = allRows.map(r => {
        const medal = getMedal(r.rank, rSelectedEvent?.round_type);
        const display = r.status_code ? '' : (r.time_seconds != null ? formatTime(r.time_seconds, _rdfmt) : '—');
        // WA: per-heat wind > +2.0 → append 'w' (valid but not record-eligible)
        const heatW = heatWindMap[r.heat_id];
        const isWindAided = needsWind && heatW != null && heatW > 2.0 && !r.status_code && r.time_seconds != null;
        const wMark = isWindAided ? '<span class="wind-aided-mark">w</span>' : '';
        const windCell = needsWind ? `<td style="font-size:11px;font-family:var(--font-mono);${heatW != null && heatW > 2.0 ? 'font-weight:700;' : ''}">${heatW != null ? formatWind(heatW) : ''}</td>` : '';
        // 비고: status_code(DNF/DQ 등), 풍속 초과 시 참고기록
        let allRemarkText = '';
        if (r.status_code) allRemarkText = r.status_code;
        else if (isWindAided) allRemarkText = '참고기록';
        else allRemarkText = r.remark || '';
        const allRemarkStyle = r.status_code ? 'color:var(--danger);font-weight:600;font-size:11px;'
                             : isWindAided ? 'color:var(--accent);font-weight:600;font-size:11px;'
                             : 'font-size:11px;color:var(--text-muted);';
        return `<tr>
            <td>${medal}</td><td style="font-size:11px;color:var(--text-muted);">${r.heat_number}조</td><td>${r.lane_number || '—'}</td><td><strong>${bib(r.bib_number)}</strong></td>
            <td style="text-align:left;">${r.name}</td><td style="font-size:12px;">${r.team || ''}</td>
            <td style="font-family:var(--font-mono);font-weight:600;">${display}${wMark}</td>${windCell}
            <td style="${allRemarkStyle}">${allRemarkText}</td>
        </tr>`;
    }).join('');
}

// ============================================================
// Field Distance Results
// ============================================================
async function renderFieldDistanceResults(entries) {
    const results = await API.getResults(rSelectedHeatId);
    const needsWind = requiresWindMeasurement(rSelectedEvent?.name, 'field_distance');
    const tbl = document.getElementById('results-table');
    if (tbl) { if (needsWind) tbl.classList.add('field-2row-table'); else tbl.classList.remove('field-2row-table'); }
    if (needsWind) {
        document.getElementById('results-thead').innerHTML = `
            <tr><th rowspan="2">순위</th><th rowspan="2">순번</th><th style="text-align:left;">성명</th><th rowspan="2">배번</th>
                <th>1차시기</th><th>2차시기</th><th>3차시기</th><th>4차시기</th><th>5차시기</th><th>6차시기</th><th rowspan="2">기록</th><th rowspan="2">비고</th></tr>
            <tr><th style="text-align:left;">소속</th>
                <th class="wind-header">풍속</th><th class="wind-header">풍속</th><th class="wind-header">풍속</th><th class="wind-header">풍속</th><th class="wind-header">풍속</th><th class="wind-header">풍속</th>
            </tr>`;
    } else {
        document.getElementById('results-thead').innerHTML = `
            <tr><th>순위</th><th>순번</th><th style="text-align:left;">성명</th><th style="text-align:left;">소속</th><th>배번</th>
                <th>1차시기</th><th>2차시기</th><th>3차시기</th><th>4차시기</th><th>5차시기</th><th>6차시기</th><th>기록</th><th>비고</th></tr>`;
    }
    const rows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {}, attWind = {};
        er.forEach(r => { if (r.attempt_number) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; } });
        const valid = Object.values(att).filter(d => d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        // WA: later attempt is the official record for same distance
        let bestWind = null;
        if (best != null) { for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } } }
        // Build sorted valid distances (descending) for WA tie-breaking
        const sortedValid = [];
        for (let i = 1; i <= 6; i++) { if (att[i] != null && att[i] > 0) sortedValid.push(att[i]); }
        sortedValid.sort((a, b) => b - a);
        const status_code = er.find(r => r.status_code && ['DNS','DNF','DQ','NM'].includes(r.status_code))?.status_code || '';
        return { ...e, att, attWind, best, bestWind, sortedValid, status_code };
    }).sort((a, b) => {
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
        if (r.status_code) { r.rank = ''; return; }
        if (r.best == null) { r.rank = '—'; rk = i + 2; return; }
        let isTied = i > 0 && rows[i-1].best === r.best && !rows[i-1].status_code;
        if (isTied) {
            const prev = rows[i-1];
            const maxLen = Math.max(prev.sortedValid.length, r.sortedValid.length);
            for (let k = 1; k < maxLen; k++) {
                if ((prev.sortedValid[k] ?? -1) !== (r.sortedValid[k] ?? -1)) { isTied = false; break; }
            }
        }
        r.rank = isTied ? rows[i-1].rank : rk;
        rk = i + 2;
    });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = r.status_code ? '' : getMedal(r.rank, rSelectedEvent?.round_type);
        let distCells = '', windCells = '';
        for (let i = 1; i <= 6; i++) {
            const v = r.att[i];
            const hasVal = v != null;
            const isFoul = hasVal && v === 0;
            const isPass = hasVal && (v === -1 || v < 0);
            let display = '';
            if (hasVal) {
                if (isFoul) display = '<span class="foul-mark">X</span>';
                else if (isPass) display = '<span class="pass-mark">-</span>';
                else display = formatHeight(v);
            }
            distCells += `<td style="font-family:var(--font-mono);font-size:12px;text-align:center;">${display}</td>`;
            if (needsWind) {
                let wDisp = '';
                if (hasVal && !isFoul && !isPass && r.attWind[i] != null) wDisp = formatWind(r.attWind[i]);
                windCells += `<td class="wind-cell">${wDisp}</td>`;
            }
        }
        const bestWindDisp = (r.bestWind != null && needsWind) ? formatWind(r.bestWind) : '';
        // WA: best attempt wind > +2.0 → append 'w' (valid but not record-eligible)
        const bestWindOver = needsWind && r.bestWind != null && parseFloat(r.bestWind) > 2.0 && r.best != null;
        const bestWMark = bestWindOver ? '<span class="wind-aided-mark">w</span>' : '';
        const bestColor = bestWindOver ? '' : 'color:var(--green);';
        // 비고: status_code(DNF/DQ/NM 등), 풍속 초과 시 참고기록
        let remark = '';
        if (r.status_code) remark = r.status_code;
        else if (bestWindOver) remark = '참고기록';
        const remarkStyle = r.status_code ? 'color:var(--danger);font-weight:600;font-size:11px;'
                          : bestWindOver ? 'color:var(--accent);font-weight:600;font-size:11px;' : 'font-size:11px;';
        const bestDisp = r.status_code ? '' : (r.best != null ? formatHeight(r.best) : '—');

        if (needsWind) {
            return `<tr class="field-row1">
                <td rowspan="2">${medal}</td><td rowspan="2">${r.lane_number || '—'}</td>
                <td style="text-align:left;"><strong>${r.name}</strong></td><td rowspan="2"><strong>${bib(r.bib_number)}</strong></td>
                ${distCells}<td rowspan="2" class="best-cell" style="font-weight:700;font-family:var(--font-mono);${bestColor}">${bestDisp}${bestWMark}<div class="best-wind" style="color:#555;font-weight:400;">${bestWindDisp}</div></td>
                <td rowspan="2" style="${remarkStyle}">${remark}</td>
            </tr><tr class="field-row2">
                <td class="team-cell" style="font-size:11px;text-align:left;color:#666;">${r.team || ''}</td>${windCells}
            </tr>`;
        } else {
            return `<tr>
                <td>${medal}</td><td>${r.lane_number || '—'}</td>
                <td style="text-align:left;"><strong>${r.name}</strong></td><td style="text-align:left;font-size:11px;color:#666;">${r.team || ''}</td><td><strong>${bib(r.bib_number)}</strong></td>
                ${distCells}<td class="best-cell" style="font-weight:700;font-family:var(--font-mono);color:var(--green);">${bestDisp}</td>
                <td style="${remarkStyle}">${remark}</td>
            </tr>`;
        }
    }).join('');
}

// ============================================================
// Field Height Results
// ============================================================
async function renderFieldHeightResults(entries) {
    const ha = await API.getHeightAttempts(rSelectedHeatId);
    const hts = [...new Set(ha.map(a => a.bar_height))].sort((a, b) => a - b);
    let h = '<tr><th>RANK</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th>';
    hts.forEach(h2 => { h += `<th style="font-size:10px;">${formatHeight(h2)}</th>`; });
    h += '<th>최고</th><th>비고</th></tr>';
    document.getElementById('results-thead').innerHTML = h;
    const rows = entries.map(e => {
        const ea = ha.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {}; ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
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
        if (r.best == null) { r.rank = ''; rk = i + 2; return; }
        let isTied = i > 0 && rows[i-1].best === r.best && rows[i-1].failsAtBest === r.failsAtBest && rows[i-1].totalFails === r.totalFails;
        r.rank = isTied ? rows[i-1].rank : rk;
        rk = i + 2;
    });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = r.best == null ? '' : getMedal(r.rank, rSelectedEvent?.round_type);
        let c = ''; hts.forEach(h2 => { const d = r.hd[h2] || {}; let m = ''; for (let i = 1; i <= 3; i++) { if (d[i]) { const mark = d[i] === 'PASS' ? '-' : d[i]; const cls = d[i] === 'O' ? 'mark-O' : d[i] === 'X' ? 'mark-X' : 'mark-PASS'; m += `<span class="height-mark ${cls}">${mark}</span>`; } } c += `<td style="font-size:11px;">${m}</td>`; });
        const bestDisp = r.best != null ? formatHeight(r.best) : '';
        const rmk = r.isNM ? 'NM' : '';
        const rmkStyle = r.isNM ? 'color:var(--danger);font-weight:600;font-size:11px;' : 'font-size:11px;';
        return `<tr><td>${medal}</td><td><strong>${bib(r.bib_number)}</strong></td><td style="text-align:left;">${r.name}</td><td style="font-size:12px;">${r.team || ''}</td>${c}<td style="font-weight:700;">${bestDisp}</td><td style="${rmkStyle}">${rmk}</td></tr>`;
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
    const subEvents = await API.getCombinedSubEvents(evt.id);
    for (const sc of scores) {
        if (sc.raw_record > 0) {
            const def = subDefs.find(d => d.order === sc.sub_event_order);
            if (def && calcWAPoints(def.key, sc.raw_record) !== sc.wa_points) {
                await API.saveCombinedScore({ event_entry_id: sc.event_entry_id, sub_event_name: sc.sub_event_name, sub_event_order: sc.sub_event_order, raw_record: sc.raw_record, wa_points: calcWAPoints(def.key, sc.raw_record) });
            }
        }
    }
    const fresh = await API.getCombinedScores(evt.id);
    const day1Max = evt.gender === 'M' ? 5 : 4;
    let hdr = '<tr><th>RANK</th><th>BIB</th><th style="text-align:left;">선수명</th>';
    subDefs.forEach(se => {
        if (se.order === 1) hdr += '<th style="font-size:9px;padding:3px 4px;background:#e8ecf4;color:#1a2a5e;font-weight:700;border-left:3px solid #1a2a5e;">DAY 1</th>';
        if (se.order === day1Max + 1) hdr += '<th style="font-size:9px;padding:3px 4px;background:#f4e8ec;color:#8b1a2a;font-weight:700;border-left:3px solid #8b1a2a;">DAY 2</th>';
        const bg = se.order <= day1Max ? 'background:#eef1f7;' : 'background:#f7f0f2;';
        hdr += `<th style="font-size:9px;padding:3px 2px;writing-mode:vertical-lr;max-width:26px;${bg}">${se.name}</th>`;
    });
    hdr += '<th>총점</th></tr>';
    document.getElementById('results-thead').innerHTML = hdr;
    const rows = allEntries.map(e => {
        let t = 0; const pts = {}, recs = {};
        subDefs.forEach(se => { const sc = fresh.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order); pts[se.order] = sc ? sc.wa_points : 0; recs[se.order] = sc ? sc.raw_record : null; t += pts[se.order]; });
        return { ...e, pts, recs, total: t };
    }).sort((a, b) => b.total - a.total);
    let rk = 1; rows.forEach((r, i) => { r.rank = (i > 0 && rows[i-1].total === r.total) ? rows[i-1].rank : rk; rk = i + 2; });
    document.getElementById('results-tbody').innerHTML = rows.map(r => {
        const medal = getMedal(r.rank, rSelectedEvent?.round_type);
        let c = '';
        subDefs.forEach(se => {
            const rec = r.recs[se.order], p = r.pts[se.order]; let d = '—';
            if (rec === 0 && p === 0) { d = '<div style="font-size:10px;color:var(--danger);font-weight:700;">NM</div><div style="font-size:10px;color:var(--text-muted);">0</div>'; }
            else if (rec && rec > 0) { const isHt = se.key && (se.key.includes('high_jump') || se.key.includes('pole_vault')); const rs = se.unit === 's' ? formatTime(rec) : formatHeight(rec); d = `<div style="font-size:10px;">${rs}</div><div style="font-size:10px;color:var(--green);font-weight:700;">${p}</div>`; }
            if (se.order === 1) c += '<td style="border-left:3px solid #1a2a5e;"></td>'; // Day1 spacer
            if (se.order === day1Max + 1) c += '<td style="border-left:3px solid #8b1a2a;"></td>'; // Day2 spacer
            c += `<td style="padding:2px 3px;line-height:1.2;">${d}</td>`;
        });
        return `<tr><td>${medal}</td><td><strong>${bib(r.bib_number)}</strong></td><td style="text-align:left;">${r.name}</td>${c}<td><span class="combined-total-points">${r.total > 0 ? r.total : '—'}</span></td></tr>`;
    }).join('');
    
    // Add sub-event detail tabs below the scoreboard
    const allArea = document.getElementById('results-all-area');
    if (allArea) {
        allArea.style.display = 'block';
        let tabsHtml = '<div style="margin-top:16px;border-top:2px solid var(--border);padding-top:12px;">';
        tabsHtml += '<h3 style="font-size:14px;margin-bottom:8px;">세부종목 기록</h3>';
        tabsHtml += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px;">';
        subDefs.forEach(se => {
            const has = fresh.some(s => s.sub_event_order === se.order && s.raw_record > 0);
            tabsHtml += `<button class="btn btn-sm ${has ? 'btn-outline' : 'btn-ghost'}" onclick="_showCombinedSubResult(${se.order})" id="csub-tab-${se.order}">${se.order}. ${se.name}${has ? ' ✓' : ''}</button>`;
        });
        tabsHtml += '</div>';
        tabsHtml += '<div id="combined-sub-result-area"></div>';
        tabsHtml += '</div>';
        allArea.innerHTML = tabsHtml;
        
        // Store data for sub-result rendering
        window._cResultData = { evt, subDefs, subEvents, fresh, allEntries, rows };
    }
}

// Render sub-event detail in results view
async function _showCombinedSubResult(subOrder) {
    const { evt, subDefs, subEvents, fresh, rows } = window._cResultData || {};
    if (!evt) return;
    const seDef = subDefs.find(se => se.order === subOrder);
    if (!seDef) return;
    
    // Highlight active tab
    subDefs.forEach(se => {
        const btn = document.getElementById(`csub-tab-${se.order}`);
        if (btn) btn.className = `btn btn-sm ${se.order === subOrder ? 'btn-primary' : (fresh.some(s => s.sub_event_order === se.order && s.raw_record > 0) ? 'btn-outline' : 'btn-ghost')}`;
    });
    
    const area = document.getElementById('combined-sub-result-area');
    if (!area) return;
    area.innerHTML = '<div class="loading-inline"><div class="loading-spinner"></div></div>';
    
    // Find the DB sub-event
    let dbSub = subEvents.find(s => s.sort_order === subOrder);
    if (!dbSub) dbSub = subEvents[subOrder - 1];
    if (!dbSub) { area.innerHTML = '<div class="empty-state">세부 종목을 찾을 수 없습니다.</div>'; return; }
    
    const subHeats = await API.getHeats(dbSub.id);
    if (subHeats.length === 0) { area.innerHTML = '<div class="empty-state">히트가 없습니다.</div>'; return; }
    
    const heatId = subHeats[0].id;
    const entries = await API.getHeatEntries(heatId);
    if (entries.length === 0) { area.innerHTML = '<div class="empty-state">선수가 없습니다.</div>'; return; }
    
    const cat = dbSub.category;
    
    if (cat === 'track') {
        const results = await API.getResults(heatId);
        _renderCombinedSubTrackResult(area, seDef, entries, results);
    } else if (cat === 'field_distance') {
        const results = await API.getResults(heatId);
        _renderCombinedSubFieldResult(area, seDef, entries, results);
    } else if (cat === 'field_height') {
        const attempts = await API.getHeightAttempts(heatId);
        _renderCombinedSubHeightResult(area, seDef, entries, attempts);
    } else {
        area.innerHTML = `<div class="empty-state">지원하지 않는 카테고리: ${cat}</div>`;
    }
}

function _renderCombinedSubTrackResult(area, seDef, entries, results) {
    const isLong = /1500|800|1000|3000|5000|10000|마라톤|10km|20km|half/i.test(seDef.name);
    const dataRows = entries.map(e => {
        const r = results.find(r => r.event_entry_id === e.event_entry_id);
        return { ...e, time_seconds: r ? r.time_seconds : null, status_code: r ? r.status_code : null };
    });
    dataRows.sort((a, b) => {
        if (a.status_code && !b.status_code) return 1;
        if (!a.status_code && b.status_code) return -1;
        if (a.time_seconds == null && b.time_seconds == null) return 0;
        if (a.time_seconds == null) return 1;
        if (b.time_seconds == null) return -1;
        return a.time_seconds - b.time_seconds;
    });
    let rk = 1;
    dataRows.forEach((r, i) => {
        if (r.status_code || r.time_seconds == null) r.rank = '';
        else { r.rank = (i > 0 && dataRows[i - 1].time_seconds === r.time_seconds) ? dataRows[i - 1].rank : rk; rk = i + 2; }
    });
    
    area.innerHTML = `
        <h4 style="margin:8px 0 4px;">${seDef.order}. ${seDef.name}</h4>
        <table class="data-table" style="font-size:13px;">
            <thead><tr><th style="width:50px;">순위</th><th style="width:60px;">BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th style="width:100px;">기록</th><th style="width:60px;">상태</th></tr></thead>
            <tbody>${dataRows.map(r => {
                const time = r.time_seconds != null ? formatTime(r.time_seconds) : '—';
                const sc = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : '';
                return `<tr class="${r.status_code ? 'row-status-code' : ''}">
                    <td>${r.status_code ? sc : (r.rank || '—')}</td><td><strong>${bib(r.bib_number)}</strong></td>
                    <td style="text-align:left;">${r.name}</td><td style="text-align:left;font-size:12px;">${r.team || ''}</td>
                    <td><strong>${r.status_code ? '—' : time}</strong></td><td>${sc}</td></tr>`;
            }).join('')}</tbody>
        </table>`;
}

function _renderCombinedSubFieldResult(area, seDef, entries, results) {
    const dataRows = entries.map(e => {
        const er = results.filter(r => r.event_entry_id === e.event_entry_id);
        const att = {};
        er.forEach(r => { if (r.attempt_number != null) att[r.attempt_number] = r.distance_meters; });
        let sc = null;
        er.forEach(r => { if (r.status_code) sc = r.status_code; });
        const valid = Object.values(att).filter(d => d != null && d > 0);
        const best = valid.length > 0 ? Math.max(...valid) : null;
        return { ...e, attempts: att, best, status_code: sc };
    });
    const ranked = dataRows.filter(r => r.best != null && !r.status_code).sort((a, b) => b.best - a.best);
    let rk = 1; ranked.forEach((r, i) => { r.rank = (i > 0 && ranked[i - 1].best === r.best) ? ranked[i - 1].rank : rk; rk = i + 2; });
    dataRows.forEach(r => { if (r.best == null || r.status_code) r.rank = null; else { const f = ranked.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; } });
    dataRows.sort((a, b) => {
        if (a.rank != null && b.rank != null) return a.rank - b.rank;
        if (a.rank != null) return -1;
        if (b.rank != null) return 1;
        return 0;
    });
    
    // Determine max attempts
    const maxAtt = Math.max(3, ...dataRows.map(r => Math.max(0, ...Object.keys(r.attempts).map(Number))));
    let attHeaders = '';
    for (let i = 1; i <= maxAtt; i++) attHeaders += `<th style="width:55px;">${i}차</th>`;
    
    area.innerHTML = `
        <h4 style="margin:8px 0 4px;">${seDef.order}. ${seDef.name}</h4>
        <table class="data-table" style="font-size:13px;">
            <thead><tr><th style="width:50px;">순위</th><th style="width:60px;">BIB</th><th style="text-align:left;">선수명</th>${attHeaders}<th style="width:70px;">최고</th></tr></thead>
            <tbody>${dataRows.map(r => {
                let cells = '';
                for (let i = 1; i <= maxAtt; i++) {
                    const v = r.attempts[i];
                    if (v === undefined || v === null) cells += '<td>—</td>';
                    else if (v === 0) cells += '<td><span class="foul-mark">X</span></td>';
                    else cells += `<td>${formatHeight(v)}</td>`;
                }
                const sc = r.status_code ? `<span class="sc-badge sc-${r.status_code}">${r.status_code}</span>` : '';
                const bestDisp = r.status_code ? sc : (r.best != null ? `<strong>${formatHeight(r.best)}</strong>` : '—');
                const rankDisp = r.status_code ? sc : (r.rank || '—');
                return `<tr class="${r.status_code ? 'row-status-code' : ''}">
                    <td>${rankDisp}</td><td><strong>${bib(r.bib_number)}</strong></td><td style="text-align:left;">${r.name}</td>${cells}<td>${bestDisp}</td></tr>`;
            }).join('')}</tbody>
        </table>`;
}

function _renderCombinedSubHeightResult(area, seDef, entries, attempts) {
    const heights = [...new Set(attempts.map(a => a.bar_height))].sort((a, b) => a - b);
    const dataRows = entries.map(e => {
        const ea = attempts.filter(a => a.event_entry_id === e.event_entry_id);
        const hd = {};
        ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
        let best = null, elim = false, totalFails = 0, failsAtBest = 0;
        heights.forEach(h => {
            const d = hd[h]; if (!d) return;
            const xCount = Object.values(d).filter(m => m === 'X').length;
            totalFails += xCount;
            if (Object.values(d).includes('O')) { best = h; failsAtBest = xCount; }
            if (xCount >= 3) elim = true;
        });
        return { ...e, heightData: hd, bestHeight: best, eliminated: elim, totalFails, failsAtBest };
    });
    const ranked = dataRows.filter(r => r.bestHeight != null).sort((a, b) => {
        if (b.bestHeight !== a.bestHeight) return b.bestHeight - a.bestHeight;
        if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
        return a.totalFails - b.totalFails;
    });
    let rk = 1; ranked.forEach((r, i) => {
        let isTied = i > 0 && ranked[i-1].bestHeight === r.bestHeight && ranked[i-1].failsAtBest === r.failsAtBest && ranked[i-1].totalFails === r.totalFails;
        r.rank = isTied ? ranked[i-1].rank : rk; rk = i + 2;
    });
    dataRows.forEach(r => { if (r.bestHeight == null) r.rank = null; else { const f = ranked.find(x => x.event_entry_id === r.event_entry_id); if (f) r.rank = f.rank; } });
    dataRows.sort((a, b) => {
        if (a.rank != null && b.rank != null) return a.rank - b.rank;
        if (a.rank != null) return -1;
        return 1;
    });
    
    let hdrCells = '';
    heights.forEach(h => { hdrCells += `<th style="font-size:10px;min-width:40px;">${formatHeight(h)}</th>`; });
    
    area.innerHTML = `
        <h4 style="margin:8px 0 4px;">${seDef.order}. ${seDef.name}</h4>
        <table class="data-table" style="font-size:13px;">
            <thead><tr><th>순위</th><th>BIB</th><th style="text-align:left;">선수명</th>${hdrCells}<th>최고</th><th>상태</th></tr></thead>
            <tbody>${dataRows.map(r => {
                let cells = '';
                heights.forEach(h => {
                    const hd = r.heightData[h] || {};
                    let marks = '';
                    for (let i = 1; i <= 3; i++) {
                        const m = hd[i] || '';
                        if (m === 'O') marks += '<span style="color:var(--green);font-weight:700;">O</span>';
                        else if (m === 'X') marks += '<span style="color:var(--danger);font-weight:700;">X</span>';
                        else if (m === 'PASS' || m === '-') marks += '<span style="color:#6b6b6b;font-weight:700;">-</span>';
                    }
                    cells += `<td style="font-size:11px;">${marks || '—'}</td>`;
                });
                const status = r.eliminated ? '<span style="color:var(--danger);">탈락</span>' : (r.bestHeight ? '<span style="color:var(--green);">완료</span>' : '—');
                return `<tr><td>${r.rank || '—'}</td><td><strong>${bib(r.bib_number)}</strong></td><td style="text-align:left;">${r.name}</td>${cells}<td><strong>${r.bestHeight ? formatHeight(r.bestHeight) : '—'}</strong></td><td>${status}</td></tr>`;
            }).join('')}</tbody>
        </table>`;
}

// ============================================================
// Helpers
// ============================================================
function getMedal(rank, roundType) {
    // Medal colors only for finals — use plain numbers in prelims/semis
    if (roundType && roundType !== 'final') return rank || '—';
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
    const gL = rSelectedEvent ? ({ M: '남자', F: '여자', X: '혼성' }[rSelectedEvent.gender] || '') : '';
    const roundL = rSelectedEvent ? fmtRound(rSelectedEvent.round_type) : '';
    const fileName = rSelectedEvent ? `${gL}_${rSelectedEvent.name}_${roundL}` : 'results';
    const wb = XLSX.utils.table_to_book(t, { sheet: '전체 결과' });
    XLSX.writeFile(wb, `${fileName}.xlsx`);
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

// ============================================================
// IO (아이오) — 1080×1350 PNG Result Image Generator
// ============================================================
const IO = (() => {
    const W = 1080, H = 1350;
    const MARGIN = 40;
    const MAX_PER_PAGE = 12;

    // Colors
    const C = {
        bg: '#ffffff',
        headerBg: '#f8fafc',
        headerBorder: '#e2e8f0',
        green: '#b79f58',
        greenDark: '#029a47',
        text: '#1a202c',
        textMuted: '#6b7280',
        textLight: '#9ca3af',
        border: '#e5e7eb',
        rowEven: '#f9fafb',
        rowOdd: '#ffffff',
        gold: '#FFD700',
        silver: '#C0C0C0',
        bronze: '#CD7F32',
        medalGoldBg: 'rgba(255,215,0,0.12)',
        medalSilverBg: 'rgba(192,192,192,0.10)',
        medalBronzeBg: 'rgba(205,127,50,0.10)',
        danger: '#ef4444',
        accent: '#6b6b6b',
        wind: '#0369a1',
    };

    // Font helpers (using system fonts — html2canvas captures from DOM)
    function font(size, weight = '400') {
        return `${weight} ${size}px "Noto Sans KR", "Pretendard", -apple-system, BlinkMacSystemFont, sans-serif`;
    }
    function monoFont(size, weight = '400') {
        return `${weight} ${size}px "SF Mono", "Fira Code", "Consolas", monospace`;
    }

    // Round rect helper
    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // Truncate text to fit width
    function truncate(ctx, text, maxW) {
        if (!text) return '';
        if (ctx.measureText(text).width <= maxW) return text;
        let t = text;
        while (t.length > 1 && ctx.measureText(t + '...').width > maxW) t = t.slice(0, -1);
        return t + '...';
    }

    // Draw medal circle
    function drawMedal(ctx, x, y, rank) {
        const r = 15;
        ctx.save();
        if (rank === 1) { ctx.fillStyle = C.gold; }
        else if (rank === 2) { ctx.fillStyle = C.silver; }
        else if (rank === 3) { ctx.fillStyle = C.bronze; }
        else { ctx.restore(); return false; }
        ctx.beginPath();
        ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
        ctx.fill();
        // Medal number
        ctx.fillStyle = rank === 1 ? '#7c5e00' : rank === 2 ? '#4a4a4a' : '#5c3600';
        ctx.font = font(16, '700');
        ctx.textAlign = 'center';
        ctx.fillText(String(rank), x + r, y + r + 5.5);
        ctx.textAlign = 'left';
        ctx.restore();
        return true;
    }

    // Format time for display
    function fmtTime(s, isRoad) {
        if (s == null) return '—';
        if (isRoad || s >= 3600) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s - h * 3600) / 60);
            const r = s - h * 3600 - m * 60;
            return `${h}:${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
        }
        if (s >= 60) {
            const m = Math.floor(s / 60);
            const r = s - m * 60;
            return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
        }
        return s.toFixed(2);
    }

    // Determine if event needs wind display for image
    function needsWindForImage(eventName, category) {
        return requiresWindMeasurement(eventName, category);
    }

    // Build filename
    function buildFileName(evt, compInfo, roundLabel, pageIdx, totalPages, format) {
        const ext = format === 'jpg' ? 'jpg' : 'png';
        const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
        const today = new Date().toISOString().slice(0, 10);
        const base = `${evt.name}${gL}_${roundLabel}_${today}`;
        if (totalPages > 1) return `${base}_${pageIdx + 1}.${ext}`;
        return `${base}.${ext}`;
    }

    // ============================================================
    // Draw Header (common for all pages)
    // ============================================================
    function drawHeader(ctx, evt, compInfo, roundLabel, heatLabel, windInfo) {
        const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';

        // Top accent bar
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, C.green);
        grad.addColorStop(1, C.greenDark);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, 6);

        let y = 32;

        // Competition name
        ctx.fillStyle = C.textMuted;
        ctx.font = font(20, '500');
        ctx.fillText(truncate(ctx, compInfo.name || '', W - MARGIN * 2), MARGIN, y + 20);
        y += 36;

        // Event name (large)
        ctx.fillStyle = C.text;
        ctx.font = font(38, '800');
        ctx.fillText(truncate(ctx, `${evt.name} ${gL}`, W - MARGIN * 2), MARGIN, y + 38);
        y += 56;

        // Round + date line
        const today = new Date();
        const dateStr = `${today.getFullYear()}. ${today.getMonth() + 1}. ${today.getDate()}.`;
        ctx.fillStyle = C.textMuted;
        ctx.font = font(18, '500');
        let infoLine = roundLabel;
        if (heatLabel) infoLine += ` ${heatLabel}`;
        infoLine += `  |  ${dateStr}`;
        ctx.fillText(infoLine, MARGIN, y + 18);

        // Wind info (right-aligned on same line)
        if (windInfo) {
            ctx.save();
            ctx.font = font(17, '600');
            ctx.fillStyle = C.wind;
            const wText = `Wind: ${windInfo} m/s`;
            const ww = ctx.measureText(wText).width;
            ctx.fillText(wText, W - MARGIN - ww, y + 18);
            ctx.restore();
        }
        y += 36;

        // Separator line
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(MARGIN, y);
        ctx.lineTo(W - MARGIN, y);
        ctx.stroke();

        return y + 12;
    }

    // ============================================================
    // Draw Footer
    // ============================================================
    function drawFooter(ctx, pageIdx, totalPages) {
        const footerY = H - 50;
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(0, footerY, W, 50);
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, footerY); ctx.lineTo(W, footerY); ctx.stroke();

        // PACE RISE branding
        ctx.fillStyle = C.green;
        ctx.font = font(14, '700');
        ctx.fillText('PACE RISE', MARGIN, footerY + 30);

        // Page indicator
        if (totalPages > 1) {
            ctx.fillStyle = C.textMuted;
            ctx.font = font(13, '500');
            const pageTxt = `${pageIdx + 1} / ${totalPages} 페이지`;
            const pw = ctx.measureText(pageTxt).width;
            ctx.fillText(pageTxt, W / 2 - pw / 2, footerY + 30);
        }

        // URL
        ctx.fillStyle = C.textLight;
        ctx.font = font(11, '400');
        const url = 'pace-rise-node.com';
        const uw = ctx.measureText(url).width;
        ctx.fillText(url, W - MARGIN - uw, footerY + 30);
    }

    // ============================================================
    // Track Table Drawing
    // ============================================================
    function drawTrackTable(ctx, rows, startY, showWind, windValue, isFinal) {
        const tableLeft = MARGIN;
        const tableRight = W - MARGIN;
        const tableW = tableRight - tableLeft;
        // Columns: RANK / NO. / BIB / 선수명 / 소속 / 기록 / 비고
        const cols = showWind
            ? [
                { key: 'rank', label: 'RANK', w: 0.07, align: 'center' },
                { key: 'lane', label: 'NO.', w: 0.05, align: 'center' },
                { key: 'bib', label: 'BIB', w: 0.07, align: 'center' },
                { key: 'name', label: '선수명', w: 0.25, align: 'left' },
                { key: 'team', label: '소속', w: 0.22, align: 'left' },
                { key: 'record', label: '기록', w: 0.19, align: 'center' },
                { key: 'remark', label: '비고', w: 0.15, align: 'center' },
            ]
            : [
                { key: 'rank', label: 'RANK', w: 0.07, align: 'center' },
                { key: 'lane', label: 'NO.', w: 0.05, align: 'center' },
                { key: 'bib', label: 'BIB', w: 0.08, align: 'center' },
                { key: 'name', label: '선수명', w: 0.27, align: 'left' },
                { key: 'team', label: '소속', w: 0.24, align: 'left' },
                { key: 'record', label: '기록', w: 0.18, align: 'center' },
                { key: 'remark', label: '비고', w: 0.11, align: 'center' },
            ];

        let y = startY;
        const headerH = 40;
        const rowH = 58;

        // Column positions
        let cx = tableLeft;
        const colPos = cols.map(c => { const pos = { ...c, x: cx, pw: tableW * c.w }; cx += pos.pw; return pos; });

        // Header row
        ctx.fillStyle = '#edf2f7';
        roundRect(ctx, tableLeft, y, tableW, headerH, 8);
        ctx.fill();
        ctx.font = font(14, '700');
        ctx.fillStyle = '#475569';
        for (const cp of colPos) {
            const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 8;
            ctx.textAlign = cp.align === 'center' ? 'center' : 'left';
            ctx.fillText(cp.label, tx, y + headerH / 2 + 5);
        }
        ctx.textAlign = 'left';
        y += headerH + 2;

        // Data rows
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const isSpecial = ['DNS', 'DNF', 'DQ', 'NM'].includes(r.status_code);
            const rank = r.rank;
            const isMedal = isFinal && typeof rank === 'number' && rank >= 1 && rank <= 3;

            // Row background
            if (isMedal) {
                ctx.fillStyle = rank === 1 ? C.medalGoldBg : rank === 2 ? C.medalSilverBg : C.medalBronzeBg;
            } else {
                ctx.fillStyle = i % 2 === 0 ? C.rowOdd : C.rowEven;
            }
            roundRect(ctx, tableLeft, y, tableW, rowH, i === 0 ? 0 : 0);
            ctx.fill();

            // Row border bottom
            ctx.strokeStyle = '#f0f0f0';
            ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(tableLeft, y + rowH); ctx.lineTo(tableRight, y + rowH); ctx.stroke();

            const cellY = y + rowH / 2 + 6;

            for (const cp of colPos) {
                const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 8;
                ctx.textAlign = cp.align === 'center' ? 'center' : 'left';

                switch (cp.key) {
                    case 'rank':
                        if (isSpecial) {
                            ctx.fillStyle = C.danger;
                            ctx.font = font(16, '700');
                            ctx.fillText(r.status_code, tx, cellY);
                        } else if (isMedal) {
                            drawMedal(ctx, cp.x + cp.pw / 2 - 15, y + rowH / 2 - 15, rank);
                        } else if (typeof rank === 'number') {
                            ctx.fillStyle = C.text;
                            ctx.font = font(18, '700');
                            ctx.fillText(String(rank), tx, cellY);
                        } else {
                            ctx.fillStyle = C.textLight;
                            ctx.font = font(16, '400');
                            ctx.fillText('—', tx, cellY);
                        }
                        break;
                    case 'lane':
                        ctx.fillStyle = C.textMuted;
                        ctx.font = font(15, '500');
                        ctx.fillText(r.lane_number || '—', tx, cellY);
                        break;
                    case 'bib':
                        ctx.fillStyle = C.text;
                        ctx.font = font(16, '700');
                        ctx.fillText(r.bib_number || '—', tx, cellY);
                        break;
                    case 'name':
                        ctx.fillStyle = isSpecial ? C.textLight : C.text;
                        ctx.font = font(17, '600');
                        ctx.fillText(truncate(ctx, r.name || '', cp.pw - 12), tx, cellY);
                        break;
                    case 'team':
                        ctx.fillStyle = C.textMuted;
                        ctx.font = font(14, '400');
                        ctx.fillText(truncate(ctx, r.team || '', cp.pw - 12), tx, cellY);
                        break;
                    case 'record':
                        if (isSpecial) {
                            ctx.fillStyle = C.danger;
                            ctx.font = font(17, '700');
                            ctx.fillText(r.status_code, tx, cellY);
                        } else if (r.time_seconds != null) {
                            ctx.fillStyle = isMedal ? C.greenDark : C.text;
                            ctx.font = monoFont(18, '700');
                            ctx.fillText(fmtTime(r.time_seconds, r._isRoad), tx, cellY);
                        } else {
                            ctx.fillStyle = C.textLight;
                            ctx.font = font(15, '400');
                            ctx.fillText('—', tx, cellY);
                        }
                        break;
                    case 'remark':
                        ctx.fillStyle = C.textLight;
                        ctx.font = font(12, '400');
                        ctx.fillText(truncate(ctx, r.remark || '', cp.pw - 8), tx, cellY);
                        break;
                }
            }
            ctx.textAlign = 'left';
            y += rowH;
        }
        return y;
    }

    // ============================================================
    // Field Distance Table Drawing
    // ============================================================
    function drawFieldDistTable(ctx, rows, startY, showWind, isFinal) {
        const tableLeft = MARGIN;
        const tableRight = W - MARGIN;
        const tableW = tableRight - tableLeft;
        const cols = [
            { key: 'rank', label: 'RANK', w: 0.07, align: 'center' },
            { key: 'bib', label: 'BIB', w: 0.07, align: 'center' },
            { key: 'name', label: '선수명', w: 0.22, align: 'left' },
            { key: 'team', label: '소속', w: 0.20, align: 'left' },
            { key: 'best', label: '최고기록', w: 0.15, align: 'center' },
            { key: 'remark', label: '비고', w: 0.29, align: 'center' },
        ];

        let y = startY;
        const headerH = 40;
        const rowH = 58;

        let cx = tableLeft;
        const colPos = cols.map(c => { const pos = { ...c, x: cx, pw: tableW * c.w }; cx += pos.pw; return pos; });

        // Header
        ctx.fillStyle = '#edf2f7';
        roundRect(ctx, tableLeft, y, tableW, headerH, 8);
        ctx.fill();
        ctx.font = font(14, '700');
        ctx.fillStyle = '#475569';
        for (const cp of colPos) {
            const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 8;
            ctx.textAlign = cp.align === 'center' ? 'center' : 'left';
            ctx.fillText(cp.label, tx, y + headerH / 2 + 5);
        }
        ctx.textAlign = 'left';
        y += headerH + 2;

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const isSpecial = ['DNS', 'DNF', 'DQ', 'NM'].includes(r.status_code);
            const rank = r.rank;
            const isMedal = isFinal && typeof rank === 'number' && rank >= 1 && rank <= 3;

            if (isMedal) {
                ctx.fillStyle = rank === 1 ? C.medalGoldBg : rank === 2 ? C.medalSilverBg : C.medalBronzeBg;
            } else {
                ctx.fillStyle = i % 2 === 0 ? C.rowOdd : C.rowEven;
            }
            roundRect(ctx, tableLeft, y, tableW, rowH, 0);
            ctx.fill();
            ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(tableLeft, y + rowH); ctx.lineTo(tableRight, y + rowH); ctx.stroke();

            const cellY = y + rowH / 2 + 6;

            for (const cp of colPos) {
                const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 8;
                ctx.textAlign = cp.align === 'center' ? 'center' : 'left';
                switch (cp.key) {
                    case 'rank':
                        if (isSpecial) { ctx.fillStyle = C.danger; ctx.font = font(16, '700'); ctx.fillText(r.status_code, tx, cellY); }
                        else if (isMedal) { drawMedal(ctx, cp.x + cp.pw / 2 - 15, y + rowH / 2 - 15, rank); }
                        else if (typeof rank === 'number') { ctx.fillStyle = C.text; ctx.font = font(18, '700'); ctx.fillText(String(rank), tx, cellY); }
                        else { ctx.fillStyle = C.textLight; ctx.font = font(16, '400'); ctx.fillText('—', tx, cellY); }
                        break;
                    case 'bib': ctx.fillStyle = C.text; ctx.font = font(16, '700'); ctx.fillText(r.bib_number || '—', tx, cellY); break;
                    case 'name': ctx.fillStyle = isSpecial ? C.textLight : C.text; ctx.font = font(17, '600'); ctx.fillText(truncate(ctx, r.name || '', cp.pw - 12), tx, cellY); break;
                    case 'team': ctx.fillStyle = C.textMuted; ctx.font = font(14, '400'); ctx.fillText(truncate(ctx, r.team || '', cp.pw - 12), tx, cellY); break;
                    case 'best':
                        if (isSpecial) { ctx.fillStyle = C.danger; ctx.font = font(17, '700'); ctx.fillText(r.status_code, tx, cellY); }
                        else if (r.best != null) {
                            ctx.fillStyle = isMedal ? C.greenDark : C.text;
                            ctx.font = monoFont(18, '700');
                            ctx.fillText(formatHeight(r.best), tx, cellY);
                            // Wind of best (if applicable)
                            if (showWind && r.bestWind != null) {
                                ctx.fillStyle = C.wind;
                                ctx.font = font(11, '500');
                                ctx.fillText(`(${formatWind(r.bestWind)})`, tx, cellY + 16);
                            }
                        } else { ctx.fillStyle = C.textLight; ctx.font = font(15, '400'); ctx.fillText('—', tx, cellY); }
                        break;
                    case 'remark':
                        ctx.fillStyle = C.textLight; ctx.font = font(12, '400');
                        // Show attempt summary
                        if (r.attempts) {
                            let attStr = '';
                            for (let a = 1; a <= 6; a++) {
                                const v = r.attempts[a];
                                if (v === undefined || v === null) continue;
                                if (v === 0) attStr += 'X ';
                                else if (v < 0) attStr += '- ';
                                else attStr += formatHeight(v) + ' ';
                            }
                            ctx.fillText(truncate(ctx, attStr.trim(), cp.pw - 8), tx, cellY);
                        }
                        break;
                }
            }
            ctx.textAlign = 'left';
            y += rowH;
        }
        return y;
    }

    // ============================================================
    // Field Height Table Drawing
    // ============================================================
    function drawFieldHeightTable(ctx, rows, heights, startY, isFinal) {
        const tableLeft = MARGIN;
        const tableRight = W - MARGIN;
        const tableW = tableRight - tableLeft;
        
        // Dynamic columns based on number of heights
        const fixedW = 0.07 + 0.07 + 0.20 + 0.18 + 0.12; // rank+bib+name+team+best = 0.64
        const remainW = 1.0 - fixedW;
        const barW = heights.length > 0 ? Math.min(remainW / heights.length, 0.08) : 0.06;
        
        const cols = [
            { key: 'rank', label: 'RANK', w: 0.07, align: 'center' },
            { key: 'bib', label: 'BIB', w: 0.07, align: 'center' },
            { key: 'name', label: '선수명', w: 0.20, align: 'left' },
            { key: 'team', label: '소속', w: 0.18, align: 'left' },
        ];
        for (const h of heights) {
            cols.push({ key: `h_${h}`, label: formatHeight(h), w: barW, align: 'center' });
        }
        cols.push({ key: 'best', label: '최고', w: 0.12, align: 'center' });

        let y = startY;
        const headerH = 40;
        const rowH = 50;

        let cx = tableLeft;
        const colPos = cols.map(c => { const pos = { ...c, x: cx, pw: tableW * c.w }; cx += pos.pw; return pos; });

        // Header
        ctx.fillStyle = '#edf2f7';
        roundRect(ctx, tableLeft, y, tableW, headerH, 8);
        ctx.fill();
        ctx.font = font(heights.length > 6 ? 10 : 12, '700');
        ctx.fillStyle = '#475569';
        for (const cp of colPos) {
            const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 6;
            ctx.textAlign = cp.align === 'center' ? 'center' : 'left';
            ctx.fillText(cp.label, tx, y + headerH / 2 + 4);
        }
        ctx.textAlign = 'left';
        y += headerH + 2;

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const rank = r.rank;
            const isMedal = isFinal && typeof rank === 'number' && rank >= 1 && rank <= 3;

            if (isMedal) {
                ctx.fillStyle = rank === 1 ? C.medalGoldBg : rank === 2 ? C.medalSilverBg : C.medalBronzeBg;
            } else {
                ctx.fillStyle = i % 2 === 0 ? C.rowOdd : C.rowEven;
            }
            roundRect(ctx, tableLeft, y, tableW, rowH, 0);
            ctx.fill();
            ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(tableLeft, y + rowH); ctx.lineTo(tableRight, y + rowH); ctx.stroke();

            const cellY = y + rowH / 2 + 5;

            for (const cp of colPos) {
                const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 6;
                ctx.textAlign = cp.align === 'center' ? 'center' : 'left';
                if (cp.key === 'rank') {
                    if (isMedal) { drawMedal(ctx, cp.x + cp.pw / 2 - 15, y + rowH / 2 - 15, rank); }
                    else if (typeof rank === 'number') { ctx.fillStyle = C.text; ctx.font = font(16, '700'); ctx.fillText(String(rank), tx, cellY); }
                    else { ctx.fillStyle = C.textLight; ctx.font = font(14, '400'); ctx.fillText('—', tx, cellY); }
                } else if (cp.key === 'bib') {
                    ctx.fillStyle = C.text; ctx.font = font(14, '700'); ctx.fillText(r.bib_number || '—', tx, cellY);
                } else if (cp.key === 'name') {
                    ctx.fillStyle = C.text; ctx.font = font(15, '600'); ctx.fillText(truncate(ctx, r.name || '', cp.pw - 10), tx, cellY);
                } else if (cp.key === 'team') {
                    ctx.fillStyle = C.textMuted; ctx.font = font(12, '400'); ctx.fillText(truncate(ctx, r.team || '', cp.pw - 10), tx, cellY);
                } else if (cp.key === 'best') {
                    if (r.bestHeight != null) {
                        ctx.fillStyle = isMedal ? C.greenDark : C.text;
                        ctx.font = monoFont(16, '700');
                        ctx.fillText(formatHeight(r.bestHeight), tx, cellY);
                    } else { ctx.fillStyle = C.textLight; ctx.font = font(13, '400'); ctx.fillText('—', tx, cellY); }
                } else if (cp.key.startsWith('h_')) {
                    const bh = parseFloat(cp.key.substring(2));
                    const marks = r.heightMarks?.[bh] || '';
                    if (marks) {
                        ctx.font = font(heights.length > 8 ? 10 : 12, '700');
                        // Color-code marks
                        let markX = cp.x + 2;
                        for (const ch of marks) {
                            ctx.fillStyle = ch === 'O' ? C.green : ch === 'X' ? C.danger : C.accent;
                            const display = ch === 'PASS' ? '-' : ch;
                            ctx.textAlign = 'left';
                            ctx.fillText(display, markX, cellY);
                            markX += ctx.measureText(display).width + 1;
                        }
                    }
                }
            }
            ctx.textAlign = 'left';
            y += rowH;
        }
        return y;
    }

    // ============================================================
    // Combined (10종/7종) Table Drawing
    // ============================================================
    function drawCombinedTable(ctx, rows, subDefs, startY, isFinal) {
        const tableLeft = MARGIN;
        const tableRight = W - MARGIN;
        const tableW = tableRight - tableLeft;

        const cols = [
            { key: 'rank', label: 'RANK', w: 0.06, align: 'center' },
            { key: 'bib', label: 'BIB', w: 0.06, align: 'center' },
            { key: 'name', label: '선수명', w: 0.17, align: 'left' },
            { key: 'team', label: '소속', w: 0.15, align: 'left' },
        ];
        const subW = Math.min(0.06, (0.45 / Math.max(subDefs.length, 1)));
        for (const se of subDefs) {
            const shortName = se.name.length > 4 ? se.name.substring(0, 4) : se.name;
            cols.push({ key: `sub_${se.order}`, label: shortName, w: subW, align: 'center' });
        }
        cols.push({ key: 'total', label: '총점', w: 0.10, align: 'center' });

        let y = startY;
        const headerH = 38;
        const rowH = 55;

        let cx = tableLeft;
        const colPos = cols.map(c => { const pos = { ...c, x: cx, pw: tableW * c.w }; cx += pos.pw; return pos; });

        // Header
        ctx.fillStyle = '#edf2f7';
        roundRect(ctx, tableLeft, y, tableW, headerH, 8);
        ctx.fill();
        ctx.font = font(subDefs.length > 8 ? 9 : 11, '700');
        ctx.fillStyle = '#475569';
        for (const cp of colPos) {
            const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 4;
            ctx.textAlign = cp.align === 'center' ? 'center' : 'left';
            ctx.fillText(cp.label, tx, y + headerH / 2 + 4);
        }
        ctx.textAlign = 'left';
        y += headerH + 2;

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const rank = r.rank;
            const isMedal = isFinal && typeof rank === 'number' && rank >= 1 && rank <= 3;

            if (isMedal) {
                ctx.fillStyle = rank === 1 ? C.medalGoldBg : rank === 2 ? C.medalSilverBg : C.medalBronzeBg;
            } else {
                ctx.fillStyle = i % 2 === 0 ? C.rowOdd : C.rowEven;
            }
            roundRect(ctx, tableLeft, y, tableW, rowH, 0);
            ctx.fill();
            ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(tableLeft, y + rowH); ctx.lineTo(tableRight, y + rowH); ctx.stroke();

            const cellY = y + rowH / 2 + 4;

            for (const cp of colPos) {
                const tx = cp.align === 'center' ? cp.x + cp.pw / 2 : cp.x + 4;
                ctx.textAlign = cp.align === 'center' ? 'center' : 'left';
                if (cp.key === 'rank') {
                    if (isMedal) { drawMedal(ctx, cp.x + cp.pw / 2 - 13, y + rowH / 2 - 13, rank); }
                    else if (typeof rank === 'number') { ctx.fillStyle = C.text; ctx.font = font(16, '700'); ctx.fillText(String(rank), tx, cellY); }
                    else { ctx.fillStyle = C.textLight; ctx.font = font(14, '400'); ctx.fillText('—', tx, cellY); }
                } else if (cp.key === 'bib') {
                    ctx.fillStyle = C.text; ctx.font = font(14, '700'); ctx.fillText(r.bib_number || '—', tx, cellY);
                } else if (cp.key === 'name') {
                    ctx.fillStyle = C.text; ctx.font = font(14, '600'); ctx.fillText(truncate(ctx, r.name || '', cp.pw - 8), tx, cellY);
                } else if (cp.key === 'team') {
                    ctx.fillStyle = C.textMuted; ctx.font = font(12, '400'); ctx.fillText(truncate(ctx, r.team || '', cp.pw - 8), tx, cellY);
                } else if (cp.key === 'total') {
                    ctx.fillStyle = isMedal ? C.greenDark : C.text;
                    ctx.font = font(18, '800');
                    ctx.fillText(r.total > 0 ? String(r.total) : '—', tx, cellY);
                } else if (cp.key.startsWith('sub_')) {
                    const order = parseInt(cp.key.substring(4));
                    const pts = r.pts?.[order];
                    if (pts && pts > 0) {
                        ctx.fillStyle = C.green; ctx.font = font(11, '700');
                        ctx.fillText(String(pts), tx, cellY);
                    } else {
                        ctx.fillStyle = C.textLight; ctx.font = font(10, '400');
                        ctx.fillText('—', tx, cellY);
                    }
                }
            }
            ctx.textAlign = 'left';
            y += rowH;
        }
        return y;
    }

    // ============================================================
    // Main Generate Function
    // ============================================================
    async function generate(format) {
        format = format || 'png';
        if (!rSelectedEvent) { alert('종목을 선택하세요.'); return; }
        const evt = rSelectedEvent;
        const cat = evt.category;
        const compInfo = await API.getCompetitionInfo(getCompetitionId()).catch(() => ({ name: '', venue: '' }));
        const gL = { M: '남자', F: '여자', X: '혼성' }[evt.gender] || '';
        const roundLabel = fmtRound(evt.round_type);
        const isFinal = evt.round_type === 'final';
        const isRoad = isRoadEvent(evt.name);
        const showWind = needsWindForImage(evt.name, cat);

        // Collect data based on category
        let allRows = [];
        let heights = []; // for field_height
        let windValue = null;
        let heatLabel = '';
        let subDefs = []; // for combined

        if (cat === 'combined') {
            // Combined event
            await API.syncCombinedScores(evt.id);
            const scores = await API.getCombinedScores(evt.id);
            subDefs = evt.gender === 'M' ? DECATHLON_EVENTS : HEPTATHLON_EVENTS;
            const allEntries = await API.getEventEntries(evt.id);

            allRows = allEntries.map(e => {
                let t = 0; const pts = {};
                subDefs.forEach(se => {
                    const sc = scores.find(s => s.event_entry_id === e.event_entry_id && s.sub_event_order === se.order);
                    pts[se.order] = sc ? (sc.wa_points || 0) : 0;
                    t += pts[se.order];
                });
                return { ...e, pts, total: t };
            }).sort((a, b) => b.total - a.total);
            let rk = 1;
            allRows.forEach((r, i) => { r.rank = (i > 0 && allRows[i - 1].total === r.total) ? allRows[i - 1].rank : rk; rk = i + 2; });

        } else if (cat === 'field_height') {
            const heats = await API.getHeats(evt.id);
            const heat = heats[0];
            if (!heat) { alert('히트 데이터가 없습니다.'); return; }
            const entries = await API.getHeatEntries(heat.id);
            const ha = await API.getHeightAttempts(heat.id);
            heights = [...new Set(ha.map(a => a.bar_height))].sort((a, b) => a - b);

            allRows = entries.map(e => {
                const ea = ha.filter(a => a.event_entry_id === e.event_entry_id);
                const hd = {};
                ea.forEach(a => { if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
                let bestHeight = null;
                const heightMarks = {};
                for (const h of heights) {
                    const d = hd[h];
                    if (d) {
                        let marks = '';
                        for (let i = 1; i <= 3; i++) { if (d[i]) marks += d[i] === 'PASS' ? '-' : d[i]; }
                        heightMarks[h] = marks;
                        if (Object.values(d).includes('O')) bestHeight = h;
                    }
                }
                // WA tie-break: failsAtBest, totalFails
                let totalFails = 0, failsAtBest = 0;
                for (const h of heights) {
                    const d = hd[h]; if (!d) continue;
                    const xCount = Object.values(d).filter(m => m === 'X').length;
                    totalFails += xCount;
                    if (Object.values(d).includes('O')) failsAtBest = xCount;
                }
                return { ...e, bestHeight, heightMarks, totalFails, failsAtBest };
            }).sort((a, b) => {
                if (a.bestHeight == null && b.bestHeight == null) return 0;
                if (a.bestHeight == null) return 1;
                if (b.bestHeight == null) return -1;
                if (b.bestHeight !== a.bestHeight) return b.bestHeight - a.bestHeight;
                if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
                return a.totalFails - b.totalFails;
            });
            let rk = 1;
            allRows.forEach((r, i) => {
                if (r.bestHeight == null) { r.rank = null; rk = i + 2; return; }
                let isTied = i > 0 && allRows[i-1].bestHeight === r.bestHeight && allRows[i-1].failsAtBest === r.failsAtBest && allRows[i-1].totalFails === r.totalFails;
                r.rank = isTied ? allRows[i-1].rank : rk;
                rk = i + 2;
            });

        } else if (cat === 'field_distance') {
            const heats = await API.getHeats(evt.id);
            const heat = heats[0];
            if (!heat) { alert('히트 데이터가 없습니다.'); return; }
            const entries = await API.getHeatEntries(heat.id);
            const results = await API.getResults(heat.id);

            allRows = entries.map(e => {
                const er = results.filter(r => r.event_entry_id === e.event_entry_id);
                const att = {}, attWind = {};
                er.forEach(r => { if (r.attempt_number) { att[r.attempt_number] = r.distance_meters; attWind[r.attempt_number] = r.wind; } });
                const valid = Object.values(att).filter(d => d > 0);
                const best = valid.length > 0 ? Math.max(...valid) : null;
                let bestWind = null;
                if (best != null) { for (let i = 6; i >= 1; i--) { if (att[i] === best) { bestWind = attWind[i]; break; } } }
                let status = er.find(r => r.status_code && ['DNS', 'DNF', 'NM', 'DQ'].includes(r.status_code))?.status_code || '';
                if (!status && e.status === 'no_show') status = 'DNS';
                return { ...e, attempts: att, best, bestWind, status_code: status };
            }).sort((a, b) => {
                const aS = ['DNS', 'DNF', 'DQ', 'NM'].includes(a.status_code);
                const bS = ['DNS', 'DNF', 'DQ', 'NM'].includes(b.status_code);
                if (aS && !bS) return 1; if (!aS && bS) return -1;
                if (a.best == null && b.best == null) return 0;
                if (a.best == null) return 1; if (b.best == null) return -1;
                return b.best - a.best;
            });
            let rk = 1;
            allRows.forEach((r, i) => {
                if (r.best == null || ['DNS', 'DNF', 'DQ', 'NM'].includes(r.status_code)) { r.rank = null; rk = i + 2; return; }
                r.rank = (i > 0 && allRows[i - 1].best === r.best) ? allRows[i - 1].rank : rk;
                rk = i + 2;
            });

        } else {
            // Track / Relay / Road — gather from all heats (unified ranking)
            const heats = await API.getHeats(evt.id);
            const heatWindMap = {};
            if (showWind) {
                heats.forEach(h => { if (h.wind != null) { const w = parseFloat(h.wind); if (!isNaN(w)) heatWindMap[h.id] = w; } });
            }
            for (const heat of heats) {
                const entries = await API.getHeatEntries(heat.id);
                const results = await API.getResults(heat.id);
                entries.forEach(e => {
                    const r = results.find(r => r.event_entry_id === e.event_entry_id);
                    allRows.push({
                        ...e,
                        time_seconds: r ? r.time_seconds : null,
                        status_code: r ? (r.status_code || '') : '',
                        remark: r ? (r.remark || '') : '',
                        heat_number: heat.heat_number,
                        heat_id: heat.id,
                        _isRoad: isRoad,
                    });
                });
                if (heats.length === 1 && heatWindMap[heat.id] != null) {
                    windValue = formatWind(heatWindMap[heat.id]);
                }
                if (heats.length === 1) {
                    heatLabel = '';
                } else if (heats.length > 1) {
                    heatLabel = `${heats.length}개 조 통합`;
                }
            }

            allRows.sort((a, b) => {
                const aS = a.status_code && ['DNS', 'DNF', 'DQ', 'NM'].includes(a.status_code);
                const bS = b.status_code && ['DNS', 'DNF', 'DQ', 'NM'].includes(b.status_code);
                if (aS && !bS) return 1; if (!aS && bS) return -1;
                if (a.time_seconds == null && b.time_seconds == null) return 0;
                if (a.time_seconds == null) return 1; if (b.time_seconds == null) return -1;
                return a.time_seconds - b.time_seconds;
            });
            let rk = 1;
            allRows.forEach((r, i) => {
                if (r.status_code && ['DNS', 'DNF', 'DQ', 'NM'].includes(r.status_code)) { r.rank = r.status_code; return; }
                r.rank = r.time_seconds == null ? null : ((i > 0 && allRows[i - 1].time_seconds === r.time_seconds && !allRows[i - 1].status_code) ? allRows[i - 1].rank : rk);
                rk = i + 2;
            });
        }

        if (allRows.length === 0) { alert('데이터가 없습니다.'); return; }

        // Paginate
        const totalPages = Math.ceil(allRows.length / MAX_PER_PAGE);
        const canvases = [];

        for (let page = 0; page < totalPages; page++) {
            const pageRows = allRows.slice(page * MAX_PER_PAGE, (page + 1) * MAX_PER_PAGE);
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');

            // White background
            ctx.fillStyle = C.bg;
            ctx.fillRect(0, 0, W, H);

            // Header
            let y = drawHeader(ctx, evt, compInfo, roundLabel, heatLabel, showWind ? windValue : null);

            // Table
            if (cat === 'combined') {
                y = drawCombinedTable(ctx, pageRows, subDefs, y, isFinal);
            } else if (cat === 'field_height') {
                y = drawFieldHeightTable(ctx, pageRows, heights, y, isFinal);
            } else if (cat === 'field_distance') {
                y = drawFieldDistTable(ctx, pageRows, y, showWind, isFinal);
            } else {
                y = drawTrackTable(ctx, pageRows, y, showWind, windValue, isFinal);
            }

            // Footer
            drawFooter(ctx, page, totalPages);

            canvases.push(canvas);
        }

        // Download
        for (let i = 0; i < canvases.length; i++) {
            const fname = buildFileName(evt, compInfo, roundLabel, i, canvases.length, format);
            const a = document.createElement('a');
            a.download = fname;
            if (format === 'jpg') {
                a.href = canvases[i].toDataURL('image/jpeg', 0.95);
            } else {
                a.href = canvases[i].toDataURL('image/png');
            }
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Small delay between multiple downloads
            if (canvases.length > 1 && i < canvases.length - 1) {
                await new Promise(r => setTimeout(r, 300));
            }
        }
    }

    return { generate };
})();
