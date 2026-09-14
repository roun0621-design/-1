// ============================================================
// 필드 기록 입력 — 터치용 키패드 패널 (record-fieldpad.js)
// ------------------------------------------------------------
// 태블릿/폰(pointer: coarse)에서 필드 종목 입력 시, 표 안의 작은 인라인 입력창 대신
// 오른쪽(세로면 아래)에 큰 키패드 패널을 붙인다. 표는 그대로 두고(전체 판 확인용)
// 칸을 누르면 그 칸이 키패드 대상이 된다. 저장은 record.js 의 기존 저장 함수를 그대로 호출
// (saveFieldInline / fieldInlineFoul / fieldInlinePass / saveFieldWind / toggleHeightMark)
// 하므로 오프라인 큐·합동조·종합(10종/7종) 동기화가 동일하게 동작한다.
//
// 거리 종목: 시기 탭(1~6차) · 선택 칸 강조 · 숫자 키패드(724 → 7.24) · X 파울 / – 패스 ·
//           풍속 입력 · 저장 후 같은 시기 다음 순번으로 자동 이동 · 되돌리기(마지막 1건)
// 높이 종목: 현재 바 높이 · 선택 선수의 이번 높이 시도 · O / X / – 큰 버튼 · 다음 선수 자동 선택
// PC(마우스)는 기존 인라인 입력 그대로. 토글 버튼으로 켜고 끌 수 있고 설정은 기기에 저장.
// ============================================================
(function () {
    if (typeof state === 'undefined' || typeof renderFieldDistanceContent !== 'function') return;

    const LS_KEY = 'fe_pad_enabled';
    const isCoarse = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } };
    function padEnabled() {
        try { const v = localStorage.getItem(LS_KEY); if (v === '1') return true; if (v === '0') return false; } catch (e) {}
        return isCoarse();
    }
    function setPadEnabled(on) {
        try { localStorage.setItem(LS_KEY, on ? '1' : '0'); } catch (e) {}
        fe.sel = null; he.sel = null;
        if (state.selectedEvent && state.selectedEvent.category === 'field_height') renderHeightContent();
        else renderFieldDistanceContent();
    }
    window._fePadOn = padEnabled;
    window.fePadToggle = () => setPadEnabled(!padEnabled());

    // ─── 스타일 ───
    const css = document.createElement('style');
    css.textContent = `
        #field-content.fe-on, #height-content.fe-on { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:12px; align-items:start; }
        #field-content.fe-on > .sort-toggle-bar, #height-content.fe-on > .sort-toggle-bar, #field-content.fe-on > div[style*="border-left:3px"] { grid-column:1 / -1; }
        #field-content.fe-on .field-two-panel { grid-template-columns:1fr; }
        #field-content.fe-on .field-ranking-panel { display:none; }
        #field-content.fe-on .field-input-panel, #height-content.fe-on .height-scroll-wrap { overflow-x:auto; }
        .fe-pad { position:sticky; top:8px; background:#fff; border:1px solid #e9e4da; border-radius:14px; padding:12px 12px 14px; box-shadow:0 8px 24px rgba(30,20,0,.08); display:flex; flex-direction:column; gap:8px; }
        .fe-pad .fe-who { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
        .fe-pad .fe-who b { font-size:16px; font-weight:800; } .fe-pad .fe-who span { font-size:11px; color:#9a938d; white-space:nowrap; }
        .fe-pad .fe-empty { font-size:13px; color:#7a746e; background:#f6f4ef; border-radius:10px; padding:14px 12px; text-align:center; line-height:1.6; }
        .fe-pad .fe-val { font-family:'D2Coding', var(--font-mono, monospace); font-size:38px; font-weight:700; letter-spacing:.02em; background:#f6f4ef; border-radius:12px; padding:6px 14px; min-height:56px; display:flex; align-items:center; border:2px solid transparent; }
        .fe-pad .fe-val.focus { border-color:#b79f58; background:#fbf8ef; }
        .fe-pad .fe-val .cur { display:inline-block; width:3px; height:30px; background:#b79f58; margin-left:3px; animation:feBlink 1s steps(2) infinite; }
        @keyframes feBlink { 50% { opacity:0; } }
        .fe-pad .fe-wind { display:flex; align-items:center; gap:6px; }
        .fe-pad .fe-wind .wl { font-size:12px; color:#9a938d; width:34px; }
        .fe-pad .fe-wind .wv { flex:1; font-family:'D2Coding', var(--font-mono, monospace); font-size:20px; font-weight:700; background:#f6f4ef; border-radius:10px; padding:6px 12px; min-height:40px; display:flex; align-items:center; border:2px solid transparent; }
        .fe-pad .fe-wind .wv.focus { border-color:#b79f58; background:#fbf8ef; }
        .fe-pad .fe-wind button { height:44px; width:50px; border:1px solid #e9e4da; background:#fff; border-radius:10px; font-size:18px; font-weight:800; color:#262324; }
        .fe-keys { display:grid; grid-template-columns:repeat(4, 1fr); gap:7px; }
        .fe-keys button { height:56px; border:none; border-radius:12px; background:#f0ede6; font-family:'D2Coding', var(--font-mono, monospace); font-size:24px; font-weight:700; color:#262324; touch-action:manipulation; }
        .fe-keys button:active { background:#e4dfd3; }
        .fe-keys .fn { font-family:'Noto Sans KR', sans-serif; font-size:15px; font-weight:800; }
        .fe-keys .x { background:#fbeceb; color:#c0392b; } .fe-keys .pass { background:#f6f4ef; color:#5d5754; }
        .fe-keys .go { grid-row:span 2; background:#262324; color:#fff; font-family:'Noto Sans KR', sans-serif; font-size:16px; font-weight:800; line-height:1.3; }
        .fe-keys .go:disabled { opacity:.35; }
        .fe-pad .fe-hint { font-size:11px; color:#7a746e; line-height:1.5; }
        .fe-pad .fe-undo { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#9a938d; margin-top:2px; }
        .fe-pad .fe-undo b { color:#5d5754; } .fe-pad .fe-undo button { border:1px solid #e9e4da; background:#fff; border-radius:999px; padding:6px 12px; font-size:12px; font-weight:700; color:#5d5754; }
        .fe-pad .fe-close { position:absolute; top:8px; right:10px; border:none; background:none; color:#9a938d; font-size:16px; padding:4px; }
        .fe-tabs { display:flex; gap:5px; margin:0 0 8px; }
        .fe-tabs button { flex:1; min-width:0; border:1px solid #e9e4da; background:#fff; border-radius:8px; padding:8px 0; font-size:13px; font-weight:700; color:#5d5754; }
        .fe-tabs button.done { color:#9a938d; background:#f6f4ef; } .fe-tabs button.now { background:#262324; color:#fff; border-color:#262324; }
        #field-distance-table td.fe-now, #field-distance-table th.fe-now { background:#fffbe8 !important; }
        #field-distance-table td.fe-sel { box-shadow:inset 0 0 0 2px #b79f58; background:#f6f1e3 !important; border-radius:6px; }
        #field-distance-table td.attempt-cell { min-height:44px; }
        .height-toggle-table th.fe-now, .height-toggle-table td.fe-now { background:#fffbe8 !important; }
        .height-toggle-table tr.fe-selrow td { background:#f6f1e3 !important; }
        .fe-hbtns { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
        .fe-hbtns button { height:84px; border-radius:14px; border:2px solid #e9e4da; background:#fff; font-size:30px; font-weight:800; color:#5d5754; touch-action:manipulation; }
        .fe-hbtns .o { color:#2e7d32; border-color:#2e7d32; background:#eaf5eb; } .fe-hbtns .x { color:#c0392b; border-color:#c0392b; background:#fbeceb; }
        .fe-hbtns button:disabled { opacity:.35; }
        .fe-tries { display:flex; gap:8px; align-items:center; justify-content:center; margin:2px 0; }
        .fe-tries i { width:16px; height:16px; border-radius:50%; border:2px solid #e9e4da; display:inline-block; } .fe-tries i.o { background:#2e7d32; border-color:#2e7d32; } .fe-tries i.x { background:#c0392b; border-color:#c0392b; } .fe-tries i.p { background:#9a938d; border-color:#9a938d; }
        .fe-tries span { font-size:12px; color:#9a938d; margin-left:4px; }
        .fe-bar { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .fe-bar .h { font-family:'D2Coding', var(--font-mono, monospace); font-size:28px; font-weight:700; } .fe-bar .h small { font-family:'Noto Sans KR', sans-serif; font-size:11px; color:#9a938d; font-weight:400; margin-left:6px; }
        .fe-bar button { border:1px solid #e9e4da; background:#fff; border-radius:10px; height:38px; padding:0 10px; font-size:13px; font-weight:700; color:#5d5754; }
        .fe-order { border:1px solid #e9e4da; border-radius:10px; overflow:hidden; font-size:12px; }
        .fe-order div { display:flex; justify-content:space-between; padding:6px 10px; border-bottom:1px solid #e9e4da; } .fe-order div:last-child { border-bottom:none; }
        .fe-order div.cur { background:#f6f1e3; font-weight:700; } .fe-order div span { color:#9a938d; }
        .fe-toggle-btn { margin-left:auto; }
        @media (max-width: 899px) {
            #field-content.fe-on, #height-content.fe-on { grid-template-columns:1fr; }
            .fe-pad { position:sticky; bottom:0; top:auto; border-radius:14px 14px 0 0; }
            .fe-keys button { height:50px; }
            .fe-hbtns button { height:64px; }
        }
    `;
    document.head.appendChild(css);

    // ─── 공통 유틸 ───
    const fmtDist = v => (typeof formatHeight === 'function' ? formatHeight(v) : Number(v).toFixed(2));
    const fmtW = v => (typeof formatWind === 'function' ? formatWind(v) : String(v));
    const laneSorted = () => [...state.heatEntries].sort((a, b) => (a.lane_number || 999) - (b.lane_number || 999));
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function attemptsOf(eid) {
        const att = {}, wind = {}; let sc = '';
        (state.results || []).forEach(r => {
            if (r.event_entry_id !== eid) return;
            if (r.attempt_number != null) { att[r.attempt_number] = r.distance_meters; wind[r.attempt_number] = r.wind; }
            if (r.status_code && !sc) sc = r.status_code;
        });
        return { att, wind, sc };
    }
    const isLocked = e => e.status === 'no_show' || (attemptsOf(e.event_entry_id).sc && attemptsOf(e.event_entry_id).sc !== 'NM');
    const maxAtt = () => (state.selectedEvent && state.selectedEvent.parent_event_id ? 3 : 6);

    // ─── 거리 종목 ───
    const fe = { sel: null, attempt: 1, buf: '', wind: '', focus: 'dist', undo: null, lastAttemptInit: false };
    window._fe = fe;

    function firstPendingAttempt() {
        const m = maxAtt();
        const ents = laneSorted().filter(e => !isLocked(e));
        for (let a = 1; a <= m; a++) if (ents.some(e => attemptsOf(e.event_entry_id).att[a] === undefined)) return a;
        return m;
    }
    function nextPending(attempt, afterEid) {
        const ents = laneSorted().filter(e => !isLocked(e));
        const idx = afterEid == null ? -1 : ents.findIndex(e => e.event_entry_id === afterEid);
        for (let i = idx + 1; i < ents.length; i++) if (attemptsOf(ents[i].event_entry_id).att[attempt] === undefined) return ents[i].event_entry_id;
        return null;
    }
    function selectCell(eid, attempt, keepBuf) {
        fe.sel = eid == null ? null : { eid, attempt };
        fe.attempt = attempt || fe.attempt;
        if (!keepBuf) {
            fe.buf = ''; fe.wind = ''; fe.focus = 'dist';
            if (eid != null) {
                const { att, wind } = attemptsOf(eid);
                const v = att[attempt];
                if (v != null && v > 0) { fe.buf = fmtDist(v).replace(/m/, '.'); }
                if (wind[attempt] != null) fe.wind = fmtW(wind[attempt]);
            }
        }
    }
    window.feSelectAttempt = function (a) {
        fe.attempt = a;
        const eid = nextPending(a, null);
        selectCell(eid, a);
        renderFieldDistanceContent();
    };
    window.feKey = function (k) {
        if (!fe.sel) return;
        const isWind = fe.focus === 'wind';
        let s = isWind ? fe.wind : fe.buf;
        if (k === 'del') s = s.slice(0, -1);
        else if (k === '.') { if (!s.includes('.')) s = (s || '0') + '.'; }
        else if (k === '+' || k === '-') { if (isWind) s = k + s.replace(/^[+-]/, ''); }
        else { if (s.replace(/[^0-9]/g, '').length >= 5) return; s += k; }
        if (isWind) fe.wind = s; else fe.buf = s;
        feRenderPad();
    };
    window.feFocus = function (f) { fe.focus = f; feRenderPad(); };
    // 풍속 버퍼 정규화: "+06" → "+0.6", "12" → "+1.2", "-1.4" 그대로
    function normWind(s) {
        s = (s || '').trim(); if (!s) return '';
        const sign = s[0] === '-' ? '-' : '+';
        let d = s.replace(/[^0-9.]/g, '');
        if (!d) return sign;
        if (!d.includes('.')) d = d.length >= 2 ? d.slice(0, -1) + '.' + d.slice(-1) : '0.' + d;
        return sign + d;
    }
    function parseBuf(s) {
        s = (s || '').trim();
        if (!s) return null;
        if (!s.includes('.')) { if (s.length >= 3) s = s.slice(0, -2) + '.' + s.slice(-2); else return null; }
        const v = parseFloat(s);
        return (isNaN(v) || v <= 0) ? null : Math.round(v * 100) / 100;
    }
    function snapshot(eid, attempt) {
        const r = (state.results || []).find(x => x.event_entry_id === eid && x.attempt_number === attempt);
        return r ? { eid, attempt, dist: r.distance_meters, wind: r.wind ?? null, name: nameOf(eid) } : { eid, attempt, dist: undefined, name: nameOf(eid) };
    }
    const nameOf = eid => { const e = state.heatEntries.find(x => x.event_entry_id === eid); return e ? e.name : ''; };
    const laneOf = eid => { const e = state.heatEntries.find(x => x.event_entry_id === eid); return e ? (e.lane_number || '') : ''; };
    function advanceAfter(eid, attempt) {
        let next = nextPending(attempt, eid);
        let a = attempt;
        if (next == null) { const m = maxAtt(); for (let k = attempt + 1; k <= m; k++) { next = nextPending(k, null); if (next != null) { a = k; break; } } }
        selectCell(next, next == null ? attempt : a);
    }
    window.feSave = async function () {
        if (!fe.sel) return;
        const { eid, attempt } = fe.sel;
        const dist = parseBuf(fe.buf);
        if (dist == null) { feFlash('기록을 3자리 이상 입력 (예: 724 → 7.24)'); return; }
        const wind = fe.wind.trim() ? parseFloat(normWind(fe.wind)) : null;
        fe.undo = { prev: snapshot(eid, attempt), label: `${laneOf(eid)} ${nameOf(eid)} ${fmtDist(dist)}${wind != null && !isNaN(wind) ? ' ' + fmtW(wind) : ''}` };
        advanceAfter(eid, attempt);
        await saveFieldInline(eid, attempt, dist);
        if (wind != null && !isNaN(wind)) await saveFieldWind(eid, attempt, wind);
        renderFieldDistanceContent();
    };
    window.feFoul = async function () {
        if (!fe.sel) return; const { eid, attempt } = fe.sel;
        fe.undo = { prev: snapshot(eid, attempt), label: `${laneOf(eid)} ${nameOf(eid)} 파울(X)` };
        advanceAfter(eid, attempt);
        await fieldInlineFoul(eid, attempt);
        renderFieldDistanceContent();
    };
    window.fePass = async function () {
        if (!fe.sel) return; const { eid, attempt } = fe.sel;
        fe.undo = { prev: snapshot(eid, attempt), label: `${laneOf(eid)} ${nameOf(eid)} 패스(–)` };
        advanceAfter(eid, attempt);
        await fieldInlinePass(eid, attempt);
        renderFieldDistanceContent();
    };
    window.feUndo = async function () {
        const u = fe.undo; if (!u) return;
        fe.undo = null;
        const { eid, attempt, dist, wind } = u.prev;
        if (dist === undefined) await fieldInlineClear(eid, attempt);
        else if (dist === 0) await fieldInlineFoul(eid, attempt);
        else if (dist < 0) await fieldInlinePass(eid, attempt);
        else { await saveFieldInline(eid, attempt, dist); if (wind != null) await saveFieldWind(eid, attempt, wind); }
        selectCell(eid, attempt);
        renderFieldDistanceContent();
    };
    function feFlash(msg) { const el = document.querySelector('.fe-pad .fe-hint'); if (el) { const o = el.textContent; el.textContent = msg; el.style.color = '#c0392b'; setTimeout(() => { el.textContent = o; el.style.color = ''; }, 1600); } }

    function feRenderPad() {
        const content = document.getElementById('field-content'); if (!content) return;
        let pad = content.querySelector('.fe-pad');
        if (!pad) { pad = document.createElement('div'); pad.className = 'fe-pad'; content.appendChild(pad); }
        const needsWind = typeof requiresWindMeasurement === 'function' && requiresWindMeasurement(state.selectedEvent?.name, 'field_distance');
        const m = maxAtt();
        const ents = laneSorted().filter(e => !isLocked(e));
        const done = ents.filter(e => attemptsOf(e.event_entry_id).att[fe.attempt] !== undefined).length;
        const nxt = fe.sel ? nextPending(fe.attempt, fe.sel.eid) : null;
        let body;
        if (!fe.sel) {
            body = `<div class="fe-empty">표에서 입력할 칸을 누르거나<br>위 시기 탭을 선택하세요</div>`;
        } else {
            const { att } = attemptsOf(fe.sel.eid);
            const valid = Object.values(att).filter(v => v > 0);
            const best = valid.length ? Math.max(...valid) : null;
            body = `
            <div class="fe-who"><b>${laneOf(fe.sel.eid)} · ${esc(nameOf(fe.sel.eid))}</b><span>${fe.sel.attempt}차 시기${best != null ? ' · 최고 ' + fmtDist(best) : ''}</span></div>
            <div class="fe-val ${fe.focus === 'dist' ? 'focus' : ''}" onclick="feFocus('dist')">${esc(fe.buf) || '<span style="color:#c9c3b8;font-size:20px;font-weight:400;">예: 724 → 7.24</span>'}${fe.focus === 'dist' ? '<span class="cur"></span>' : ''}</div>
            ${needsWind ? `<div class="fe-wind"><span class="wl">풍속</span><div class="wv ${fe.focus === 'wind' ? 'focus' : ''}" onclick="feFocus('wind')">${esc(normWind(fe.wind)) || '<span style="color:#c9c3b8;font-weight:400;">±0.0</span>'}${fe.focus === 'wind' ? '<span class="cur" style="height:22px"></span>' : ''}</div><button onclick="feFocus('wind');feKey('+')">+</button><button onclick="feFocus('wind');feKey('-')">−</button></div>` : ''}
            <div class="fe-keys">
                <button onclick="feKey('7')">7</button><button onclick="feKey('8')">8</button><button onclick="feKey('9')">9</button><button class="fn x" onclick="feFoul()">X 파울</button>
                <button onclick="feKey('4')">4</button><button onclick="feKey('5')">5</button><button onclick="feKey('6')">6</button><button class="fn pass" onclick="fePass()">– 패스</button>
                <button onclick="feKey('1')">1</button><button onclick="feKey('2')">2</button><button onclick="feKey('3')">3</button><button class="go" onclick="feSave()">저장<br>다음 ▸</button>
                <button onclick="feKey('.')">.</button><button onclick="feKey('0')">0</button><button onclick="feKey('del')">⌫</button>
            </div>
            <div class="fe-hint">${fe.attempt}차 시기 ${done}/${ents.length} 입력${nxt != null ? ' · 다음 ' + laneOf(nxt) + ' ' + esc(nameOf(nxt)) : (done >= ents.length ? ' · 이 시기 완료' : '')}${m > 3 && ents.length > 8 ? ' · 4차부터 상위 8명' : ''}</div>`;
        }
        pad.innerHTML = `<button class="fe-close" onclick="fePadToggle()" title="키패드 끄기 (표에서 직접 입력)">×</button>${body}
            <div class="fe-undo"><span>${fe.undo ? '방금 저장: <b>' + esc(fe.undo.label) + '</b>' : '&nbsp;'}</span>${fe.undo ? '<button onclick="feUndo()">되돌리기</button>' : ''}</div>`;
    }

    // renderFieldDistanceContent 후처리: 탭·강조·패널
    const _origRenderDist = window.renderFieldDistanceContent;
    window.renderFieldDistanceContent = function () {
        _origRenderDist.apply(this, arguments);
        const content = document.getElementById('field-content'); if (!content) return;
        const on = padEnabled() && state.fieldMode !== 'view' && state.fieldMode !== 'rank';
        // 토글 버튼 (정렬 바 끝)
        const bar = content.querySelector('.sort-toggle-bar');
        if (bar && !bar.querySelector('.fe-toggle-btn')) {
            const b = document.createElement('button');
            b.className = 'btn btn-xs ' + (on ? 'btn-primary' : 'btn-outline') + ' fe-toggle-btn';
            b.textContent = on ? '키패드 켜짐' : '키패드';
            b.title = '터치용 큰 키패드 패널';
            b.onclick = fePadToggle;
            bar.appendChild(b);
        }
        content.classList.toggle('fe-on', on);
        if (!on) return;
        if (!fe.lastAttemptInit || !state.heatEntries.length) { fe.attempt = firstPendingAttempt(); fe.lastAttemptInit = true; }
        if (fe.sel && !state.heatEntries.some(e => e.event_entry_id === fe.sel.eid)) fe.sel = null;
        if (!fe.sel) { const eid = nextPending(fe.attempt, null); if (eid != null) selectCell(eid, fe.attempt); }
        // 시기 탭
        const m = maxAtt();
        const tabs = document.createElement('div'); tabs.className = 'fe-tabs';
        for (let a = 1; a <= m; a++) {
            const pend = nextPending(a, null) != null;
            tabs.innerHTML += `<button class="${a === fe.attempt ? 'now' : (!pend ? 'done' : '')}" onclick="feSelectAttempt(${a})">${a}차</button>`;
        }
        const table = content.querySelector('#field-distance-table');
        if (table && table.parentElement) table.parentElement.insertBefore(tabs, table);
        // 칸 강조: 현재 시기 열 + 선택 칸
        content.querySelectorAll('td.attempt-cell[data-attempt]').forEach(td => {
            const a = +td.dataset.attempt, eid = +td.dataset.entry;
            td.classList.toggle('fe-now', a === fe.attempt);
            td.classList.toggle('fe-sel', !!fe.sel && fe.sel.eid === eid && fe.sel.attempt === a);
        });
        if (table) table.querySelectorAll('thead th').forEach(th => { if (/^(\d)차시기$/.test(th.textContent.trim())) th.classList.toggle('fe-now', +th.textContent.trim()[0] === fe.attempt); });
        feRenderPad();
    };
    // 칸 클릭 → 인라인 입력 대신 키패드 대상 지정
    const _origActivate = window.activateFieldCell;
    window.activateFieldCell = function (entryId, attempt) {
        if (padEnabled() && state.fieldMode !== 'view' && state.fieldMode !== 'rank') {
            const e = state.heatEntries.find(x => x.event_entry_id === entryId);
            if (e && isLocked(e)) return;
            selectCell(entryId, attempt);
            renderFieldDistanceContent();
            return;
        }
        return _origActivate.apply(this, arguments);
    };
    // 저장 후 풍속 칸 자동 활성화(인라인) 는 키패드 모드에선 불필요
    const _origActivateWind = window.activateWindCell;
    window.activateWindCell = function () { if (padEnabled() && state.fieldMode !== 'view' && state.fieldMode !== 'rank') return; return _origActivateWind.apply(this, arguments); };

    // ─── 높이 종목 ───
    const he = { sel: null, bar: null, undo: null };
    window._he = he;
    function heRows() {
        const heights = state._heightBarList || [];
        return laneSorted().map(e => {
            const hd = {}; let elim = e.status === 'no_show', best = null, sc = null;
            (state.heightAttempts || []).forEach(a => { if (a.event_entry_id !== e.event_entry_id) return; if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
            if (state.results) { const sr = state.results.find(r => r.event_entry_id === e.event_entry_id && r.status_code); if (sr) sc = sr.status_code; }
            if (sc) elim = true;
            heights.forEach(h => { const d = hd[h]; if (!d) return; const x = Object.values(d).filter(m => m === 'X').length; if (Object.values(d).includes('O')) best = h; if (x >= 3) elim = true; });
            return { ...e, hd, elim, best, sc };
        });
    }
    function heBar() {
        const hs = state._heightBarList || [];
        if (!hs.length) return null;
        if (he.bar != null && hs.includes(he.bar)) return he.bar;
        he.bar = hs[hs.length - 1]; return he.bar;
    }
    // 이번 높이에서 시도가 남은 선수: [ {row, attempt} ] — 시도 수 적은 순, 같으면 순번 순
    function hePending(bar) {
        const out = [];
        heRows().forEach(r => {
            if (r.elim) return;
            const d = r.hd[bar] || {};
            if (Object.values(d).includes('O')) return;
            if (Object.values(d).includes('PASS') || Object.values(d).includes('-')) return;
            const n = Object.keys(d).length;
            if (n >= 3) return;
            out.push({ row: r, attempt: n + 1 });
        });
        return out.sort((a, b) => a.attempt - b.attempt || (a.row.lane_number || 999) - (b.row.lane_number || 999));
    }
    window.heSelect = function (eid) { const bar = heBar(); const p = hePending(bar).find(x => x.row.event_entry_id === eid); he.sel = p ? { eid, attempt: p.attempt } : null; renderHeightContent(); };
    window.heSetBar = function (dir) { const hs = state._heightBarList || []; const i = hs.indexOf(heBar()); const j = Math.min(hs.length - 1, Math.max(0, i + dir)); he.bar = hs[j]; he.sel = null; renderHeightContent(); };
    window.heMark = async function (mark) {
        const bar = heBar(); if (!he.sel || bar == null) return;
        const { eid, attempt } = he.sel;
        const cur = (state.heightAttempts || []).find(a => a.event_entry_id === eid && a.bar_height === bar && a.attempt_number === attempt);
        he.undo = { eid, bar, attempt, prev: cur ? cur.result_mark : '', label: `${laneOf(eid)} ${nameOf(eid)} ${fmtDist(bar)} ${attempt}차 ${mark}` };
        he.sel = null;
        await toggleHeightMark(eid, bar, attempt, mark);
        renderHeightContent();
    };
    window.heUndo = async function () {
        const u = he.undo; if (!u) return; he.undo = null;
        await toggleHeightMark(u.eid, u.bar, u.attempt, u.prev === 'PASS' ? '-' : (u.prev || ''));
        he.sel = { eid: u.eid, attempt: u.attempt };
        renderHeightContent();
    };
    function heRenderPad() {
        const content = document.getElementById('height-content'); if (!content) return;
        let pad = content.querySelector('.fe-pad');
        if (!pad) { pad = document.createElement('div'); pad.className = 'fe-pad'; content.appendChild(pad); }
        const bar = heBar();
        const hs = state._heightBarList || [];
        const i = hs.indexOf(bar);
        const pend = bar != null ? hePending(bar) : [];
        if (!he.sel && pend.length) he.sel = { eid: pend[0].row.event_entry_id, attempt: pend[0].attempt };
        const cur = he.sel ? pend.find(p => p.row.event_entry_id === he.sel.eid) : null;
        const order = pend.slice(0, 3);
        let body;
        if (bar == null) body = `<div class="fe-empty">위의 '높이 추가'로 바 높이를 먼저 입력하세요</div>`;
        else {
            const barUi = `<div class="fe-bar"><button onclick="heSetBar(-1)" ${i <= 0 ? 'disabled' : ''}>‹ ${i > 0 ? fmtDist(hs[i - 1]) : ''}</button><div class="h">${fmtDist(bar)}<small>현재 바</small></div><button onclick="heSetBar(1)" ${i >= hs.length - 1 ? 'disabled' : ''}>${i < hs.length - 1 ? fmtDist(hs[i + 1]) : ''} ›</button></div>`;
            if (!cur) body = `${barUi}<div class="fe-empty">${pend.length ? '표에서 선수를 누르세요' : '이 높이는 전원 완료 — › 로 다음 높이'}</div>`;
            else {
                const d = cur.row.hd[bar] || {};
                const dots = [1, 2, 3].map(k => `<i class="${d[k] === 'O' ? 'o' : d[k] === 'X' ? 'x' : (d[k] ? 'p' : '')}"></i>`).join('');
                body = `${barUi}
                <div class="fe-who"><b>${laneOf(cur.row.event_entry_id)} · ${esc(cur.row.name)}</b><span>${fmtDist(bar)} · ${cur.attempt}차 시도${cur.row.best != null ? ' · 최고 ' + fmtDist(cur.row.best) : ''}</span></div>
                <div class="fe-tries">${dots}<span>${cur.attempt === 3 ? '마지막 시도' : cur.attempt + '차'}</span></div>
                <div class="fe-hbtns"><button class="o" onclick="heMark('O')">O</button><button class="x" onclick="heMark('X')">X</button><button onclick="heMark('-')">–</button></div>
                <div class="fe-order">${order.map((p, k) => `<div class="${k === 0 ? 'cur' : ''}"><span>${k === 0 ? '지금' : k === 1 ? '다음' : '그다음'}</span>${laneOf(p.row.event_entry_id)} ${esc(p.row.name)} · ${p.attempt}차</div>`).join('')}</div>
                <div class="fe-hint">한 번 탭 = 저장 · O 통과 · X 실패(3회면 탈락) · – 패스</div>`;
            }
        }
        pad.innerHTML = `<button class="fe-close" onclick="fePadToggle()" title="키패드 끄기">×</button>${body}
            <div class="fe-undo"><span>${he.undo ? '방금 저장: <b>' + esc(he.undo.label) + '</b>' : '&nbsp;'}</span>${he.undo ? '<button onclick="heUndo()">되돌리기</button>' : ''}</div>`;
    }
    const _origRenderHeight = window.renderHeightContent;
    window.renderHeightContent = function () {
        _origRenderHeight.apply(this, arguments);
        const content = document.getElementById('height-content'); if (!content) return;
        const on = padEnabled();
        const bar = content.querySelector('.sort-toggle-bar');
        if (bar && !bar.querySelector('.fe-toggle-btn')) {
            const b = document.createElement('button');
            b.className = 'btn btn-xs ' + (on ? 'btn-primary' : 'btn-outline') + ' fe-toggle-btn';
            b.textContent = on ? '키패드 켜짐' : '키패드'; b.onclick = fePadToggle;
            bar.appendChild(b);
        }
        content.classList.toggle('fe-on', on);
        if (!on) return;
        const cur = heBar();
        // 기본 선택(다음 시도 선수)을 표 강조 전에 확정
        if (cur != null) { const pend = hePending(cur); if (he.sel && !pend.some(p => p.row.event_entry_id === he.sel.eid)) he.sel = null; if (!he.sel && pend.length) he.sel = { eid: pend[0].row.event_entry_id, attempt: pend[0].attempt }; }
        const table = content.querySelector('.height-toggle-table');
        if (table && cur != null) {
            const ths = [...table.querySelectorAll('thead th')];
            let colIdx = -1;
            ths.forEach((th, k) => { const t = th.childNodes[0] && th.childNodes[0].textContent ? th.childNodes[0].textContent.trim() : ''; if (t === fmtDist(cur)) { th.classList.add('fe-now'); colIdx = k; } });
            table.querySelectorAll('tbody tr').forEach(tr => {
                const tds = tr.children; if (colIdx >= 0 && tds[colIdx]) tds[colIdx].classList.add('fe-now');
                const inp = tr.querySelector('.height-rank-input, .sc-select');
                const eid = inp ? +inp.dataset.eid : null;
                if (eid != null && he.sel && he.sel.eid === eid) tr.classList.add('fe-selrow');
                if (eid != null) tr.querySelectorAll('td').forEach((td, k) => { if (k <= 2) { td.style.cursor = 'pointer'; td.addEventListener('click', ev => { if (ev.target.closest('input,select,button')) return; heSelect(eid); }); } });
            });
        }
        heRenderPad();
    };
})();
