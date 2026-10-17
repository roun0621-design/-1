'use strict';
/**
 * 종목 매칭 — 들어온 이름·성별·부·라운드로 대회의 event 를 찾는 단 하나의 규칙 (2026-09 Phase 4)
 *   시간표 자동연결(lib/routes/timetable.js), 계측 파일 .lif/.txt/기록 xlsx(lib/routes/timing_import.js),
 *   노출용 시간표(server.js autoLinkDisplayTimetable)가 각자 norm()·후보 고르기를 갖고 있었고 조금씩 달랐다
 *   (콤마 처리, × 처리, 100m 이 100mH 로 새는 접두 매칭, 라운드 폴백 유무). 여기로 모은다.
 *
 *   normEvt(name)                         비교용 정규화: 공백·콤마 제거, 소문자, ×→x  ('10,000m'='10000m', '4×100mR'='4x100mr')
 *   parseCategory(cat)                    시간표 '종별' 칸 → { divisions:[…], genders:['M'|'F'|'X'] }
 *   combinedParentName(roundStr)          '10종(3)' 같은 종합경기 세부 표기 → '10종경기' (아니면 null)
 *   findEvents(events, query, opts)       후보 종목 목록 → { matches, exact, roundMatched, ambiguous }
 *   pickByGender(matches, scoreOf)        성별마다 대표 하나(점수 높은 쪽) — 시간표 한 행이 남·여 두 종목에 걸릴 때
 *
 *   query: { name, genders?: [], round?: 'preliminary'|'semifinal'|'final', divToken?: '초등'|'중등'|'고등'|'대학'|'일반'|'', division?: '정규화된 부 라벨' }
 *   opts:  { allowPrefix?: bool  — 정확한 이름이 없을 때만 접두 매칭 허용(계측 파일 '100' → '100m' 류). 정확한 이름이 있으면 그것만.
 *            roundFallback?: bool — 라운드가 맞는 종목이 없으면 라운드를 무시하고 다시 찾는다(round_type 이 다르게 저장된 대회)
 *            divisionStrict?: bool — query.division 이 있으면 부 라벨까지 같아야 한다(노출용 대회: 같은 종목이 부마다 있다) }
 */

function normEvt(s) { return String(s || '').replace(/[,\s　]+/g, '').toLowerCase().replace(/[×✕✖]/g, 'x'); }

const DIV_CHAR_MAP = { '초': '초등', '중': '중등', '고': '고등', '대': '대학', '일': '일반', '실': '실업' };
/**
 * 시간표 '종별' 칸 해석. 지원 표기:
 *   "대학(남)" · "대학/실업(여)" · "대학(남)/실업(남,여)" · "남고"/"여대"/"남일" · "남자(아시아)" · "대학부"/"남자"/"남" · "혼성"
 */
function parseCategory(cat) {
    if (!cat) return { divisions: [], genders: [] };
    const genders = new Set(), divisions = new Set();
    for (let part of String(cat).split('/')) {
        part = part.trim();
        const divMatch = part.match(/^(대학|실업|초등|중등|고등|일반)/);
        if (divMatch) divisions.add(divMatch[1]);
        const genderMatch = part.match(/\(([남여혼성,]+)\)/);
        if (genderMatch) {
            const inner = genderMatch[1];
            if (inner.includes('남')) genders.add('M');
            if (inner.includes('여')) genders.add('F');
            if (inner.includes('혼성')) genders.add('X');
        }
        const shortMatch = part.match(/^([남여])([초중고대일실])(?:[부]?)/);
        if (shortMatch) { genders.add(shortMatch[1] === '남' ? 'M' : 'F'); if (DIV_CHAR_MAP[shortMatch[2]]) divisions.add(DIV_CHAR_MAP[shortMatch[2]]); }
        if (!divMatch && !shortMatch) {
            if (/^남자?(\(|$)/.test(part)) genders.add('M');
            if (/^여자?(\(|$)/.test(part)) genders.add('F');
            if (/혼성|혼합/.test(part)) genders.add('X');
        }
        const divOnlyMatch = part.match(/^(대학|실업|초등|중등|고등|일반)부$/);
        if (divOnlyMatch) divisions.add(divOnlyMatch[1]);
    }
    return { divisions: [...divisions], genders: [...genders] };
}

/** '10종(3)' · '7종(1)' · '5종(2)' → '10종경기' … (종합경기 세부 행은 부모 종목에 붙인다) */
function combinedParentName(roundStr) {
    const m = String(roundStr || '').trim().match(/^(10|7|5)종\(\d+\)/);
    return m ? m[1] + '종경기' : null;
}

/** 부 라벨/종목명에서 부 토큰 하나 ('남자 실업부' → '일반', '고등부' → '고등') */
function divToken(raw) {
    const s = String(raw || '').replace(/\s/g, '').replace(/^(남자|여자|혼성|남|여|혼)/, '');
    if (/초등|^초/.test(s)) return '초등';
    if (/중학|중등|^중/.test(s)) return '중등';
    if (/고등|^고/.test(s)) return '고등';
    if (/대학|^대/.test(s)) return '대학';
    if (/일반|실업|성인/.test(s)) return '일반';
    return s;
}

function findEvents(events, query, opts) {
    const o = opts || {}, q = query || {};
    const target = normEvt(q.name);
    if (!target) return { matches: [], exact: false, roundMatched: false, ambiguous: false };
    let byName = events.filter(e => normEvt(e.name) === target);
    let exact = byName.length > 0;
    if (!exact && o.allowPrefix) byName = events.filter(e => normEvt(e.name).startsWith(target));   // 정확한 이름이 있으면 접두 매칭은 쓰지 않는다 (100m ↛ 100mH)
    const genders = Array.isArray(q.genders) ? q.genders.filter(Boolean) : (q.gender ? [q.gender] : []);
    let list = genders.length ? byName.filter(e => !e.gender || genders.includes(e.gender)) : byName;
    if (o.divisionStrict && q.division) list = list.filter(e => String(e.division || '') === String(q.division));
    let roundMatched = true;
    if (q.round) {
        const r = list.filter(e => e.round_type === q.round);
        if (r.length || !o.roundFallback) list = r; else roundMatched = false;
    }
    if (list.length > 1 && q.divToken) {
        const tok = e => (e.division && String(e.division).trim()) ? divToken(e.division) : (['초등', '중등', '고등', '대학', '일반'].includes(divToken(e.name)) ? divToken(e.name) : '');
        const narrowed = list.filter(e => { const t = tok(e); return t === '' || t === q.divToken; });
        if (narrowed.length) list = narrowed;
    }
    return { matches: list, exact, roundMatched, ambiguous: list.length > 1 };
}

/** 성별마다 대표 종목 하나 — 같은 성별에 중복 종목이 있으면 scoreOf(event) 가 큰 쪽, 같으면 id 작은 쪽 */
function pickByGender(matches, scoreOf) {
    const byGender = new Map();
    for (const m of matches) { const g = m.gender || ''; if (!byGender.has(g)) byGender.set(g, []); byGender.get(g).push(m); }
    const out = [];
    for (const [, list] of byGender) { list.sort((a, b) => ((scoreOf && scoreOf(b)) || 0) - ((scoreOf && scoreOf(a)) || 0) || (a.id - b.id)); out.push(list[0]); }
    return out;
}

module.exports = { normEvt, parseCategory, combinedParentName, divToken, findEvents, pickByGender };
