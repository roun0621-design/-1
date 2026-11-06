/**
 * 레거시 키 로그인 보호 · 자격증명 정책 · 로그인 이력 (Phase 1 2차)
 *  - 키-only 경로는 관리자 비밀번호를 통과시키지 않는다 (관리자는 JWT 탭으로만)
 *  - 같은 IP·심판명으로 10회 실패 → 429 잠금, login_audit 에 기록
 *  - 접근 키 변경: 짧거나 흔한 값은 400 (예전엔 조용히 무시)
 *  - 약한 비밀번호 로그인 → weak_password 플래그, 비밀번호 변경 최소 8자
 *  - /api/admin/login-audit 는 관리자 JWT 전용
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');

let app, db;
const ADMIN_KEY = 'testadmin1234', OP_KEY = 'testopkey';
const stamp = Date.now();

beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; });

describe('레거시 키 로그인', () => {
    it('키-only: 운영키는 통과, 관리자 비밀번호는 거부', async () => {
        let r = await request(app).post('/api/auth/verify').send({ key: OP_KEY });
        expect(r.status).toBe(200);
        expect(r.body.role).toBe('operation');
        r = await request(app).post('/api/auth/verify').send({ key: ADMIN_KEY });
        expect(r.status).toBe(403);
        const a = await db.get("SELECT * FROM login_audit WHERE failure_reason='legacy_admin_pw_rejected' ORDER BY id DESC LIMIT 1");
        expect(a).toBeTruthy();
    });
    it('같은 심판명으로 10회 실패하면 잠기고(429) 감사로그가 남는다', async () => {
        const name = 'guard_judge_' + stamp;
        for (let i = 0; i < 10; i++) {
            const r = await request(app).post('/api/auth/verify').send({ judge_name: name, key: 'wrong-' + i });
            expect(r.status).toBe(403);
        }
        const locked = await request(app).post('/api/auth/verify').send({ judge_name: name, key: 'wrong-x' });
        expect(locked.status).toBe(429);
        const n = await db.get('SELECT COUNT(*) c FROM login_audit WHERE username=? AND success=0', name);
        expect(n.c).toBeGreaterThanOrEqual(11);
        // 다른 심판명은 영향 없음
        const other = await request(app).post('/api/auth/verify').send({ judge_name: 'other_' + stamp, key: 'nope' });
        expect(other.status).toBe(403);
    });
});

describe('접근 키 정책', () => {
    it('짧거나 흔한 값은 400 — 아무것도 바뀌지 않는다', async () => {
        for (const body of [{ new_operation_key: '1234' }, { new_operation_key: 'abc12' }, { new_admin_key: 'short7!' }, { new_admin_key: 'password' }, { new_record_officer_key: '123' }]) {
            const r = await request(app).post('/api/admin/change-keys').send({ admin_key: ADMIN_KEY, ...body });
            expect(r.status, JSON.stringify(body)).toBe(400);
        }
        // 기존 키는 그대로 유효
        const ok = await request(app).post('/api/admin/verify').send({ admin_key: OP_KEY });
        expect(ok.status).toBe(200);
    });
    it('관리자 보안 상태 API — 관리자만', async () => {
        let r = await request(app).get('/api/admin/security-status');
        expect(r.status).toBe(403);
        r = await request(app).get('/api/admin/security-status').set('x-admin-key', ADMIN_KEY);
        expect(r.status).toBe(200);
        expect(Array.isArray(r.body.warnings)).toBe(true);
    });
});

describe('JWT 계정 정책 · 로그인 이력', () => {
    const U = 'weakpw_' + stamp, A = 'audit_admin_' + stamp;
    let adminTok;
    beforeAll(async () => {
        await db.run('INSERT INTO app_user (username, password_hash, display_name, role, active) VALUES (?,?,?,?,1)', U, bcrypt.hashSync('abc123', 4), U, 'operator');
        await db.run('INSERT INTO app_user (username, password_hash, display_name, role, active) VALUES (?,?,?,?,1)', A, bcrypt.hashSync('Strong!pass99', 4), A, 'admin');
        const r = await request(app).post('/api/auth/login').send({ username: A, password: 'Strong!pass99' });
        adminTok = r.body.access_token;
        expect(r.body.weak_password).toBe(false);
    });
    it('약한 비밀번호 로그인은 weak_password=true, 변경은 8자 이상·흔한 값 금지', async () => {
        const r = await request(app).post('/api/auth/login').send({ username: U, password: 'abc123' });
        expect(r.status).toBe(200);
        expect(r.body.weak_password).toBe(true);
        let c = await request(app).post('/api/auth/change-password').set('Authorization', 'Bearer ' + r.body.access_token).send({ current: 'abc123', next: 'seven77' });
        expect(c.status).toBe(400);
        c = await request(app).post('/api/auth/change-password').set('Authorization', 'Bearer ' + r.body.access_token).send({ current: 'abc123', next: '12345678' });
        expect(c.status).toBe(400);
        c = await request(app).post('/api/auth/change-password').set('Authorization', 'Bearer ' + r.body.access_token).send({ current: 'abc123', next: 'Better#pass8' });
        expect(c.status).toBe(200);
    });
    it('로그인 이력은 관리자 JWT 로만 조회', async () => {
        let r = await request(app).get('/api/admin/login-audit');
        expect(r.status).toBe(401);
        r = await request(app).get('/api/admin/login-audit?only=fail&limit=50').set('Authorization', 'Bearer ' + adminTok);
        expect(r.status).toBe(200);
        expect(r.body.rows.length).toBeGreaterThan(0);
        expect(r.body.rows.every(x => x.success === 0)).toBe(true);
    });
});
