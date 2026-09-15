'use strict';
/**
 * lib/fieldCardImport.js — 필드 수기 기록카드(xlsx) 파서 + 계산/검산 (순수 함수, DB 무관)
 *
 * 심판이 손으로 쓴 필드 기록카드 사진을 ChatGPT/Claude 로 전사한 xlsx 를 읽어
 * 시기별 기록(투척·수평도약), 시기별 풍속(수평도약), 높이별 O/X(수직도약)로 풀어낸다.
 * 카드에 적힌 최고기록·순위는 저장 대상이 아니라 "검산값"이다 — 시기별 기록으로
 * 다시 계산한 값과 대조해서 다르면 경고를 붙인다 (AI 오독 자동 탐지).
 *
 * 양식 3종 (헤더 1행 + 선수 1명당 1행, 셀 병합 없음, 종별·세부종목·라운드·조는 매 행 반복):
 *   throw      투척      : 공통8열 + 1차..6차 + 최고기록 + 순위 + 기록구분 + 비고
 *   horizontal 수평도약  : "기록" 시트(투척과 동일) + "풍속" 시트(공통8열 + 1차풍속..6차풍속)
 *   vertical   수직도약  : 공통8열 + 높이 헤더(1.55, 1.60 …) + 최고기록 + 순위 + 기록구분 + 비고
 *
 * 셀 표기:
 *   거리   숫자 "36.20" / 파울 "X" / 패스 "-" / 시도 없음 빈칸
 *   풍속   "+0.8" "-0.9" "0.0" — 유효 시기에만. 파울·패스 시기의 풍속은 무시 (저장 NULL)
 *   높이   "O" "XO" "XXO" "XXX" "-" "X-" "XX-" / 시도 없음 빈칸 / 끝의 "r" 은 기권 표시(저장 안 함)
 *   기록구분 DNS / DNF / DQ / NM (빈칸 = 없음). 순위 칸의 DNS 등도 인식.
 *
 * 저장 규칙은 FIELD_EVENT_GUIDE.md 와 동일: 파울=0, 패스=-1, 높이 패스='PASS'.
 * 라우트: lib/routes/field_card_import.js
 */
const XLSX = require('xlsx');

const MAX_ATTEMPTS = 6;
const COMMON_HEADERS = ['종별', '세부종목', '라운드', '조', '순서', '배번', '성명', '소속'];
const ATTEMPT_HEADERS = ['1차', '2차', '3차', '4차', '5차', '6차'];
const WIND_HEADERS = ['1차풍속', '2차풍속', '3차풍속', '4차풍속', '5차풍속', '6차풍속'];
const TAIL_HEADERS = ['최고기록', '순위', '기록구분', '비고'];

// ─────────────────────────────────────────────────────────────
// 토큰 정규화
// ─────────────────────────────────────────────────────────────
function _tok(raw) { return String(raw == null ? '' : raw).normalize('NFKC').trim(); }
function _normH(h) {
    return _tok(h).replace(/\(.*?\)/g, '').replace(/\s+/g, '').replace(/[\[\]]/g, '').toLowerCase();
}
function _normBib(b) {
    const d = String(b == null ? '' : b).replace(/[^0-9]/g, '');
    return d.replace(/^0+/, '') || (d ? '0' : '');
}
function _normName(s) { return _tok(s).replace(/\s+/g, ''); }
function _normEvt(s) { return String(s || '').replace(/[,\s]+/g, '').toLowerCase(); }
function hk(h) { return Number(h).toFixed(2); }          // 높이 키 "1.55"
function fmtDist(v) { return v == null ? '' : Number(v).toFixed(2); }
function fmtWind(w) { if (w == null) return ''; const v = Number(w); return (v > 0 ? '+' : '') + v.toFixed(1); }

const FOUL_RE = /^(x|×|✕|✗|f|foul|파울)$/i;
const PASS_RE = /^(-|—|–|ー|p|pass|패스)$/i;

/** 거리 셀 → null(빈칸) | {kind:'valid',value} | {kind:'foul',value:0} | {kind:'pass',value:-1} | {error} */
function parseDistanceToken(raw) {
    const s0 = _tok(raw);
    const s = s0.replace(/m$/i, '').replace(',', '.').trim();
    if (s === '') return null;
    if (FOUL_RE.test(s)) return { kind: 'foul', value: 0 };
    if (PASS_RE.test(s)) return { kind: 'pass', value: -1 };
    if (/^\d{1,3}(\.\d+)?$/.test(s)) {
        const v = Math.round(parseFloat(s) * 100) / 100;
        if (v <= 0) return { error: `0 이하 기록 "${s0}"` };
        if (v > 120) return { error: `범위 밖 기록 "${s0}"` };
        return { kind: 'valid', value: v };
    }
    return { error: `기록 인식 불가 "${s0}"` };
}

