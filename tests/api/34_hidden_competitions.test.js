/**
 * 대회 숨기기 / 연맹 숨기기 — 홈·운영 화면 목록에서 제외, 관리자 페이지(include_hidden)에서는 표시
 *
 * 고정하는 규칙:
 *  - competition.home_visibility='hidden' 또는 소속 연맹 federation_list.hidden=1 이면
 *    GET /api/competitions, /recent(active·all), /by-federation 에서 빠진다
 *  - ?include_hidden=1 이면 전부 반환 (관리자 페이지·이름 조회용)
 *  - PUT /api/competitions/:id/home-visibility, PUT /api/federations/:id/hidden 은 관리자 키 전용
 *  - 직접 조회 GET /api/competitions/:id 는 숨겨도 열린다
 */
const request = require('supertest');

let app, db;
const ADMIN_KEY = 'testadmin1234';
const OP_KEY = 'testopkey';
const stamp = Date.now();
const FED_A = 'HIDA' + String(stamp).slice(-4);
const FED_B = 'HIDB' + String(stamp).slice(-4);
const fx = {};

async function mkComp(name, federation, home_visibility = 'auto', status = 'active') {
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, federation, home_visibility) VALUES (?,?,?,?,?,?,?)",
        name + '_' + stamp, '2026-01-01', '2099-12-31', '장', status, federation, home_visibility);
    return r.lastInsertRowid;
}
const ids = (rows) => (Array.isArray(rows) ? rows : rows.items).map(c => c.id);

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db;
    let r = await request(app).post('/api/federations').send({ admin_key: ADMIN_KEY, code: FED_A, name: '숨김연맹' }).set('Content-Type', 'application/json');
    expect(r.status).toBe(200); fx.fedA = r.body.id;
    r = await request(app).post('/api/federations').send({ admin_key: ADMIN_KEY, code: FED_B, name: '표시연맹' }).set('Content-Type', 'application/json');
    expect(r.status).toBe(200); fx.fedB = r.body.id;
    fx.a1 = await mkComp('A연맹대회1', FED_A);
    fx.a2 = await mkComp('A연맹대회2', FED_A);
    fx.b1 = await mkComp('B연맹대회', FED_B);
    fx.bHidden = await mkComp('B연맹숨김대회', FED_B, 'hidden');
    fx.noFed = await mkComp('무연맹대회', '');
});

describe('대회 단위 숨김 (home_visibility=hidden)', () => {
    it('기본 목록·recent·by-federation 에서 빠지고 include_hidden=1 이면 보인다', async () => {
        const list = ids((await request(app).get('/api/competitions')).body);
        expect(list).toContain(fx.b1); expect(list).toContain(fx.noFed); expect(list).not.toContain(fx.bHidden);
        const all = ids((await request(app).get('/api/competitions?include_hidden=1')).body);
        expect(all).toContain(fx.bHidden);
        const recentActive = ids((await request(app).get('/api/competitions/recent?window=active')).body);
        expect(recentActive).toContain(fx.b1); expect(recentActive).not.toContain(fx.bHidden);
        const recentAll = ids((await request(app).get('/api/competitions/recent?window=all')).body);
        expect(recentAll).toContain(fx.b1); expect(recentAll).not.toContain(fx.bHidden);   // 전체 펼침에서도 숨김
        const byFed = ids((await request(app).get(`/api/competitions/by-federation/${FED_B}`)).body);
        expect(byFed).toEqual([fx.b1]);
        const byFedAll = ids((await request(app).get(`/api/competitions/by-federation/${FED_B}?include_hidden=1`)).body);
        expect(byFedAll.sort()).toEqual([fx.b1, fx.bHidden].sort());
        // 직접 조회는 열린다
        expect((await request(app).get(`/api/competitions/${fx.bHidden}`)).status).toBe(200);
    });
    it('PUT /home-visibility 로 숨김·해제, 관리자 키 전용, 잘못된 값 400', async () => {
        const noKey = await request(app).put(`/api/competitions/${fx.b1}/home-visibility`).send({ home_visibility: 'hidden' }).set('Content-Type', 'application/json');
        expect(noKey.status).toBe(403);
        const opKey = await request(app).put(`/api/competitions/${fx.b1}/home-visibility`).send({ admin_key: OP_KEY, home_visibility: 'hidden' }).set('Content-Type', 'application/json');
        expect(opKey.status).toBe(403);
        const bad = await request(app).put(`/api/competitions/${fx.b1}/home-visibility`).send({ admin_key: ADMIN_KEY, home_visibility: 'nope' }).set('Content-Type', 'application/json');
        expect(bad.status).toBe(400);
        const hide = await request(app).put(`/api/competitions/${fx.b1}/home-visibility`).send({ admin_key: ADMIN_KEY, home_visibility: 'hidden' }).set('Content-Type', 'application/json');
        expect(hide.status).toBe(200); expect(hide.body.home_visibility).toBe('hidden');
        expect(ids((await request(app).get('/api/competitions')).body)).not.toContain(fx.b1);
        const log = await db.get("SELECT message FROM operation_log WHERE message LIKE '대회 숨김:%' ORDER BY id DESC LIMIT 1");
        expect(log.message).toContain('B연맹대회');
        const show = await request(app).put(`/api/competitions/${fx.b1}/home-visibility`).send({ admin_key: ADMIN_KEY, home_visibility: 'auto' }).set('Content-Type', 'application/json');
        expect(show.status).toBe(200);
        expect(ids((await request(app).get('/api/competitions')).body)).toContain(fx.b1);
        expect((await request(app).put('/api/competitions/999999/home-visibility').send({ admin_key: ADMIN_KEY, home_visibility: 'hidden' }).set('Content-Type', 'application/json')).status).toBe(404);
    });
});

