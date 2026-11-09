'use strict';
/**
 * 전국체육대회(대한체육회 meet.sports.or.kr) 육상 일정·엔트리·결과 읽기 — 순수 파서 (2026-10-17)
 *   사이트 구조(2026-10-17 확인):
 *     POST /national/schedule/selectKindCdListAjax.do        { searchClassCd }            → 부(kind) 목록  (03 남자18세이하부 … 10 여자일반부, 13/14/15 는 성별 없는 혼성계주용)
 *     POST /national/schedule/selectGmDtListAjax.do          { searchClassCd … }          → 경기 날짜 목록
 *     GET  /national/schedule/scheduleClass.do?searchGmDt=YYYYMMDD&searchClassCd=A1  → 일정표 HTML (종별·세부종목·경기구분·상태·일시·경기장)
 *     POST /national/schedule/detailPlayerListAjax.do        { searchDetailClassCd, searchRhCd } → 출전 명단 JSON (ID_NO·KOR_NM·SIDO_NM·TEAM_NM·GRADE·EVENT_ATH_NO·KIND_CD)
 *     GET  /national/schedule/scheduleDetailR.do?searchClassCd=&searchDetailClassCd=&searchRhCd=&searchPcntGbn=&searchConfirmYn= → 결과·스타트리스트 HTML 조각
 *   코드: class A1 트랙 · B1 필드 · C1 로드. detailClassCd = class + kind(2) + 종목번호(2) (예 A10301 = 트랙·남자18세이하부·100m).
 *         rhCd: A110NN = 예선 NN조 · A120NN = 준결승(추정) · A19000 = 결승 · A100NN = 종합경기 세부종목 NN (경기구분 칸이 세부종목 이름)
 *   종료 시각은 쓰지 않는다(시작 시각만). 같은 종목에 대학부·일반부가 함께 뛰면(출전 명단의 KIND_CD 가 둘) 부 라벨을 '대학·일반부' 로.
 */
const BASE_DEFAULT = 'https://meet.sports.or.kr';
const UA = 'Mozilla/5.0 (compatible; PACE-RISE-Node sync; +https://pace-rise-node.com)';

const CLASSES = ['A1', 'B1', 'C1'];
const KIND_GENDER = k => /^남자/.test(k) ? 'M' : /^여자/.test(k) ? 'F' : 'X';
const divisionOf = k => String(k || '').replace(/^(남자|여자)/, '').trim();   // '남자18세이하부' → '18세이하부'

/** 사이트 종목 표기 → 우리 종목 이름(lib/eventCatalog 사전과 맞춤) */
function normEventName(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    const m = s.match(/^(.+?) \1$/); if (m) s = m[1];   // '10km 10km' 처럼 두 번 찍힌 표기
    s = s.replace(/×/g, 'X').replace(/x/g, 'X');
    const map = [
        [/^4X100MR$/i, '4X100mR'], [/^4X400MR\(MIXED\)$/i, '4X400mR(Mixed)'], [/^4X400MR$/i, '4X400mR'], [/^4X800MR$/i, '4X800mR'],
        [/^(\d+)M?허들$/i, (_, d) => `${d}mH`], [/^(\d+)M?장애$/i, (_, d) => `${d}mSC`],
        [/^마라톤/, '마라톤'], [/^하프마라톤/, '하프마라톤'], [/^(\d+)KM경보$/i, (_, d) => `${d}kmW`], [/^(\d+)KM$/i, (_, d) => `${d}K`],
        [/^(\d+)M$/i, (_, d) => `${d}m`],
    ];
    for (const [re, to] of map) { if (re.test(s)) return typeof to === 'function' ? s.replace(re, to) : to; }
    return s;   // 멀리뛰기·높이뛰기·포환던지기·10종경기 … 그대로
}
const HEIGHT = new Set(['높이뛰기', '장대높이뛰기']);
function categoryOf(cls, name, isTeam) {
    if (/종경기$/.test(name)) return 'combined';
    if (isTeam || /mR(\(Mixed\))?$/.test(name)) return 'relay';
    if (cls === 'C1' || /마라톤|K$|kmW$/.test(name)) return 'road';
    if (cls === 'B1' || /뛰기|던지기/.test(name)) return HEIGHT.has(name) ? 'field_height' : 'field_distance';
    return 'track';
}