/** 풍속 셀 → null(빈칸/측정없음) | {value} | {error} */
function parseWindToken(raw) {
    const s0 = _tok(raw);
    let s = s0.toLowerCase().replace(/m\/s|㎧/g, '').replace(/\s/g, '').replace(',', '.').replace(/^±/, '+');
    if (s === '') return null;
    if (/^(nwi|없음|n\/a|na|-|—|–)$/.test(s)) return null;
    if (/^[+-]?\d*(\.\d+)?$/.test(s)) {
        const v = parseFloat(s);
        if (Number.isNaN(v)) return { error: `풍속 인식 불가 "${s0}"` };
        const r = Math.round(v * 10) / 10;
        if (Math.abs(r) > 20) return { error: `풍속 범위 밖 "${s0}"` };
        return { value: r === 0 ? 0 : r };
    }
    return { error: `풍속 인식 불가 "${s0}"` };
}

/** 높이 셀 → null(빈칸) | {marks:['X','X','O'], retired} | {error}  (패스는 'PASS') */
function parseHeightToken(raw) {
    const s0 = _tok(raw);
    let s = s0.toUpperCase().replace(/\s/g, '');
    if (s === '') return null;
    s = s.replace(/PASS/g, '-').replace(/P/g, '-').replace(/[—–ー]/g, '-').replace(/[×✕✗]/g, 'X').replace(/0/g, 'O');
    let retired = false;
    if (/R$/.test(s)) { retired = true; s = s.slice(0, -1); }
    if (s === '' && retired) return { marks: [], retired: true };
    if (!/^(X{0,2}[O-]|X{1,3})$/.test(s)) return { error: `높이 표기 인식 불가 "${s0}"` };
    return { marks: s.split('').map(c => (c === '-' ? 'PASS' : c)), retired };
}

/** 기록구분 셀 → {code:''|'DNS'|'DNF'|'DQ'|'NM', unsupported?, unknown?} */
function parseStatusToken(raw) {
    const s = _tok(raw).toUpperCase().replace(/\s/g, '');
    if (s === '') return { code: '' };
    if (/^(DNS|결장|불참|미출전|미출발)$/.test(s)) return { code: 'DNS' };
    if (/^(DNF|중도포기|미완주)$/.test(s)) return { code: 'DNF' };
    if (/^(DQ|DSQ|실격)$/.test(s)) return { code: 'DQ' };
    if (/^(NM|NH|기록없음|무기록)$/.test(s)) return { code: 'NM' };
    if (/^(R|RET|RETIRED|기권)$/.test(s)) return { code: '', unsupported: 'R' };
    return { code: '', unknown: s };
}

/** 바 높이 헤더/셀 → 미터 (1.55 / "155" / "155cm" / "1.55m") | null */
function normalizeBarHeight(raw) {
    const s = _tok(raw).toLowerCase().replace(/\s/g, '').replace(',', '.');
    const m = s.match(/^(\d+(?:\.\d+)?)(m|cm)?$/);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (m[2] === 'cm' || (!m[2] && v >= 10)) v = v / 100;
    v = Math.round(v * 100) / 100;
    if (v < 0.5 || v > 7) return null;
    return v;
}

const EN_EVENT_MAP = [
    ['javelin', '창던지기'], ['shotput', '포환던지기'], ['shot', '포환던지기'], ['discus', '원반던지기'],
    ['hammer', '해머던지기'], ['longjump', '멀리뛰기'], ['triplejump', '세단뛰기'],
    ['highjump', '높이뛰기'], ['polevault', '장대높이뛰기'],
];
/** 세부종목 문자열 → { base: 비교용 종목명, combined: '10종'|'7종'|'5종'|null } */
function normalizeEventName(raw) {
    let s = _tok(raw);
    let combined = null;
    const cm = s.match(/(10종|7종|5종)/);
    if (cm) { combined = cm[1]; s = s.replace(/\[?(10종|7종|5종)(경기)?\]?/g, ' '); }
    s = s.replace(/^\[.*?\]\s*/, '');
    s = s.replace(/\((남|여|남자|여자|혼성)\)/g, ' ').replace(/^(남자|여자|혼성)\s*/, '').replace(/\s*(남자|여자|혼성)$/, '');
    let n = _normEvt(s);
    for (const [en, ko] of EN_EVENT_MAP) { if (n.includes(en)) { n = ko; break; } }
    return { base: n, combined };
}
function needsWindByName(name) { return /멀리뛰기|세단뛰기|long|triple/i.test(String(name || '')); }

