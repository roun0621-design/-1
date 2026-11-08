'use strict';
/**
 * 결과 문자용 결과표 가져오기 — 주최 측이 주는 '한 줄 = 선수 한 명의 한 종목 결과' 엑셀을 우리 구조(선수·종목·조·기록)로 (2026-11-08)
 *
 *   쓰임: 경기 운영은 주최가 하고 우리는 결과 문자만 보내는 계약(2026 유소년 기초종목 생활체육 육상 페스티벌 등).
 *         파일을 올리면 선수(이름+전화)·종목(부별·종목·라운드)·1조·기록을 만들고, 그다음 문자 일괄 발송은 기존 흐름 그대로.
 *
 *   열(머리글 이름으로 찾는다 — 순서는 자유, 없는 열은 비워도 된다):
 *     이름(성명·선수명) · 전화번호(휴대폰·연락처) · 소속(팀·학교) · 종목 · 기록
 *     선택: 부별(부·종별·학년·구분) · 성별 · 라운드 · 조 · 순위 · 비고
 *   종목 칸에 부별·라운드가 같이 적혀 있어도 된다: '남초6 100m 예선', '여자초등부 3학년 멀리뛰기', '60m 결승'.
 *   부별 칸의 표기: '남초 6', '여초3', '남자초등부 1학년 (5~7세 포함)', '남.여초 5.6'(→ 성별은 선수 쪽에서 알 수 없으므로 종목 성별 X·부 '초등 5·6학년').
 *   기록: 트랙 '9.87' '2:05.3' / 거리·높이 '3.21' '3m21' '321cm' / 상태 DNS·DNF·DQ·NM(결장·기권·실격·기록없음).
 *
 *   parseResultSheet(buffer) → { header, rows:[{ line, name, phone, team, eventKey:{ gender, division, name, round, category }, label, record, status, value, rank, heat, issues[] }], issues[] }
 */
const XLSX = require('xlsx');
const timingParse = require('./timingParse');

const norm = v => String(v == null ? '' : v).replace(/[\s　]+/g, ' ').trim();
const ROUND_KO = { preliminary: '예선', semifinal: '준결승', final: '결승' };
const G_KO = { M: '남자', F: '여자', X: '혼성' };

/** 머리글 → 열 역할 */
const HEADER_RULES = [
    ['name', /^(이름|성명|선수명|선수|name|athlete)$/i],
    ['phone', /^(전화번호|전화|휴대폰|휴대전화|핸드폰|연락처|phone|phone_number|mobile|tel)$/i],
    ['team', /^(소속|팀|팀명|학교|소속팀|team|club|school)$/i],
    ['event', /^(종목|세부종목|종목명|event)$/i],
    ['record', /^(기록|결과|record|result|mark|time)$/i],
    ['division', /^(부별|부|종별|학년|구분|부문|division|grade|category)$/i],
    ['gender', /^(성별|gender|sex)$/i],
    ['round', /^(라운드|round|경기구분)$/i],
    ['heat', /^(조|heat)$/i],
    ['rank', /^(순위|등위|rank|place)$/i],
    ['remark', /^(비고|상태|기록구분|remark|status|note)$/i],
];
function mapHeader(cells) {
    const col = {};
    cells.forEach((h, i) => {
        const hn = norm(h).replace(/\s/g, '').replace(/[()（）]/g, '');
        if (!hn) return;
        for (const [key, re] of HEADER_RULES) { if (col[key] === undefined && re.test(hn)) { col[key] = i; return; } }
    });
    return col;
}

/** 전화번호: 숫자만, +82 → 0 */
function normPhone(raw) {
    let d = String(raw == null ? '' : raw).replace(/[^0-9+]/g, '');
    if (/^\+?82/.test(d)) d = '0' + d.replace(/^\+?82/, '');
    d = d.replace(/\D/g, '');
    if (/^1[0-9]{8,9}$/.test(d)) d = '0' + d;          // 엑셀이 앞 0 을 지운 경우 (1012345678)
    return d;
}