const strip = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** 일정표 HTML → 행 [{dc, rh, pg, ma, kind, event, round, status, when, venue}] */
function parseScheduleRows(html, cls) {
    const rows = [];
    for (const tr of String(html).split(/<tr\b/).slice(1)) {
        const m = tr.match(/openSide\('([A-Z0-9]+)','([A-Z0-9]+)','(\w)','(\w)','([^']*)'/);
        if (!m) continue;
        const tds = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
        if (tds.length < 6) continue;
        rows.push({ cls, dc: m[1], rh: m[2], pg: m[3], ma: m[4], kind: tds[0], event: tds[1], round: tds[2], status: tds[3], when: tds[4], venue: tds[5] || '', note: tds[6] || '' });
    }
    return rows;
}
/** '2026/10/18 13:25 ~ 13:40' → { date: '2026-10-18', time: '13:25', iso: '2026-10-18T13:25:00+09:00' } (끝 시각은 버린다) */
function parseWhen(when) {
    const m = String(when || '').match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (!m) return { date: '', time: '', iso: null };
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00` };
}
function roundOf(rh, roundLabel) {
    const t = String(rh).slice(2, 3), n = parseInt(String(rh).slice(3), 10) || 0;
    if (t === '0') return { type: 'sub', n };                     // 종합경기 세부종목
    if (t === '9' || /결승/.test(roundLabel)) return { type: 'final', n: 1 };
    if (t === '2' || /준결승/.test(roundLabel)) return { type: 'semifinal', n: n || 1 };
    return { type: 'preliminary', n: n || 1 };
}

/** 행들 → 종목 구조 [{ key(dc), cls, kind, gender, division, name, category, isTeam, rounds:[{type, units:[{key, heatNo, iso, date, time, status, venue, label}]}], subEvents:[{order, name, category, units:[...]}] }] */
function buildStructure(rows) {
    const byDc = new Map();
    for (const r of rows) {
        if (!byDc.has(r.dc)) byDc.set(r.dc, { key: r.dc, cls: r.cls, kind: r.kind, gender: KIND_GENDER(r.kind), division: divisionOf(r.kind), name: normEventName(r.event), isTeam: r.pg === 'T', rounds: new Map(), subEvents: new Map(), venue: r.venue });
        const ev = byDc.get(r.dc);
        ev.category = categoryOf(r.cls, ev.name, ev.isTeam);
        const w = parseWhen(r.when);
        const ro = roundOf(r.rh, r.round);
        const unit = { key: `${r.dc}/${r.rh}`, dc: r.dc, rh: r.rh, pg: r.pg, iso: w.iso, date: w.date, time: w.time, status: r.status, venue: r.venue, label: r.round };
        if (ro.type === 'sub') {
            const name = normEventName(r.round);
            if (!ev.subEvents.has(r.rh)) ev.subEvents.set(r.rh, { order: ro.n, name, category: categoryOf('A1', name, false), units: [] });
            unit.heatNo = 1; ev.subEvents.get(r.rh).units.push(unit);
        } else {
            if (!ev.rounds.has(ro.type)) ev.rounds.set(ro.type, { type: ro.type, units: [] });
            unit.heatNo = ro.n; ev.rounds.get(ro.type).units.push(unit);
        }
    }
    const order = { preliminary: 0, semifinal: 1, final: 2 };
    return [...byDc.values()].map(ev => ({
        ...ev,
        rounds: [...ev.rounds.values()].sort((a, b) => order[a.type] - order[b.type]).map(r => ({ ...r, units: r.units.sort((a, b) => a.heatNo - b.heatNo) })),
        subEvents: [...ev.subEvents.values()].sort((a, b) => a.order - b.order),
    })).sort((a, b) => sortKey(a) - sortKey(b));
}
// 정렬: 트랙 → 필드 → 로드, 그 안에서 종목번호·부
function sortKey(ev) { return (ev.cls === 'A1' ? 0 : ev.cls === 'B1' ? 1000 : 2000) + (parseInt(ev.key.slice(4), 10) || 0) * 10 + (parseInt(ev.key.slice(2, 4), 10) || 0) / 20; }

/** 출전 명단 JSON → [{ id, name, sido, team, grade, bib, kind }] (계주는 playerList 가 주자, startList 가 팀일 수 있어 둘 다 돌려준다) */
function parseEntrants(json) {
    const list = (json && Array.isArray(json.playerList)) ? json.playerList : [];
    const players = list.map(p => ({ id: String(p.ID_NO || '').trim(), name: String(p.KOR_NM || '').trim(), sido: String(p.SIDO_NM || '').trim(), team: String(p.TEAM_NM || '').trim(), grade: String(p.GRADE || '').trim(), bib: String(p.EVENT_ATH_NO || '').trim(), kind: String(p.KIND_CD || '').trim(), athNo: String(p.ATH_NO || '').trim() })).filter(p => p.name || p.id);
    return { players, startList: (json && Array.isArray(json.startList)) ? json.startList : [] };
}

/** 결과/스타트리스트 HTML 조각 → { finished, results:[{rank, sido, name, team, grade, mark, remark}], startlist:[…], wind } */
function parseDetail(html) {
    const text = String(html || '');
    const tables = [...text.matchAll(/<table\b[\s\S]*?<\/table>/g)].map(m => m[0]);
    const parseTable = t => {
        const head = [...(t.match(/<thead\b[\s\S]*?<\/thead>/) || [''])[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(x => strip(x[1]));
        const body = (t.match(/<tbody\b[\s\S]*?<\/tbody>/) || [t])[0];
        const rows = [];
        for (const tr of body.split(/<tr\b/).slice(1)) {
            const tds = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
            if (!tds.length) continue;
            if (tds.length === 1 && /종료되지|없습니다/.test(tds[0])) { rows.push({ _note: tds[0] }); continue; }
            const o = {}; head.forEach((h, i) => { o[h] = tds[i] || ''; }); o._raw = tds; rows.push(o);
        }
        return { head, rows };
    };
    const parsed = tables.map(parseTable).filter(t => t.head.length);
    const toRow = o => ({ rank: parseInt(o['순위'], 10) || null, sido: o['시도'] || '', name: o['선수명'] || o['팀명'] || o['팀'] || '', team: o['소속'] || '', grade: o['학년'] || '', lane: parseInt(o['레인'] || o['조/레인'], 10) || null, mark: o['기록'] || '', remark: o['신기록/비고'] || o['비고'] || '' });
    let results = [], startlist = [], finished = false;
    if (parsed.length) {
        const first = parsed[0];
        const note = first.rows.find(r => r._note);
        if (note) { finished = false; } else { results = first.rows.filter(r => !r._note).map(toRow).filter(r => r.name); finished = results.some(r => r.mark || r.rank); }
        if (parsed[1]) startlist = parsed[1].rows.filter(r => !r._note).map(toRow).filter(r => r.name);
        if (!parsed[1] && !finished) startlist = results, results = [];
    }
    const wm = text.match(/풍속[^0-9+\-]*([+\-]?\d+(?:\.\d+)?)/); const wind = wm ? parseFloat(wm[1]) : null;
    const title = strip((text.match(/육상\([^)]*\)[\s\S]{0,200}?<\/(div|p|h\d)>/) || [''])[0]).slice(0, 120);
    return { finished, results, startlist, wind: isFinite(wind) ? wind : null, title };
}

/** 사이트 기록 문자열 → 숫자 (트랙·로드: 초, 필드: m, 종합: 점) */
function markToNumber(mark, category) {
    const s = String(mark || '').trim().replace(/m$/i, '').replace(/점$/, '').replace(/,/g, '');
    if (!s) return null;
    if (category === 'track' || category === 'relay' || category === 'road') {
        const p = s.split(':').map(Number); if (p.some(x => !isFinite(x))) return null;
        return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
    }
    const n = parseFloat(s); return isFinite(n) ? n : null;
}
const STATUS_WORDS = { DQ: 'DQ', DSQ: 'DQ', 실격: 'DQ', DNS: 'DNS', 결장: 'DNS', 불참: 'DNS', DNF: 'DNF', 기권: 'DNF', 중도포기: 'DNF', NM: 'NM', NH: 'NM', 기록없음: 'NM' };
function statusOf(mark, remark) {
    const s = String(mark || '').trim().toUpperCase(), r = String(remark || '').trim().toUpperCase();
    for (const [k, v] of Object.entries(STATUS_WORDS)) { if (s === k.toUpperCase() || s.startsWith(k.toUpperCase() + '(') || r === k.toUpperCase()) return v; }
    return '';
}

/** 실제 네트워크 — opts.fetch 로 바꿔 끼운다(테스트 픽스처). kind: 'kinds'|'dates'|'schedule'|'entrants'|'detail' */
async function fetchLive(source, kind, p = {}) {
    const base = (source && source.base) || BASE_DEFAULT;
    const headers = { 'User-Agent': UA };
    const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${path} HTTP ${r.status}`); return r.json(); };
    const get = async (path) => { const r = await fetch(base + path, { headers }); if (!r.ok) throw new Error(`${path} HTTP ${r.status}`); return r.text(); };
    switch (kind) {
        case 'kinds': return (await post('/national/schedule/selectKindCdListAjax.do', { searchClassCd: p.cls })).codeList || [];
        case 'dates': return ((await post('/national/schedule/selectGmDtListAjax.do', { searchClassCd: p.cls, searchKindCd: '', searchDetailClassCd: '', searchsidoCd: '', searchPcntGbn: '' })).codeList || []).map(d => d.GM_DT_CO);
        case 'schedule': return get(`/national/schedule/scheduleClass.do?searchSidoCd=&searchGmDt=${p.date}&searchClassCd=${p.cls}&searchKindCd=&searchDetailClassCd=&searchGmConfirmYn=`);
        case 'entrants': return post('/national/schedule/detailPlayerListAjax.do', { searchEntrantTeamCd: '', searchDetailClassCd: p.dc, searchRhCd: p.rh });
        case 'detail': return get(`/national/schedule/scheduleDetailR.do?searchClassCd=${p.cls}&searchDetailClassCd=${p.dc}&searchRhCd=${p.rh}&searchPcntGbn=${p.pg || 'I'}&searchConfirmYn=${p.confirm || 'N'}`);
        default: throw new Error('unknown fetch kind ' + kind);
    }
}

module.exports = { CLASSES, BASE_DEFAULT, KIND_GENDER, divisionOf, normEventName, categoryOf, parseScheduleRows, parseWhen, roundOf, buildStructure, parseEntrants, parseDetail, markToNumber, statusOf, fetchLive, strip };