// ─────────────────────────────────────────────────────────────
// 헤더 인식
// ─────────────────────────────────────────────────────────────
function detectColumns(headerRow) {
    const col = { attempts: {}, winds: {}, heights: [] };
    (headerRow || []).forEach((raw, i) => {
        const h = _normH(raw);
        if (!h) return;
        let m;
        if ((m = h.match(/^([1-6])차(?:시기|시도)?풍속$/)) || (m = h.match(/^wind([1-6])$/))) { col.winds[+m[1]] = i; return; }
        if ((m = h.match(/^([1-6])차(?:시기|시도|기록)?$/)) || (m = h.match(/^(?:trial|attempt)([1-6])$/))) { col.attempts[+m[1]] = i; return; }
        if (/^\d+(?:[.,]\d+)?(?:m|cm)?$/.test(h)) {
            const bh = normalizeBarHeight(h);
            if (bh != null) { col.heights.push({ col: i, height: bh }); return; }
        }
        if (h.includes('기록구분') || h === '상태' || h === 'status') { col.status = i; return; }
        if (h.includes('세부종목') || h === '종목' || h.includes('종목명') || h === 'event') { col.event = i; return; }
        if (h === '종별' || h.includes('부문') || h.includes('부별') || h === '부' || h === 'division') { col.div = i; return; }
        if (h.includes('라운드') || h === 'round') { col.round = i; return; }
        if (h === '조' || h.includes('조번호') || h === 'heat') { col.heat = i; return; }
        if (h.includes('순서') || h.includes('레인') || h === 'order' || h === 'lane') { col.order = i; return; }
        if (h.includes('배번') || h === 'bib') { col.bib = i; return; }
        if (h.includes('성명') || h.includes('이름') || h.includes('선수') || h === 'name' || h === 'athlete') { col.name = i; return; }
        if (h.includes('소속') || h.includes('팀') || h === 'team') { col.team = i; return; }
        if (h.includes('최고') || h === '기록' || h === 'best' || h === 'mark') { col.best = i; return; }
        if (h.includes('순위') || h === 'pos' || h === 'rank') { col.rank = i; return; }
        if (h.includes('비고') || h === 'remark' || h === 'detail') { col.remark = i; return; }
    });
    col.heights.sort((a, b) => a.height - b.height);
    const hasAtt = Object.keys(col.attempts).length > 0;
    const hasWind = Object.keys(col.winds).length > 0;
    col.kind = hasAtt ? 'distance' : (col.heights.length ? 'height' : (hasWind ? 'wind' : 'unknown'));
    return col;
}

