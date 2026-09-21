'use strict';
/**
 * 한국중·고육상연맹(KJAF) 종합기록지 — Excel (Phase 7-①, 2026-09)
 *   기준: 2026 춘계 · 회장배 24회 · 6회 학년별 종합기록지 xlsx (세 대회 양식 동일, 시트 구성만 다름)
 *
 *   시트 = 부(종별) 묶음, 시트 안 블록 = 성별·학년 부 하나:
 *     행 2   대회명(E2:T2, 18pt) · '심판장 : (인)'(X2, 밑줄)
 *     행 3   부 이름(B3:C3) · '( 장소  YYYY년 M월D일 ∼ M월D일 )'(F3:S3)
 *     행 5   순위 | 1위 … 8위      행 6   종목 | 성명 소속 기록 ×8
 *     종목 행: A=경기 일차, B=종목, C·D·E=1위(성명·소속·기록) … X·Y·Z=8위. 동순위가 8명을 넘으면 같은 자리로 이어지는 행
 *     아래 행: 트랙 풍속('풍향풍속' + 값 하나 / 도약은 선수마다), 계주는 주자 4명(C:E 병합), 믹스 계주는 B='(Mixed)'
 *     기록 표기: '11.90 CR' · '1.40(공동2위)' · '3,648점' · 계주는 성명 칸 비우고 소속에 팀명 · 추풍 도약은 풍속 칸에 '2.5참고기록' · 완주 3명 미만은 '기록경기'
 *     마지막 행: 기록 약어 설명. 마지막 시트 '신기록현황'.
 *
 *   부 묶음 규칙(대회마다 다른 것은 이것뿐):
 *     초등: 학년 없음 → '남초,여초' 한 시트(남·여 블록) / 3·4학년 → '3,4학년부' / 5 → '5학년부' / 6 → '6학년부'
 *     중·고: 학년 없음 → '남중'·'여중' 성별 시트 / 1학년만 → '중 1학년부'(남·여 블록) / 학년별 대회 → '중1학년부' …
 *     혼성(X) → '믹스릴레이'(중학교부·고등학교부 블록) / 학년 시트가 있는 대회의 학년 없는 종목 → '통합경기'
 *
 *   generateKjafRecordSheet(db, comp, deps) → ExcelJS.Workbook   deps: { getEventResultsForCert }
 */
const ExcelJS = require('exceljs');

const FONT_TITLE = '휴먼각진옛체';
const FONT_BODY = '가는으뜸체';
const RANKS = 8;
const COL_W = [2.33, 5.44, 3.66, 4.66, 5.66, 3.66, 4.66, 5.66, 3.66, 4.66, 5.66, 3.66, 4.66, 5.66, 3.66, 4.66, 5.66, 3.66, 4.66, 5.66, 3.66, 4.66, 5.66, 3.66, 4.66, 5.66];
const EVENT_ORDER = ['60m', '80m', '100m', '200m', '400m', '800m', '1500m', '3000m', '5000m', '10000m', '80mH', '100mH', '110mH', '400mH', '2000mSC', '3000mSC',
    '3000mW', '5000mW', '10000mW', '4x100mR', '4x400mR', '4x400mR(Mixed)', '4x800mR', '4x1500mR', '높이뛰기', '장대높이뛰기', '멀리뛰기', '세단뛰기',
    '포환던지기', '원반던지기', '해머던지기', '창던지기', '5종경기', '7종경기', '10종경기'];
const FOOT_NOTE = '※ WR:세계신, WT:세계타이, AR:아시아신, AT:아시아타이, KR:한국신, KT:한국타이, CR:대회신, CT:대회타이, DR:부별최고, DT:부별타이';