/** 부별 문구 → { gender, division } — '남초 6' / '여자초등부 3학년' / '남.여초 5.6' / '남자 일반부' */
function parseDivision(raw) {
    const s = norm(raw);
    if (!s) return { gender: null, division: '' };
    let gender = null;
    if (/남\s*[.·,/]\s*여|남녀|혼성|mixed/i.test(s)) gender = 'X';
    else if (/^남|남자|남초|남중|남고|\bM\b/i.test(s) || /(^|[^가-힣])남([^가-힣]|$)/.test(s)) gender = 'M';
    else if (/^여|여자|여초|여중|여고|\bF\b/i.test(s) || /(^|[^가-힣])여([^가-힣]|$)/.test(s)) gender = 'F';
    let body = s.replace(/남\s*[.·,/]\s*여|남녀|혼성|남자|여자|^남|^여/g, '').replace(/\(.*?\)/g, '').trim();
    const school = /초등|^초|초\s*\d/.test(body) ? '초등' : /중학|중등|^중/.test(body) ? '중등' : /고등|^고/.test(body) ? '고등' : /대학/.test(body) ? '대학' : /일반|실업|성인|마스터/.test(body) ? '일반' : '';
    const grades = (body.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= 6);
    let division;
    if (school && grades.length) division = `${school}부 ${grades.join('·')}학년`;
    else if (school) division = `${school}부`;
    else if (grades.length) division = `${grades.join('·')}학년`;
    else division = body.replace(/\s+/g, ' ');
    return { gender, division };
}

const EVENT_RE = /(\d+\s*[×xX]\s*\d+\s*m?\s*R?|\d+\s*mH|\d+\s*mSC|\d+\s*mW|\d+\s*m\b|\d+\s*km\s*W?|하프마라톤|마라톤|멀리뛰기|세단뛰기|높이뛰기|장대높이뛰기|포환던지기|원반던지기|창던지기|해머던지기|\d+종경기|\d+종|경보)/i;
/** 종목 칸 → { name, round, divisionText, genderText } — 부별·라운드가 섞여 있어도 종목 이름을 뽑는다 */
function parseEventText(raw) {
    const s = norm(raw);
    let m = s.match(EVENT_RE);
    let name = m ? m[1].replace(/\s+/g, '') : '';
    let rest = m ? (s.slice(0, m.index) + ' ' + s.slice(m.index + m[1].length)) : s;
    if (!name) {
        const bare = s.match(/(?:^|\s)(\d{2,5})(?=\s|$)/);                      // '100 결승' → 100m
        if (bare) { name = bare[1] + 'm'; rest = s.replace(bare[0], ' '); }
    }
    if (/^\d+m$/i.test(name)) name = name.toLowerCase();
    if (/^\d+mh$/i.test(name)) name = name.replace(/mh$/i, 'mH');
    if (/^\d+\s*[×x]\s*\d+/i.test(name)) name = name.replace(/[×x]/i, 'X').replace(/m?r?$/i, 'mR');
    const round = /예선|prelim|heat/i.test(rest) ? 'preliminary' : /준결/i.test(rest) ? 'semifinal' : /결승|final/i.test(rest) ? 'final' : null;
    rest = rest.replace(/예선|준결승|결승|prelim\w*|final|heat|\d+\s*조/gi, ' ').replace(/\s+/g, ' ').trim();
    return { name, round, rest };
}
function categoryOf(name) {
    const n = name || '';
    if (/릴레이|mR$|4X/i.test(n)) return 'relay';
    if (/높이뛰기|장대높이/.test(n)) return 'field_height';
    if (/멀리뛰기|세단뛰기|포환|원반|창던지기|해머/.test(n)) return 'field_distance';
    if (/종경기$|^\d+종$/.test(n)) return 'combined';
    if (/마라톤|km/i.test(n)) return 'road';
    return 'track';
}

/** 기록 칸 → { status, value } — 트랙은 초, 거리·높이는 m */
function parseRecord(raw, category, remark) {
    const s = norm(raw);
    const st = timingParse.parseStatus(s) || timingParse.parseStatus(norm(remark));
    if (st) return { status: st, value: null };
    if (!s) return { status: null, value: null };
    if (category === 'track' || category === 'road' || category === 'relay') {
        let t = s.replace(/["”″]/g, '').replace(/[′’']/g, ':').replace(/초$/, '').replace(/분/, ':');
        const v = timingParse.parseTime(t);
        if (v == null) { const f = parseFloat(t); return isFinite(f) && f > 0 && /^\d+(\.\d+)?$/.test(t) ? { status: null, value: f } : { status: null, value: null, bad: true }; }
        return { status: null, value: v };
    }
    // 거리·높이: '3.21' '3m21' '3m 21' '321cm' '3.21m'
    let m;
    if ((m = s.match(/^(\d+)\s*m\s*(\d{1,2})\s*(cm)?$/i))) return { status: null, value: parseInt(m[1], 10) + parseInt(m[2].padEnd(2, '0'), 10) / 100 };
    if ((m = s.match(/^(\d+(?:\.\d+)?)\s*cm$/i))) return { status: null, value: parseFloat(m[1]) / 100 };
    if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*m?$/i))) { const v = parseFloat(m[1].replace(',', '.')); return v > 0 ? { status: null, value: v } : { status: null, value: null, bad: true }; }
    return { status: null, value: null, bad: true };
}

