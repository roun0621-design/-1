'use strict';
/**
 * 대한육상연맹 실시간 결과(result.kaaf.or.kr) 읽기 — 전국체전 결과는 대한체육회(meet.sports.or.kr)보다 여기가 먼저·자세히 올라온다 (2026-10-17 사용자 안내)
 *   종목표: GET /tourInfo/resultInfo.do?reg_year=2026&to_cd=E010031092&gubun=E&domestic=0&resultType=TRM&kind_cd=&tabs_id=toKor
 *           행마다 종목·종별('남자고등학교부')·라운드·상태('경기완료') + go_result(to_cd, year, kind_cd, detail_class_cd, round, gday, resultType)
 *   결과표: POST /tourInfo/info_command.do  command=RESULT_LIST + 위 값들 → 조(1조…)마다 표 하나
 *           트랙: 순위·레인(또는 순번)·배번·성명·소속·기록·풍속·비고·신기록      (계주는 팀 행 아래 주자 행 — 배번·성명만)
 *           높이: 순위·순번·배번·성명·높이들(1.75 1.80 …, 점프오프는 내려가는 높이)·기록·비고 / 소속 (한 선수가 표 하나 = twotable)
 *           거리: 순위·순번·배번·성명·1차시기…6차시기·기록·비고 / 소속
 *           종합: 순위·배번·성명·총점·신기록·세부종목들 / 소속 (1행 점수, 2행 기록, 3행 풍속)
 *   한국어 블록(id='html_kor')만 읽는다 — 영어 블록은 같은 표를 영문으로 한 번 더 찍는다.
 */
const N = require('./nsf');
const strip = N.strip;
const BASE = 'https://result.kaaf.or.kr';
const UA = 'Mozilla/5.0 (PaceRise Node sync)';

const KIND = { '12': ['M', '중학부'], '13': ['M', '18세이하부'], '14': ['M', '대학부'], '15': ['M', '일반부'], '22': ['F', '중학부'], '23': ['F', '18세이하부'], '24': ['F', '대학부'], '25': ['F', '일반부'], '32': ['X', '중학부'], '33': ['X', '18세이하부'], '34': ['X', '대학부'], '35': ['X', '일반부'] };
const ROUND = { '1': 'preliminary', '2': 'preliminary', '3': 'semifinal', '4': 'final' };
const DIVISION_LABEL = { '고등학교부': '18세이하부', '고등부': '18세이하부', '대학교부': '대학부', '대학부': '대학부', '일반부': '일반부', '실업부': '일반부', '중학교부': '중학부', '중등부': '중학부' };

/** '남자고등학교부' → { gender:'M', division:'18세이하부' } */
function divisionOfLabel(label) {
    const m = String(label || '').replace(/\s/g, '').match(/^(남자|여자|혼성)?(.+)$/);
    if (!m) return { gender: 'X', division: '' };
    return { gender: m[1] === '남자' ? 'M' : m[1] === '여자' ? 'F' : 'X', division: DIVISION_LABEL[m[2]] || m[2] };
}
/** 사이트 종목명 → { name(우리 표기), combined('10종'|null) } — '100m(10종)' 은 종합경기 세부종목 */
function eventOfLabel(label) {
    let s = String(label || '').replace(/\s/g, '').replace(/\([\d.]+KG\)/i, '');   // '포환던지기(6.0KG)' 의 무게 표시
    let combined = null;
    const m = s.match(/^(.+?)\((10종|7종|5종)\)$/); if (m) { s = m[1]; combined = m[2]; }
    s = s.replace(/^4x/i, '4X').replace(/\(mixed\)$/i, '(Mixed)');
    if (/^5종경기_/.test(s)) s = '5종경기';
    return { name: N.normEventName(s), combined };
}
const korBlock = html => { const t = String(html || ''); const i = t.indexOf("id='html_kor'"); const j = t.indexOf("id='html_eng'"); return i >= 0 ? t.slice(i, j > i ? j : undefined) : t; };

