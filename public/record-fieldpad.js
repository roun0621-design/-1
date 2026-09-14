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
// 항상 켜짐(2026-09 현장 요청: 표 인라인 입력은 OS 키보드가 아래서 튀어나와 조잡 → 키패드/목록 단일 UI).
// PC 물리 키보드도 지원: 숫자·. ·Backspace·Enter(저장)·X(파울)·P(패스)·Tab(기록↔풍속)·Delete(칸 지움)
// ============================================================
(function () {
    if (typeof state === 'undefined' || typeof renderFieldDistanceContent !== 'function') return;

    // 키패드/목록 모드 단일화 — 표 인라인 입력 모드는 제거 (토글 없음)
    function padEnabled() { return true; }
    window._fePadOn = padEnabled;
    window.fePadToggle = function () {};

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
        .fe-tabs { display:flex; gap:5px; margin:0 0 8px; }
        .fe-tabs button { flex:1; min-width:0; border:1px solid #e9e4da; background:#fff; border-radius:8px; padding:8px 0; font-size:13px; font-weight:700; color:#5d5754; }
        .fe-tabs button.done { color:#9a938d; background:#f6f4ef; } .fe-tabs button.now { background:#262324; color:#fff; border-color:#262324; }
        #field-distance-table td.fe-now { background:#fffbe8 !important; }
        #field-distance-table th.fe-now { box-shadow:inset 0 -4px 0 #b79f58; }
        #field-distance-table td.fe-sel { box-shadow:inset 0 0 0 2px #b79f58; background:#f6f1e3 !important; border-radius:6px; }
        #field-distance-table td.attempt-cell { min-height:44px; }
        .height-toggle-table td.fe-now { background:#fffbe8 !important; }
        .height-toggle-table th.fe-now { box-shadow:inset 0 -4px 0 #b79f58; }
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
        /* 높이 종목 터치 목록 */
        .fe-hlist { border:1px solid #e9e4da; border-radius:14px; background:#fff; overflow:hidden; }
        #height-content, #field-content { min-width:0; max-width:100%; }
        .fe-hlist { max-width:100%; }
        .fe-hbar { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid #e9e4da; background:#faf8f3; }
        .fe-hbar .lbl { flex:0 0 auto; font-size:12px; color:#9a938d; white-space:nowrap; } .fe-hbar .cnt { flex:0 0 auto; margin-left:auto; font-size:12px; color:#5d5754; white-space:nowrap; }
        /* 바 높이 칩 줄만 좌우 스크롤 (min-width:0 이 없으면 내용만큼 늘어나 목록 전체가 화면 밖으로 밀림) */
        .fe-hbar .chips { flex:1 1 auto; min-width:0; display:flex; gap:6px; overflow-x:auto; overscroll-behavior-x:contain; scroll-behavior:smooth; padding:4px 2px; scrollbar-width:thin; scrollbar-color:#d9d2c3 transparent; }
        .fe-hbar .chips::-webkit-scrollbar { height:5px; } .fe-hbar .chips::-webkit-scrollbar-thumb { background:#d9d2c3; border-radius:3px; }
        .fe-hbar .arw { flex:0 0 auto; width:30px; height:34px; border:1px solid #e9e4da; background:#fff; border-radius:8px; font-size:16px; color:#5d5754; padding:0; }
        .fe-hbar .chips button { flex:0 0 auto; border:1px solid #e9e4da; background:#fff; border-radius:999px; padding:8px 14px; font-family:'D2Coding', var(--font-mono, monospace); font-size:15px; font-weight:700; color:#5d5754; }
        .fe-hbar .chips button.now { background:#fff; color:#262324; border:2px solid #b79f58; box-shadow:0 0 0 3px #f6f1e3; }
        .fe-hbar .del { flex:0 0 auto; border:1px solid #e9e4da; background:#fff; border-radius:8px; padding:6px 10px; font-size:12px; color:#9a938d; white-space:nowrap; }
        .fe-hlist .hrow { display:grid; grid-template-columns:36px minmax(0,1fr) auto auto auto; column-gap:10px; align-items:center; padding:10px 12px; border-bottom:1px solid #e9e4da; min-height:72px; }
        .fe-hlist .hrow.done .btns { display:none; }
        .fe-hlist .sc select { font-size:13px; padding:8px 6px; border:1px solid #e9e4da; border-radius:8px; background:#fff; color:#5d5754; min-width:78px; }
        .fe-hlist .hrow.off .sc select { opacity:1; }
        .fe-hlist .hrow.done { background:#faf9f6; } .fe-hlist .hrow.off { opacity:.5; }
        .fe-hlist .no { font-family:'D2Coding', var(--font-mono, monospace); font-size:18px; font-weight:700; color:#9a938d; text-align:center; }
        .fe-hlist .nm { font-size:17px; font-weight:800; } .fe-hlist .nm small { font-size:11px; color:#9a938d; font-weight:400; margin-left:6px; }
        .fe-hlist .prev { display:flex; flex-wrap:wrap; gap:4px 8px; margin-top:3px; }
        .fe-hlist .prev i { font-style:normal; font-size:11px; color:#5d5754; background:#f6f4ef; border-radius:5px; padding:1px 6px; font-family:'D2Coding', var(--font-mono, monospace); letter-spacing:.04em; }
        .fe-hlist .prev i b { font-weight:500; color:#9a938d; margin-right:4px; } .fe-hlist .prev i em { font-style:normal; font-weight:800; } .fe-hlist .prev i em.o { color:#2e7d32; } .fe-hlist .prev i em.x { color:#c0392b; }
        .fe-hlist .prev i.none { color:#c9c3b8; background:none; }
        .fe-hlist .cur { display:flex; flex-direction:column; align-items:center; gap:4px; min-width:96px; }
        .fe-hlist .dots { display:flex; gap:6px; } .fe-hlist .dots i { width:26px; height:26px; border-radius:50%; border:2px solid #e9e4da; display:inline-flex; align-items:center; justify-content:center; font-style:normal; font-size:13px; font-weight:800; color:#fff; }
        .fe-hlist .dots i.o { background:#2e7d32; border-color:#2e7d32; } .fe-hlist .dots i.x { background:#c0392b; border-color:#c0392b; } .fe-hlist .dots i.p { background:#9a938d; border-color:#9a938d; }
        .fe-hlist .st { font-size:12px; color:#7a746e; font-weight:700; } .fe-hlist .st.ok { color:#2e7d32; } .fe-hlist .st.out { color:#c0392b; }
        .fe-hlist .clr { border:1px solid #e9e4da; background:#fff; border-radius:999px; padding:3px 10px; font-size:11px; font-weight:700; color:#9a938d; }
        .fe-hlist .prev i.lnk { cursor:pointer; } .fe-hlist .prev i.lnk:active { background:#efe9d8; }
        .fe-pad .fe-clr { border:1px solid #e9e4da; background:#fff; border-radius:999px; padding:4px 10px; font-size:11px; font-weight:700; color:#c0392b; white-space:nowrap; }
        .fe-hlist .btns { display:flex; gap:8px; }
        .fe-hlist .btns button { width:64px; height:56px; border-radius:12px; border:2px solid #e9e4da; background:#fff; font-size:24px; font-weight:800; color:#5d5754; touch-action:manipulation; }
        .fe-hlist .btns .o { color:#2e7d32; border-color:#2e7d32; background:#eaf5eb; } .fe-hlist .btns .x { color:#c0392b; border-color:#c0392b; background:#fbeceb; }
        .fe-hlist .btns button:active { transform:scale(.96); }
        .fe-hlist .fe-undo { padding:10px 12px; }
        .fe-hlist .fe-empty { margin:12px; }
        @media (max-width: 600px) { .fe-hlist .hrow { grid-template-columns:30px minmax(0,1fr) auto auto; grid-template-rows:auto auto; } .fe-hlist .btns { grid-column:1 / -1; justify-content:flex-end; } .fe-hlist .btns button { width:72px; } }
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
        for (let a = 1; a <= m; a++) if (ents.some(e => attemptsOf(e.event_entry_id).att[a] == null)) return a;
        return m;
    }
    function nextPending(attempt, afterEid) {
        const ents = laneSorted().filter(e => !isLocked(e));
        const idx = afterEid == null ? -1 : ents.findIndex(e => e.event_entry_id === afterEid);
        // att[attempt] == null : 미입력(undefined) 또는 풍속만 먼저 저장된 빈 시기(null) → 둘 다 '입력 대기'
        for (let i = idx + 1; i < ents.length; i++) if (attemptsOf(ents[i].event_entry_id).att[attempt] == null) return ents[i].event_entry_id;
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
        const wind = fe.wind.trim() ? parseFloat(normWind(fe.wind)) : null;
        // 기록 없이 풍속만 입력한 경우 → 풍속만 저장하고 같은 칸에 머무름 (거리 계측 후 이어서 입력)
        if (dist == null) {
            if (wind == null || isNaN(wind)) { feFlash('기록을 3자리 이상 입력 (예: 724 → 7.24)'); return; }
            fe.undo = { prev: snapshot(eid, attempt), label: `${laneOf(eid)} ${nameOf(eid)} 풍속 ${fmtW(wind)}` };
            await saveFieldWind(eid, attempt, wind);
            selectCell(eid, attempt);
            renderFieldDistanceContent();
            return;
        }
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
        else if (dist === null) { await fieldInlineClear(eid, attempt); if (wind != null) await saveFieldWind(eid, attempt, wind); }
        else if (dist === 0) await fieldInlineFoul(eid, attempt);
        else if (dist < 0) await fieldInlinePass(eid, attempt);
        else { await saveFieldInline(eid, attempt, dist); if (wind != null) await saveFieldWind(eid, attempt, wind); }
        selectCell(eid, attempt);
        renderFieldDistanceContent();
    };
    // 오입력 정정: 선택 칸의 기록·풍속 삭제 (되돌리기 가능), 같은 칸에 머무름
    window.feClear = async function () {
        if (!fe.sel) return; const { eid, attempt } = fe.sel;
        const { att, wind } = attemptsOf(eid);
        if (att[attempt] === undefined) return;
        const cur = att[attempt] === 0 ? 'X' : att[attempt] === -1 ? '–' : att[attempt] == null ? ('풍속 ' + fmtW(wind[attempt])) : fmtDist(att[attempt]);
        if (!confirm(`${laneOf(eid)} ${nameOf(eid)} ${attempt}차 시기(${cur})를 지울까요?`)) return;
        fe.undo = { prev: snapshot(eid, attempt), label: `${laneOf(eid)} ${nameOf(eid)} ${attempt}차 지움` };
        await fieldInlineClear(eid, attempt);
        selectCell(eid, attempt);
        renderFieldDistanceContent();
    };
    // PC 물리 키보드 → 키패드 (입력창에 포커스가 없을 때만)
    document.addEventListener('keydown', function (ev) {
        if (!fe.sel) return;
        if (!state.selectedEvent || state.selectedEvent.category !== 'field_distance') return;
        if (state.fieldMode === 'view' || state.fieldMode === 'rank') return;
        const t = ev.target; if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
        const k = ev.key;
        if (/^[0-9]$/.test(k) || k === '.') { feKey(k); }
        else if (k === 'Backspace') { feKey('del'); }
        else if (k === 'Enter') { feSave(); }
        else if (k === 'x' || k === 'X') { feFoul(); }
        else if (k === 'p' || k === 'P') { fePass(); }
        else if (k === '+' || k === '-') { feFocus('wind'); feKey(k); }
        else if (k === 'Tab') { feFocus(fe.focus === 'wind' ? 'dist' : 'wind'); }
        else if (k === 'Delete') { feClear(); }
        else return;
        ev.preventDefault();
    });
    function feFlash(msg) { const el = document.querySelector('.fe-pad .fe-hint'); if (el) { const o = el.textContent; el.textContent = msg; el.style.color = '#c0392b'; setTimeout(() => { el.textContent = o; el.style.color = ''; }, 1600); } }

    function feRenderPad() {
        const content = document.getElementById('field-content'); if (!content) return;
        let pad = content.querySelector('.fe-pad');
        if (!pad) { pad = document.createElement('div'); pad.className = 'fe-pad'; content.appendChild(pad); }
        const needsWind = typeof requiresWindMeasurement === 'function' && requiresWindMeasurement(state.selectedEvent?.name, 'field_distance');
        const m = maxAtt();
        const ents = laneSorted().filter(e => !isLocked(e));
        const done = ents.filter(e => attemptsOf(e.event_entry_id).att[fe.attempt] != null).length;
        const nxt = fe.sel ? nextPending(fe.attempt, fe.sel.eid) : null;
        let body;
        if (!fe.sel) {
            body = `<div class="fe-empty">표에서 입력할 칸을 누르거나<br>위 시기 탭을 선택하세요</div>`;
        } else {
            const { att } = attemptsOf(fe.sel.eid);
            const valid = Object.values(att).filter(v => v > 0);
            const best = valid.length ? Math.max(...valid) : null;
            body = `
            <div class="fe-who"><b>${laneOf(fe.sel.eid)} · ${esc(nameOf(fe.sel.eid))}</b><span>${fe.sel.attempt}차 시기${best != null ? ' · 최고 ' + fmtDist(best) : ''}${att[fe.sel.attempt] !== undefined ? ` <button class="fe-clr" onclick="feClear()" title="이 칸의 기록·풍속을 지웁니다 (오입력 정정)">이 칸 지움</button>` : ''}</span></div>
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
        pad.innerHTML = `${body}
            <div class="fe-undo"><span>${fe.undo ? '방금 저장: <b>' + esc(fe.undo.label) + '</b>' : '&nbsp;'}</span>${fe.undo ? '<button onclick="feUndo()">되돌리기</button>' : ''}</div>`;
    }

    // renderFieldDistanceContent 후처리: 탭·강조·패널
    const _origRenderDist = window.renderFieldDistanceContent;
    window.renderFieldDistanceContent = function () {
        _origRenderDist.apply(this, arguments);
        const content = document.getElementById('field-content'); if (!content) return;
        const on = state.fieldMode !== 'view' && state.fieldMode !== 'rank';
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

    // ─── 높이 종목: 선수 행마다 현재 높이의 O / X / – 큰 버튼 (선택 단계 없음, 가로 스크롤 없음) ───
    const he = { bar: null, undo: null };
    window._he = he;
    function heRows() {
        const heights = state._heightBarList || [];
        return laneSorted().map(e => {
            const hd = {}; let elim = e.status === 'no_show', best = null, sc = null;
            (state.heightAttempts || []).forEach(a => { if (a.event_entry_id !== e.event_entry_id) return; if (!hd[a.bar_height]) hd[a.bar_height] = {}; hd[a.bar_height][a.attempt_number] = a.result_mark; });
            if (state.results) { const sr = state.results.find(r => r.event_entry_id === e.event_entry_id && r.status_code); if (sr) sc = sr.status_code; }
            if (e.status === 'no_show' && !sc) sc = 'DNS';
            if (sc) elim = true;
            let fails = 0;
            heights.forEach(h => { const d = hd[h]; if (!d) return; const x = Object.values(d).filter(m => m === 'X').length; fails += x; if (Object.values(d).includes('O')) best = h; if (x >= 3) elim = true; });
            if (elim && best == null && !sc && fails >= 3) sc = 'NM';
            return { ...e, hd, elim, best, sc };
        });
    }
    function heBar() {
        const hs = state._heightBarList || [];
        if (!hs.length) return null;
        if (he.bar != null && hs.includes(he.bar)) return he.bar;
        he.bar = hs[hs.length - 1]; return he.bar;
    }
    window.heSetBar = function (h) { he.bar = h; renderHeightContent(); };
    // 행 버튼: 이 선수의 현재 높이 다음 시도에 mark 저장
    window.heMarkRow = async function (eid, mark) {
        const bar = heBar(); if (bar == null) return;
        const r = heRows().find(x => x.event_entry_id === eid); if (!r) return;
        const d = r.hd[bar] || {};
        const n = Object.keys(d).length;
        if (n >= 3) return;
        const attempt = n + 1;
        he.undo = { eid, bar, attempt, prev: '', label: `${laneOf(eid)} ${nameOf(eid)} ${fmtDist(bar)} ${attempt}차 ${mark === '-' ? '패스' : mark}` };
        await toggleHeightMark(eid, bar, attempt, mark);
        renderHeightContent();
    };
    // 이미 찍은 시도 점을 누르면 그 시도를 지움(정정)
    window.heClearMark = async function (eid, attempt) {
        const bar = heBar(); if (bar == null) return;
        const cur = (state.heightAttempts || []).find(a => a.event_entry_id === eid && a.bar_height === bar && a.attempt_number === attempt);
        if (!cur) return;
        if (!confirm(`${nameOf(eid)} ${fmtDist(bar)} ${attempt}차 시도(${cur.result_mark === 'PASS' ? '–' : cur.result_mark})를 지울까요?`)) return;
        he.undo = { eid, bar, attempt, prev: cur.result_mark, label: `${laneOf(eid)} ${nameOf(eid)} ${fmtDist(bar)} ${attempt}차 지움` };
        await toggleHeightMark(eid, bar, attempt, '');
        renderHeightContent();
    };
    window.heUndo = async function () {
        const u = he.undo; if (!u) return; he.undo = null;
        await toggleHeightMark(u.eid, u.bar, u.attempt, u.prev === 'PASS' ? '-' : (u.prev || ''));
        renderHeightContent();
    };
    function heRenderList(content) {
        let box = content.querySelector('.fe-hlist');
        if (!box) { box = document.createElement('div'); box.className = 'fe-hlist'; content.appendChild(box); }
        const hs = state._heightBarList || [];
        const bar = heBar();
        if (bar == null) { box.innerHTML = '<div class="fe-empty">위의 \'높이 추가\'로 바 높이를 먼저 입력하세요</div>'; return; }
        const rows = heRows();
        const chips = hs.map(h => `<button class="${h === bar ? 'now' : ''}" onclick="heSetBar(${h})">${fmtDist(h)}</button>`).join('');
        const active = rows.filter(r => !r.elim && !(Object.values(r.hd[bar] || {}).includes('O')) && !(Object.values(r.hd[bar] || {}).some(m => m === 'PASS' || m === '-')) && Object.keys(r.hd[bar] || {}).length < 3);
        let html = `<div class="fe-hbar"><span class="lbl">현재 바</span><button class="arw" onclick="heScrollChips(-1)" title="이전 높이 보기">‹</button><div class="chips">${chips}</div><button class="arw" onclick="heScrollChips(1)" title="다음 높이 보기">›</button><button class="del" onclick="deleteBarHeight(${bar})" title="${fmtDist(bar)} 삭제">${fmtDist(bar)} 삭제</button><span class="cnt">남은 선수 ${active.length}</span></div>`;
        rows.forEach(r => {
            const d = r.hd[bar] || {};
            const n = Object.keys(d).length;
            const cleared = Object.values(d).includes('O');
            const passed = Object.values(d).some(m => m === 'PASS' || m === '-');
            const done = r.elim || cleared || passed || n >= 3;
            // 이전 높이 요약 (현재 바 제외, 시도한 높이만)
            // 이전 높이 칩을 누르면 그 높이로 이동 → 오입력 정정 가능
            const prev = hs.filter(h => h !== bar && r.hd[h]).map(h => { const m = [1, 2, 3].map(k => r.hd[h][k]).filter(Boolean).map(k => k === 'PASS' ? '–' : k).join(''); return `<i class="lnk" onclick="heSetBar(${h})" title="${fmtDist(h)} 로 이동해 정정"><b>${fmtDist(h)}</b>${m.replace(/O/g, '<em class="o">O</em>').replace(/X/g, '<em class="x">X</em>')}</i>`; }).join('');
            const dots = [1, 2, 3].map(k => { const m = d[k]; const cls = m === 'O' ? 'o' : m === 'X' ? 'x' : (m ? 'p' : ''); const txt = m === 'O' ? 'O' : m === 'X' ? 'X' : (m ? '–' : ''); return `<i class="${cls}" ${m ? `onclick="heClearMark(${r.event_entry_id},${k})" title="이 시도 지우기"` : ''}>${txt}</i>`; }).join('');
            let status = '';
            if (r.sc) status = `<span class="st out">${r.sc}</span>`;
            else if (r.elim) status = `<span class="st out">탈락${r.best != null ? ' · 최고 ' + fmtDist(r.best) : ''}</span>`;
            else if (cleared) status = `<span class="st ok">통과</span>`;
            else if (passed) status = `<span class="st">패스</span>`;
            const btns = done ? '' : `<div class="btns"><button class="o" onclick="heMarkRow(${r.event_entry_id},'O')">O</button><button class="x" onclick="heMarkRow(${r.event_entry_id},'X')">X</button><button class="p" onclick="heMarkRow(${r.event_entry_id},'-')">–</button></div>`;
            // 상태(DNS/DNF/DQ/NM) — 표 모드의 상태 열과 같은 핸들러(setFieldHeightStatusCode)
            const noShow = r.status === 'no_show';
            const scSel = `<select class="sc-select fe-sc" data-eid="${r.event_entry_id}" onchange="setFieldHeightStatusCode(this)" title="DNS=불출전, DNF=미완주, DQ=실격, NM=기록없음" ${noShow ? 'disabled' : ''}>
                <option value="">상태 —</option>${['DNS', 'DNF', 'DQ', 'NM'].map(c => `<option value="${c}" ${r.sc === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`;
            html += `<div class="hrow ${done ? 'done' : ''} ${r.elim ? 'off' : ''}">
                <div class="no">${r.lane_number || '—'}</div>
                <div class="who"><div class="nm">${esc(r.name)}<small>#${typeof bib === 'function' ? bib(r.bib_number) : r.bib_number}</small></div><div class="prev">${prev || '<i class="none">첫 높이</i>'}</div></div>
                <div class="cur"><div class="dots">${dots}</div>${status}${n > 0 && !r.sc ? `<button class="clr" onclick="heClearMark(${r.event_entry_id},${n})" title="마지막 시도 지우기 (오입력 정정)">${n}차 지움</button>` : ''}</div>
                <div class="sc">${scSel}</div>
                ${btns}
            </div>`;
        });
        html += `<div class="fe-undo"><span>${he.undo ? '방금 저장: <b>' + esc(he.undo.label) + '</b>' : '&nbsp;'}</span>${he.undo ? '<button onclick="heUndo()">되돌리기</button>' : ''}</div>`;
        box.innerHTML = html;
        // 현재 바 칩이 보이도록 칩 줄만 스크롤 (페이지는 안 움직임)
        const chipsEl = box.querySelector('.chips'), nowEl = box.querySelector('.chips .now');
        if (chipsEl && nowEl) chipsEl.scrollLeft = Math.max(0, nowEl.offsetLeft - chipsEl.clientWidth / 2 + nowEl.offsetWidth / 2);
    }
    window.heScrollChips = function (dir) {
        const el = document.querySelector('#height-content .fe-hbar .chips'); if (!el) return;
        el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.6), behavior: 'smooth' });
    };
    // 표 모드: 순위·순번·이름 열 고정 (가로 스크롤 시 이름이 사라지던 문제)
    function heStickyCols(content) {
        const table = content.querySelector('.height-toggle-table'); if (!table) return;
        const rows = table.querySelectorAll('tr');
        rows.forEach(tr => {
            let left = 0;
            for (let k = 0; k < 3 && k < tr.children.length; k++) {
                const c = tr.children[k];
                c.style.position = 'sticky'; c.style.left = left + 'px'; c.style.zIndex = '2';
                c.style.background = c.tagName === 'TH' ? '' : (getComputedStyle(tr).backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : getComputedStyle(tr).backgroundColor);
                left += c.getBoundingClientRect().width;
            }
        });
    }
    const _origRenderHeight = window.renderHeightContent;
    window.renderHeightContent = function () {
        _origRenderHeight.apply(this, arguments);
        const content = document.getElementById('height-content'); if (!content) return;
        const on = true;
        content.classList.remove('fe-on');
        content.classList.toggle('fe-hl', on);
        const wrap = content.querySelector('.height-scroll-wrap');
        if (!on) { if (wrap) wrap.style.display = ''; const box = content.querySelector('.fe-hlist'); if (box) box.remove(); heStickyCols(content); return; }
        if (wrap) wrap.style.display = 'none';
        heRenderList(content);
    };
})();