function groupKey(divRaw, eventName, roundRaw, heatNum) {
    return [divRaw, eventName, roundRaw, heatNum].map(x => _tok(x).replace(/\s+/g, '')).join('|');
}
function groupLabel(g) {
    return `${g.divisionRaw || ''} ${g.eventName || ''} ${g.roundRaw || ''} ${g.heatNum}조`.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// 시트 파싱
// ─────────────────────────────────────────────────────────────
function applyWinds(row, winds) {
    for (const n of Object.keys(winds)) {
        const w = winds[n];
        if (w == null) continue;
        const a = row.attempts[n];
        if (!a) { row.issues.push({ level: 'warn', msg: `${n}차 기록이 없는데 풍속 ${fmtWind(w)} 있음 — 무시` }); continue; }
        if (a.kind !== 'valid') { row.issues.push({ level: 'info', msg: `${n}차 파울·패스 시기의 풍속 ${fmtWind(w)} 무시` }); continue; }
        a.wind = w;
    }
}

function parseSheet(sheetName, rows, col, out, issues) {
    const get = (r, k) => (col[k] === undefined ? '' : _tok(r[col[k]]));
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i] || [];
        if (!r.some(c => _tok(c) !== '')) continue;
        const excelRow = i + 1;
        const where = `${sheetName} ${excelRow}행`;
        const eventName = get(r, 'event');
        const divRaw = get(r, 'div');
        const roundRaw = get(r, 'round') || '결승';
        const heatNum = parseInt(get(r, 'heat'), 10) || 1;
        if (!eventName) { issues.push({ level: 'error', msg: `${where}: 세부종목이 비어 있어 건너뜀` }); continue; }
        const key = groupKey(divRaw, eventName, roundRaw, heatNum);
        let g = out.get(key);
        if (!g) {
            g = { key, kind: col.kind, sheet: sheetName, divisionRaw: divRaw, eventName, roundRaw, heatNum,
                  heights: col.heights.map(h => h.height), rows: [], issues: [] };
            out.set(key, g);
        } else if (g.kind !== col.kind) {
            issues.push({ level: 'error', msg: `${where}: 같은 조가 다른 양식의 시트에 중복됨 — 건너뜀` });
            continue;
        } else if (col.kind === 'height') {
            g.heights = [...new Set([...g.heights, ...col.heights.map(h => h.height)])].sort((a, b) => a - b);
        }

        const row = {
            where, excelRow, sheet: sheetName,
            order: parseInt(get(r, 'order'), 10) || null,
            bib: get(r, 'bib'), name: get(r, 'name'), team: get(r, 'team'), remark: get(r, 'remark'),
            status: parseStatusToken(get(r, 'status')),
            card: { best: null, bestNM: false, rank: null },
            attempts: {}, marks: {}, winds: {}, retired: false,
            computed: { best: null, rank: null, bestWind: null, sortedValid: [] },
            issues: [],
        };
        // 순위 칸의 DNS/DQ 등도 상태로 인식 (구 양식 호환)
        const rankTok = get(r, 'rank');
        if (/^\d+$/.test(rankTok)) row.card.rank = parseInt(rankTok, 10);
        else if (rankTok) { const st = parseStatusToken(rankTok); if (st.code && !row.status.code) row.status = st; }
        const bestTok = get(r, 'best');
        if (bestTok) {
            if (/^(nm|nh|기록없음|무기록)$/i.test(bestTok)) row.card.bestNM = true;
            else if (col.kind === 'height') {
                const v = normalizeBarHeight(bestTok);
                if (v != null) row.card.best = v; else row.issues.push({ level: 'warn', msg: `최고기록 "${bestTok}" 인식 불가 — 검산 생략` });
            } else if (col.kind === 'distance') {
                const t = parseDistanceToken(bestTok);
                if (t && t.kind === 'valid') row.card.best = t.value;
                else if (t && t.error) row.issues.push({ level: 'warn', msg: `최고기록 ${t.error} — 검산 생략` });
            }
        }

        if (col.kind === 'distance') {
            for (let n = 1; n <= MAX_ATTEMPTS; n++) {
                if (col.attempts[n] === undefined) continue;
                const t = parseDistanceToken(r[col.attempts[n]]);
                if (!t) continue;
                if (t.error) { row.issues.push({ level: 'error', msg: `${n}차 ${t.error}` }); continue; }
                row.attempts[n] = { kind: t.kind, value: t.value, wind: null, raw: _tok(r[col.attempts[n]]) };
            }
            const inlineWinds = {};
            for (let n = 1; n <= MAX_ATTEMPTS; n++) {
                if (col.winds[n] === undefined) continue;
                const w = parseWindToken(r[col.winds[n]]);
                if (!w) continue;
                if (w.error) { row.issues.push({ level: 'error', msg: `${n}차 ${w.error}` }); continue; }
                inlineWinds[n] = w.value;
            }
            applyWinds(row, inlineWinds);
        } else if (col.kind === 'height') {
            for (const hc of col.heights) {
                const t = parseHeightToken(r[hc.col]);
                if (!t) continue;
                if (t.error) { row.issues.push({ level: 'error', msg: `${hk(hc.height)} ${t.error}` }); continue; }
                if (t.marks.length) row.marks[hk(hc.height)] = t.marks;
                if (t.retired) row.retired = true;
            }
        } else if (col.kind === 'wind') {
            for (let n = 1; n <= MAX_ATTEMPTS; n++) {
                if (col.winds[n] === undefined) continue;
                const w = parseWindToken(r[col.winds[n]]);
                if (!w) continue;
                if (w.error) { row.issues.push({ level: 'error', msg: `${n}차 ${w.error}` }); continue; }
                row.winds[n] = w.value;
            }
        }
        g.rows.push(row);
    }
}

function findRow(rows, probe) {
    const nb = _normBib(probe.bib);
    if (nb) { const m = rows.find(r => _normBib(r.bib) === nb); if (m) return m; }
    if (probe.order) { const m = rows.find(r => r.order === probe.order); if (m) return m; }
    const nn = _normName(probe.name);
    if (nn) { const m = rows.find(r => _normName(r.name) === nn); if (m) return m; }
    return null;
}

