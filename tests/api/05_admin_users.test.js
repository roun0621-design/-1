/**
 * Admin Users Management API — 회귀 테스트 (B-5)
 *
 * 보호하는 것:
 *  - lib/routes/admin_users.js
 *      GET    /api/admin/users
 *      GET    /api/admin/users/:id
 *      POST   /api/admin/users
 *      PUT    /api/admin/users/:id
 *      DELETE /api/admin/users/:id
 *      POST   /api/admin/users/:id/revoke-sessions
 *
 * 정책 보장:
 *  - JWT 미인증 → 401
 *  - admin 외 → 403 (※ 본 테스트는 admin JWT 사용 — 403 검증은 별도 사용자가 필요해서 생략)
 *  - 자기 자신 role/active 변경 → 400
 *  - 자기 자신 삭제 → 400
 *  - 비활성 계정 로그인 → 403
 *  - 잘못된 username/role → 400 / 409
 */
const request = require('supertest');

let app;
let adminToken;

beforeAll(async () => {
    // server.js require → 마이그레이션 실행되며 app_user('admin') 시드됨 (ADMIN_PW='testadmin1234' 의 hash)
    app = require('../../server.js').app;

    // global-setup.js 가 process.env.ADMIN_ID='admin', ADMIN_PW='testadmin1234' 로 세팅함.
    // 마이그레이션이 system_config.admin_pw 의 hash 를 app_user.password_hash 로 sync.
    const username = process.env.ADMIN_ID || 'admin';
    const password = process.env.ADMIN_PW || 'testadmin1234';

    const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ username, password });
    if (res.status !== 200 || !res.body.access_token) {
        throw new Error('admin 로그인 실패 (status=' + res.status + ', body=' + JSON.stringify(res.body) + ')');
    }
    adminToken = res.body.access_token;
});

describe('Admin Users Management API — 회귀 (B-5)', () => {

    it('GET /api/admin/users — JWT 없으면 401', async () => {
        const res = await request(app).get('/api/admin/users');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/users — admin JWT 로 목록 조회 OK', async () => {
        expect(adminToken).toBeTruthy();
        const res = await request(app)
            .get('/api/admin/users')
            .set('Authorization', 'Bearer ' + adminToken);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.users)).toBe(true);
        expect(res.body.users.length).toBeGreaterThanOrEqual(1);
    });

    it('POST /api/admin/users — 잘못된 username (특수문자) → 400', async () => {
        const res = await request(app)
            .post('/api/admin/users')
            .set('Authorization', 'Bearer ' + adminToken)
            .set('Content-Type', 'application/json')
            .send({ username: 'bad name!!', password: 'pw123456', role: 'viewer' });
        expect(res.status).toBe(400);
    });

    it('POST /api/admin/users — 짧은 비밀번호 → 400', async () => {
        const res = await request(app)
            .post('/api/admin/users')
            .set('Authorization', 'Bearer ' + adminToken)
            .set('Content-Type', 'application/json')
            .send({ username: 'okuser_short', password: 'abc', role: 'viewer' });
        expect(res.status).toBe(400);
    });

    it('POST → GET → PUT → DELETE 사이클', async () => {
        const uname = '_reg_user_' + Date.now();
        // CREATE
        const created = await request(app)
            .post('/api/admin/users')
            .set('Authorization', 'Bearer ' + adminToken)
            .set('Content-Type', 'application/json')
            .send({
                username: uname,
                password: 'tempPass1',
                display_name: 'Regression User',
                role: 'operator'
            });
        expect(created.status).toBe(201);
        expect(created.body.user.username).toBe(uname);
        expect(created.body.user.role).toBe('operator');
        const id = created.body.user.id;

        // GET single
        const got = await request(app)
            .get('/api/admin/users/' + id)
            .set('Authorization', 'Bearer ' + adminToken);
        expect(got.status).toBe(200);
        expect(got.body.user.id).toBe(id);

        // DUPLICATE create → 409
        const dup = await request(app)
            .post('/api/admin/users')
            .set('Authorization', 'Bearer ' + adminToken)
            .set('Content-Type', 'application/json')
            .send({ username: uname, password: 'tempPass2', role: 'viewer' });
        expect(dup.status).toBe(409);

        // PUT — role 변경
        const upd = await request(app)
            .put('/api/admin/users/' + id)
            .set('Authorization', 'Bearer ' + adminToken)
            .set('Content-Type', 'application/json')
            .send({ role: 'record_officer', display_name: 'Updated Name' });
        expect(upd.status).toBe(200);
        expect(upd.body.user.role).toBe('record_officer');
        expect(upd.body.user.display_name).toBe('Updated Name');

        // DELETE (soft)
        const del = await request(app)
            .delete('/api/admin/users/' + id)
            .set('Authorization', 'Bearer ' + adminToken);
        expect(del.status).toBe(200);
        expect(del.body.ok).toBe(true);

        // GET 다시 → active=0
        const got2 = await request(app)
            .get('/api/admin/users/' + id)
            .set('Authorization', 'Bearer ' + adminToken);
        expect(got2.status).toBe(200);
        expect(got2.body.user.active).toBe(0);

        // 비활성 계정 로그인 시도 → 403
        const loginInactive = await request(app)
            .post('/api/auth/login')
            .set('Content-Type', 'application/json')
            .send({ username: uname, password: 'tempPass1' });
        expect(loginInactive.status).toBe(403);

        // cleanup — 테스트 row 완전 제거
        try {
            const Database = require('better-sqlite3');
            const path = require('path');
            const dbPath = process.env.DB_PATH || path.join(__dirname, '../../db/competition.db');
            const sqdb = new Database(dbPath);
            sqdb.prepare('DELETE FROM app_user WHERE id=?').run(id);
            sqdb.close();
        } catch(_) {}
    });

    it('PUT 자기 자신 role 변경 → 400', async () => {
        // 먼저 본인 id 알아내기
        const me = await request(app).get('/api/auth/me')
            .set('Authorization', 'Bearer ' + adminToken);
        expect(me.status).toBe(200);
        const myId = me.body.user.id;

        const res = await request(app)
            .put('/api/admin/users/' + myId)
            .set('Authorization', 'Bearer ' + adminToken)
            .set('Content-Type', 'application/json')
            .send({ role: 'viewer' });
        expect(res.status).toBe(400);
    });

    it('DELETE 자기 자신 → 400', async () => {
        const me = await request(app).get('/api/auth/me')
            .set('Authorization', 'Bearer ' + adminToken);
        const myId = me.body.user.id;
        const res = await request(app)
            .delete('/api/admin/users/' + myId)
            .set('Authorization', 'Bearer ' + adminToken);
        expect(res.status).toBe(400);
    });

    it('GET /api/admin/users/:id — 존재하지 않는 id → 404', async () => {
        const res = await request(app)
            .get('/api/admin/users/9999999')
            .set('Authorization', 'Bearer ' + adminToken);
        expect(res.status).toBe(404);
    });
});
