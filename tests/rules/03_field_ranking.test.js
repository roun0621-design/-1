/**
 * [WA 규정] 필드 종목 순위 — public/lib/ranking.js (서버·브라우저 공용 단일 구현)
 *   TR 25.22 거리 동률, TR 25.6 상위 8명, TR 26.2 3회 연속 실패, TR 26.8 높이 동률(카운트백)
 */
const R = require('../../public/lib/ranking');

const H = (spec) => { // '1.80:O 1.85:XO 1.90:XXX' → hd
    const hd = {};
    spec.trim().split(/\s+/).forEach(tok => { const [h, m] = tok.split(':'); hd[parseFloat(h)] = m.split('').map(c => (c === '-' ? 'PASS' : c)); });
    return hd;
};

describe('높이 종목 (TR 26)', () => {
    it('최고 높이 · 그 높이의 실패 수 · 그 높이"까지"의 실패 수', () => {
        const s = R.heightStats(H('1.80:O 1.85:XO 1.90:XXO 1.95:XXX'));
        expect(s.best).toBe(1.90);
        expect(s.failsAtBest).toBe(2);
        expect(s.totalFails).toBe(3);      // 1.85 의 X 1 + 1.90 의 X 2 — 1.95 의 XXX 는 세지 않는다
        expect(s.allFails).toBe(6);
        expect(s.eliminated).toBe(true);
    });
    it('카운트백 ②: 마지막으로 넘은 높이 이후의 실패는 동률 판정에 들어가지 않는다', () => {
        // A: 1.90 을 1차에 넘고 1.95 에서 XXX / B: 1.90 을 1차에 넘고 1.95 에서 X 후 기권(패스)
        // 예전 구현(경기 전체 실패 수)은 B(1) < A(3) 로 B 를 위에 뒀다. 규정상 둘은 동률.
        const A = { id: 'A', ...R.heightStats(H('1.85:O 1.90:O 1.95:XXX')) };
        const B = { id: 'B', ...R.heightStats(H('1.85:O 1.90:O 1.95:X--')) };
        expect(R.compareHeight(A, B)).toBe(0);
        const rows = [A, B]; R.assignRanks(rows, R.compareHeight);
        expect(rows.map(r => r.rank)).toEqual([1, 1]);
    });
    it('카운트백 ①→②: 같은 높이면 그 높이 실패 수, 같으면 그 높이까지의 실패 수', () => {
        const A = { id: 'A', ...R.heightStats(H('1.80:O 1.85:XO 1.90:XO')) };   // at best 1, total 2
        const B = { id: 'B', ...R.heightStats(H('1.80:O 1.85:O 1.90:XO')) };    // at best 1, total 1
        const C = { id: 'C', ...R.heightStats(H('1.80:XXO 1.85:O 1.90:O')) };   // at best 0, total 2
        const rows = [A, B, C]; const ranked = R.assignRanks(rows, R.compareHeight);
        expect(ranked.map(r => r.id)).toEqual(['C', 'B', 'A']);
        expect(rows.find(r => r.id === 'C').rank).toBe(1);
    });
    it('TR 26.2: 높이에 걸친 3회 연속 실패는 탈락 (패스는 연속을 끊지 않는다, 성공은 끊는다)', () => {
        expect(R.heightStats(H('1.80:X-- 1.83:XX')).eliminated).toBe(true);      // X, 패스, 패스, X, X → 3연속
        expect(R.heightStats(H('1.80:XXO 1.83:XX')).eliminated).toBe(false);     // O 가 끊음 → 1.83 에서 아직 2회
        expect(R.heightStats(H('1.80:XX- 1.83:X')).eliminated).toBe(true);
        expect(R.heightStats(H('1.80:O 1.83:X- 1.86:X')).eliminated).toBe(false);
    });
    it('NM: 한 번도 못 넘고 탈락 / 시도 없음은 NM 아님', () => {
        expect(R.heightStats(H('1.60:XXX')).isNM).toBe(true);
        expect(R.heightStats({}).isNM).toBe(false);
        expect(R.heightStats(H('1.60:X')).isNM).toBe(false);
    });
    it('동률이면 같은 순위, 다음 순위는 건너뛴다', () => {
        const rows = ['1.90:O', '1.90:O', '1.85:O', '1.80:XXX'].map((sp, i) => ({ id: i, ...R.heightStats(H(sp)) }));
        R.assignRanks(rows, R.compareHeight);
        expect(rows.map(r => r.rank)).toEqual([1, 1, 3, null]);
    });
    it("표기 혼용('-', 'PASS', 소문자, 객체형 {1:'X'})을 같게 처리", () => {
        const a = R.heightStats({ 1.8: { 1: 'x', 2: 'PASS', 3: 'o' } });
        expect(a.best).toBe(1.8); expect(a.failsAtBest).toBe(1);
    });
});

