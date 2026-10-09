/**
 * event.code — 종목 코드가 생성·업로드·조회 시 채워지고, 옛 종목(code NULL)은 조회 때 채워진다 (2026-09-30)
 */
const request = require('supertest');
let app, db, comp; const ADMIN = 'testadmin1234';

describe('event.code', () => {
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        comp = (await db.run("INSERT INTO competition (name, start_date, end_date, status) VALUES ('코드 테스트', '2026-11-01', '2026-11-02', 'active')")).lastInsertRowid;
    });
    it('관리자 종목 생성 → code 자동, GET /api/events 는 code·name_en 을 준다', async () => {
        const r = await request(app).post('/api/admin/events').send({ admin_key: ADMIN, competition_id: comp, name: '멀리뛰기 일반부', category: 'field_distance', gender: 'M', round_type: 'final' });
        expect(r.status).toBe(200);
        const list = (await request(app).get('/api/events').query({ competition_id: comp })).body;
        const lj = list.find(e => e.name === '멀리뛰기 일반부');
        expect(lj.code).toBe('LJ'); expect(lj.name_en).toBe('Long Jump');
    });
    it('code 없이 들어간 옛 종목은 조회 때 채워지고, 모르는 이름은 NULL 로 남는다', async () => {
        const a = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type) VALUES (?, '4X400mR(Mixed)', 'relay', 'X', 'final')", comp)).lastInsertRowid;
        const b = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type) VALUES (?, '이상한종목', 'track', 'M', 'final')", comp)).lastInsertRowid;
        const list = (await request(app).get('/api/events').query({ competition_id: comp })).body;
        expect(list.find(e => e.id === a).code).toBe('4X400X'); expect(list.find(e => e.id === a).name_en).toBe('4x400m Mixed Relay');
        expect(list.find(e => e.id === b).code).toBeNull(); expect(list.find(e => e.id === b).name_en).toBe('이상한종목');
        expect((await db.get('SELECT code FROM event WHERE id=?', a)).code).toBe('4X400X');
    });
    it('종목 xlsx 업로드로 만든 종목도 code 가 있다', async () => {
        const XLSX = require('xlsx');
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['종목명', '카테고리', '성별', '라운드'], ['110mH', '트랙', '남', '결승'], ['포환던지기', '필드(거리)', '여', '결승']]), 'Sheet1');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const up = await request(app).post('/api/events/upload').field('admin_key', ADMIN).field('competition_id', String(comp)).attach('file', buf, 'events.xlsx');
        expect(up.status).toBe(200);
        const rows = await db.all("SELECT name, code FROM event WHERE competition_id=? AND name IN ('110mH','포환던지기')", comp);
        expect(rows.map(r => r.code).sort()).toEqual(['110H', 'SP']);
    });
});
