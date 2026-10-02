'use strict';
/**
 * 부(division) 공용 규칙 — 2026-09 Phase 7-②
 *
 *   종목의 부는 자유 문자열(event.division: '중등부'·'고등부'·'중1학년부'·'U20'…)이고,
 *   부별 기록(DR)·연맹 기록지는 부 마스터 코드(division_master.code: M_MID·F_HIGH1…)로 움직인다.
 *   이 파일이 둘 사이를 잇는다.
 *
 *   normalizeDivisionLabel(raw)   → 저장용 표기 하나로 ('남자 중학교부'→'중등부', '남중 1학년부'→'중1학년부')
 *   parseDivision(label)          → { level: 'ELEM'|'MID'|'HIGH'|'UNIV'|'GEN'|null, grade: 1~6|null }
 *   divisionCodeFor(label, gender, masters) → 부 마스터 코드 또는 null  (코드 그대로 · 라벨 일치 · 학교급+학년+성별)
 *   gradeDivisionSeed()           → 학년 단위 부 마스터 20행 (초3~6 · 중1~3 · 고1~3 × 남녀)
 */

const LEVEL_KO = { ELEM: '초', MID: '중', HIGH: '고' };
const LEVEL_LABEL = { ELEM: '초등부', MID: '중등부', HIGH: '고등부', UNIV: '대학부', GEN: '일반부' };
const LEVEL_FULL = { ELEM: '초등', MID: '중학', HIGH: '고등' };   // 마스터 라벨용: 남자중학1학년부

/** 학년이 든 라벨 → { level, grade } (없으면 null). '남중 1학년부'·'중학교1학년부'·'초등 5학년'·'고1'·'초3학년부' */
function parseGradeLabel(s) {
    s = String(s || '').replace(/\s+/g, '');
    if (!s) return null;
    let m = s.match(/^(?:남자|여자|남|여)?(초등학교|초등|초|중학교|중학|중등|중|고등학교|고등|고)(?:부)?(\d)(?:학년)?(?:부)?$/);
    if (!m) m = s.match(/^(?:남자|여자|남|여)?(초등학교|초등|초|중학교|중학|중등|중|고등학교|고등|고)?(\d)학년(?:부)?$/);
    if (!m) return null;
    const lv = m[1] ? ({ 초: 'ELEM', 중: 'MID', 고: 'HIGH' })[m[1][0]] : null;
    const grade = Number(m[2]);
    if (!lv) return null;                                            // '3학년부'만으로는 학교급을 모른다
    if (lv === 'ELEM' ? (grade < 1 || grade > 6) : (grade < 1 || grade > 3)) return null;
    return { level: lv, grade };
}

/**
 * 부 라벨 정규화 — 같은 뜻의 여러 표기를 하나로. 모르는 라벨은 원본을 보존한다.
 *   (server.js 에서 이곳으로 옮김. 시간표·명단·조편성 업로드가 모두 이 함수로 부를 저장한다)
 */
