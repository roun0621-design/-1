/**
 * 연맹 명단 업로드(/api/federation/import) — scoreboard_key 자동생성 회귀
 *
 * 버그: 연맹 import 의 조(heat) 생성 경로들이 scoreboard_key 를 설정하지 않아
 *       업로드 후 모든 조의 키가 비어 전광판 매칭이 안 됨.
 * 수정: import 트랜잭션 끝에 키 없는 조를 generateScoreboardKey 로 일괄 백필.
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

// 연맹 명단 형식: 소속명/성명/성별/생년월일/종목1/종목2/...릴레이.../바코드
function buildFedBuffer(athletes) {
    const header = ['소속명', '성명', '성별', '생년월일', '종목1', '종목2', '4x100mR', '바코드'];
    const aoa = [header, ...athletes.map((a, i) => [
        a.team, a.name, a.gender, '20000101', a.ev1 || '', a.ev2 || '', a.relay ? 'o' : '', `PR-${100 + i}`,
    ])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '선수명단');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function createComp(name, federation) {
    const res = await request(app).post('/api/competitions')
        .send({ admin_key: ADMIN_KEY, name, start_date: '2026-05-28', end_date: '2026-05-30', venue: '', federation })
        .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    return res.body.id;
}
async function getEvents(compId) {
    return (await request(app).get(`/api/events?competition_id=${compId}`)).body;
}
async function getHeats(eventId) {
    return (await request(app).get(`/api/heats?event_id=${eventId}`)).body;
}

describe('연맹 명단 업로드 — scoreboard_key 자동생성', () => {

    it('업로드된 모든 조에 scoreboard_key 가 생성된다 (KTFL→실업부 라벨)', async () => {
        const compId = await createComp('FED_SBKEY_' + Date.now(), 'KTFL');
        const athletes = [];
        // 100m 남 12명(여러 조), 멀리뛰기 남 3명, 4x100mR 릴레이
        for (let i = 0; i < 12; i++) athletes.push({ team: `T${i % 3}`, name: `주자${i}`, gender: '남자', ev1: '100m', relay: true });
        for (let i = 0; i < 3; i++) athletes.push({ team: `J${i}`, name: `점퍼${i}`, gender: '남자', ev1: '멀리뛰기' });

        const res = await request(app).post('/api/federation/import')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId))
            .attach('file', buildFedBuffer(athletes), 'fed.xlsx');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const events = await getEvents(compId);
        expect(events.length).toBeGreaterThan(0);

        let totalHeats = 0, keyless = 0;
        for (const e of events) {
            const heats = await getHeats(e.id);
            for (const h of heats) {
                totalHeats++;
                if (!h.scoreboard_key) keyless++;
            }
        }
        expect(totalHeats).toBeGreaterThan(0);
        expect(keyless).toBe(0); // 모든 조에 키 존재 (회귀 방지)

        // 100m 종목 키 형식 확인: "남자실업부 100m ..."
        const e100 = events.find(e => e.name === '100m' && e.gender === 'M');
        const heats100 = await getHeats(e100.id);
        expect(heats100[0].scoreboard_key).toContain('실업부');
        expect(heats100[0].scoreboard_key).toContain('100m');
    });

    it('연맹 라벨이 없어도(federation 미설정) 기본 라벨로 키가 생성된다', async () => {
        const compId = await createComp('FED_NOLABEL_' + Date.now(), '');
        const athletes = [{ team: 'A', name: '가', gender: '남자', ev1: '200m' }, { team: 'B', name: '나', gender: '남자', ev1: '200m' }];
        const res = await request(app).post('/api/federation/import')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId))
            .attach('file', buildFedBuffer(athletes), 'fed.xlsx');
        expect(res.status).toBe(200);

        const ev = (await getEvents(compId)).find(e => e.name === '200m' && e.gender === 'M');
        const heats = await getHeats(ev.id);
        expect(heats[0].scoreboard_key).toBeTruthy();
        expect(heats[0].scoreboard_key).toContain('남자'); // 기본 성별 라벨 폴백
    });
});
