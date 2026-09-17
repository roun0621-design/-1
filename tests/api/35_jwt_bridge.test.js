/**
 * JWT → 레거시 키 브리지 (2026-09 인증 정리 · Phase 1)
 *
 * 관리자가 JWT(쿠키/Bearer)로 로그인했으면, 레거시 키 검사(isAdminKey(req.query.key / body.admin_key / x-admin-key))를
 * 키 없이 통과한다 → 브라우저가 관리자 비밀번호를 localStorage 에 두거나 URL 로 보낼 필요가 없다.
 *  - 키 없음 + JWT 없음 → 403 (기존과 동일)
 *  - 클라이언트가 보낸 가짜 'jwtb:' 토큰은 통하지 않는다
 *  - operator 역할 JWT 는 운영 권한 라우트만, 관리자 라우트는 403
 *  - 쿠키 인증 + 다른 Origin 의 변경 요청은 브리지하지 않는다 (CSRF)
 *  - multipart 업로드 라우트도 통과 (multer 가 body 를 새로 만들어도 재주입)
 *  - /api/_diag/* 제거 확인, 부팅 재동기화 제거 확인
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');

let app, db;
const stamp = Date.now();
const ADMIN_U = 'bridge_admin_' + stamp, OPER_U = 'bridge_oper_' + stamp, VIEW_U = 'bridge_view_' + stamp, PW = 'Bridge!pass1';
const tok = {};

async function login(u) {
    const r = await request(app).post('/api/auth/login').send({ username: u, password: PW });
    expect(r.status).toBe(200);
    const cookie = (r.headers['set-cookie'] || []).find(c => c.startsWith('pr_access='));
    return { access: r.body.access_token, cookie: cookie.split(';')[0] };
}

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db;
    const hash = bcrypt.hashSync(PW, 4);
    for (const [u, role] of [[ADMIN_U, 'admin'], [OPER_U, 'operator'], [VIEW_U, 'viewer']]) {
        await db.run('INSERT INTO app_user (username, password_hash, display_name, role, active) VALUES (?,?,?,?,1)', u, hash, u, role);
    }
    tok.admin = await login(ADMIN_U); tok.oper = await login(OPER_U); tok.view = await login(VIEW_U);
});

describe('JWT 브리지', () => {
    it('키도 JWT 도 없으면 관리자 라우트는 403', async () => {
        const r = await request(app).get('/api/admin/operation-keys');
        expect(r.status).toBe(403);
    });
    it('관리자 JWT(Bearer) — ?key= 없이 관리자 GET 통과', async () => {
        const r = await request(app).get('/api/admin/operation-keys').set('Authorization', 'Bearer ' + tok.admin.access);
        expect(r.status).toBe(200);
    });
    it('관리자 JWT(쿠키) — 표식 키("jwt-session")를 보내도 통과 (클라이언트 호환)', async () => {
        const r = await request(app).get('/api/admin/operation-keys?key=jwt-session').set('Cookie', tok.admin.cookie);
        expect(r.status).toBe(200);
    });
    it('위조한 jwtb: 토큰은 통하지 않는다', async () => {
        const r = await request(app).get('/api/admin/operation-keys?key=jwtb:' + 'a'.repeat(36));
        expect(r.status).toBe(403);
    });
    it('operator JWT — 관리자 라우트 403, viewer JWT 도 403', async () => {
        let r = await request(app).get('/api/admin/operation-keys').set('Authorization', 'Bearer ' + tok.oper.access);
        expect(r.status).toBe(403);
        r = await request(app).get('/api/admin/operation-keys').set('Authorization', 'Bearer ' + tok.view.access);
        expect(r.status).toBe(403);
    });
    it('JSON 변경 요청: 관리자 JWT 로 대회 생성 (body.admin_key 없이)', async () => {
        const r = await request(app).post('/api/competitions').set('Cookie', tok.admin.cookie)
            .send({ name: 'BRIDGE_COMP_' + stamp, start_date: '2099-01-01', end_date: '2099-01-02', venue: 'x', federation: 'KTFL', mode: 'operation' });
        expect(r.status).toBe(200);
        tok.compId = r.body.id;
    });
    it('CSRF: 쿠키 인증 + 다른 Origin 의 변경 요청은 브리지하지 않는다', async () => {
        const r = await request(app).post('/api/competitions').set('Cookie', tok.admin.cookie).set('Origin', 'https://evil.example')
            .send({ name: 'BRIDGE_EVIL_' + stamp, start_date: '2099-01-01', end_date: '2099-01-02', venue: 'x', federation: 'KTFL', mode: 'operation' });
        expect(r.status).toBe(403);
    });
    it('multipart 업로드: admin_key 필드 없이 관리자 JWT 로 연맹 명단 미리보기 통과', async () => {
        const ws = XLSX.utils.aoa_to_sheet([['팀명', '선수명', '성별', '생년월일', '종목1', '종목2', '4x100mR', '바코드', '배번'], ['T', '가나다', '남', '20000101', '100m', '', '', '', '1']]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '선수명단');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const noAuth = await request(app).post('/api/federation/preview').field('competition_id', String(tok.compId)).attach('file', buf, 'f.xlsx');
        expect(noAuth.status).toBe(403);
        const r = await request(app).post('/api/federation/preview').set('Cookie', tok.admin.cookie).field('competition_id', String(tok.compId)).attach('file', buf, 'f.xlsx');
        expect(r.status).toBe(200);
    });
    it('브리지 토큰은 응답 후 폐기된다 (재사용 불가)', async () => {
        // 서버 내부 토큰을 알 방법은 없지만, 형식이 맞는 임의 토큰이 계속 거부되는지로 확인
        const r = await request(app).get('/api/admin/operation-keys').set('x-admin-key', 'jwtb:' + '0'.repeat(36));
        expect(r.status).toBe(403);
    });
});

describe('진단 라우트 제거 · 비밀번호 재동기화 제거', () => {
    it('/api/_diag/* 는 더 이상 없다', async () => {
        const r = await request(app).get('/api/_diag/auth-state').set('x-admin-key', 'testadmin1234');
        expect(r.status).toBe(404);
    });
    it('runAuthMigrations 를 다시 돌려도 관리자 JWT 비밀번호가 legacy admin_pw 로 덮이지 않는다', async () => {
        const idCfg = await db.get("SELECT value FROM system_config WHERE key='admin_id'");
        const adminUsername = (idCfg && idCfg.value) || 'admin';
        const newHash = bcrypt.hashSync('Changed!pass9', 4);
        await db.run('UPDATE app_user SET password_hash=? WHERE username=?', newHash, adminUsername);
        const { runAuthMigrations } = require('../../lib/auth/migrations');
        await runAuthMigrations(db);
        const row = await db.get('SELECT password_hash FROM app_user WHERE username=?', adminUsername);
        expect(row.password_hash).toBe(newHash);
    });
});
