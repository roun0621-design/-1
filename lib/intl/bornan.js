'use strict';
/**
 * Bornan 웹결과(국제대회 공식 결과 사이트) 어댑터 — 2026-09 국제대회 동기화
 *   예: 2026 아이치·나고야 아시안게임 results.asiangames2026.org → API back.results.asiangames2026.org/s/AG2026/en/ATH/…
 *   응답은 JSON 을 zlib 로 압축한 뒤 latin1 글자로 보낸다(Content-Type 은 json) → 글자를 바이트로 되돌려 inflate.
 *
 *   fetchJson(source, path)            — source: { base, champ, lang, disc }
 *   parseSchedule(units)               — 일정 유닛(조) 목록 → 우리 종목/라운드/조 구조
 *   parseEventEntries(json)            — 종목 엔트리 → 선수·팀(계주)
 *   describeResults(json)              — 결과 JSON 의 모양을 요약 (형식 확정 전 진단용)
 *   parseResults(json)                 — 결과 JSON → [{ reg, rank, lane, mark, status, wind, qual, record }] (모양이 다르면 빈 배열 + note)
 */
const zlib = require('zlib');
const { storedName } = require('../eventName');

// Bornan 종목 코드 → 우리 표기·분류
const EVENT_MAP = {
    '100M': ['100m', 'track'], '200M': ['200m', 'track'], '400M': ['400m', 'track'], '800M': ['800m', 'track'], '1500M': ['1500m', 'track'],
    '5000M': ['5000m', 'track'], '10000M': ['10000m', 'track'],
    '100MHURD': ['100mH', 'track'], '110MHURD': ['110mH', 'track'], '400MHURD': ['400mH', 'track'], '3000MST': ['3000mSC', 'track'],
    '4X100M': ['4x100mR', 'relay'], '4X400M': ['4x400mR', 'relay'],
    'HIGHJUMP': ['높이뛰기', 'field_height'], 'PLEVAULT': ['장대높이뛰기', 'field_height'],
    'LONGJUMP': ['멀리뛰기', 'field_distance'], 'TRPLJUMP': ['세단뛰기', 'field_distance'],
    'SHOTPUT': ['포환던지기', 'field_distance'], 'DISCUS': ['원반던지기', 'field_distance'], 'HAMMER': ['해머던지기', 'field_distance'], 'JAVELIN': ['창던지기', 'field_distance'],
    'HEPTATH': ['7종경기', 'combined'], 'DECATH': ['10종경기', 'combined'],
    'MARATHON': ['마라톤', 'road'], 'WALKHM': ['하프마라톤경보', 'road'], 'WALKM': ['마라톤경보', 'road'], 'WALK20K': ['20kmW', 'road'], 'WALK35K': ['35kmW', 'road'],
};
// 라운드 코드 → 우리 라운드
const ROUND_MAP = { 'RND1': 'preliminary', 'QUAL': 'preliminary', 'RND2': 'semifinal', 'SFNL': 'semifinal', 'FNL-': 'final', 'FNL': 'final' };
// 종합경기 세부종목 코드 → 이름
const SUB_MAP = { '100-': '100m', '100H': '100mH', '110H': '110mH', '200-': '200m', '400-': '400m', '800-': '800m', '1500': '1500m',
    'HJ--': '높이뛰기', 'PV--': '장대높이뛰기', 'LJ--': '멀리뛰기', 'SP--': '포환던지기', 'DT--': '원반던지기', 'JT--': '창던지기' };
const SUB_CATEGORY = n => /뛰기$/.test(n) ? (/높이/.test(n) ? 'field_height' : 'field_distance') : /던지기$/.test(n) ? 'field_distance' : 'track';
const SKIP_PHASES = new Set(['VICT']);   // 시상식

function decodeBody(text) {
    try { return JSON.parse(text); } catch (e) {}
    const b = Buffer.from(Array.from(text).map(c => c.charCodeAt(0) & 255));
    return JSON.parse(zlib.inflateSync(b).toString('utf8'));
}

