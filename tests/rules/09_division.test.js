/**
 * [규정·운영] 부(division) 규칙 — lib/division.js (Phase 7-②)
 *   라벨 정규화(학년 단위 부 포함), 라벨 → 부 마스터 코드, 학년 부 시드
 */
const { normalizeDivisionLabel, parseDivision, divisionCodeFor, gradeDivisionSeed } = require('../../lib/division');

describe('normalizeDivisionLabel — 같은 뜻은 한 표기로, 학년은 잃지 않는다', () => {
    it.each([
        ['남자 중학교부', '중등부'], ['여자중학부', '중등부'], ['고등학교부', '고등부'], ['실업부', '일반부'], ['초등학교부', '초등부'],
        ['남중 1학년부', '중1학년부'], ['중학교 1학년부', '중1학년부'], ['중등2학년부', '중2학년부'], ['여고3학년부', '고3학년부'],
        ['초등 5학년', '초5학년부'], ['초3학년부', '초3학년부'], ['고1', '고1학년부'],
        ['U20 남자부', 'U20(남)'], ['선수권 여자', '선수권(여)'], ['국제', '국제'], ['3학년부', '3학년부'], ['', ''],
    ])('%s → %s', (raw, want) => { expect(normalizeDivisionLabel(raw)).toBe(want); });
    it('학년 범위 밖(중4·초7)은 학년부로 보지 않는다', () => {
        expect(normalizeDivisionLabel('중4학년부')).toBe('중4학년부');
        expect(normalizeDivisionLabel('초7학년부')).toBe('초7학년부');
    });
});

describe('parseDivision — 학교급·학년', () => {
    it.each([
        ['중등부', 'MID', null], ['고등부', 'HIGH', null], ['중1학년부', 'MID', 1], ['초6학년부', 'ELEM', 6], ['대학부', 'UNIV', null], ['일반부', 'GEN', null],
        ['M_MID1', 'MID', 1], ['F_HIGH', 'HIGH', null], ['M_OPEN', null, null], ['U20', null, null], ['', null, null],
    ])('%s → %s / %s', (raw, level, grade) => { expect(parseDivision(raw)).toEqual({ level, grade }); });
});

describe('divisionCodeFor — 종목의 부 라벨 + 성별 → 부 마스터 코드', () => {
    const masters = [
        { code: 'M_MID', label_ko: '남자중학부', gender: 'M', school_level: 'MID', grade: null },
        { code: 'F_MID', label_ko: '여자중학부', gender: 'F', school_level: 'MID', grade: null },
        { code: 'M_MID1', label_ko: '남자중학1학년부', gender: 'M', school_level: 'MID', grade: 1 },
        { code: 'M_ELEM5', label_ko: '남자초등5학년부', gender: 'M', school_level: 'ELEM', grade: 5 },
        { code: 'M_GEN', label_ko: '남자일반부', gender: 'M', school_level: 'GEN', grade: null },
        { code: 'M_OPEN', label_ko: '남자공개부', gender: 'M', school_level: 'OPEN', grade: null },
    ];
    it('코드 그대로 · 라벨 일치 · 학교급+학년+성별', () => {
        expect(divisionCodeFor('M_MID', 'M', masters)).toBe('M_MID');
        expect(divisionCodeFor('남자중학부', 'M', masters)).toBe('M_MID');
        expect(divisionCodeFor('중등부', 'M', masters)).toBe('M_MID');
        expect(divisionCodeFor('중등부', 'F', masters)).toBe('F_MID');
        expect(divisionCodeFor('중1학년부', 'M', masters)).toBe('M_MID1');
        expect(divisionCodeFor('남중 1학년부', 'M', masters)).toBe('M_MID1');
        expect(divisionCodeFor('초5학년부', 'M', masters)).toBe('M_ELEM5');
        expect(divisionCodeFor('일반부', 'M', masters)).toBe('M_GEN');
        expect(divisionCodeFor('남자공개부', 'M', masters)).toBe('M_OPEN');
    });
    it('없는 조합은 null — 학년부는 학교급 전체 부로 뭉개지 않는다(부별 기록이 다른 부)', () => {
        expect(divisionCodeFor('중2학년부', 'M', masters)).toBeNull();
        expect(divisionCodeFor('중1학년부', 'F', masters)).toBeNull();
        expect(divisionCodeFor('고등부', 'M', masters)).toBeNull();
        expect(divisionCodeFor('U20', 'M', masters)).toBeNull();
        expect(divisionCodeFor('', 'M', masters)).toBeNull();
    });
});

describe('gradeDivisionSeed — 초3~6 · 중1~3 · 고1~3 × 남녀 = 20', () => {
    it('코드·라벨·정렬', () => {
        const rows = gradeDivisionSeed();
        expect(rows).toHaveLength(20);
        expect(rows.map(r => r[0])).toEqual(expect.arrayContaining(['M_ELEM3', 'M_ELEM6', 'M_MID1', 'M_HIGH3', 'F_ELEM3', 'F_MID2', 'F_HIGH1']));
        const m1 = rows.find(r => r[0] === 'M_MID1');
        expect(m1).toEqual(['M_MID1', '남자중학1학년부', 'M', 'MID', 21, 1]);
        expect(new Set(rows.map(r => r[0])).size).toBe(20);
        expect(new Set(rows.map(r => r[4])).size).toBe(20);     // 정렬값 중복 없음
        // 마스터 라벨로도 코드가 풀린다
        const masters = rows.map(([code, label_ko, gender, school_level, , grade]) => ({ code, label_ko, gender, school_level, grade }));
        expect(divisionCodeFor('고2학년부', 'F', masters)).toBe('F_HIGH2');
    });
});
