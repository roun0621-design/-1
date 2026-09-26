/**
 * 조편성 업로드 — 부(division)별 종목 분리 + 종목 자동생성 + 스코어보드 키 자동생성
 *
 * 회귀 방지:
 *  - 같은 종목이라도 부(중등/고등/대학/일반)가 다르면 별도 종목으로 분리 생성되어야 함
 *    (기존 버그: 부를 무시해 1500m 4개 부 121명이 한 종목으로 뭉개짐)
 *  - 조편성 업로드 한 파일로 종목+선수+조편성이 한번에 생성되어야 함(종목 자동생성)
 *  - 종목(조)이 생성되면 scoreboard_key 가 자동 생성되어야 함(연맹 라벨 없어도 폴백)
 *
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 를 주입하므로 운영 DB 무관.
 */
const request = require('supertest');
const XLSX = require('xlsx');

let app;
const ADMIN_KEY = 'testadmin1234'; // global-setup 의 ADMIN_PW 와 일치

beforeAll(async () => {
    app = require('../../server.js').app;
});

// 참가명단 시트(헤더 포함) → xlsx 버퍼
function buildRosterBuffer(rows, { withDivision = true } = {}) {
    const header = withDivision
        ? ['일차', '종목', '라운드', '조', '레인', '배번', '성명', '소속', '부', '성별']
        : ['일차', '종목', '라운드', '조', '레인', '배번', '성명', '소속', '성별'];
    const aoa = [header, ...rows.map(r => withDivision
        ? [5, r.event, r.round, r.heat, r.lane, r.bib, r.name, r.team, r.division, r.gender]
        : [5, r.event, r.round, r.heat, r.lane, r.bib, r.name, r.team, r.gender])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '참가명단');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function createCompetition(name) {
    const res = await request(app).post('/api/competitions')
        .send({ admin_key: ADMIN_KEY, name, start_date: '2026-06-01', end_date: '2026-06-05', venue: '' })
        .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    return res.body.id;
}

function apply(compId, buffer) {
    return request(app).post('/api/heat-assignment/apply')
        .field('admin_key', ADMIN_KEY)
        .field('competition_id', String(compId))
        .attach('file', buffer, 'roster.xlsx');
}
function preview(compId, buffer) {
    return request(app).post('/api/heat-assignment/preview')
        .field('admin_key', ADMIN_KEY)
        .field('competition_id', String(compId))
        .attach('file', buffer, 'roster.xlsx');
}
async function getEvents(compId) {
    const res = await request(app).get(`/api/events?competition_id=${compId}`);
    expect(res.status).toBe(200);
    return res.body;
}
async function getHeats(eventId) {
    const res = await request(app).get(`/api/heats?event_id=${eventId}`);
    expect(res.status).toBe(200);
    return res.body;
}
async function getEntryCount(eventId) {
    const res = await request(app).get(`/api/events/${eventId}/entries`);
    expect(res.status).toBe(200);
    return res.body.length;
}

describe('조편성 업로드 — 부(division) 분리 + 자동생성', () => {

    it('같은 1500m 라도 부가 다르면 4개 종목으로 분리 생성된다 (121명 붕괴 회귀 방지)', async () => {
        const compId = await createCompetition('DIV_SPLIT_' + Date.now());
        const rows = [];
        const make = (division, n) => {
            for (let i = 0; i < n; i++) rows.push({
                event: '1500m', round: '결승', heat: 1, lane: i + 1,
                bib: '', name: `${division}선수${i}`, team: `${division}팀`, division, gender: '남',
            });
        };
        make('중등부', 3); make('고등부', 4); make('대학부', 2); make('일반부', 5);

        const res = await apply(compId, buildRosterBuffer(rows));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.stats.eventsCreated).toBe(4);

        const events = await getEvents(compId);
        const names = events.map(e => e.name).sort();
        expect(names).toEqual(['1500m 고등부', '1500m 대학부', '1500m 일반부', '1500m 중등부']);

        // division 컬럼도 채워지고, 부별 인원 보존
        const byName = Object.fromEntries(events.map(e => [e.name, e]));
        expect(byName['1500m 일반부'].division).toBe('일반부');
        expect(byName['1500m 일반부'].gender).toBe('M');
        expect(await getEntryCount(byName['1500m 일반부'].id)).toBe(5);
        expect(await getEntryCount(byName['1500m 중등부'].id)).toBe(3);
        expect(await getEntryCount(byName['1500m 고등부'].id)).toBe(4);
        expect(await getEntryCount(byName['1500m 대학부'].id)).toBe(2);
    });

    it('연맹 라벨이 없어도 scoreboard_key 가 자동 생성된다 (null 폴백 수정)', async () => {
        const compId = await createCompetition('SBKEY_' + Date.now());
        const rows = [
            { event: '1500m', round: '결승', heat: 1, lane: 1, bib: '', name: '가', team: 'A', division: '일반부', gender: '남' },
            { event: '1500m', round: '결승', heat: 1, lane: 2, bib: '', name: '나', team: 'B', division: '일반부', gender: '남' },
        ];
        const res = await apply(compId, buildRosterBuffer(rows));
        expect(res.status).toBe(200);

        const ev = (await getEvents(compId)).find(e => e.name === '1500m 일반부');
        expect(ev).toBeTruthy();
        const heats = await getHeats(ev.id);
        expect(heats.length).toBeGreaterThan(0);
        // 키가 null/빈값이 아니어야 하고, 부가 종목명에 포함됐으므로 키에도 들어감
        expect(heats[0].scoreboard_key).toBeTruthy();
        expect(heats[0].scoreboard_key).toContain('1500m 일반부');
        expect(heats[0].scoreboard_key).toContain('남자');
    });

    it('카테고리 추론: 4X400mR→relay, 멀리뛰기→field_distance', async () => {
        const compId = await createCompetition('CAT_' + Date.now());
        const rows = [
            { event: '4x400mR', round: '결승', heat: 1, lane: 1, bib: '', name: 'A팀', team: 'A팀', division: '일반부', gender: '남' },
            { event: '멀리뛰기', round: '결승', heat: 1, lane: 1, bib: '', name: '점프', team: 'J', division: '고등부', gender: '남' },
        ];
        const res = await apply(compId, buildRosterBuffer(rows));
        expect(res.status).toBe(200);
        const events = await getEvents(compId);
        const relay = events.find(e => e.name.startsWith('4X400mR'));
        const jump = events.find(e => e.name.startsWith('멀리뛰기'));
        expect(relay && relay.category).toBe('relay');
        expect(jump && jump.category).toBe('field_distance');
    });

    it('preview 는 자동생성될 종목을 will_create 로 표시한다', async () => {
        const compId = await createCompetition('PREVIEW_' + Date.now());
        const rows = [
            { event: '1500m', round: '결승', heat: 1, lane: 1, bib: '', name: '가', team: 'A', division: '일반부', gender: '남' },
        ];
        const res = await preview(compId, buildRosterBuffer(rows));
        expect(res.status).toBe(200);
        const item = res.body.preview.find(p => p.willCreate);
        expect(item).toBeTruthy();
        expect(item.status).toBe('will_create');
        expect(item.willCreate.name).toBe('1500m 일반부');
        expect(item.willCreate.division).toBe('일반부');
    });

    it('동일 파일 재업로드는 멱등 — 종목 추가 생성 0, 변경없음 스킵', async () => {
        const compId = await createCompetition('IDEMP_' + Date.now());
        const rows = [
            { event: '1500m', round: '결승', heat: 1, lane: 1, bib: '', name: '가', team: 'A', division: '일반부', gender: '남' },
            { event: '1500m', round: '결승', heat: 1, lane: 2, bib: '', name: '나', team: 'B', division: '일반부', gender: '남' },
        ];
        const buf = buildRosterBuffer(rows);
        const first = await apply(compId, buf);
        expect(first.body.stats.eventsCreated).toBe(1);

        const second = await apply(compId, buf);
        expect(second.status).toBe(200);
        expect(second.body.stats.eventsCreated).toBe(0);
        expect(second.body.stats.skippedUnchanged).toBeGreaterThanOrEqual(1);

        // 종목이 중복 생성되지 않음
        const events = (await getEvents(compId)).filter(e => e.name === '1500m 일반부');
        expect(events.length).toBe(1);
    });

    it('시간표 자동연결 종목(이름=기본명 + division 컬럼)을 재사용하고 중복 생성하지 않는다', async () => {
        const compId = await createCompetition('REUSE_' + Date.now());
        // 시간표 컨벤션으로 미리 생성: name="1500m", division="일반부"
        const create = await request(app).post('/api/admin/events')
            .send({ admin_key: ADMIN_KEY, competition_id: compId, name: '1500m', category: 'track', gender: 'M', round_type: 'final', division: '일반부' })
            .set('Content-Type', 'application/json');
        expect(create.status).toBe(200);
        expect(create.body.division).toBe('일반부');

        const rows = [
            { event: '1500m', round: '결승', heat: 1, lane: 1, bib: '', name: '가', team: 'A', division: '일반부', gender: '남' },
        ];
        const res = await apply(compId, buildRosterBuffer(rows));
        expect(res.status).toBe(200);
        expect(res.body.stats.eventsCreated).toBe(0); // 재사용 → 생성 안 함

        const events = (await getEvents(compId)).filter(e => e.gender === 'M' && (e.name === '1500m' || e.name === '1500m 일반부'));
        // 기존 1500m(일반부) 1개만 존재해야 함 (중복 생성 금지)
        expect(events.length).toBe(1);
    });

    it('하위호환: 부 열이 없는 파일은 기존처럼 단일 종목으로 처리된다', async () => {
        const compId = await createCompetition('NODIV_' + Date.now());
        const rows = [
            { event: '800m', round: '결승', heat: 1, lane: 1, bib: '', name: '가', team: 'A', gender: '남' },
            { event: '800m', round: '결승', heat: 1, lane: 2, bib: '', name: '나', team: 'B', gender: '남' },
        ];
        const res = await apply(compId, buildRosterBuffer(rows, { withDivision: false }));
        expect(res.status).toBe(200);
        const events = (await getEvents(compId)).filter(e => e.name.startsWith('800m'));
        expect(events.length).toBe(1);
        expect(events[0].name).toBe('800m'); // 부 접미사 없음
    });
});