function apiPath(source, tail) {
    const s = source || {};
    return `/s/${s.champ}/${s.lang || 'en'}/${s.disc || 'ATH'}/${tail.replace(/^\//, '')}`;
}

/** GET base + /s/champ/lang/disc/tail → JSON. 404 는 null */
async function fetchJson(source, tail, opts = {}) {
    const url = String(source.base).replace(/\/$/, '') + apiPath(source, tail);
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
    try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'PaceRise-Node/1.0 (+results sync)', 'Accept': 'application/json', 'Referer': (source.referer || source.base) } });
        const text = await r.text();
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
        return decodeBody(text);
    } finally { clearTimeout(t); }
}

/** 'M.100M--------------' → { gender:'M', code:'100M' } */
function splitEventKey(evKey) {
    const [g, code] = String(evKey).split('.');
    return { gender: g === 'W' ? 'F' : g === 'X' ? 'X' : 'M', code: String(code || '').replace(/-+$/, '') };
}
/** 'W.100M--------------.SFNL.000100--' → { event, gender, code, phase, unit, unitNo } */
function splitUnitKey(key) {
    const parts = String(key).split('.');
    const ev = splitEventKey(parts[0] + '.' + parts[1]);
    const unitNo = parseInt(String(parts[3] || '').replace(/-+$/, ''), 10);
    return { event: parts[0] + '.' + parts[1], gender: ev.gender, code: ev.code, phase: parts[2] || '', unitRaw: parts[3] || '', unitNo: isFinite(unitNo) ? Math.round(unitNo / 100) : 1 };
}

/** 우리 종목 이름 (혼성 계주는 '4X400mR(Mixed)') */
function eventName(code, gender) {
    const m = EVENT_MAP[code];
    if (!m) return null;
    const name = storedName(m[0]) + (m[1] === 'relay' && gender === 'X' ? '(Mixed)' : '');   // 혼성 계주 저장 표기: '4X400mR(Mixed)'
    return { name, category: m[1] };
}

/**
 * 일정 유닛 목록 → 구조
 *   events: [{ key, gender, code, name, category, rounds: [{ phase, round_type, order, units: [{ key, no, time, venue, status, label }] }],
 *             subEvents: [{ phase, name, category, order, units: [...] }] }]  (종합경기)
 *   ceremonies: [{ key, event, time, label }]
 */
function parseSchedule(units) {
    const byEvent = new Map(); const ceremonies = [];
    for (const u of units || []) {
        const k = splitUnitKey(u.Key);
        if (SKIP_PHASES.has(k.phase)) { ceremonies.push({ key: u.Key, event: k.event, time: u.DateTimeRaw, label: u.PhaseDescS || u.PhaseDesc }); continue; }
        const en = eventName(k.code, k.gender);
        if (!en) { continue; }
        if (!byEvent.has(k.event)) byEvent.set(k.event, { key: k.event, gender: k.gender, code: k.code, name: en.name, category: en.category, desc: u.EventDesc, rounds: [], subEvents: [] });
        const ev = byEvent.get(k.event);
        const unit = { key: u.Key, no: k.unitNo, time: u.DateTimeRaw, venue: u.VenueDescS || u.Venue, status: u.StatusDesc || u.Status, label: u.UnitDescA || u.PhaseDescS };
        if (en.category === 'combined' && SUB_MAP[k.phase]) {
            let se = ev.subEvents.find(x => x.phase === k.phase);
            if (!se) { se = { phase: k.phase, name: SUB_MAP[k.phase], category: SUB_CATEGORY(SUB_MAP[k.phase]), order: ev.subEvents.length + 1, units: [] }; ev.subEvents.push(se); }
            se.units.push(unit);
        } else {
            const rt = ROUND_MAP[k.phase] || 'final';
            let r = ev.rounds.find(x => x.phase === k.phase);
            if (!r) { r = { phase: k.phase, round_type: rt, order: u.PhaseOrder != null ? Number(u.PhaseOrder) : ev.rounds.length, units: [] }; ev.rounds.push(r); }
            r.units.push(unit);
        }
    }
    const events = [...byEvent.values()];
    for (const ev of events) {
        for (const r of ev.rounds) r.units.sort((a, b) => a.no - b.no || String(a.time).localeCompare(String(b.time)));
        ev.rounds.sort((a, b) => ({ preliminary: 0, semifinal: 1, final: 2 })[a.round_type] - ({ preliminary: 0, semifinal: 1, final: 2 })[b.round_type] || a.order - b.order);
        // 종합경기 세부종목 순서 = 첫 유닛 시각
        ev.subEvents.sort((a, b) => String(a.units[0] && a.units[0].time).localeCompare(String(b.units[0] && b.units[0].time)));
        ev.subEvents.forEach((s, i) => { s.order = i + 1; s.units.sort((a, b) => a.no - b.no); });
        ev.firstTime = [...ev.rounds.flatMap(r => r.units), ...ev.subEvents.flatMap(s => s.units)].map(u => u.time).sort()[0] || null;
    }
    events.sort((a, b) => String(a.firstTime).localeCompare(String(b.firstTime)));
    return { events, ceremonies };
}