describe('연맹 단위 숨김 (federation_list.hidden)', () => {
    it('연맹을 숨기면 소속 대회 전체가 목록·recent 에서 빠지고, 관리자 목록·GET /api/federations 에는 남는다', async () => {
        const noKey = await request(app).put(`/api/federations/${fx.fedA}/hidden`).send({ hidden: 1 }).set('Content-Type', 'application/json');
        expect(noKey.status).toBe(403);
        const res = await request(app).put(`/api/federations/${fx.fedA}/hidden`).send({ admin_key: ADMIN_KEY, hidden: 1 }).set('Content-Type', 'application/json');
        expect(res.status).toBe(200); expect(res.body.hidden).toBe(1);
        const feds = (await request(app).get('/api/federations')).body;
        expect(feds.find(f => f.id === fx.fedA).hidden).toBe(1);
        const list = ids((await request(app).get('/api/competitions')).body);
        expect(list).not.toContain(fx.a1); expect(list).not.toContain(fx.a2); expect(list).toContain(fx.b1); expect(list).toContain(fx.noFed);
        const recentAll = ids((await request(app).get('/api/competitions/recent?window=all')).body);
        expect(recentAll).not.toContain(fx.a1);
        const recentActive = ids((await request(app).get('/api/competitions/recent?window=active')).body);
        expect(recentActive).not.toContain(fx.a1); expect(recentActive).toContain(fx.b1);
        expect(ids((await request(app).get(`/api/competitions/by-federation/${FED_A}`)).body)).toEqual([]);
        const all = ids((await request(app).get('/api/competitions?include_hidden=1')).body);
        expect(all).toContain(fx.a1); expect(all).toContain(fx.a2);
        // pinned 대회라도 연맹이 숨김이면 안 보인다
        await db.run("UPDATE competition SET home_visibility='pinned' WHERE id=?", fx.a1);
        expect(ids((await request(app).get('/api/competitions/recent?window=active')).body)).not.toContain(fx.a1);
        await db.run("UPDATE competition SET home_visibility='auto' WHERE id=?", fx.a1);
        const log = await db.get("SELECT message FROM operation_log WHERE message LIKE '연맹 숨김:%' ORDER BY id DESC LIMIT 1");
        expect(log.message).toContain(FED_A);
    });
    it('해제하면 다시 보이고, PUT /api/federations/:id 의 hidden 필드로도 바꿀 수 있다', async () => {
        let res = await request(app).put(`/api/federations/${fx.fedA}/hidden`).send({ admin_key: ADMIN_KEY, hidden: 0 }).set('Content-Type', 'application/json');
        expect(res.status).toBe(200); expect(res.body.hidden).toBe(0);
        expect(ids((await request(app).get('/api/competitions')).body)).toContain(fx.a1);
        res = await request(app).put(`/api/federations/${fx.fedA}`).send({ admin_key: ADMIN_KEY, hidden: true }).set('Content-Type', 'application/json');
        expect(res.status).toBe(200);
        expect((await db.get('SELECT hidden FROM federation_list WHERE id=?', fx.fedA)).hidden).toBe(1);
        // hidden 을 안 보내면 기존 값 유지
        res = await request(app).put(`/api/federations/${fx.fedA}`).send({ admin_key: ADMIN_KEY, name: '숨김연맹2' }).set('Content-Type', 'application/json');
        expect(res.status).toBe(200);
        expect((await db.get('SELECT hidden, name FROM federation_list WHERE id=?', fx.fedA))).toMatchObject({ hidden: 1, name: '숨김연맹2' });
        await request(app).put(`/api/federations/${fx.fedA}/hidden`).send({ admin_key: ADMIN_KEY, hidden: 0 }).set('Content-Type', 'application/json');
        expect(ids((await request(app).get('/api/competitions')).body)).toContain(fx.a2);
    });
});
