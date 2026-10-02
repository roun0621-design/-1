/**
 * lib/fieldCardImport.js — 필드 수기 기록카드 파서/계산/검산 단위 테스트 (DB 무관)
 *
 * 고정하는 것:
 *  - 셀 토큰 규칙: 거리(숫자/X/-), 풍속(부호 포함, 유효 시기만), 높이(O/XO/XXO/XXX/-), 기록구분
 *  - 헤더 인식(1차~6차 / N차풍속 / 높이 헤더 155·1.55) 과 시트 종류 판정
 *  - 풍속 시트 병합: 파울·패스 시기 풍속 무시, 유효 시기 풍속 누락 경고
 *  - 최고기록·순위 계산(WA 동점 처리) 과 카드 검산값 대조 경고
 */
const XLSX = require('xlsx');
const fc = require('../../lib/fieldCardImport');

function wb(sheets) {
    const book = XLSX.utils.book_new();
    for (const [name, aoa] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), name);
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
const COMMON = ['종별', '세부종목', '라운드', '조', '순서', '배번', '성명', '소속'];
const DIST_HDR = [...COMMON, '1차', '2차', '3차', '4차', '5차', '6차', '최고기록', '순위', '기록구분', '비고'];

describe('토큰 파서', () => {
    it('거리: 숫자 / 파울 X / 패스 - / 빈칸 / 오류', () => {
        expect(fc.parseDistanceToken('36.20')).toEqual({ kind: 'valid', value: 36.2 });
        expect(fc.parseDistanceToken(36.2)).toEqual({ kind: 'valid', value: 36.2 });
        expect(fc.parseDistanceToken('36,20m')).toEqual({ kind: 'valid', value: 36.2 });
        expect(fc.parseDistanceToken('X')).toEqual({ kind: 'foul', value: 0 });
        expect(fc.parseDistanceToken('Ｘ')).toEqual({ kind: 'foul', value: 0 });   // 전각
        expect(fc.parseDistanceToken('x')).toEqual({ kind: 'foul', value: 0 });
        expect(fc.parseDistanceToken('-')).toEqual({ kind: 'pass', value: -1 });
        expect(fc.parseDistanceToken('—')).toEqual({ kind: 'pass', value: -1 });
        expect(fc.parseDistanceToken('')).toBeNull();
        expect(fc.parseDistanceToken(null)).toBeNull();
        expect(fc.parseDistanceToken('3a.20').error).toMatch(/인식 불가/);
        expect(fc.parseDistanceToken('0').error).toMatch(/0 이하/);
    });
    it('풍속: 부호 포함 숫자, 빈칸/NWI 는 null', () => {
        expect(fc.parseWindToken('+0.8')).toEqual({ value: 0.8 });
        expect(fc.parseWindToken('-0.9')).toEqual({ value: -0.9 });
        expect(fc.parseWindToken('0.0')).toEqual({ value: 0 });
        expect(fc.parseWindToken(0)).toEqual({ value: 0 });
        expect(fc.parseWindToken('+1.2 m/s')).toEqual({ value: 1.2 });
        expect(fc.parseWindToken('')).toBeNull();
        expect(fc.parseWindToken('NWI')).toBeNull();
        expect(fc.parseWindToken('abc').error).toMatch(/풍속/);
    });
    it('높이: O / XO / XXO / XXX / - / X- / 0→O / r 기권', () => {
        expect(fc.parseHeightToken('XXO').marks).toEqual(['X', 'X', 'O']);
        expect(fc.parseHeightToken('xo').marks).toEqual(['X', 'O']);
        expect(fc.parseHeightToken('0').marks).toEqual(['O']);
        expect(fc.parseHeightToken('-').marks).toEqual(['PASS']);
        expect(fc.parseHeightToken('XX-').marks).toEqual(['X', 'X', 'PASS']);
        expect(fc.parseHeightToken('XXX').marks).toEqual(['X', 'X', 'X']);
        expect(fc.parseHeightToken('XX')).toMatchObject({ marks: ['X', 'X'], retired: false });
        expect(fc.parseHeightToken('XXXr')).toMatchObject({ marks: ['X', 'X', 'X'], retired: true });
        expect(fc.parseHeightToken('')).toBeNull();
        expect(fc.parseHeightToken('XXXO').error).toMatch(/인식 불가/);
        expect(fc.parseHeightToken('OX').error).toMatch(/인식 불가/);
    });
    it('기록구분 / 바 높이 / 종목명 정규화', () => {
        expect(fc.parseStatusToken('DNS').code).toBe('DNS');
        expect(fc.parseStatusToken('결장').code).toBe('DNS');
        expect(fc.parseStatusToken('실격').code).toBe('DQ');
        expect(fc.parseStatusToken('NM').code).toBe('NM');
        expect(fc.parseStatusToken('R')).toMatchObject({ code: '', unsupported: 'R' });
        expect(fc.parseStatusToken('??')).toMatchObject({ code: '', unknown: '??' });
        expect(fc.normalizeBarHeight('155')).toBe(1.55);
        expect(fc.normalizeBarHeight(1.6)).toBe(1.6);
        expect(fc.normalizeBarHeight('1.55m')).toBe(1.55);
        expect(fc.normalizeBarHeight('155cm')).toBe(1.55);
        expect(fc.normalizeBarHeight('abc')).toBeNull();
        expect(fc.normalizeEventName('[10종] 포환던지기')).toEqual({ base: '포환던지기', combined: '10종' });
        expect(fc.normalizeEventName('10종경기 창던지기')).toEqual({ base: '창던지기', combined: '10종' });
        expect(fc.normalizeEventName('Javelin Throw').base).toBe('창던지기');
        expect(fc.normalizeEventName('여자 멀리뛰기').base).toBe('멀리뛰기');
        expect(fc.normalizeEventName('멀리뛰기(여)').base).toBe('멀리뛰기');
        expect(fc.needsWindByName('세단뛰기')).toBe(true);
        expect(fc.needsWindByName('창던지기')).toBe(false);
    });
});