/** 풍속 시트 그룹을 기록 시트 그룹에 병합 (배번 → 순서 → 성명 순 매칭) */
function mergeWind(recordGroups, windGroups, issues) {
    for (const wg of windGroups.values()) {
        let g = recordGroups.get(wg.key);
        if (!g) {
            const cands = [...recordGroups.values()].filter(x => x.kind === 'distance'
                && normalizeEventName(x.eventName).base === normalizeEventName(wg.eventName).base && x.heatNum === wg.heatNum);
            if (cands.length === 1) g = cands[0];
        }
        if (!g) { issues.push({ level: 'warn', msg: `풍속 시트 "${wg.sheet}" ${groupLabel(wg)}: 해당하는 기록 시트의 조를 찾지 못해 풍속 무시` }); continue; }
        if (g.kind !== 'distance') { g.issues.push({ level: 'warn', msg: `높이 종목에 풍속 시트가 있어 무시` }); continue; }
        g.windSheet = wg.sheet;
        for (const wr of wg.rows) {
            const target = findRow(g.rows, wr);
            if (!target) { g.issues.push({ level: 'warn', msg: `풍속 시트 ${wr.where}: 배번 ${wr.bib || '-'} ${wr.name || ''} 선수를 기록 시트에서 찾지 못함` }); continue; }
            for (const is of wr.issues) target.issues.push(is);
            applyWinds(target, wr.winds);
        }
    }
}

/**
 * xlsx 버퍼 → { groups: [...], issues: [...] }
 * groups 는 계산 전 상태. 종목 해석 후 computeGroup(g, { needsWind }) 호출.
 */
function parseFieldCardWorkbook(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const recordGroups = new Map();
    const windGroups = new Map();
    const issues = [];
    for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (rows.length < 2) continue;
        const col = detectColumns(rows[0]);
        if (col.kind === 'unknown') { issues.push({ level: 'info', msg: `시트 "${name}": 기록 열이 없어 건너뜀` }); continue; }
        if (col.event === undefined) { issues.push({ level: 'error', msg: `시트 "${name}": '세부종목' 열이 없어 건너뜀` }); continue; }
        parseSheet(name, rows, col, col.kind === 'wind' ? windGroups : recordGroups, issues);
    }
    if (recordGroups.size === 0) throw new Error('기록 시트를 찾을 수 없습니다. 1차~6차 열 또는 높이 열(1.55 …)이 있는 시트가 필요합니다.');
    mergeWind(recordGroups, windGroups, issues);
    return { groups: Array.from(recordGroups.values()), issues };
}

// ─────────────────────────────────────────────────────────────
// 계산 (record.js 의 순위 로직과 동일) + 검산
// ─────────────────────────────────────────────────────────────
function rowHasData(r) {
    return Object.keys(r.attempts).length > 0 || Object.keys(r.marks).length > 0 || !!r.status.code;
}

function computeDistance(g) {
    for (const r of g.rows) {
        const vals = [];
        for (let n = 1; n <= MAX_ATTEMPTS; n++) { const a = r.attempts[n]; if (a && a.kind === 'valid') vals.push(a.value); }
        const best = vals.length ? Math.max(...vals) : null;
        r.computed.best = best;
        r.computed.sortedValid = [...vals].sort((a, b) => b - a);
        r.computed.bestWind = null;
        if (best != null) {
            // WA: 같은 기록이 여러 시기면 나중 시기의 풍속이 공식
            for (let n = MAX_ATTEMPTS; n >= 1; n--) { const a = r.attempts[n]; if (a && a.kind === 'valid' && a.value === best) { r.computed.bestWind = a.wind; break; } }
        }
        r.computed.rank = null;
    }
    const cmpTail = (A, B) => {
        const L = Math.max(A.length, B.length);
        for (let k = 1; k < L; k++) { const av = A[k] ?? -1, bv = B[k] ?? -1; if (bv !== av) return bv - av; }
        return 0;
    };
    const ranked = g.rows.filter(r => r.computed.best != null && !r.status.code).sort((a, b) => {
        if (b.computed.best !== a.computed.best) return b.computed.best - a.computed.best;
        return cmpTail(a.computed.sortedValid, b.computed.sortedValid);
    });
    let cr = 1;
    ranked.forEach((r, i) => {
        if (i > 0) {
            const p = ranked[i - 1];
            const tied = p.computed.best === r.computed.best && cmpTail(p.computed.sortedValid, r.computed.sortedValid) === 0;
            r.computed.rank = tied ? p.computed.rank : cr;
        } else r.computed.rank = cr;
        cr = i + 2;
    });
}

