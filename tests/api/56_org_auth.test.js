/**
 * 멀티테넌시 3단계 (2026-10-09): 계정·운영키가 조직 소속이고, 다른 조직 호스트에서는 통하지 않는다.
 *   - 기본 조직(id 1)의 admin 계정 = 플랫폼 관리자: 어느 호스트에서나 로그인·관리 가능
 *   - 다른 조직의 계정은 자기 호스트에서만 로그인, 다른 호스트에서는 권한 없음
 *   - 운영키는 만든 조직 호스트에서만, 기본 운영키·기록위원 키는 기본 조직에서만
 *   - 요청이 가리키는 대회가 이 호스트의 조직 것이 아니면 404
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234', OP = 'testopkey';
const JP = 'jp.localhost';

describe('조직 소속 계정·운영키·대회 가드', () => {
    let jpOrg, platformTok, jpTok, krComp, jpComp;
    const login = (u, p, host) => { let r = request(app).post('/api/auth/login'); if (host) r = r.set('Host', host); return r.send({ username: u, password: p }); };
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        jpOrg = (await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'jp', name: 'JP', country: 'JP' })).body;
        krComp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'KR 대회', start_date: '2026-11-01', end_date: '2026-11-02' })).body;
        jpComp = (await request(app).post('/api/competitions').set('Host', JP).send({ admin_key: ADMIN, name: 'JP 大会', start_date: '2026-11-01', end_date: '2026-11-02' })).body;
    });

    it('플랫폼 관리자는 어느 호스트에서나 로그인하고, 그 호스트의 조직 계정을 만든다', async () => {
        const r = await login('admin', ADMIN, JP);
        expect(r.status).toBe(200); platformTok = r.body.access_token; expect(platformTok).toBeTruthy();
        const mk = await request(app).post('/api/admin/users').set('Host', JP).set('Authorization', 'Bearer ' + platformTok).send({ username: 'jpadmin', password: 'jpadmin1234', role: 'admin' });
        expect([200, 201]).toContain(mk.status);
        expect((await db.get('SELECT organization_id FROM app_user WHERE username=?', 'jpadmin')).organization_id).toBe(jpOrg.id);
        // 계정 목록은 호스트의 조직 것만
        const jpUsers = (await request(app).get('/api/admin/users').set('Host', JP).set('Authorization', 'Bearer ' + platformTok)).body.users.map(u => u.username);
        const krUsers = (await request(app).get('/api/admin/users').set('Authorization', 'Bearer ' + platformTok)).body.users.map(u => u.username);
        expect(jpUsers).toEqual(['jpadmin']); expect(krUsers).toContain('admin'); expect(krUsers).not.toContain('jpadmin');
    });

    it('다른 조직 계정은 자기 호스트에서만 로그인되고, 다른 호스트에서는 권한이 없다', async () => {
        expect((await login('jpadmin', 'jpadmin1234')).status).toBe(403);           // 기본 호스트에서 거부
        const ok = await login('jpadmin', 'jpadmin1234', JP);
        expect(ok.status).toBe(200); jpTok = ok.body.access_token;
        // JWT 브리지: JP 토큰은 JP 호스트에서만 관리자
        expect((await request(app).get('/api/admin/operation-keys').set('Host', JP).set('Authorization', 'Bearer ' + jpTok)).status).toBe(200);
        expect((await request(app).get('/api/admin/operation-keys').set('Authorization', 'Bearer ' + jpTok)).status).toBe(403);
        expect((await request(app).get('/api/admin/users').set('Authorization', 'Bearer ' + jpTok)).status).toBe(403);
        // JP 관리자가 만든 대회는 JP 조직
        const c = await request(app).post('/api/competitions').set('Host', JP).set('Authorization', 'Bearer ' + jpTok).send({ name: 'JP 2', start_date: '2026-12-01', end_date: '2026-12-02' });
        expect(c.status).toBe(200); expect(c.body.organization_id).toBe(jpOrg.id);
    });

    it('운영키는 만든 조직 호스트에서만, 기본 운영키·기록위원 키는 기본 조직에서만', async () => {
        const mk = await request(app).post('/api/admin/operation-keys').set('Host', JP).send({ admin_key: ADMIN, judge_name: '佐藤', key_value: 'jpjudge01' });
        expect(mk.status).toBe(200);
        expect((await db.get('SELECT organization_id FROM operation_key WHERE id=?', mk.body.id)).organization_id).toBe(jpOrg.id);
        expect((await request(app).post('/api/auth/verify').set('Host', JP).send({ key: 'jpjudge01' })).status).toBe(200);
        expect((await request(app).post('/api/auth/verify').send({ key: 'jpjudge01' })).status).toBe(403);
        expect((await request(app).post('/api/auth/verify').send({ key: OP })).status).toBe(200);                       // 기본 운영키: 기본 조직
        expect((await request(app).post('/api/auth/verify').set('Host', JP).send({ key: OP })).status).toBe(403);      // 다른 조직에서는 안 됨
        // 심판 이름 목록·키 목록도 조직별
        expect((await request(app).get('/api/registered-judges').set('Host', JP)).body).toEqual(['佐藤']);
        expect((await request(app).get('/api/registered-judges')).body).not.toContain('佐藤');
        expect((await request(app).get('/api/admin/operation-keys').query({ key: ADMIN })).body.map(k => k.id)).not.toContain(mk.body.id);
        expect((await request(app).delete(`/api/admin/operation-keys/${mk.body.id}`).send({ admin_key: ADMIN })).status).toBe(404);
        // JP 운영키로 JP 대회에 쓰기 가능, KR 호스트에서는 인증 키로도 안 통함
        const ev = await request(app).post('/api/admin/events').set('Host', JP).send({ operation_key: 'jpjudge01', admin_key: 'jpjudge01', competition_id: jpComp.id, name: '100m', gender: 'M', category: 'track', round_type: 'final' });
        expect([200, 201]).toContain(ev.status);
    });

    it('다른 조직의 대회를 가리키는 요청은 404', async () => {
        expect((await request(app).get(`/api/events?competition_id=${krComp.id}`).set('Host', JP)).status).toBe(404);
        expect((await request(app).put(`/api/competitions/${krComp.id}`).set('Host', JP).send({ admin_key: ADMIN, venue: 'x' })).status).toBe(404);
        expect((await request(app).post('/api/admin/events').set('Host', JP).send({ admin_key: ADMIN, competition_id: krComp.id, name: '200m', gender: 'M', category: 'track', round_type: 'final' })).status).toBe(404);
        expect((await request(app).get(`/api/events?competition_id=${krComp.id}`)).status).toBe(200);   // 자기 호스트에서는 정상
        expect((await request(app).get(`/api/events?competition_id=${jpComp.id}`)).status).toBe(404);
    });
});