describe('헤더 인식', () => {
    it('거리 시트: 1차~6차 + 풍속 열', () => {
        const c = fc.detectColumns([...COMMON, '1차', '2차 시기', '3차', '1차 풍속(m/s)', '최고기록', '순위', '기록구분']);
        expect(c.kind).toBe('distance');
        expect(c.attempts).toEqual({ 1: 8, 2: 9, 3: 10 });
        expect(c.winds).toEqual({ 1: 11 });
        expect(c.best).toBe(12); expect(c.rank).toBe(13); expect(c.status).toBe(14);
        expect(c.bib).toBe(5); expect(c.order).toBe(4); expect(c.event).toBe(1); expect(c.div).toBe(0);
    });
    it('높이 시트: 숫자 헤더가 바 높이 (155 → 1.55)', () => {
        const c = fc.detectColumns([...COMMON, '155', 1.6, '1.65m', '최고기록', '순위']);
        expect(c.kind).toBe('height');
        expect(c.heights.map(h => h.height)).toEqual([1.55, 1.6, 1.65]);
    });
    it('풍속만 있는 시트는 wind 종류', () => {
        const c = fc.detectColumns([...COMMON, '1차풍속', '2차풍속']);
        expect(c.kind).toBe('wind');
    });
});

describe('거리 종목 파싱·계산·검산', () => {
    it('시기별 기록/최고/순위 계산 + 카드 검산값 불일치 경고', () => {
        const buf = wb([['기록', [DIST_HDR,
            ['여자 일반부', '창던지기', '결승', 1, 1, 53, '이금희', 'A', '36.20', '33.43', '35.68', '34.70', '38.03', '33.60', '38.03', 2, '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 6, 57, '박보경', 'B', '46.24', '50.45', 'X', '53.20', '50.19', 'X', '53.20', 1, '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 7, 116, '고현서', 'C', '46.04', 'X', '46.46', '49.60', 'X', '-', '49.61', '', '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 8, 120, '결장자', 'D', '', '', '', '', '', '', '', '', 'DNS', ''],
            ['여자 일반부', '창던지기', '결승', 1, 9, 121, '무기록', 'E', 'X', 'X', 'X', '', '', '', '', '', 'NM', ''],
        ]]]);
        const { groups } = fc.parseFieldCardWorkbook(buf);
        expect(groups.length).toBe(1);
        const g = fc.computeGroup(groups[0], { needsWind: false });
        expect(g.kind).toBe('distance');
        expect(fc.groupLabel(g)).toBe('여자 일반부 창던지기 결승 1조');
        const [r1, r2, r3, r4, r5] = g.rows;
        expect(r2.attempts[3]).toMatchObject({ kind: 'foul', value: 0 });
        expect(r3.attempts[6]).toMatchObject({ kind: 'pass', value: -1 });
        expect(r4.attempts).toEqual({});
        expect(r1.computed.best).toBe(38.03);
        expect(r2.computed.rank).toBe(1);
        expect(r3.computed.rank).toBe(2);
        expect(r1.computed.rank).toBe(3);
        // 카드 순위 2 vs 계산 3 → 경고
        expect(r1.issues.some(i => i.level === 'warn' && /순위 불일치/.test(i.msg))).toBe(true);
        // 카드 최고 49.61 vs 계산 49.60 → 경고
        expect(r3.issues.some(i => /최고기록 불일치/.test(i.msg))).toBe(true);
        expect(r2.issues.filter(i => i.level === 'warn').length).toBe(0);
        expect(r4.status.code).toBe('DNS');
        expect(r4.hasData).toBe(true);
        expect(r5.status.code).toBe('NM');
        expect(r5.computed.best).toBeNull();
    });
    it('WA 동점 처리: 최고 같으면 2번째 기록으로 순위', () => {
        const buf = wb([['기록', [DIST_HDR,
            ['남고', '포환던지기', '결승', 1, 1, 1, 'A', '', '15.00', '14.50', 'X', '', '', '', '', '', '', ''],
            ['남고', '포환던지기', '결승', 1, 2, 2, 'B', '', '15.00', '14.80', 'X', '', '', '', '', '', '', ''],
            ['남고', '포환던지기', '결승', 1, 3, 3, 'C', '', '15.00', '14.80', 'X', '', '', '', '', '', '', ''],
        ]]]);
        const g = fc.computeGroup(fc.parseFieldCardWorkbook(buf).groups[0]);
        expect(g.rows.map(r => r.computed.rank)).toEqual([3, 1, 1]);
    });
    it('NM 인데 유효 기록이 있으면 NM 을 버리고 경고', () => {
        const buf = wb([['기록', [DIST_HDR,
            ['남고', '포환던지기', '결승', 1, 1, 1, 'A', '', '15.00', 'X', 'X', '', '', '', '', '', 'NM', ''],
        ]]]);
        const g = fc.computeGroup(fc.parseFieldCardWorkbook(buf).groups[0]);
        expect(g.rows[0].status.code).toBe('');
        expect(g.rows[0].issues.some(i => /NM/.test(i.msg))).toBe(true);
    });
    it('인식 불가 셀은 error 로 표시되고 행이 invalid', () => {
        const buf = wb([['기록', [DIST_HDR,
            ['남고', '포환던지기', '결승', 1, 1, 1, 'A', '', '15.00', '1a.3', '', '', '', '', '', '', '', ''],
        ]]]);
        const g = fc.computeGroup(fc.parseFieldCardWorkbook(buf).groups[0]);
        expect(g.rows[0].valid).toBe(false);
        expect(g.rows[0].issues.some(i => i.level === 'error' && /2차/.test(i.msg))).toBe(true);
    });
    it('기록 시트가 없으면 throw', () => {
        const buf = wb([['설명', [['안내'], ['내용']]]]);
        expect(() => fc.parseFieldCardWorkbook(buf)).toThrow(/기록 시트/);
    });
});

describe('수평도약 풍속 시트 병합', () => {
    const WIND_HDR = [...COMMON, '1차풍속', '2차풍속', '3차풍속', '4차풍속', '5차풍속', '6차풍속'];
    it('유효 시기에만 풍속 부착, 파울·패스 시기 풍속은 무시, 누락은 경고', () => {
        const buf = wb([
            ['기록', [DIST_HDR,
                ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '임지현', 'A', '5.94', 'X', '6.05', '5.88', '-', '', '6.05', 1, '', ''],
                ['여자 일반부', '멀리뛰기', '결승', 1, 2, 217, '이하은', 'B', '5.85', '5.59', '', '', '', '', '5.85', 2, '', ''],
            ]],
            ['풍속', [WIND_HDR,
                ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '임지현', 'A', '+0.8', '+0.3', '+1.2', '0.0', '-0.5', ''],
                ['여자 일반부', '멀리뛰기', '결승', 1, 2, 217, '이하은', 'B', '-0.3', '', '', '', '', ''],
            ]],
        ]);
        const { groups, issues } = fc.parseFieldCardWorkbook(buf);
        expect(groups.length).toBe(1);
        const g = fc.computeGroup(groups[0], { needsWind: true });
        expect(g.windSheet).toBe('풍속');
        const [r1, r2] = g.rows;
        expect(r1.attempts[1].wind).toBe(0.8);
        expect(r1.attempts[2].wind).toBeNull();          // 파울 시기 → 무시
        expect(r1.attempts[3].wind).toBe(1.2);
        expect(r1.attempts[4].wind).toBe(0);
        expect(r1.attempts[5].wind).toBeNull();          // 패스 시기 → 무시
        expect(r1.issues.some(i => i.level === 'info' && /2차 파울·패스/.test(i.msg))).toBe(true);
        expect(r1.computed.bestWind).toBe(1.2);
        // 2차 유효 기록인데 풍속 없음 → 경고
        expect(r2.issues.some(i => i.level === 'warn' && /2차 유효 기록/.test(i.msg))).toBe(true);
        expect(r2.issues.some(i => /1차 유효 기록/.test(i.msg))).toBe(false);
        expect(issues.filter(i => i.level === 'error').length).toBe(0);
    });
    it('한 시트에 N차풍속 열이 같이 있어도 동작', () => {
        const hdr = [...COMMON, '1차', '1차풍속', '2차', '2차풍속', '최고기록', '순위'];
        const buf = wb([['기록', [hdr, ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '임지현', 'A', '5.94', '+0.8', 'X', '+0.2', '5.94', 1]]]]);
        const g = fc.computeGroup(fc.parseFieldCardWorkbook(buf).groups[0], { needsWind: true });
        expect(g.rows[0].attempts[1].wind).toBe(0.8);
        expect(g.rows[0].attempts[2].wind).toBeNull();
    });
    it('풍속 시트의 선수를 기록 시트에서 못 찾으면 그룹 경고', () => {
        const buf = wb([
            ['기록', [DIST_HDR, ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '임지현', 'A', '5.94', '', '', '', '', '', '', '', '', '']]],
            ['풍속', [WIND_HDR, ['여자 일반부', '멀리뛰기', '결승', 1, 9, 999, '없는선수', 'Z', '+0.8', '', '', '', '', '']]],
        ]);
        const g = fc.computeGroup(fc.parseFieldCardWorkbook(buf).groups[0], { needsWind: true });
        expect(g.issues.some(i => /찾지 못함/.test(i.msg))).toBe(true);
    });
});

