/**
 * 회귀 테스트 2건 (2026-09 예천 준비 중 발견)
 *
 *  1) 연맹 명단 업로드 — 배포 양식(PACERISE_upload_template.xlsx)처럼 E열이 휴대폰이고
 *     종목1/종목2 가 F·G열에 있어도 헤더명으로 종목 열을 찾아 종목이 누락되지 않는다.
 *     (이전: row[4], row[5] 고정 인덱스 → 휴대폰을 종목1로 읽고 종목2 가 버려짐)
 *
 *  2) 결승 생성 직후 시간표의 "결승" 행이 자동 연결된다.
 *     (이전: autoLinkDisplayTimetable 이 "실업(남)" 을 division 으로 해석해 division 이 빈
 *      운영용 종목과 매칭 실패 → 재매칭 버튼을 수동으로 눌러야 했음)
 *
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
const XLSX = require('xlsx');

let app;
const ADMIN_KEY = 'testadmin1234';

beforeAll(async () => {
    app = require('../../server.js').app;
});

function xlsxBuffer(aoa, sheetName) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function createComp(name, federation) {
    const res = await request(app).post('/api/competitions')
        .send({ admin_key: ADMIN_KEY, name, start_date: '2026-09-14', end_date: '2026-09-16', venue: '', federation, mode: 'operation' })
        .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    return res.body.id;
}
async function getEvents(compId) {
    return (await request(app).get(`/api/events?competition_id=${compId}`)).body;
}

describe('연맹 명단 업로드 — 종목 열 헤더 탐색 (배포 양식 호환)', () => {
    // 배포 양식 열 순서: 팀명 | 선수명 | 성별 | 생년월일 | 휴대폰 | 종목1 | 종목2 | 4x100mR | ... | 바코드
    const header = ['팀명', '선수명', '성별', '생년월일', '휴대폰', '종목1', '종목2', '4x100mR', '4x400mR', 'Mixed 4x400mR', '4x1500mR', '4x800mR', '바코드'];
    const rows = [
        ['목포시청', '석민수', '남', '2005-03-03', '01012345678', '100m', '200m', '', '', '', '', '', ''],
        ['청주시청', '김민정', '여', '2000-05-12', '', '5000m', '3000mSC', '', '', '', '', '', ''],
        ['청주시청', '김혜미', '여', '1999-07-15', '', '5000m', '', '', '', '', '', '', ''],
    ];

    it('preview — 휴대폰 열을 종목으로 오인하지 않고 종목1·2 를 모두 인식한다', async () => {
        const res = await request(app).post('/api/federation/preview')
            .field('admin_key', ADMIN_KEY)
            .attach('file', xlsxBuffer([header, ...rows], '선수명단'), 'fed.xlsx');
        expect(res.status).toBe(200);
        const names = res.body.individualEvents.map(e => `${e.name}|${e.gender}`).sort();
        expect(names).toEqual(['100m|M', '200m|M', '3000mSC|F', '5000m|F']);
        const f5000 = res.body.individualEvents.find(e => e.name === '5000m');
        expect(f5000.count).toBe(2);
    });

    it('import — 종목2 까지 출전 등록된다', async () => {
        const compId = await createComp('FED_TEMPLATE_COLS_' + Date.now(), 'KTFL');
        const res = await request(app).post('/api/federation/import')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId))
            .attach('file', xlsxBuffer([header, ...rows], '선수명단'), 'fed.xlsx');
        expect(res.status).toBe(200);
        expect(res.body.stats.athletes).toBe(3);
        const evs = await getEvents(compId);
        const key = e => `${e.name}|${e.gender}`;
        expect(evs.map(key).sort()).toEqual(['100m|M', '200m|M', '3000mSC|F', '5000m|F']);
        expect(res.body.stats.entries).toBe(5);
    });

    it('레거시 고정 위치(E·F열 종목, 헤더명 없음)도 그대로 동작한다', async () => {
        const legacy = [
            ['소속', '이름', '성별', '생년', '', '', '바코드'],
            ['A팀', '선수1', '남', '20000101', '100m', '200m', 'PR-1'],
        ];
        const res = await request(app).post('/api/federation/preview')
            .field('admin_key', ADMIN_KEY)
            .attach('file', xlsxBuffer(legacy, '선수명단'), 'fed.xlsx');
        expect(res.status).toBe(200);
        expect(res.body.individualEvents.map(e => e.name).sort()).toEqual(['100m', '200m']);
    });
});

describe('결승 생성 직후 시간표 자동 연결', () => {
    it('예선 종목의 결승을 만들면 시간표 "결승" 행이 즉시 연결된다', async () => {
        const compId = await createComp('TT_FINAL_AUTOLINK_' + Date.now(), 'KTFL');

        // 남자 100m 12명 → 예선(2조) 종목 생성
        const header = ['팀명', '선수명', '성별', '생년월일', '종목1', '종목2', '바코드'];
        const rows = [];
        for (let i = 0; i < 12; i++) rows.push([`T${i % 4}`, `주자${i}`, '남', '20000101', '100m', '', '']);
        let res = await request(app).post('/api/federation/import')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).field('heat_size', '8')
            .attach('file', xlsxBuffer([header, ...rows], '선수명단'), 'fed.xlsx');
        expect(res.status).toBe(200);
        const prelim = (await getEvents(compId)).find(e => e.name === '100m' && e.gender === 'M');
        expect(prelim.round_type).toBe('preliminary');

        // 시간표: 예선 행 + 결승 행 (실업(남) 부별 표기)
        const tt = [
            ['구분', '시간', '종목', '부별', '라운드', '비고'],
            ['트랙', '10:25', '100m', '실업(남)', '2-1+6', ''],
            ['트랙', '14:50', '100m', '실업(남)', '결승', ''],
        ];
        res = await request(app).post('/api/timetable/upload')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).field('overwrite_mode', 'force')
            .attach('file', xlsxBuffer(tt, '1일차'), 'tt.xlsx');
        expect(res.status).toBe(200);

        let days = (await request(app).get(`/api/timetable/${compId}`)).body.days;
        let track = days['1'].track;
        expect(track.find(r => r.round === '2-1+6').event_id).toBe(prelim.id);
        expect(track.find(r => r.round === '결승').event_id).toBeNull();

        // 예선 기록 입력 없이도 결승 생성이 가능한지에 따라 create-final 또는 admin 종목 생성으로 결승 종목 생성
        res = await request(app).post('/api/admin/events')
            .send({ admin_key: ADMIN_KEY, competition_id: compId, name: '100m', category: 'track', gender: 'M', round_type: 'final' })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);
        const finalId = res.body.id;

        // 결승 생성 직후 — 재매칭 버튼 없이 연결되어야 함
        days = (await request(app).get(`/api/timetable/${compId}`)).body.days;
        track = days['1'].track;
        expect(track.find(r => r.round === '결승').event_id).toBe(finalId);
        // 예선 행 연결은 그대로 유지
        expect(track.find(r => r.round === '2-1+6').event_id).toBe(prelim.id);
    });
});
