/**
 * 종목 매칭 공통 규칙 — lib/eventMatch.js (2026-09 Phase 4)
 *   시간표 자동연결 · 계측 파일(.lif/.txt/xlsx) · 노출용 시간표가 같은 판정을 쓴다.
 */
const EM = require('../../lib/eventMatch');

const ev = (id, name, gender, round_type, extra) => ({ id, name, gender, round_type, division: '', ...(extra || {}) });
const EVENTS = [
    ev(1, '100m', 'M', 'preliminary'), ev(2, '100m', 'M', 'final'), ev(3, '100m', 'F', 'final'),
    ev(4, '100mH', 'F', 'final'), ev(5, '110mH', 'M', 'final'),
    ev(6, '10,000m', 'M', 'final'), ev(7, '4X100mR', 'M', 'final'), ev(8, '4X400mR(Mixed)', 'X', 'final'),
    ev(9, '10종경기', 'M', 'final'), ev(10, '20kmW', 'M', 'final'), ev(11, '20kmW', 'F', 'final'),
    ev(12, '200m', 'M', 'final', { division: '고등부' }), ev(13, '200m', 'M', 'final', { division: '대학부' }),
];

describe('normEvt', () => {
    it('공백·콤마·대소문자·곱셈기호 차이를 지운다', () => {
        expect(EM.normEvt('10,000m')).toBe(EM.normEvt('10000m'));
        expect(EM.normEvt('4×100mR')).toBe(EM.normEvt('4X100mR'));
        expect(EM.normEvt('4 x 100 mR')).toBe('4x100mr');
        expect(EM.normEvt('100m')).not.toBe(EM.normEvt('100mH'));
    });
});

describe('parseCategory (시간표 종별)', () => {
    it('부·성별 표기 여러 가지', () => {
        expect(EM.parseCategory('대학(남)')).toEqual({ divisions: ['대학'], genders: ['M'] });
        expect(EM.parseCategory('대학/실업(여)')).toEqual({ divisions: ['대학', '실업'], genders: ['F'] });
        expect(EM.parseCategory('대학(남)/실업(남,여)').genders.sort()).toEqual(['F', 'M']);
        expect(EM.parseCategory('남고')).toEqual({ divisions: ['고등'], genders: ['M'] });
        expect(EM.parseCategory('여자(아시아)')).toEqual({ divisions: [], genders: ['F'] });
        expect(EM.parseCategory('혼성')).toEqual({ divisions: [], genders: ['X'] });
        expect(EM.parseCategory('')).toEqual({ divisions: [], genders: [] });
    });
    it('종합경기 세부 행은 부모 종목으로', () => {
        expect(EM.combinedParentName('10종(3)')).toBe('10종경기'); expect(EM.combinedParentName('7종(1)')).toBe('7종경기'); expect(EM.combinedParentName('결승')).toBeNull();
    });
});

describe('findEvents', () => {
    it('이름·성별·라운드가 맞는 것만, 정확한 이름이 있으면 접두 매칭은 안 한다 (100m ↛ 100mH)', () => {
        const r = EM.findEvents(EVENTS, { name: '100m', genders: ['M'], round: 'final' });
        expect(r.matches.map(e => e.id)).toEqual([2]); expect(r.exact).toBe(true); expect(r.ambiguous).toBe(false);
        expect(EM.findEvents(EVENTS, { name: '100m', gender: 'F', round: 'final' }, { allowPrefix: true }).matches.map(e => e.id)).toEqual([3]);
    });
    it('접두 매칭은 정확한 이름이 없을 때만 (계측 파일 "100" → 100m 는 파서가 m 을 붙이고, "10000" 은 10,000m 로)', () => {
        expect(EM.findEvents(EVENTS, { name: '10000m', gender: 'M', round: 'final' }).matches.map(e => e.id)).toEqual([6]);
        expect(EM.findEvents(EVENTS, { name: '4×100mR', gender: 'M', round: 'final' }).matches.map(e => e.id)).toEqual([7]);
        expect(EM.findEvents(EVENTS, { name: '4x400mR(Mixed)', gender: 'X', round: 'final' }).matches.map(e => e.id)).toEqual([8]);
        expect(EM.findEvents(EVENTS, { name: '110', gender: 'M', round: 'final' }, { allowPrefix: true }).matches.map(e => e.id)).toEqual([5]);
        expect(EM.findEvents(EVENTS, { name: '110', gender: 'M', round: 'final' }).matches).toEqual([]);
    });
    it('라운드 폴백: 예선으로 저장된 종목이 없으면 라운드를 무시하고 찾고 roundMatched=false', () => {
        expect(EM.findEvents(EVENTS, { name: '100mH', gender: 'F', round: 'preliminary' }).matches).toEqual([]);
        const r = EM.findEvents(EVENTS, { name: '100mH', gender: 'F', round: 'preliminary' }, { roundFallback: true });
        expect(r.matches.map(e => e.id)).toEqual([4]); expect(r.roundMatched).toBe(false);
    });
    it('남녀 동시출발(성별 둘)은 두 종목, pickByGender 는 성별마다 점수 높은 대표', () => {
        const r = EM.findEvents(EVENTS, { name: '20kmW', genders: ['M', 'F'], round: 'final' });
        expect(r.matches.map(e => e.id)).toEqual([10, 11]); expect(r.ambiguous).toBe(true);
        const dup = [...EVENTS, ev(14, '20kmW', 'M', 'final')];
        const reps = EM.pickByGender(EM.findEvents(dup, { name: '20kmW', genders: ['M', 'F'], round: 'final' }).matches, e => e.id === 14 ? 100 : 0);
        expect(reps.map(e => e.id).sort()).toEqual([11, 14]);
    });
    it('부 토큰으로 좁히기(계측 파일: "남자 고등부 200m") · 부 라벨 엄격 비교(노출용)', () => {
        expect(EM.findEvents(EVENTS, { name: '200m', gender: 'M', round: 'final', divToken: '고등' }).matches.map(e => e.id)).toEqual([12]);
        expect(EM.findEvents(EVENTS, { name: '200m', gender: 'M', round: 'final', divToken: '중등' }).matches.length).toBe(2);   // 못 좁히면 그대로(ambiguous)
        expect(EM.findEvents(EVENTS, { name: '200m', gender: 'M', round: 'final', division: '대학부' }, { divisionStrict: true }).matches.map(e => e.id)).toEqual([13]);
        expect(EM.divToken('남자 실업부')).toBe('일반'); expect(EM.divToken('여중')).toBe('중등'); expect(EM.divToken('고등부')).toBe('고등');
    });
    it('성별이 없는 종목(gender null)은 어느 성별 질의에도 후보', () => {
        const list = [ev(20, '마라톤', null, 'final')];
        expect(EM.findEvents(list, { name: '마라톤', gender: 'F', round: 'final' }).matches.map(e => e.id)).toEqual([20]);
    });
});