describe('거리 종목 (TR 25.22 · 25.6)', () => {
    const D = (id, ...att) => ({ id, ...R.distanceStats(att) });
    it('최고 기록이 같으면 두 번째, 세 번째 기록으로 가린다', () => {
        const rows = [D('A', 7.20, 7.05, 0), D('B', 7.20, 7.10, 6.90), D('C', 7.20, 7.10, 6.95)];
        const ranked = R.assignRanks(rows, R.compareDistance);
        expect(ranked.map(r => r.id)).toEqual(['C', 'B', 'A']);
        expect(ranked.map(r => r.rank)).toEqual([1, 2, 3]);
    });
    it('유효 기록 수가 다르면 없는 쪽이 진다 (7.20 단독 < 7.20 + 6.50)', () => {
        const ranked = R.assignRanks([D('A', 7.20, 0, -1), D('B', 7.20, 6.50, 0)], R.compareDistance);
        expect(ranked.map(r => r.id)).toEqual(['B', 'A']);
    });
    it('모든 기록이 같으면 1위도 공동', () => {
        const rows = [D('A', 7.20, 7.10), D('B', 7.10, 7.20)]; R.assignRanks(rows, R.compareDistance);
        expect(rows.map(r => r.rank)).toEqual([1, 1]);
    });
    it('파울(0)·패스(-1)·미입력(null)은 기록이 아니다', () => {
        expect(R.distanceStats({ 1: 0, 2: -1, 3: null }).best).toBe(null);
        expect(R.distanceStats([0, 6.5, -1]).sortedValid).toEqual([6.5]);
    });
    it('상위 8명: 8위 동률은 두 번째 기록으로 가린다 — 최고 기록만 같다고 9명이 되지 않는다', () => {
        const rows = [];
        for (let i = 0; i < 7; i++) rows.push({ event_entry_id: i + 1, ...R.distanceStats([8.0 - i * 0.1, 6.0]) });
        rows.push({ event_entry_id: 8, ...R.distanceStats([7.00, 6.80, 6.00]) });
        rows.push({ event_entry_id: 9, ...R.distanceStats([7.00, 6.70, 6.00]) });   // 최고는 같지만 두 번째가 낮다 → 탈락
        rows.push({ event_entry_id: 10, ...R.distanceStats([6.90]) });
        const ids = R.topNIds(rows, 8);
        expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
    it('상위 8명: 끝까지 같으면 모두 진출, 8명 이하면 전원', () => {
        const rows = [];
        for (let i = 0; i < 7; i++) rows.push({ event_entry_id: i + 1, ...R.distanceStats([8.0 - i * 0.1]) });
        rows.push({ event_entry_id: 8, ...R.distanceStats([7.00, 6.80]) });
        rows.push({ event_entry_id: 9, ...R.distanceStats([6.80, 7.00]) });
        expect(R.topNIds(rows, 8).size).toBe(9);
        expect(R.topNIds(rows.slice(0, 5), 8).size).toBe(5);
        expect(R.topNIds([{ event_entry_id: 1, best: null, sortedValid: [] }], 8).size).toBe(0);   // 기록 없는 선수는 포함하지 않는다
    });
});