function normalizeDivisionLabel(div) {
    if (!div) return '';
    const s = div.toString().trim().replace(/\s+/g, '');
    if (!s) return '';

    // 선수권 변형 통합
    if (/^선수권\(?남자?\)?부?$/.test(s) || s === '선수권남' || s === '남자선수권') return '선수권(남)';
    if (/^선수권\(?여자?\)?부?$/.test(s) || s === '선수권여' || s === '여자선수권') return '선수권(여)';
    if (/^선수권\(?혼성?\)?부?$/.test(s) || /^선수권\(?mix/i.test(s)) return '선수권(혼)';
    if (s === '선수권') return '선수권';

    // U18/U20 변형 통합
    let m = s.match(/^U(18|20)\(?(남자?|여자?|혼성?)\)?부?$/i);
    if (m) {
        const g = /^남/.test(m[2]) ? '남' : (/^여/.test(m[2]) ? '여' : '혼');
        return `U${m[1]}(${g})`;
    }
    if (/^U18$/i.test(s)) return 'U18';
    if (/^U20$/i.test(s)) return 'U20';

    // 학년 단위 부: '남중 1학년부'·'중학교 1학년부'·'초등5학년' → '중1학년부'·'초5학년부'
    const g = parseGradeLabel(s);
    if (g) return `${LEVEL_KO[g.level]}${g.grade}학년부`;

    // 학교부 변형 통합
    if (/^(남자|여자)?(중학교부|중학부|중등부)$/.test(s)) return '중등부';
    if (/^(남자|여자)?(고등학교부|고등부)$/.test(s)) return '고등부';
    if (/^(남자|여자)?(대학교부|대학부)$/.test(s)) return '대학부';
    if (/^(남자|여자)?(초등학교부|초등부)$/.test(s)) return '초등부';
    if (/^(남자|여자)?(일반부|실업부)$/.test(s)) return '일반부';

    // 기타 알 수 없는 라벨은 원본 보존
    return div.toString().trim();
}

/** 부 라벨 → { level, grade }. 코드(M_MID1)도 읽는다 */
function parseDivision(label) {
    const s = String(label || '').replace(/\s/g, '');
    if (!s) return { level: null, grade: null };
    let m = s.match(/^[MFX]_(ELEM|MID|HIGH|UNIV|GEN|OPEN|MIXED)(\d)?$/);
    if (m) return { level: ['OPEN', 'MIXED'].includes(m[1]) ? null : m[1], grade: m[2] ? Number(m[2]) : null };
    const g = parseGradeLabel(s);
    if (g) return g;
    let level = null;
    if (/초/.test(s)) level = 'ELEM'; else if (/중/.test(s)) level = 'MID'; else if (/고/.test(s)) level = 'HIGH';
    else if (/대학/.test(s)) level = 'UNIV'; else if (/일반|실업/.test(s)) level = 'GEN';
    return { level, grade: null };
}

/**
 * 종목의 부 라벨 + 성별 → 부 마스터 코드.
 *   masters: [{ code, label_ko, gender, school_level, grade? }] (active 만 넘길 것)
 *   순서: ① 라벨이 코드 그대로 ② 마스터 라벨과 일치(성별 접두 무시) ③ 학교급·학년·성별 일치 ④ 학년 없는 라벨은 학교급·성별
 */
function divisionCodeFor(label, gender, masters) {
    const raw = String(label || '').trim();
    if (!raw || !Array.isArray(masters) || !masters.length) return null;
    const byCode = masters.find(d => d.code === raw);
    if (byCode) return byCode.code;
    const norm = s => String(s || '').replace(/\s+/g, '').replace(/^(남자|여자|남|여)/, '');
    const nl = norm(raw);
    const byLabel = masters.find(d => d.gender === gender && norm(d.label_ko) === nl);
    if (byLabel) return byLabel.code;
    const p = parseDivision(raw);
    if (!p.level) return null;
    const cand = masters.filter(d => d.gender === gender && d.school_level === p.level);
    const hit = cand.find(d => (d.grade == null ? null : Number(d.grade)) === p.grade);
    return hit ? hit.code : null;
}

/** 학년 단위 부 마스터 시드 — [code, label_ko, gender, school_level, sort_order, grade] */
function gradeDivisionSeed() {
    const rows = [];
    const base = { M: { ELEM: 10, MID: 20, HIGH: 30 }, F: { ELEM: 110, MID: 120, HIGH: 130 } };
    for (const g of ['M', 'F']) for (const lv of ['ELEM', 'MID', 'HIGH']) {
        const grades = lv === 'ELEM' ? [3, 4, 5, 6] : [1, 2, 3];
        for (const gr of grades) rows.push([`${g}_${lv}${gr}`, `${g === 'M' ? '남자' : '여자'}${LEVEL_FULL[lv]}${gr}학년부`, g, lv, base[g][lv] + gr, gr]);
    }
    return rows;
}

module.exports = { normalizeDivisionLabel, parseDivision, parseGradeLabel, divisionCodeFor, gradeDivisionSeed, LEVEL_KO, LEVEL_LABEL };
