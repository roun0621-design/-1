/**
 * [WA 규정] 종합경기 점수표 — World Athletics Scoring Tables for Combined Events
 *   트랙:  P = INT( A × (B − T)^C )        T = 초
 *   도약:  P = INT( A × (M − B)^C )        M = cm
 *   투척:  P = INT( A × (D − B)^C )        D = m
 * 계수 17개(10종 10 + 7종 7)와 널리 알려진 1000점 기준 기록, 그리고 0.01 단위 전 구간에서
 * 부동소수 오차로 1점이 어긋나지 않는지(정수 cm/1/100초 산술과 대조) 고정한다.
 */
let calcWAPoints, WA_TABLES, DECATHLON_KEYS, HEPTATHLON_KEYS;
beforeAll(() => { ({ calcWAPoints, WA_TABLES, DECATHLON_KEYS, HEPTATHLON_KEYS } = require('../../server.js')); });

const OFFICIAL = {
    M_100m: [25.4347, 18, 1.81], M_long_jump: [0.14354, 220, 1.4], M_shot_put: [51.39, 1.5, 1.05], M_high_jump: [0.8465, 75, 1.42],
    M_400m: [1.53775, 82, 1.81], M_110m_hurdles: [5.74352, 28.5, 1.92], M_discus: [12.91, 4, 1.1], M_pole_vault: [0.2797, 100, 1.35],
    M_javelin: [10.14, 7, 1.08], M_1500m: [0.03768, 480, 1.85],
    F_100m_hurdles: [9.23076, 26.7, 1.835], F_high_jump: [1.84523, 75, 1.348], F_shot_put: [56.0211, 1.5, 1.05], F_200m: [4.99087, 42.5, 1.81],
    F_long_jump: [0.188807, 210, 1.41], F_javelin: [15.9803, 3.8, 1.04], F_800m: [0.11193, 254, 1.88],
};

describe('종합경기 점수표', () => {
    it('계수 A·B·C 가 공식 표와 일치 (17종목)', () => {
        for (const [k, [A, B, C]] of Object.entries(OFFICIAL)) {
            expect(WA_TABLES[k], k).toBeTruthy();
            expect([WA_TABLES[k].A, WA_TABLES[k].B, WA_TABLES[k].C], k).toEqual([A, B, C]);
        }
        expect(Object.keys(WA_TABLES).sort()).toEqual(Object.keys(OFFICIAL).sort());
    });
    it('세부종목 순서 — 10종 1일차 100m·멀리·포환·높이·400m / 2일차 110mH·원반·장대·창·1500m, 7종 100mH·높이·포환·200m / 멀리·창·800m', () => {
        expect(DECATHLON_KEYS).toEqual(['M_100m', 'M_long_jump', 'M_shot_put', 'M_high_jump', 'M_400m', 'M_110m_hurdles', 'M_discus', 'M_pole_vault', 'M_javelin', 'M_1500m']);
        expect(HEPTATHLON_KEYS).toEqual(['F_100m_hurdles', 'F_high_jump', 'F_shot_put', 'F_200m', 'F_long_jump', 'F_javelin', 'F_800m']);
    });
    it('1000점 기준 기록', () => {
        const marks = [['M_100m', 10.395, 1000], ['M_long_jump', 7.76, 1000], ['M_shot_put', 18.40, 1000], ['M_400m', 46.17, 1000], ['M_110m_hurdles', 13.80, 1000],
            ['M_discus', 56.17, 1000], ['M_javelin', 77.19, 1000], ['M_1500m', 233.79, 1000], ['M_high_jump', 2.21, 1002], ['M_pole_vault', 5.29, 1001],
            ['F_100m_hurdles', 13.85, 1000], ['F_shot_put', 17.07, 1000], ['F_200m', 23.80, 1000], ['F_javelin', 57.18, 1000], ['F_800m', 127.63, 1000], ['F_high_jump', 1.82, 1003], ['F_long_jump', 6.48, 1001]];
        for (const [k, v, p] of marks) expect(calcWAPoints(k, v), `${k} ${v}`).toBe(p);
    });
    it('0.01 단위 전 구간: 부동소수 오차로 인한 1점 어긋남 없음', () => {
        let bad = 0;
        for (const [k, [A, B, C]] of Object.entries(OFFICIAL)) {
            const t = WA_TABLES[k].type;
            const lo = t === 'track' ? 900 : 100, hi = t === 'track' ? Math.round(B * 100) : (t === 'field_cm' ? 900 : 9000);
            for (let h = lo; h <= hi; h++) {
                const val = t === 'track' ? (Math.round(B * 100) - h) / 100 : t === 'field_cm' ? h - B : (h - Math.round(B * 100)) / 100;
                const ref = val <= 0 ? 0 : Math.floor(A * Math.pow(val, C) + 1e-9);
                if (calcWAPoints(k, h / 100) !== ref) bad++;
            }
        }
        expect(bad).toBe(0);
    });
    it('기록 없음·0·음수·기준 미달은 0점', () => {
        expect(calcWAPoints('M_100m', null)).toBe(0);
        expect(calcWAPoints('M_100m', 0)).toBe(0);
        expect(calcWAPoints('M_100m', 18.5)).toBe(0);      // B(18초)보다 느림
        expect(calcWAPoints('M_high_jump', 0.70)).toBe(0); // B(75cm) 미달
        expect(calcWAPoints('X_unknown', 10)).toBe(0);
    });
});