describe('수직도약 파싱·계산', () => {
    it('높이 헤더 정규화, 마크 확장, 최고/순위(실패 수 동점 처리)', () => {
        const hdr = [...COMMON, '155', '160', '165', '170', '175', '최고기록', '순위', '기록구분', '비고'];
        const buf = wb([['기록', [hdr,
            ['남고', '높이뛰기', '결승', 1, 1, 34, 'A', 'T', '-', 'O', 'XO', 'O', 'XXX', '1.70', 1, '', ''],
            ['남고', '높이뛰기', '결승', 1, 2, 83, 'B', 'T', 'O', 'O', 'O', 'XO', 'XXX', '1.70', 2, '', ''],
            ['남고', '높이뛰기', '결승', 1, 3, 109, 'C', 'T', 'O', 'XXO', 'XXX', '', '', '1.60', 3, '', ''],
            ['남고', '높이뛰기', '결승', 1, 4, 110, 'D', 'T', 'XXX', '', '', '', '', '', '', 'NM', ''],
        ]]]);
        const { groups } = fc.parseFieldCardWorkbook(buf);
        const g = fc.computeGroup(groups[0]);
        expect(g.kind).toBe('height');
        expect(g.heights).toEqual([1.55, 1.6, 1.65, 1.7, 1.75]);
        const [a, b, c, d] = g.rows;
        expect(a.marks['1.55']).toEqual(['PASS']);
        expect(a.marks['1.65']).toEqual(['X', 'O']);
        expect(a.marks['1.75']).toEqual(['X', 'X', 'X']);
        expect(a.computed.best).toBe(1.7);
        expect(b.computed.best).toBe(1.7);
        // 1.70 에서 A 는 0실패, B 는 1실패 → A 1위, B 2위
        expect(a.computed.rank).toBe(1);
        expect(b.computed.rank).toBe(2);
        expect(c.computed.rank).toBe(3);
        expect(d.computed.best).toBeNull();
        expect(d.status.code).toBe('NM');
        expect(g.rows.every(r => r.issues.filter(i => i.level === 'warn').length === 0)).toBe(true);
        expect(fc.marksToString(a.marks['1.65'])).toBe('XO');
        expect(fc.marksToString(a.marks['1.55'])).toBe('-');
    });
});

describe('양식 템플릿', () => {
    it('3종 양식이 자기 파서로 다시 읽힌다', () => {
        for (const kind of ['throw', 'horizontal', 'vertical']) {
            const buf = fc.buildTemplateWorkbook(kind);
            expect(Buffer.isBuffer(buf)).toBe(true);
            const { groups } = fc.parseFieldCardWorkbook(buf);
            expect(groups.length).toBe(1);
            const g = fc.computeGroup(groups[0], { needsWind: kind === 'horizontal' });
            expect(g.rows.every(r => r.valid)).toBe(true);
            // 예시 행의 카드 최고기록·순위는 계산값과 일치해야 함 (양식 자체가 검산을 통과)
            expect(g.rows.every(r => !r.issues.some(i => i.level === 'warn'))).toBe(true);
        }
        expect(fc.buildTemplateWorkbook('nope')).toBeNull();
        expect(fc.AI_PROMPT).toMatch(/파울/);
    });
});