/**
 * phases 목록(전체 라운드)으로 일정에 아직 유닛이 없는 종목·라운드를 보탠다 — 예: 마라톤 경보는 일정 API 에 시상식만 있고 경기 유닛이 아직 없었다.
 *   유닛 없는 라운드는 조 없이 종목만 만들어 두고, 유닛이 올라오면 setup 을 다시 돌려 조·시간표가 붙는다.
 */
function mergePhases(sched, phases) {
    for (const ph of phases || []) {
        const parts = String(ph.Key || '').split('.'); if (parts.length < 3) continue;
        const evKey = parts[0] + '.' + parts[1], phase = parts[2];
        const k = splitEventKey(evKey); const en = eventName(k.code, k.gender); if (!en) continue;
        if (SKIP_PHASES.has(phase)) continue;
        // 일정에 이미 있는 종목은 건드리지 않는다 — phases 에는 안 쓰는 예비 라운드(PREL·REP-)도 들어 있어 라운드를 늘리면 안 된다
        const existing = sched.events.find(e => e.key === evKey);
        if (existing && !existing._fromPhases) continue;
        if (!ROUND_MAP[phase]) continue;
        let ev = existing;
        if (!ev) { ev = { key: evKey, gender: k.gender, code: k.code, name: en.name, category: en.category, desc: ph.Desc, rounds: [], subEvents: [], firstTime: null, _fromPhases: true }; sched.events.push(ev); }
        if (en.category === 'combined') continue;      // 세부종목은 일정 유닛으로만
        if (!ev.rounds.find(r => r.round_type === ROUND_MAP[phase])) ev.rounds.push({ phase, round_type: ROUND_MAP[phase], order: Number(ph.Order) || 0, units: [] });
        ev.rounds.sort((a, b) => ({ preliminary: 0, semifinal: 1, final: 2 })[a.round_type] - ({ preliminary: 0, semifinal: 1, final: 2 })[b.round_type] || a.order - b.order);
    }
    sched.events.sort((a, b) => String(a.firstTime || '9').localeCompare(String(b.firstTime || '9')));
    return sched;
}

/** 종목 엔트리 → { athletes: [{ reg, name, given, family, org, orgDesc, gender, birth }], teams: [{ reg, name, org, orgDesc, members: [{ reg, name, order, birth }] }] } */
function parseEventEntries(json) {
    const athletes = [], teams = [];
    for (const p of (json && json.Partics) || []) {
        if (p.hasMembers || p.Type === 'T') {
            teams.push({ reg: p.Reg, name: p.Name || p.OrgDesc, org: p.Org, orgDesc: p.OrgDesc, gender: p.Gender === 'W' ? 'F' : p.Gender === 'X' ? 'X' : 'M',
                members: (p.Members || []).map(m => ({ reg: m.Reg, name: m.Name, order: m.Order, birth: m.BirthDateRaw || '', substitute: !!m.Substitute })) });
        } else {
            athletes.push({ reg: p.Reg, name: p.Name, given: p.GivenName || '', family: p.FamilyName || '', org: p.Org, orgDesc: p.OrgDesc, gender: p.Gender === 'W' ? 'F' : 'M', birth: p.BirthDateRaw || '', ifId: p.IFId || '' });
        }
    }
    return { evKey: json && json.EvKey, athletes, teams };
}