const normEv = n => String(n || '').replace(/[,\s]/g, '').replace(/[×X]/g, 'x').replace(/\(mixed\)/i, '(Mixed)');
const evOrder = n => { const i = EVENT_ORDER.indexOf(normEv(n)); return i < 0 ? 900 : i; };
const isRelay = ev => ev.category === 'relay' || /mR/i.test(normEv(ev.name));
const needsWind = ev => {
    const n = normEv(ev.name);
    if (ev.category === 'field_distance') return /멀리뛰기|세단뛰기/.test(n);
    if (ev.category !== 'track') return false;
    return /^(60|80|100|200)m$|^(80|100|110)mH$|^200mH$/.test(n);
};

/** 부 라벨 → { level: 'ELEM'|'MID'|'HIGH'|null, grade: 1~6|null } */
function parseDivision(label) {
    const s = String(label || '').replace(/\s/g, '');
    let level = null;
    if (/초/.test(s)) level = 'ELEM'; else if (/중/.test(s)) level = 'MID'; else if (/고/.test(s)) level = 'HIGH';
    let grade = null;
    const m = s.match(/(\d)\s*학년/) || s.match(/^[초중고](\d)$/) || s.match(/[초중고](?:등|학)?(\d)(?:부|학년부)?$/);
    if (m) grade = Number(m[1]);
    return { level, grade };
}
const LEVEL_KO = { ELEM: '초', MID: '중', HIGH: '고' };
const LEVEL_FULL = { ELEM: '초등학교부', MID: '중학교부', HIGH: '고등학교부' };
const G_KO = { M: '남자', F: '여자' };
const G_SHORT = { M: '남', F: '여' };
const LEVEL_SORT = { ELEM: 0, MID: 1, HIGH: 2 };

/**
 * 종목 목록 → 시트 계획 [{ name, blocks: [{ title, events: [] }] }]
 *   ev: { ...event, _level, _grade }
 */
function planSheets(events) {
    const sheets = [];
    const byLevel = new Map();
    for (const ev of events) {
        if (ev.gender === 'X') continue;
        const k = ev._level || 'NONE';
        if (!byLevel.has(k)) byLevel.set(k, []);
        byLevel.get(k).push(ev);
    }
    const levels = [...byLevel.keys()].sort((a, b) => (LEVEL_SORT[a] ?? 9) - (LEVEL_SORT[b] ?? 9));
    const integrated = [];      // 학년별 대회의 학년 없는 종목 → 통합경기
    for (const level of levels) {
        const evs = byLevel.get(level);
        const grades = new Set(evs.map(e => e._grade));
        const gradeList = [...grades].filter(g => g != null).sort((a, b) => a - b);
        const isGradeMeet = gradeList.some(g => g !== 1);              // 1학년부만 있으면 '학년별 대회'가 아니다
        const pick = (g, gender) => evs.filter(e => e._grade === g && e.gender === gender);
        const block = (title, list) => ({ title, events: list });
        if (level === 'NONE') {
            sheets.push({ name: '남자부', blocks: [block('남자부', pick(null, 'M'))] }, { name: '여자부', blocks: [block('여자부', pick(null, 'F'))] });
            continue;
        }
        const ko = LEVEL_KO[level], full = LEVEL_FULL[level];
        if (level === 'ELEM') {
            if (grades.has(null) && !isGradeMeet) sheets.push({ name: '남초,여초', blocks: [block(`${G_KO.M}${full}`, pick(null, 'M')), block(`${G_KO.F}${full}`, pick(null, 'F'))] });
            else if (grades.has(null)) integrated.push(block(`${G_KO.M}${full}`, pick(null, 'M')), block(`${G_KO.F}${full}`, pick(null, 'F')));
            const g34 = gradeList.filter(g => g <= 4);
            if (g34.length) sheets.push({ name: `${g34.join(',')}학년부`, blocks: g34.flatMap(g => [block(`${G_SHORT.M}${ko}${g}학년부`, pick(g, 'M')), block(`${G_SHORT.F}${ko}${g}학년부`, pick(g, 'F'))]) });
            for (const g of gradeList.filter(g => g >= 5)) sheets.push({ name: `${g}학년부`, blocks: [block(`${G_SHORT.M}${ko}${g}학년부`, pick(g, 'M')), block(`${G_SHORT.F}${ko}${g}학년부`, pick(g, 'F'))] });
            continue;
        }
        if (grades.has(null) && !isGradeMeet) {
            sheets.push({ name: `${G_SHORT.M}${ko}`, blocks: [block(`${G_KO.M}${full}`, pick(null, 'M'))] }, { name: `${G_SHORT.F}${ko}`, blocks: [block(`${G_KO.F}${full}`, pick(null, 'F'))] });
        } else if (grades.has(null)) integrated.push(block(`${G_KO.M}${full}`, pick(null, 'M')), block(`${G_KO.F}${full}`, pick(null, 'F')));
        for (const g of gradeList) {
            const name = isGradeMeet ? `${ko}${g}학년부` : `${ko} ${g}학년부`;
            sheets.push({ name, blocks: [block(`${G_SHORT.M}${ko}${isGradeMeet ? '' : ' '}${g}학년부`, pick(g, 'M')), block(`${G_SHORT.F}${ko}${isGradeMeet ? '' : ' '}${g}학년부`, pick(g, 'F'))] });
        }
    }
    const mixed = events.filter(e => e.gender === 'X');
    if (mixed.length) {
        const blocks = [];
        for (const level of ['ELEM', 'MID', 'HIGH', null]) {
            const list = mixed.filter(e => (e._level || null) === level);
            if (list.length) blocks.push({ title: level ? LEVEL_FULL[level] : '혼성', events: list, mixed: true });
        }
        sheets.push({ name: '믹스릴레이', blocks });
    }
    if (integrated.length) sheets.push({ name: '통합경기', blocks: integrated });
    // 빈 블록 제거, 빈 시트 제거
    for (const s of sheets) s.blocks = s.blocks.filter(b => b.events.length);
    return sheets.filter(s => s.blocks.length);
}