function computeHeight(g) {
    const heights = [...g.heights].sort((a, b) => a - b);
    for (const r of g.rows) {
        let best = null, totalFails = 0, failsAtBest = 0, elim = false;
        for (const h of heights) {
            const marks = r.marks[hk(h)];
            if (!marks) continue;
            const x = marks.filter(m => m === 'X').length;
            totalFails += x;
            if (marks.includes('O')) { best = h; failsAtBest = x; }
            if (x >= 3) elim = true;
        }
        r.computed.best = best;
        r.computed.failsAtBest = failsAtBest;
        r.computed.totalFails = totalFails;
        r.computed.eliminated = elim;
        r.computed.rank = null;
    }
    const ranked = g.rows.filter(r => r.computed.best != null && !r.status.code).sort((a, b) => {
        if (b.computed.best !== a.computed.best) return b.computed.best - a.computed.best;
        if (a.computed.failsAtBest !== b.computed.failsAtBest) return a.computed.failsAtBest - b.computed.failsAtBest;
        return a.computed.totalFails - b.computed.totalFails;
    });
    let cr = 1;
    ranked.forEach((r, i) => {
        if (i > 0) {
            const p = ranked[i - 1];
            const tied = p.computed.best === r.computed.best && p.computed.failsAtBest === r.computed.failsAtBest && p.computed.totalFails === r.computed.totalFails;
            r.computed.rank = tied ? p.computed.rank : cr;
        } else r.computed.rank = cr;
        cr = i + 2;
    });
}

function runChecks(g, needsWind) {
    const fmt = g.kind === 'height' ? hk : fmtDist;
    for (const r of g.rows) {
        const c = r.computed, card = r.card;
        const hasAttempts = Object.keys(r.attempts).length > 0 || Object.keys(r.marks).length > 0;
        if (g.kind === 'distance' && needsWind) {
            for (let n = 1; n <= MAX_ATTEMPTS; n++) {
                const a = r.attempts[n];
                if (a && a.kind === 'valid' && a.wind == null) r.issues.push({ level: 'warn', msg: `${n}차 유효 기록 ${fmtDist(a.value)}에 풍속 없음` });
            }
        }
        if (card.best != null) {
            if (c.best == null) r.issues.push({ level: 'warn', msg: `카드 최고기록 ${fmt(card.best)} / 계산: 유효 기록 없음` });
            else if (Math.abs(card.best - c.best) > 0.005) r.issues.push({ level: 'warn', msg: `최고기록 불일치: 카드 ${fmt(card.best)} / 계산 ${fmt(c.best)}` });
        } else if (card.bestNM && c.best != null) {
            r.issues.push({ level: 'warn', msg: `카드는 NM 인데 유효 기록 ${fmt(c.best)} 있음` });
        }
        if (card.rank != null) {
            if (c.rank != null && card.rank !== c.rank) r.issues.push({ level: 'warn', msg: `순위 불일치: 카드 ${card.rank} / 계산 ${c.rank}` });
            else if (c.rank == null && !r.status.code) r.issues.push({ level: 'warn', msg: `카드 순위 ${card.rank} 인데 계산 순위 없음 (유효 기록 없음)` });
        }
        if (r.status.code === 'NM' && c.best != null) {
            r.issues.push({ level: 'warn', msg: `기록구분 NM 인데 유효 기록 ${fmt(c.best)} 있음 — NM 저장 안 함` });
            r.status = { code: '' };
        }
        if (['DNS', 'DQ', 'DNF'].includes(r.status.code) && hasAttempts) {
            r.issues.push({ level: 'warn', msg: `기록구분 ${r.status.code} 인데 시기 기록도 있음 (화면에는 ${r.status.code} 가 우선 표시)` });
        }
        if (r.status.unknown) r.issues.push({ level: 'warn', msg: `기록구분 "${r.status.unknown}" 인식 불가 — 무시` });
        if (r.status.unsupported) r.issues.push({ level: 'info', msg: `기권(R) 표시는 저장하지 않음 (기록은 그대로 인정)` });
        if (r.retired) r.issues.push({ level: 'info', msg: `높이 셀의 r(기권) 표시는 저장하지 않음` });
    }
}

/** 그룹 계산 + 검산. opts.needsWind: 멀리뛰기·세단뛰기 여부 (DB 종목명 기준으로 라우트가 결정) */
function computeGroup(g, opts = {}) {
    if (g.kind === 'distance') computeDistance(g);
    else if (g.kind === 'height') computeHeight(g);
    runChecks(g, !!opts.needsWind);
    for (const r of g.rows) {
        r.hasData = rowHasData(r);
        r.valid = !r.issues.some(i => i.level === 'error');
    }
    return g;
}

/** marks 배열 → 표시 문자열 ('X','X','O' → "XXO", PASS → "-") */
function marksToString(marks) { return (marks || []).map(m => (m === 'PASS' || m === '-') ? '-' : m).join(''); }