/** 결과 JSON 의 모양 요약 — 형식을 확정하기 전 로그용 */
function describeResults(json, depth = 0) {
    if (json == null) return 'null';
    if (Array.isArray(json)) return `[${json.length}]` + (json.length ? describeResults(json[0], depth + 1) : '');
    if (typeof json !== 'object') return typeof json;
    if (depth > 2) return '{…}';
    return '{' + Object.keys(json).slice(0, 25).map(k => `${k}:${describeResults(json[k], depth + 1)}`).join(',') + '}';
}

const STATUS_WORDS = { DNS: 'DNS', DNF: 'DNF', DQ: 'DQ', DSQ: 'DQ', NM: 'NM', NH: 'NM', FOUL: 'NM' };
function normStatus(v) { const s = String(v || '').trim().toUpperCase(); return STATUS_WORDS[s] || (/^D[NS]/.test(s) ? s.slice(0, 3) : ''); }
function firstKey(o, names) { for (const n of names) { if (o && o[n] != null && o[n] !== '') return o[n]; } return null; }

/**
 * 결과 JSON → 행 목록. 모양을 모르는 상태라 후보 키를 넓게 본다:
 *   참가자 배열: Results | Partics | Competitors | Rows | Items  (재귀로 찾음)
 *   행: Reg/Id · Rank/Pos · Lane · Result/Mark/Time · Status(IRM) · Wind · Qual(Q/q) · Record(WR/AR/GR/NR)
 */
