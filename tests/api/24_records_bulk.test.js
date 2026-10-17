/**
 * 기록표 엑셀 일괄 업로드 (NR/DR/CR) — /api/records/bulk-preview, /api/records/bulk-import
 *
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
const XLSX = require('xlsx');

let app;
const ADMIN_KEY = 'testadmin1234';
const HEADER = ['종류', '성별', '부', '종목', '기록', '성명', '소속', '대회명', '장소', '일자', '풍속', '비고'];

beforeAll(async () => {
    app = require('../../server.js').app;
});

function buf(rows, header = HEADER) {
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '기록표');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function post(path, b, fields = {}) {
    let r = request(app).post(path).field('admin_key', ADMIN_KEY);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
    return r.attach('file', b, 'records.xlsx');
}
async function getRecords(q) {
    return (await request(app).get('/api/records?' + new URLSearchParams(q).toString())).body;
}

describe('기록표 일괄 업로드', () => {
    it('admin_key 없으면 403', async () => {
        const res = await request(app).post('/api/records/bulk-preview').attach('file', buf([]), 'r.xlsx');
        expect(res.status).toBe(403);
    });

    it('미리보기 — 정규화·상태 분류 (신규/오류/CR 시리즈 미선택)', async () => {
        const rows = [
            ['NR', '남', '', '10,000m', '28:23.62', '전은회', '대구도시공사', '제211회 일본체육대학장거리경기대회', '가와사키', '2010.10.23', '', ''],
            ['DR', '남', '대학', '110mH(1.067m)', '13.91', '이정준', '한국체대', '', '홍콩', '2006-07-02', '0.8', ''],
            ['DR', '여', '실업', '높이뛰기', '1m 93', '김희선', '코오롱', '', '서울', '1990', '', ''],
            ['NR', '남', '', '10종경기', '7,860점', '김건우', '문경시청', '', '대구', '20110828', '', ''],
            ['NR', '여', '', '1500m', '3:38:60', '오타', '', '', '', '', '', ''],          // 초 60 → 오류
            ['NR', '여', '', '10000m', '37.10.55', '오타2', '', '', '', '', '', ''],        // 점 두 개 → 오류
            ['DR', '남', '', '200m', '20.68', '고승환', '성균관대', '', '', '', '', ''],     // 부 누락 → 오류
            ['CR', '남', '', '100m', '10.30', '이시몬', '한국체대', '', '', '', '', '77회'], // 시리즈 미선택 → 오류
        ];
        const res = await post('/api/records/bulk-preview', buf(rows));
        expect(res.status).toBe(200);
        const byRow = Object.fromEntries(res.body.rows.map(r => [r.row, r]));
        expect(byRow[2].status).toBe('new');
        expect(byRow[2].event_name).toBe('10000m');
        expect(byRow[2].record_value_num).toBeCloseTo(28 * 60 + 23.62, 5);
        expect(byRow[2].record_date).toBe('2010-10-23');
        expect(byRow[2].record_year).toBe('2010');
        expect(byRow[3].event_name).toBe('110mH');
        expect(byRow[3].division_code).toBe('M_UNIV');
        expect(byRow[3].note).toContain('풍속 +0.8');
        expect(byRow[4].division_code).toBe('F_GEN');           // 실업 → 일반부
        expect(byRow[4].record_value).toBe('1.93');
        expect(byRow[5].record_value).toBe('7860');
        expect(byRow[5].record_date).toBe('2011-08-28');
        expect(byRow[6].status).toBe('error');
        expect(byRow[7].status).toBe('error');
        expect(byRow[8].status).toBe('error');
        expect(byRow[8].errors.join()).toContain('부 필수');
        expect(byRow[9].status).toBe('error');
        expect(byRow[9].errors.join()).toContain('시리즈');
        expect(res.body.summary.error).toBe(4);
        expect(res.body.summary.new).toBe(4);
    });

    it('오류 행이 있으면 import 는 400 + 아무것도 저장하지 않음', async () => {
        const rows = [
            ['NR', '남', '', '400m', '45.37', '손주일', '경찰대학', '', '서울', '1994-06-17', '', ''],
            ['NR', '남', '', '800m', '1:74.14', '오타', '', '', '', '', '', ''],   // 초 74 → 오류
        ];
        const res = await post('/api/records/bulk-import', buf(rows));
        expect(res.status).toBe(400);
        expect(res.body.summary.error).toBe(1);
        const list = await getRecords({ event_name: '400m', gender: 'M', record_type: 'national' });
        expect(list.filter(r => r.holder_name === '손주일').length).toBe(0);
    });

    it('import — 신규 저장 → 재업로드 변경없음 → 나쁜 값은 체크 없이는 건너뜀 → 허용 시 덮어씀', async () => {
        // 시리즈 생성 (CR용)
        const sRes = await request(app).post('/api/competition-series')
            .send({ admin_key: ADMIN_KEY, name: 'BULK_TEST_SERIES_' + Date.now(), federation: 'KUAF' })
            .set('Content-Type', 'application/json');
        expect(sRes.status).toBe(200);
        const seriesId = sRes.body.id;

        const rows = [
            ['NR', '여', '', '100mH', '13.00', '이연경', '안양시청', '제64회 전국육상경기선수권대회', '대구', '2010-06-07', '0.8', ''],
            ['DR', '여', '대학', '100mH', '13.63', '방신혜', '경북대', '', '서울', '1988-05-07', '0.3', ''],
            ['CR', '여', '', '100mH', '13.63', '방신혜', '경북대', '', '', '', '', '42회'],
            ['CR', '남', '', '높이뛰기', '2.32', '이진택', '경북대', '', '', '', '', '49회'],
        ];
        let res = await post('/api/records/bulk-import', buf(rows), { series_id: seriesId });
        expect(res.status).toBe(200);
        expect(res.body.stats).toMatchObject({ inserted: 4, updated: 0, unchanged: 0, skippedWorse: 0 });

        const nr = await getRecords({ event_name: '100mH', gender: 'F', record_type: 'national' });
        expect(nr.length).toBe(1);
        expect(nr[0].record_value).toBe('13.00');
        expect(nr[0].holder_name).toBe('이연경');
        expect(nr[0].note).toContain('풍속 +0.8');
        const cr = await getRecords({ event_name: '높이뛰기', gender: 'M', record_type: 'competition', series_id: seriesId });
        expect(cr.length).toBe(1);
        expect(cr[0].record_value).toBe('2.32');

        // 같은 파일 재업로드 → 전부 변경없음
        res = await post('/api/records/bulk-preview', buf(rows), { series_id: seriesId });
        expect(res.body.summary.unchanged).toBe(4);

        // 나쁜 값(100mH 13.00 → 13.20 느림 / 높이뛰기 2.32 → 2.30 낮음) + 좋은 값(CR 100mH 13.63 → 13.50)
        const worse = [
            ['NR', '여', '', '100mH', '13.20', '누군가', '어딘가', '', '', '2030-01-01', '', ''],
            ['CR', '남', '', '높이뛰기', '2.30', '누군가', '어딘가', '', '', '', '', ''],
            ['CR', '여', '', '100mH', '13.50', '신기록', '경북대', '', '', '', '', '80회'],
        ];
        res = await post('/api/records/bulk-preview', buf(worse), { series_id: seriesId });
        expect(res.body.summary.worse).toBe(2);
        expect(res.body.summary.update).toBe(1);

        res = await post('/api/records/bulk-import', buf(worse), { series_id: seriesId });
        expect(res.status).toBe(200);
        expect(res.body.stats).toMatchObject({ updated: 1, skippedWorse: 2 });
        expect((await getRecords({ event_name: '100mH', gender: 'F', record_type: 'national' }))[0].record_value).toBe('13.00'); // 보존
        expect((await getRecords({ event_name: '100mH', gender: 'F', record_type: 'competition', series_id: seriesId }))[0].record_value).toBe('13.50');

        res = await post('/api/records/bulk-import', buf(worse), { series_id: seriesId, allow_worse: '1' });
        expect(res.status).toBe(200);
        expect(res.body.stats.updated).toBe(2);
        expect((await getRecords({ event_name: '100mH', gender: 'F', record_type: 'national' }))[0].record_value).toBe('13.20');
    });

    it('파일 안 중복 키(동률 2건)는 뒤 행이 오류', async () => {
        const rows = [
            ['NR', '여', '', '100m', '11.49', '이영숙', '안산시청', '1994 토토 국제슈퍼육상경기대회', '후쿠오카', '1994-09-15', '0.0', ''],
            ['NR', '여', '', '100m', '11.49', '이영숙', '안산시청', '제48회 전국육상경기선수권대회', '서울', '1994-06-17', '0.8', ''],
        ];
        const res = await post('/api/records/bulk-preview', buf(rows));
        expect(res.body.rows[0].status).toBe('new');
        expect(res.body.rows[1].status).toBe('error');
        expect(res.body.rows[1].errors.join()).toContain('중복');
    });

    it('필수 열이 없으면 400', async () => {
        const res = await post('/api/records/bulk-preview', buf([['NR', '남', '100m', '10.07']], ['종류', '성별', '종목명X', '기록']));
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('종목');
    });
});