// ─────────────────────────────────────────────────────────────
// 양식 템플릿 + AI 프롬프트
// ─────────────────────────────────────────────────────────────
const NOTATION_ROWS = [
    ['필드 기록카드 xlsx 작성 규칙'],
    ['1행은 헤더, 2행부터 선수 1명당 1행. 셀 병합 없음. 종별·세부종목·라운드·조는 매 행 반복.'],
    ['종별: "여자 일반부" 처럼 성별 + 부.  세부종목: 한글 종목명.  라운드: 결승/예선.  조: 숫자(없으면 1).'],
    ['거리(투척·멀리뛰기·세단뛰기): 숫자 "36.20" / 파울 X / 패스 - / 시도 없음(4~6차 미진출 등)은 빈칸.'],
    ['풍속(멀리뛰기·세단뛰기): 두 번째 시트 "풍속"에 1차풍속~6차풍속. 부호 포함 "+0.8" "-0.9" "0.0". 파울·패스 시기는 빈칸. 부호는 칸 앞 인쇄된 +/- 중 동그라미 친 쪽.'],
    ['높이(높이뛰기·장대높이뛰기): 바 높이를 열 헤더로(1.55, 1.60 …). 셀에는 O / XO / XXO / XXX / 패스 - / 실패 후 패스 X- XX- / 시도 없음 빈칸.'],
    ['최고기록·순위: 카드에 적힌 값을 그대로. 프로그램은 저장하지 않고 계산값과 대조(검산)만 함.'],
    ['기록구분: DNS(결장) / DNF / DQ(실격) / NM(기록 없음) 중 하나. 없으면 빈칸.  빈 행은 "변경 없음"으로 처리.'],
    ['"1~3차 최고기록", "3차 후 순위/순서" 열은 옮기지 않음 (상위 8명 자동 계산).'],
];
const TEMPLATES = {
    throw: {
        label: '투척 (포환·원반·해머·창)', filename: 'field_card_throw.xlsx', filenameKo: '필드기록카드_투척_양식.xlsx',
        sheets: [{ name: '기록', header: [...COMMON_HEADERS, ...ATTEMPT_HEADERS, ...TAIL_HEADERS], rows: [
            ['여자 일반부', '창던지기', '결승', 1, 1, 53, '홍길동', '○○시청', '36.20', '33.43', '35.68', '34.70', '38.03', '33.60', '38.03', 3, '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 2, 57, '김영희', '△△시청', '46.24', '50.45', 'X', '53.20', '50.19', 'X', '53.20', 1, '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 3, 116, '이순이', '□□군청', '46.04', 'X', '46.46', '49.60', 'X', 'X', '49.60', 2, '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 4, 120, '박하나', '◇◇시청', '', '', '', '', '', '', '', '', 'DNS', ''],
        ] }, { name: '설명', header: null, rows: NOTATION_ROWS }],
    },
    horizontal: {
        label: '수평도약 (멀리뛰기·세단뛰기, 풍속)', filename: 'field_card_horizontal.xlsx', filenameKo: '필드기록카드_수평도약_양식.xlsx',
        sheets: [{ name: '기록', header: [...COMMON_HEADERS, ...ATTEMPT_HEADERS, ...TAIL_HEADERS], rows: [
            ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '홍길동', '○○시청', '5.94', 'X', '6.05', '5.88', '-', '-', '6.05', 1, '', ''],
            ['여자 일반부', '멀리뛰기', '결승', 1, 2, 217, '김영희', '△△시청', '5.85', '5.59', '5.63', '5.53', '5.71', 'X', '5.85', 2, '', ''],
            ['여자 일반부', '멀리뛰기', '결승', 1, 3, 119, '이순이', '□□군청', 'X', 'X', 'X', '', '', '', '', '', 'NM', ''],
        ] }, { name: '풍속', header: [...COMMON_HEADERS, ...WIND_HEADERS], rows: [
            ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '홍길동', '○○시청', '+0.8', '', '+1.2', '0.0', '', ''],
            ['여자 일반부', '멀리뛰기', '결승', 1, 2, 217, '김영희', '△△시청', '-0.3', '+0.5', '+0.9', '+1.4', '-0.2', ''],
            ['여자 일반부', '멀리뛰기', '결승', 1, 3, 119, '이순이', '□□군청', '', '', '', '', '', ''],
        ] }, { name: '설명', header: null, rows: NOTATION_ROWS }],
    },
    vertical: {
        label: '수직도약 (높이뛰기·장대높이뛰기)', filename: 'field_card_vertical.xlsx', filenameKo: '필드기록카드_수직도약_양식.xlsx',
        sheets: [{ name: '기록', header: [...COMMON_HEADERS, '1.55', '1.60', '1.65', '1.70', '1.75', '1.80', ...TAIL_HEADERS], rows: [
            ['여자 일반부', '높이뛰기', '결승', 1, 1, 34, '홍길동', '○○시청', '-', 'O', 'XO', 'O', 'XXO', 'XXX', '1.75', 1, '', ''],
            ['여자 일반부', '높이뛰기', '결승', 1, 2, 83, '김영희', '△△시청', 'O', 'O', 'XXO', 'XXX', '', '', '1.65', 2, '', ''],
            ['여자 일반부', '높이뛰기', '결승', 1, 3, 109, '이순이', '□□군청', 'XXX', '', '', '', '', '', '', '', 'NM', ''],
        ] }, { name: '설명', header: null, rows: NOTATION_ROWS }],
    },
};