// ── 셀 스타일 ─────────────────────────────────────────────────
const thin = { style: 'thin' }, hair = { style: 'hair' }, dbl = { style: 'double' };
const F = (size, extra = {}) => ({ name: FONT_BODY, size, ...extra });
function setCell(ws, r, c, value, opt = {}) {
    const cell = ws.getCell(r, c);
    cell.value = value;
    cell.font = opt.font || F(7);
    cell.alignment = { vertical: 'middle', horizontal: opt.align || 'left', wrapText: !!opt.wrap };
    if (opt.border) cell.border = opt.border;
    if (opt.fmt) cell.numFmt = opt.fmt;
    return cell;
}

function kstDateParts(iso) { const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null; }
function periodText(comp) {
    const a = kstDateParts(comp.start_date), b = kstDateParts(comp.end_date);
    if (!a) return '';
    const venue = comp.venue ? String(comp.venue).replace(/스타디움|종합운동장|공설운동장|운동장/g, '').trim() || comp.venue : '';
    const to = b ? (b.y === a.y ? `${b.mo}월${b.d}일` : `${b.y}년 ${b.mo}월${b.d}일`) : '';
    return `( ${venue}  ${a.y}년 ${a.mo}월${a.d}일${to ? ' ∼ ' + to : ''} )`;
}