/** 종목표 → [{ event, division, round, state, to_cd, year, kind_cd, dc, round_cd, gday, resultType }] */
function parseEventTable(html) {
    const rows = [];
    for (const tr of korBlock(html).split(/<tr\b/).slice(1)) {
        const m = tr.match(/go_result\('([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'\)/);
        if (!m) continue;
        const tds = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
        if (tds.length < 4) continue;
        rows.push({ event: tds[0], division: tds[1], round: tds[2], state: tds[3], to_cd: m[1], year: m[2], kind_cd: m[3], dc: m[4], round_cd: m[5], gday: m[6], resultType: m[7], key: `${m[3]}/${m[4]}/${m[5]}` });
    }
    return rows;
}

const tdsOf = tr => [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
const trsOf = html => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(x => x[1]);

/** 결과 페이지 → { event, division, round, date, heats:[{ heatNo, kind, rows }] } */
function parseResultPage(html) {
    const seg = korBlock(html);
    const info = {};
    for (const m of seg.matchAll(/<span class="info_box_title[^"]*">([^<]*)<\/span>[\s\S]*?value="([^"]*)"/g)) info[strip(m[1])] = strip(m[2]);
    const heats = [];
    for (const tbl of seg.split(/<table class="table table-hover team_table">/).slice(1)) {
        const theadM = tbl.match(/<thead>([\s\S]*?)<\/thead>/); if (!theadM) continue;
        const headTrs = trsOf(theadM[1]).map(tr => [...tr.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(x => strip(x[1])));
        const flat = headTrs.flat();
        const heatNo = parseInt((flat.find(t => /^\d+조$/.test(t)) || '1조'), 10);
        const main = headTrs.find(r => r.includes('순위')) || [];
        if (!main.length) continue;                                       // 영어 표 등
        const bodyStart = tbl.indexOf('<tbody>'); if (bodyStart < 0) continue;
        const body = tbl.slice(bodyStart);
        let kind = 'track';
        if (main.includes('총점')) kind = 'combined';
        else if (main.some(h => /^\d+차시기$/.test(h))) kind = 'distance';
        else if (main.some(h => /^\d\.\d\d$/.test(h))) kind = 'height';
        const rows = [];
        if (kind === 'track') {
            const idx = Object.fromEntries(main.map((h, i) => [h, i]));
            const laneIdx = idx['레인'] ?? idx['순번'];
            let last = null;
            for (const tr of trsOf(body)) {
                const td = tdsOf(tr); if (td.length < 5) continue;
                const row = { rank: parseInt(td[idx['순위']], 10) || null, lane: parseInt(td[laneIdx], 10) || null, bib: td[idx['배번']] || '', name: td[idx['성명']] || '', team: td[idx['소속']] || '',
                    mark: td[idx['기록']] || '', wind: idx['풍속'] != null ? td[idx['풍속']] : '', remark: td[idx['비고']] || '', record: idx['신기록'] != null ? td[idx['신기록']] || '' : '', members: [] };
                // 계주 주자 행: 순위·레인·소속·기록이 비고 배번·성명만
                if (!row.lane && !row.team && !row.mark && !row.rank && row.name && last) { last.members.push({ bib: row.bib, name: row.name }); continue; }
                if (!row.name && !row.bib) continue;
                rows.push(row); last = row;
            }
        } else {
            const nameI = main.indexOf('성명'), markI = main.indexOf(main.includes('총점') ? '총점' : '기록');
            const cols = main.slice(nameI + 1, markI);                      // 높이들 / N차시기 / (종합은 비어 있음)
            const subNames = kind === 'combined' ? main.slice(main.indexOf('신기록') + 1).filter(Boolean) : [];
            for (const blk of body.split(/<table class="table table-hover twotable">/).slice(1)) {
                const trs = trsOf(blk).map(tdsOf).filter(t => t.length);
                if (!trs.length) continue;
                const a = trs[0], b = trs[1] || [], c = trs[2] || [];
                if (kind === 'combined') {
                    // a: 순위·배번·성명·총점·신기록(상태)·점수들 / b: 소속·기록들 / c: 풍속들
                    const n = subNames.length;
                    rows.push({ rank: parseInt(a[0], 10) || null, bib: a[1] || '', name: a[2] || '', total: a[3] || '', remark: a[4] || '', team: b[0] || '',
                        subs: subNames.map((nm, i) => ({ name: nm, points: a[5 + i] || '', mark: b[1 + i] || '', wind: c[i] || '' })), order: null, mark: a[3] || '' });
                    if (n === 0) rows[rows.length - 1].subs = [];
                } else {
                    // a: 순위·순번·배번·성명·시기들·기록·비고 / b: 소속·…·신기록
                    const att = a.slice(4, 4 + cols.length);
                    const row = { rank: parseInt(a[0], 10) || null, order: parseInt(a[1], 10) || null, lane: parseInt(a[1], 10) || null, bib: a[2] || '', name: a[3] || '', team: b[0] || '',
                        mark: a[4 + cols.length] || '', remark: a[5 + cols.length] || '', record: b[b.length - 1] || '', wind: '' };
                    if (kind === 'height') {
                        row.heights = []; let prev = 0;
                        cols.forEach((h, i) => { const v = parseFloat(h); if (!isFinite(v)) return; const jumpoff = v <= prev; if (!jumpoff) prev = v; row.heights.push({ height: v, marks: att[i] || '', jumpoff }); });
                    } else row.attempts = att;
                    rows.push(row);
                }
            }
        }
        heats.push({ heatNo, kind, rows, subNames: kind === 'combined' ? (main.slice(main.indexOf('신기록') + 1).filter(Boolean)) : undefined });
    }
    return { event: info['종목명'] || '', division: info['종별'] || '', round: info['라운드'] || '', date: info['일자'] || '', heats };
}

const STATUS_KO = { '기권': 'DNF', '불참': 'DNS', '실격': 'DQ', '기록없음': 'NM', '무효': 'NM' };
/** 한글 비고 → 상태 코드 (영문 토큰은 nsf.statusOf 가 본다) */
function statusOf(mark, remark) {
    const r = String(remark || '').trim(), s = String(mark || '').trim();
    if (STATUS_KO[r]) return STATUS_KO[r]; if (STATUS_KO[s]) return STATUS_KO[s];
    return N.statusOf(mark, remark);
}

async function fetchLive(src, kind, p = {}) {
    const base = (src && src.base) || BASE;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
    try {
        if (kind === 'table') {
            const url = `${base}/tourInfo/resultInfo.do?reg_year=${encodeURIComponent(src.year)}&to_cd=${encodeURIComponent(src.to_cd)}&gubun=E&domestic=0&resultType=TRM&kind_cd=&tabs_id=toKor`;
            const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal }); if (!r.ok) throw new Error(`종목표 HTTP ${r.status}`); return r.text();
        }
        if (kind === 'result') {
            const body = new URLSearchParams({ to_cd: src.to_cd, reg_year: src.year, kind_cd: p.kind_cd, detail_class_cd: p.dc, round: p.round_cd, gday: p.gday || '', resultType: p.resultType || 'TRM', command: 'RESULT_LIST', domestic: '0', tabs_id: 'toKor', gubun: 'E' }).toString();
            const r = await fetch(`${base}/tourInfo/info_command.do`, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctl.signal });
            if (!r.ok) throw new Error(`결과표 HTTP ${r.status}`); return r.text();
        }
        throw new Error('unknown kind ' + kind);
    } finally { clearTimeout(t); }
}

module.exports = { KIND, ROUND, DIVISION_LABEL, divisionOfLabel, eventOfLabel, parseEventTable, parseResultPage, statusOf, fetchLive, korBlock };
