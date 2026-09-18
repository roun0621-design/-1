/** 계측 결과 공통 파서 — lib/timingParse.js */
const T = require('../../lib/timingParse');
describe('시간', () => {
    it('형식', () => {
        expect(T.parseTime('10.52')).toBe(10.52); expect(T.parseTime('10,52')).toBe(10.52); expect(T.parseTime('10.523')).toBe(10.523);
        expect(T.parseTime('1:52.34')).toBeCloseTo(112.34, 5); expect(T.parseTime('1:02:15.3')).toBeCloseTo(3735.3, 5); expect(T.parseTime(' 45.10 ')).toBe(45.1);
    });
    it('글자가 섞이면 시간이 아니다 — 추측하지 않는다', () => {
        for (const v of ['DQ(TR16.8)', 'DNS', '10.52s?', '', null, '0', 'abc']) expect([v, T.parseTime(v)]).toEqual([v, null]);
    });
});
describe('상태', () => {
    it('사유가 붙어도 상태로', () => {
        expect(T.parseStatus('DQ')).toBe('DQ'); expect(T.parseStatus('DQ(TR16.8)')).toBe('DQ'); expect(T.parseStatus('dq TR17.3.1')).toBe('DQ'); expect(T.parseStatus('DSQ')).toBe('DQ');
        expect(T.parseStatus('DNS')).toBe('DNS'); expect(T.parseStatus('DNF')).toBe('DNF'); expect(T.parseStatus('실격')).toBe('DQ'); expect(T.parseStatus('10.52')).toBe(null); expect(T.parseStatus('1')).toBe(null);
    });
});
describe('라운드·성별', () => {
    it('준결승은 결승이 아니다', () => { expect(T.parseRound('남자 100m 준결승')).toBe('semifinal'); expect(T.parseRound('결승')).toBe('final'); expect(T.parseRound('예선 2조')).toBe('preliminary'); });
    it('성별은 라벨 어디에 있어도', () => {
        expect(T.genderOf('합동 남자 100m 결승')).toBe('M'); expect(T.genderOf('실업부 여자 100m')).toBe('F'); expect(T.genderOf('혼성 4X400mR')).toBe('X');
        expect(T.genderOf('남 100m')).toBe('M'); expect(T.genderOf('100m')).toBe(null); expect(T.genderOf('남양주시청')).toBe(null);
    });
});