function buildTemplateWorkbook(kind) {
    const t = TEMPLATES[kind];
    if (!t) return null;
    const wb = XLSX.utils.book_new();
    for (const s of t.sheets) {
        const aoa = s.header ? [s.header, ...s.rows] : s.rows;
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        if (s.header) ws['!cols'] = s.header.map(h => ({ wch: Math.max(6, Math.min(16, String(h).length * 2 + 2)) }));
        XLSX.utils.book_append_sheet(wb, ws, s.name);
    }
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const AI_PROMPT = `첨부한 사진은 육상 필드경기 수기 기록카드입니다. 카드에 적힌 내용을 그대로 xlsx 파일로 옮겨 주세요.

[출력 형식]
- 1행은 헤더, 2행부터 선수 1명당 1행. 셀 병합 없이 작성합니다.
- 공통 열(모든 행에 반복): 종별, 세부종목, 라운드, 조, 순서, 배번, 성명, 소속
  · 종별: "여자 일반부" 처럼 성별 + 부 (카드의 Women/Men, Senior/High School 등 체크박스 참고)
  · 세부종목: 한글 종목명 (창던지기 / 포환던지기 / 원반던지기 / 해머던지기 / 멀리뛰기 / 세단뛰기 / 높이뛰기 / 장대높이뛰기)
  · 라운드: 결승 또는 예선, 조: 숫자 (표시가 없으면 1)
- 투척·멀리뛰기·세단뛰기: 공통 열 다음에 1차, 2차, 3차, 4차, 5차, 6차, 최고기록, 순위, 기록구분, 비고
  · 기록은 "36.20" 처럼 소수 둘째 자리까지, 파울은 X, 패스는 -, 시도가 없는 칸(4~6차 미진출 등)은 빈칸
  · 카드의 최고기록(MARK of all trials)과 순위(POS)를 그대로 옮깁니다 (검산용)
  · "1~3차 최고기록", "3차 후 순위/순서" 열은 옮기지 않습니다
- 멀리뛰기·세단뛰기의 풍속 카드는 두 번째 시트 "풍속"에: 공통 열 + 1차풍속, 2차풍속, 3차풍속, 4차풍속, 5차풍속, 6차풍속
  · 풍속은 부호를 포함해 "+0.8", "-0.9", "0.0" 으로 적습니다. 파울·패스 시기의 풍속 칸은 비웁니다
  · 풍속 칸 앞에 인쇄된 + 와 - 중 심판이 동그라미 친 쪽이 부호입니다. 확신이 없으면 + 로 적고 비고에 "N차풍속?" 라고 적어 주세요
- 높이뛰기·장대높이뛰기: 공통 열 다음에 카드의 바 높이를 열 헤더로 (1.55, 1.60 …), 그 뒤에 최고기록, 순위, 기록구분, 비고
  · 셀에는 그 높이의 시도 결과를 순서대로: O, XO, XXO, XXX, 패스 -, 실패 후 패스 X- 또는 XX-, 시도 없음은 빈칸
- 기록구분: DNS(결장), DNF, DQ(실격), NM(기록 없음) 중 하나. 해당 없으면 빈칸

[주의]
- 동그라미, 밑줄, 사선 등 표시는 무시하고 숫자·기호만 옮깁니다.
- 값을 추정하거나 계산해서 채우지 않습니다. 카드에 적힌 그대로만 옮깁니다.
- 판독이 불확실한 셀은 가장 가까운 값을 적고 비고에 "?" 와 함께 그 칸을 적어 주세요.`;

module.exports = {
    MAX_ATTEMPTS, COMMON_HEADERS, ATTEMPT_HEADERS, WIND_HEADERS, TAIL_HEADERS,
    parseFieldCardWorkbook, computeGroup, detectColumns,
    parseDistanceToken, parseWindToken, parseHeightToken, parseStatusToken,
    normalizeBarHeight, normalizeEventName, needsWindByName,
    groupLabel, marksToString, fmtDist, fmtWind, hk,
    normBib: _normBib, normName: _normName,
    TEMPLATES, buildTemplateWorkbook, AI_PROMPT,
};