function parseResults(json) {
    const note = describeResults(json);
    let rows = null; let wind = null;
    const visit = (o, d) => {
        if (!o || typeof o !== 'object' || d > 4 || rows) return;
        if (wind == null && o.Wind != null) wind = o.Wind;
        for (const k of ['Results', 'Partics', 'Competitors', 'Rows', 'Items', 'ResultItems', 'Ranking']) {
            if (Array.isArray(o[k]) && o[k].length && typeof o[k][0] === 'object' && (firstKey(o[k][0], ['Reg', 'Id', 'ParticipantId', 'Name']) != null)) { rows = o[k]; return; }
        }
        for (const k of Object.keys(o)) visit(o[k], d + 1);
    };
    if (Array.isArray(json) && json.length && typeof json[0] === 'object' && firstKey(json[0], ['Reg', 'Name']) != null) rows = json; else visit(json, 0);
    // 공식 결과인가 — Bornan 은 유닛 상태를 'Official'/'Unofficial'/'Live' 같은 문구로 준다(정확한 키는 첫 결과로 확인). 'unofficial' 은 공식이 아니다
    let official = false;
    const visitStatus = (o, d) => {
        if (!o || typeof o !== 'object' || d > 3 || official) return;
        for (const k of ['Status', 'StatusDesc', 'ResultStatus', 'UnitStatus', 'StatusCode', 'IsOfficial', 'Official']) {
            const v = o[k]; if (v == null) continue;
            if (v === true || /^(official|final|ended|finished)$/i.test(String(v).trim()) || (/official/i.test(String(v)) && !/unofficial/i.test(String(v)))) { official = true; return; }
        }
        for (const k of Object.keys(o)) if (!Array.isArray(o[k])) visitStatus(o[k], d + 1);
    };
    visitStatus(json, 0);
    // 종목 기록(WR/AR/GR …): Results.Records[].Records[] — { Indicator:'WR', Result, Name, Org, Loc, DateTimeRaw }
    const records = [];
    const visitRecords = (o, d) => {
        if (!o || typeof o !== 'object' || d > 4) return;
        if (Array.isArray(o.Records)) {
            for (const g of o.Records) {
                const list = Array.isArray(g && g.Records) ? g.Records : (g && g.Indicator ? [g] : []);
                for (const rc of list) if (rc && rc.Indicator && rc.Result) records.push({ ind: String(rc.Indicator).trim().toUpperCase(), desc: rc.Desc || '', result: String(rc.Result).trim(), name: rc.Name || '', org: rc.Org || '', loc: rc.Loc || '', date: String(rc.DateTimeRaw || '').slice(0, 10) });
            }
            return;
        }
        for (const k of Object.keys(o)) if (k !== 'Competitors' && k !== 'Partics') visitRecords(o[k], d + 1);
    };
    visitRecords(json, 0);
    const ext = (r, code) => { const e = Array.isArray(r && r.Extensions) ? r.Extensions.find(x => x && x.Code === code) : null; const v = e ? String(e.Value == null ? '' : e.Value).trim() : ''; return v && v !== 'null' ? v : ''; };
    if (!rows) return { rows: [], note, wind, official, records };
    const out = rows.map(r => {
        const markRaw = firstKey(r, ['Result', 'Mark', 'Time', 'Perf', 'Performance', 'ResultText', 'Score', 'Points']);
        const status = normStatus(firstKey(r, ['IRM', 'Status', 'StatusCode', 'ResultStatus'])) || normStatus(markRaw);
        const rankRaw = firstKey(r, ['Rank', 'Pos', 'Position', 'Place']);
        return {
            reg: String(firstKey(r, ['Reg', 'Id', 'ParticipantId', 'TeamReg']) || ''),
            name: firstKey(r, ['Name', 'NameS']) || '',
            org: firstKey(r, ['Org', 'Noc']) || '',
            rank: rankRaw != null && /^\d+$/.test(String(rankRaw)) ? parseInt(rankRaw, 10) : null,
            lane: (() => { const l = firstKey(r, ['Lane', 'Order', 'StartOrder', 'Bib']); const n = parseInt(l, 10); return isFinite(n) ? n : null; })(),
            mark: status ? '' : String(markRaw == null ? '' : markRaw).trim(),
            status,
            wind: (() => { const w = firstKey(r, ['Wind', 'WindSpeed']); const n = parseFloat(w); return isFinite(n) ? n : null; })(),
            qual: String(firstKey(r, ['Qual', 'Qualified', 'QualMark', 'Q']) || '').trim(),
            record: String(firstKey(r, ['RecordInd', 'Record', 'RecordMark', 'Rec']) || '').trim(),   // 공식 기록 표시 (GR/AR/WR/NR …)
            bib: String(firstKey(r, ['Bib']) || '').trim(),
            pb: ext(r, 'PB'), sb: ext(r, 'SB'), hasPB: ext(r, 'HasPB') === 'Y', hasSB: ext(r, 'HasSB') === 'Y',
            // 종합경기(7종·10종) 세부종목: 이 종목 점수 · 누적 점수 · 종합 순위 (공식 점수를 그대로 쓴다)
            points: (() => { const n = parseInt(ext(r, 'Points'), 10); return isFinite(n) ? n : null; })(),
            accPoints: (() => { const n = parseInt(ext(r, 'AccPoints'), 10); return isFinite(n) ? n : null; })(),
            accRank: (() => { const n = parseInt(ext(r, 'AccRk_Combined'), 10); return isFinite(n) ? n : null; })(),
            raw: r,
        };
    });
    return { rows: out, note, wind, official, records };
}

/** '10.25' · '1:45.30' · '2:08:15' → 초, '7.85' (m) → 거리. 종목 분류로 구분 */
function markToNumber(mark, category) {
    const s = String(mark || '').trim().replace(/[^\d:.]/g, '');
    if (!s) return null;
    if (category === 'field_distance' || category === 'field_height') { const n = parseFloat(s); return isFinite(n) ? n : null; }
    if (category === 'combined') { const n = parseInt(s, 10); return isFinite(n) ? n : null; }
    const parts = s.split(':').map(Number); if (parts.some(x => !isFinite(x))) return null;
    return parts.reduce((acc, x) => acc * 60 + x, 0);
}

module.exports = { EVENT_MAP, ROUND_MAP, SUB_MAP, fetchJson, decodeBody, apiPath, splitEventKey, splitUnitKey, eventName, parseSchedule, mergePhases, parseEventEntries, parseResults, describeResults, markToNumber };