// 기록 표기: '7.30m' → '7.30', '1.85m' → '1.85', '5623점' → '5,623점', 시간은 그대로
function recordText(ev, r) {
    let v = String(r.record_value || '');
    if (!r.finished) return v;                       // DNS/DNF/DQ 등
    if (ev.category === 'combined') { const n = parseInt(v.replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n.toLocaleString('en-US') + '점' : v; }
    if (ev.category === 'field_distance' || ev.category === 'field_height') v = v.replace(/m$/, '');
    return v;
}
const RECORD_CODE = { national: 'KR', division: 'DR', competition: 'CR' };
const RECORD_RANK = { KR: 3, DR: 2, CR: 1 };

/** 블록 하나를 ws 의 startRow 부터 그린다. 다음에 쓸 행 번호를 돌려준다 */
function drawBlock(ws, startRow, block, ctx) {
    let r = startRow;
    // 부 이름 + 기간
    ws.mergeCells(r, 2, r, 3); setCell(ws, r, 2, block.title, { font: { name: FONT_TITLE, size: 8 }, align: 'center', border: { bottom: thin } });
    ws.getCell(r, 3).border = { bottom: thin };
    ws.mergeCells(r, 6, r, 19); setCell(ws, r, 6, ctx.period, { font: { name: FONT_TITLE, size: 11 }, align: 'center' });
    r += 2;
    // 순위 머리글
    setCell(ws, r, 2, '순위', { font: F(8), align: 'right', border: { top: thin, left: thin, right: thin } });
    for (let k = 0; k < RANKS; k++) {
        const c = 3 + k * 3;
        for (let j = 0; j < 3; j++) ws.getCell(r, c + j).border = { top: thin, bottom: thin, ...(j === 0 ? { left: thin } : {}), ...(j === 2 ? { right: thin } : {}) };
        setCell(ws, r, c + 1, `${k + 1}위`, { font: F(8), align: 'center', border: { top: thin, bottom: thin } });
    }
    r++;
    setCell(ws, r, 2, '종목', { font: F(8), border: { bottom: dbl, left: thin, right: thin } });
    ['성명', '소속', '기록'].forEach((h, j) => { for (let k = 0; k < RANKS; k++) setCell(ws, r, 3 + k * 3 + j, h, { font: F(8), align: 'center', border: { top: thin, bottom: dbl, left: thin, right: thin } }); });
    ws.getRow(r).height = 14.25;
    r++;

    const evs = block.events.slice().sort((a, b) => (evOrder(a.name) - evOrder(b.name)) || ((a.sort_order || 0) - (b.sort_order || 0)));
    for (const ev of evs) {
        const data = ctx.results.get(ev.id) || { rows: [] };
        const ranked = data.rows.filter(x => x.finished && x.rank != null).sort((a, b) => a.rank - b.rank);
        // 8위까지 + 8위 동순위는 모두. 자리는 순서대로 1위~8위 칸, 8칸을 넘는 동순위는 같은 순위 칸 아래 행으로 이어진다
        const shown = ranked.filter((x, i) => i < RANKS || x.rank === (ranked[RANKS - 1] && ranked[RANKS - 1].rank));
        const slots = Array.from({ length: RANKS }, () => []);
        shown.forEach((x, i) => { const s = i < RANKS ? i : shown.findIndex(y => y.rank === x.rank); slots[s].push(x); });
        const lineCount = Math.max(1, ...slots.map(s => s.length));
        const lines = Array.from({ length: lineCount }, (_, li) => slots.map(s => s[li]));
        const relay = isRelay(ev);
        const wind = needsWind(ev);
        const top = r;
        lines.forEach((line, li) => {
            const first = li === 0;
            setCell(ws, r, 2, first ? ev.name : '', { font: F(7), border: { top: first ? dbl : hair, bottom: hair, left: thin, right: thin } });
            for (let k = 0; k < RANKS; k++) {
                const c = 3 + k * 3;
                const x = line[k];
                const tieCount = x ? ranked.filter(y => y.rank === x.rank).length : 0;
                let rec = x ? recordText(ev, x) : '';
                if (x) {
                    const code = ctx.recordCodes.get(`${ev.id}|${x.entry_id}`); if (code) rec += ' ' + code;
                    if (tieCount > 1) rec += x.rank >= RANKS ? ` 공동${x.rank}위` : `(공동${x.rank}위)`;
                }
                const b = { top: first ? dbl : hair, bottom: hair };
                setCell(ws, r, c, x ? (relay ? '' : x.athlete_name) : '', { font: F(7), border: { ...b, left: thin } });
                setCell(ws, r, c + 1, x ? (relay ? x.athlete_name : x.team) : '', { font: F(7), border: { ...b, left: hair, right: hair } });
                setCell(ws, r, c + 2, rec, { font: F(7), border: { ...b, right: thin } });
            }
            // 완주 3명 미만이면 순위 경기가 아닌 기록경기 — 마지막 선수 다음 성명 칸에 표기 (연맹 양식)
            if (first && shown.length < 3) setCell(ws, r, 3 + shown.length * 3, '기록경기', { font: F(7), border: { top: dbl, bottom: hair, left: thin } });
            ws.getRow(r).height = 13.5;
            r++;
        });
        // 아래 행: 풍속 / 계주 주자
        let subRow = null;
        if (relay) {
            subRow = r;
            setCell(ws, r, 2, block.mixed ? '(Mixed)' : '', { font: F(7), border: { bottom: thin, left: thin, right: thin } });
            for (let k = 0; k < RANKS; k++) {
                const c = 3 + k * 3, x = lines[0][k];
                ws.mergeCells(r, c, r, c + 2);
                setCell(ws, r, c, x ? (ctx.members.get(x.entry_id) || []).join(' ') : '', { font: F(7), border: { top: hair, bottom: thin, left: thin, right: thin } });
            }
            ws.getRow(r).height = 13.5; r++;
        } else if (wind) {
            subRow = r;
            setCell(ws, r, 2, '풍향풍속', { font: F(7), border: { bottom: thin, left: thin, right: thin } });
            const winds = shown.map(x => x.wind);
            // 연맹 양식은 + 부호 없이 '0.7' · '-0.6'. 도약에서 추풍(+2.0 초과)이면 풍속 옆에 '참고기록' (회장배 24회 양식)
            const fw = w => (w == null ? '' : Number(w).toFixed(1)).replace(/^-0\.0$/, '0.0') + (w != null && w > 2.0 && ev.category === 'field_distance' ? '참고기록' : '');
            if (ev.category === 'field_distance') {
                for (let k = 0; k < RANKS; k++) { const x = lines[0][k]; setCell(ws, r, 3 + k * 3 + 1, x ? fw(x.wind) : '', { font: F(7), border: { bottom: thin } }); }
            } else {
                const uniq = [...new Set(winds.filter(w => w != null).map(w => Number(w).toFixed(1)))];
                if (uniq.length <= 1) setCell(ws, r, 4, uniq.length ? fw(Number(uniq[0])) : '', { font: F(7), border: { bottom: thin } });
                else for (let k = 0; k < RANKS; k++) { const x = lines[0][k]; setCell(ws, r, 3 + k * 3 + 1, x ? fw(x.wind) : '', { font: F(7), border: { bottom: thin } }); }
            }
            for (let c = 3; c <= 26; c++) { const cell = ws.getCell(r, c); cell.border = { ...(cell.border || {}), bottom: thin }; }
            ws.getRow(r).height = 13.5; r++;
        } else {
            // 아래 행이 없는 종목: 마지막 행 아래를 실선으로
            for (let c = 2; c <= 26; c++) { const cell = ws.getCell(r - 1, c); cell.border = { ...(cell.border || {}), bottom: thin }; }
        }
        // 경기 일차 (A열, 종목 행~아래 행 병합)
        const day = ctx.dayOf.get(ev.id);
        const bottom = subRow != null ? subRow : r - 1;
        if (bottom > top) ws.mergeCells(top, 1, bottom, 1);
        setCell(ws, top, 1, day || '', { font: { name: '돋움', size: 11 }, align: 'center', border: { right: thin } });
    }
    return r + 1;
}

async function generateKjafRecordSheet(db, comp, deps) {
    const { getEventResultsForCert } = deps;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PACE RISE : Node';

    // ── 데이터 ──
    // 종목의 부(division)가 비어 있으면 대회의 부 구분(division_type: middle/high/elem)을 따른다
    const compLevel = { elem: 'ELEM', middle: 'MID', high: 'HIGH' }[String(comp.division_type || '').toLowerCase()] || null;
    const events = (await db.all('SELECT * FROM event WHERE competition_id=? AND parent_event_id IS NULL ORDER BY sort_order, id', comp.id))
        .map(e => ({ ...e, ...(() => { const p = parseDivision(e.division); return { _level: p.level || compLevel, _grade: p.grade }; })() }));
    // 같은 종목의 여러 라운드 → 결승(최종 라운드)만
    const finals = new Map();
    const roundRank = { final: 3, semifinal: 2, preliminary: 1 };
    for (const e of events) {
        const k = `${e.gender}|${e.division || ''}|${normEv(e.name)}`;
        const cur = finals.get(k);
        if (!cur || (roundRank[e.round_type] || 0) > (roundRank[cur.round_type] || 0)) finals.set(k, e);
    }
    const finalEvents = [...finals.values()];
    const results = new Map();
    for (const e of finalEvents) {
        try { results.set(e.id, await getEventResultsForCert(e.id)); } catch (err) { results.set(e.id, { rows: [] }); }
    }
    // 계주 주자
    const members = new Map();
    try {
        const rows = await db.all(`SELECT rm.event_entry_id, a.name, rm.leg_order FROM relay_member rm JOIN athlete a ON a.id=rm.athlete_id JOIN event_entry ee ON ee.id=rm.event_entry_id JOIN event e ON e.id=ee.event_id WHERE e.competition_id=? ORDER BY rm.event_entry_id, rm.leg_order, rm.id`, comp.id);
        for (const m of rows) { if (!members.has(m.event_entry_id)) members.set(m.event_entry_id, []); members.get(m.event_entry_id).push(m.name); }
    } catch (e) {}
    // 신기록 (승인된 것) → 기록 옆 코드
    const recordCodes = new Map(); let recordRows = [];
    try {
        recordRows = await db.all(`SELECT rbl.*, e.name AS ev_name, e.gender AS ev_gender, e.division AS ev_division FROM record_breaking_log rbl JOIN event e ON e.id=rbl.event_id WHERE rbl.competition_id=? AND rbl.status='approved' ORDER BY rbl.reviewed_at, rbl.id`, comp.id);
        for (const x of recordRows) {
            const code = RECORD_CODE[x.record_type]; if (!code) continue;
            const key = `${x.event_id}|${x.event_entry_id}`;
            const cur = recordCodes.get(key);
            if (!cur || RECORD_RANK[code] > RECORD_RANK[cur]) recordCodes.set(key, code);
        }
    } catch (e) {}
    // 경기 일차
    const dayOf = new Map();
    try {
        const tt = await db.all(`SELECT event_id, event_ids, day, round FROM timetable WHERE competition_id=? AND (event_id IS NOT NULL OR (event_ids IS NOT NULL AND event_ids<>'')) ORDER BY day, time`, comp.id);
        const put = (id, day, isFinal) => { if (id == null) return; const cur = dayOf.get(Number(id)); if (cur == null || (isFinal && !cur.isFinal)) dayOf.set(Number(id), { day, isFinal }); };
        for (const t of tt) {
            const isFinal = /결승|final/i.test(t.round || '');
            put(t.event_id, t.day, isFinal);
            try { const ids = JSON.parse(t.event_ids || '[]'); if (Array.isArray(ids)) ids.forEach(id => put(id, t.day, isFinal)); } catch (e) {}
        }
        for (const [k, v] of dayOf) dayOf.set(k, v.day);
    } catch (e) {}
    const ctx = { results, members, recordCodes, dayOf, period: periodText(comp) };

    // ── 시트 ──
    const plan = planSheets(finalEvents);
    for (const sheet of plan) {
        const ws = wb.addWorksheet(sheet.name.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31), {
            pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.35, right: 0.2, top: 0.3, bottom: 0.3, header: 0, footer: 0 } },
        });
        COL_W.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
        // 대회명 · 심판장
        ws.mergeCells(2, 5, 2, 20);
        setCell(ws, 2, 5, comp.name || '', { font: { name: FONT_TITLE, size: 18 }, align: 'center', wrap: true });
        ws.getRow(2).height = /\n/.test(comp.name || '') || String(comp.name || '').length > 26 ? 55.5 : 45;
        setCell(ws, 2, 21, '  심판장 :                            (인)', { font: { name: FONT_TITLE, size: 11 }, align: 'left', border: { bottom: thin } });
        ws.getRow(4).height = 9.75;
        let r = 3;
        sheet.blocks.forEach((b, i) => {
            if (i > 0) r += 1;
            r = drawBlock(ws, r, b, ctx);
        });
        setCell(ws, r, 2, FOOT_NOTE, { font: { name: FONT_TITLE, size: 8 } });
        ws.views = [{ showGridLines: false }];
    }

    // ── 신기록현황 ──
    {
        const ws = wb.addWorksheet('신기록현황', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
        [5.33, 5.33, 8.89, 9.89, 10.33, 15.66, 13.11, 8.11, 8.89].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
        ws.mergeCells(1, 1, 1, 9); setCell(ws, 1, 1, '신 기 록 현 황', { font: { name: FONT_TITLE, size: 20, bold: true }, align: 'center' }); ws.getRow(1).height = 29.25;
        ws.mergeCells(3, 1, 3, 9);
        const a = kstDateParts(comp.start_date), b = kstDateParts(comp.end_date);
        const when = a ? `${a.y}년 ${a.mo}월 ${a.d}일${b ? ` ~ ${b.mo}월 ${b.d}일` : ''} ${comp.venue || ''}` : (comp.venue || '');
        setCell(ws, 3, 1, `${comp.name || ''}\n${when}`, { font: { name: FONT_TITLE, size: 12 }, align: 'center', wrap: true }); ws.getRow(3).height = 57.75;
        const H = ['순', '일시', '종별', '종목', '성명', '소속', '기록', '종전기록', '비고'];
        H.forEach((h, i) => setCell(ws, 5, i + 1, h, { font: F(9, { bold: true }), align: 'center', border: { top: thin, bottom: thin, left: thin, right: thin } })); ws.getRow(5).height = 30;
        const gl = e => { const p = parseDivision(e.ev_division); const lv = p.level ? LEVEL_KO[p.level] : ''; return e.ev_gender === 'X' ? '혼성' : `${G_SHORT[e.ev_gender] || ''}${lv}${p.grade ? p.grade + '학년' : ''}부`; };
        const label = { national: '한국신', division: '부별신', competition: '대회신' };
        let r = 6, n = 1;
        for (const x of recordRows) {
            const d = dayOf.get(x.event_id);
            [n++, d ? `${d}일` : '', gl(x), x.ev_name, x.athlete_name, x.athlete_team, x.new_value, x.previous_value, label[x.record_type] || x.record_type]
                .forEach((v, i) => setCell(ws, r, i + 1, v, { font: F(9), align: i === 4 || i === 5 ? 'left' : 'center', border: { top: thin, bottom: thin, left: thin, right: thin } }));
            ws.getRow(r).height = 40.5; r++;
        }
        if (!recordRows.length) { ws.mergeCells(6, 1, 6, 9); setCell(ws, 6, 1, '해당 없음', { font: F(9), align: 'center', border: { top: thin, bottom: thin, left: thin, right: thin } }); }
        ws.views = [{ showGridLines: false }];
    }
    return wb;
}

module.exports = { generateKjafRecordSheet, planSheets, parseDivision, recordText, normEv };