/** 머리글 행 찾기: 이름·종목(또는 기록) 열이 있는 첫 행 */
function findHeaderRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const col = mapHeader(rows[i] || []);
        if (col.name !== undefined && (col.event !== undefined || col.record !== undefined)) return { index: i, col };
    }
    return null;
}

function parseResultSheet(buffer, opts = {}) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const out = { header: null, rows: [], issues: [], sheets: [] };
    let line = 0;
    for (const sn of wb.SheetNames) {
        const ws = wb.Sheets[sn]; if (!ws) continue;
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        const hdr = findHeaderRow(rows);
        if (!hdr) { if (rows.some(r => r.some(c => norm(c)))) out.issues.push(`[${sn}] 머리글(이름·종목·기록)을 찾지 못해 건너뜀`); continue; }
        out.sheets.push(sn);
        if (!out.header) out.header = Object.fromEntries(Object.entries(hdr.col).map(([k, i]) => [k, norm(rows[hdr.index][i])]));
        const col = hdr.col;
        const get = (r, k) => (col[k] === undefined ? '' : norm(r[col[k]]));
        // 시트 이름이 부별일 수 있다 ('남초6', '여자초등부 3학년')
        const sheetDiv = parseDivision(sn);
        for (let i = hdr.index + 1; i < rows.length; i++) {
            const r = rows[i] || [];
            if (!r.some(c => norm(c))) continue;
            line++;
            const name = get(r, 'name');
            const evText = get(r, 'event');
            const issues = [];
            if (!name) { issues.push('이름 없음'); }
            const ev = parseEventText(evText);
            const divText = get(r, 'division');
            const d1 = parseDivision(divText);
            const d2 = parseDivision(ev.rest);
            const gText = get(r, 'gender');
            const gender = (gText ? (timingParse.genderOf(gText) || (/^(남|m)/i.test(gText) ? 'M' : /^(여|f)/i.test(gText) ? 'F' : null)) : null)
                || d1.gender || d2.gender || (sheetDiv.division || sheetDiv.gender ? sheetDiv.gender : null);
            const division = d1.division || d2.division || (sheetDiv.division && !sheetDiv.gender && !sheetDiv.division.match(/^sheet/i) ? sheetDiv.division : '') || '';
            const roundText = get(r, 'round');
            const round = roundText ? timingParse.parseRound(roundText) : (ev.round || 'final');
            if (!ev.name) issues.push(`종목을 읽지 못함: '${evText || '(비어 있음)'}'`);
            if (!gender) issues.push('성별을 알 수 없음 (부별 칸이나 종목 칸에 남/여를 적어 주세요)');
            const category = categoryOf(ev.name);
            const rec = parseRecord(get(r, 'record'), category, get(r, 'remark'));
            if (rec.bad) issues.push(`기록을 읽지 못함: '${get(r, 'record')}'`);
            if (!rec.status && rec.value == null && !rec.bad) issues.push('기록 없음 (문자 대상에서 빠짐)');
            const rankRaw = get(r, 'rank'); const rank = /^\d+$/.test(rankRaw) ? parseInt(rankRaw, 10) : null;
            const heatRaw = get(r, 'heat').replace(/조$/, ''); const heat = /^\d+$/.test(heatRaw) ? parseInt(heatRaw, 10) : 1;
            const phone = normPhone(get(r, 'phone'));
            if (get(r, 'phone') && !/^01[016789]\d{7,8}$/.test(phone)) issues.push(`전화번호 형식 확인: '${get(r, 'phone')}'`);
            else if (!phone) issues.push('전화번호 없음 (문자를 보낼 수 없음)');
            const eventKey = { gender: gender || 'X', division, name: ev.name, round, category };
            const label = `${gender ? G_KO[gender] : ''} ${division} ${ev.name} ${ROUND_KO[round]}`.replace(/\s+/g, ' ').trim();
            out.rows.push({ line, sheet: sn, name, phone, phoneRaw: get(r, 'phone'), team: get(r, 'team'), eventKey, label, recordRaw: get(r, 'record'), status: rec.status, value: rec.value, rank, heat, remark: get(r, 'remark'), issues });
        }
    }
    if (!out.sheets.length && !out.issues.length) out.issues.push('읽을 수 있는 시트가 없습니다.');
    return out;
}

const eventKeyStr = k => `${k.gender}|${k.division}|${k.name}|${k.round}`;

module.exports = { parseResultSheet, parseDivision, parseEventText, parseRecord, normPhone, categoryOf, mapHeader, eventKeyStr, ROUND_KO, G_KO };
