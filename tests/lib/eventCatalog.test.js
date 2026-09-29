/**
 * 종목 사전(lib/eventCatalog.js) — 이름(한글·영문·약어·연맹·Bornan 표기) → 코드, 영문 표시, 풍속 규제, 정렬
 */
const EC = require('../../lib/eventCatalog');

describe('eventCatalog.codeOf', () => {
    it.each([
        ['100m', '100'], ['남자 100m 일반부', '100'], ['100m 예선', '100'], ['100m 실업', '100'], ['100M', '100'],
        ['10,000m', '10000'], ['10000m', '10000'], ['10 000m', '10000'],
        ['110mH', '110H'], ['110m허들', '110H'], ['110m Hurdles', '110H'], ['110MHURD', '110H'], ['Women 100m Hurdles', '100H'],
        ['3000mSC', '3000SC'], ['3000m장애물', '3000SC'], ['3000MST', '3000SC'],
        ['5000mW', '5000W'], ['10000mW', '10000W'], ['20KmW', '20KW'], ['WALK20K', '20KW'], ['35kmW', '35KW'],
        ['하프마라톤', 'HM'], ['Half Marathon', 'HM'], ['하프마라톤경보', 'HMW'], ['마라톤', 'MAR'], ['MARATHON', 'MAR'], ['10K', '10K'], ['10km', '10K'], ['5K', '5K'],
        ['멀리뛰기', 'LJ'], ['Long Jump', 'LJ'], ['LONGJUMP', 'LJ'], ['세단뛰기', 'TJ'], ['높이뛰기', 'HJ'], ['High Jump', 'HJ'], ['장대높이뛰기', 'PV'], ['Pole Vault', 'PV'],
        ['포환던지기', 'SP'], ['포환던지기 중1학년부', 'SP'], ["Men's Shot Put", 'SP'], ['원반던지기', 'DT'], ['Discus', 'DT'], ['해머던지기', 'HT'], ['창던지기', 'JT'], ['Javelin Throw', 'JT'],
        ['7종경기', 'HEP'], ['HEPTATH', 'HEP'], ['10종경기', 'DEC'], ['Decathlon', 'DEC'], ['5종경기', 'PEN'],
        ['4X100mR', '4X100'], ['4x100 relay', '4X100'], ['4x100m Relay', '4X100'], ['4X400mR', '4X400'], ['4x400m Relay', '4X400'], ['4x400', '4X400'], ['남 4X100mR 일반부', '4X100'],
        ['4X400mR(Mixed)', '4X400X'], ['Mixed 4x400m Relay', '4X400X'], ['혼성 4X400mR', '4X400X'], ['4x400mR(혼성)', '4X400X'], ['4x400mR Mixed', '4X400X'],
        ['4X800mR', '4X800'], ['4x1500m relay', '4X1500'], ['400m', '400'], ['200m 준결승', '200'], ['1500m U20(남)', '1500'], ['60m', '60'],
    ])('%s → %s', (name, code) => { expect(EC.codeOf(name)).toBe(code); });
    it('모르는 이름은 null, 빈 값도 null', () => { expect(EC.codeOf('foo bar')).toBeNull(); expect(EC.codeOf('')).toBeNull(); expect(EC.codeOf(null)).toBeNull(); });
    it('4x400m 안의 400m 를 400m 로 오인하지 않는다', () => { expect(EC.codeOf('4x400m')).toBe('4X400'); });
});

describe('eventCatalog 표시·규제·정렬', () => {
    it('label/nameEn', () => {
        expect(EC.label('LJ', 'en')).toBe('Long Jump'); expect(EC.label('LJ', 'ko')).toBe('멀리뛰기'); expect(EC.label('ZZ', 'en')).toBe('ZZ');
        expect(EC.nameEn('포환던지기 일반부')).toBe('Shot Put'); expect(EC.nameEn('이상한 종목')).toBe('이상한 종목');
    });
    it('풍속 규제 종목 = 100·200·100H·110H·LJ·TJ', () => {
        for (const c of ['100', '200', '100H', '110H', 'LJ', 'TJ']) expect(EC.isWindAffected(c)).toBe(true);
        for (const c of ['400', '400H', 'HJ', 'SP', '4X100', 'MAR']) expect(EC.isWindAffected(c)).toBe(false);
    });
    it('WA 순서: 트랙 → 허들 → 장애물 → 경보 → 도로 → 도약 → 투척 → 혼성 → 계주', () => {
        const order = ['100', '110H', '3000SC', '5000W', 'MAR', 'HJ', 'LJ', 'SP', 'DEC', '4X100'].map(EC.sortIndex);
        expect([...order].sort((a, b) => a - b)).toEqual(order); expect(EC.sortIndex('ZZ')).toBe(999);
    });
    it('entry 는 category 를 준다', () => { expect(EC.entry('hj').category).toBe('field_height'); expect(EC.entry('4X400X').category).toBe('relay'); });
});
