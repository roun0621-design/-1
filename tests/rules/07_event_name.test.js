/**
 * 종목명 표기 — lib/eventName.js (시스템 전체의 단일 정의)
 *   recordKey 는 저장된 기록표가 의존하므로 출력이 고정돼야 한다(특성 테스트). storedName 은 DB 저장 표기.
 */
const E = require('../../lib/eventName');

describe('recordKey — 표기가 달라도 같은 종목', () => {
    const groups = [
        ['4X100mR', '4x100mR', '4×100mR', '4 x 100mR', '4x100m릴레이', '남자 4×100m 계주 결승', '4X100mR 예선'],
        ['4X400mR(Mixed)', '4x400mR(Mixed)', '4×400mR(Mixed)', 'MIXED 4x400mR', 'Mixed 4×400mR', '혼성 4x400mR', '4x400mR Mixed'],
        ['10,000m', '10000m', '10 000m', '여자 10000m 결승', '10000미터'],
        ['110mH', '110m허들', '110미터 허들'],
        ['3000mSC', '3000m장애물', '3,000mSC'],
        ['10,000mW', '10000mW', '10000미터 경보'],
        ['100m', '남 100m', 'M 100m 예선', '100m 준결승'],
        ['멀리뛰기', '여자 멀리뛰기', '멀리뛰기 결승'],
    ];
    for (const g of groups) it(g[0], () => { for (const v of g.slice(1)) expect([v, E.recordKey(v)]).toEqual([v, E.recordKey(g[0])]); expect(E.sameEvent(g[0], g[1])).toBe(true); });
    it('출력 고정 (기록표 저장값과 같아야 한다)', () => {
        expect(E.recordKey('4X100mR')).toBe('4x100mR'); expect(E.recordKey('10,000m')).toBe('10000m'); expect(E.recordKey('110m허들')).toBe('110mH');
        expect(E.recordKey('4X400mR(Mixed)')).toBe('4x400mR(Mixed)'); expect(E.recordKey('')).toBe('');
    });
    it('다른 종목은 다르다', () => {
        expect(E.sameEvent('100m', '100mH')).toBe(false); expect(E.sameEvent('4X100mR', '4X400mR')).toBe(false); expect(E.sameEvent('', '')).toBe(false);
    });
});

describe('storedName — DB 저장 표기', () => {
    it('계주는 모두 대문자 X (곱셈 기호·소문자·띄어쓰기 입력 포함)', () => {
        for (const [i, o] of [['4x100mR', '4X100mR'], ['4×800mR', '4X800mR'], ['4 x 1500mR', '4X1500mR'], ['4x400mR(Mixed)', '4X400mR(Mixed)'], ['Mixed 4x400mR', '4X400mR(Mixed)'], ['4X100mR', '4X100mR']]) expect([i, E.storedName(i)]).toEqual([i, o]);
    });
    it('10000m 은 콤마 표기, 그 밖은 그대로', () => {
        expect(E.storedName('10000m')).toBe('10,000m'); expect(E.storedName('10000mW')).toBe('10,000mW'); expect(E.storedName('멀리뛰기')).toBe('멀리뛰기'); expect(E.storedName(null)).toBe(null);
    });
    it('저장 표기와 비교 키가 어긋나지 않는다', () => {
        for (const v of ['4x100mR', '4×800mR', '10000m', 'Mixed 4x400mR']) expect(E.sameEvent(E.storedName(v), v)).toBe(true);
    });
});
