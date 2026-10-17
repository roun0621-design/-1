/**
 * /api/health 강화 회귀 테스트
 *
 * health 는 모니터링·배포 헬스체크·롤백 판단의 기준점이므로,
 * 실제 DB 연결 확인(SELECT 1)과 응답 스키마를 보장한다.
 */
const request = require('supertest');

let app;

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
});

describe('GET /api/health — 강화된 헬스체크', () => {
    it('DB 가 살아있을 때 200 + ok:true + db:"up" 를 반환해야 한다', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.db).toBe('up'); // 실제 SELECT 1 통과
    });

    it('운영 진단 필드를 포함해야 한다 (backend/uptime/node/memory/ts)', async () => {
        const res = await request(app).get('/api/health');
        expect(['sqlite', 'postgres']).toContain(res.body.backend);
        expect(typeof res.body.uptime_sec).toBe('number');
        expect(res.body.node).toMatch(/^v\d+/);          // 예: v20.20.0
        expect(typeof res.body.rss_mb).toBe('number');    // 메모리 사용량(MB)
        expect(typeof res.body.heap_used_mb).toBe('number');
        expect(res.body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    });

    it('테스트 환경의 백엔드는 설정(TEST_DB_BACKEND)과 같다 — 운영 DB 가 아니다', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.backend).toBe((process.env.TEST_DB_BACKEND || 'sqlite').toLowerCase());
    });
});

describe('보안 헤더 (CSP, 2026-09)', () => {
    it('CSP 가 켜져 있고 프레임 감싸기·object·base 를 막는다, 쓰는 외부 출처는 허용', async () => {
        const request = require('supertest');
        const { app } = require('../../server.js');
        const r = await request(app).get('/api/health');
        const csp = r.headers['content-security-policy'];
        expect(csp).toBeTruthy();
        expect(csp).toContain("frame-ancestors 'self'"); expect(csp).toContain("object-src 'none'"); expect(csp).toContain("base-uri 'self'");
        expect(csp).toContain('https://www.gstatic.com'); expect(csp).toContain('https://www.youtube.com'); expect(csp).toContain('https://fonts.gstatic.com');
        expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
    });
});

describe('GET 키는 헤더로 (URL 쿼리 없이)', () => {
    it('x-admin-key 헤더만으로 관리자 GET 이 통과하고, 없으면 403', async () => {
        const request = require('supertest');
        const { app } = require('../../server.js');
        expect((await request(app).get('/api/admin/events')).status).toBe(403);
        expect((await request(app).get('/api/admin/events').set('x-admin-key', 'testopkey')).status).toBe(200);
        expect((await request(app).get('/api/admin/operation-keys').set('x-admin-key', 'testadmin1234')).status).toBe(200);
        expect((await request(app).get('/api/admin/operation-keys').set('x-admin-key', 'testopkey')).status).toBe(403);
        expect((await request(app).get('/api/admin/events').query({ key: 'testopkey' })).status).toBe(200);   // 쿼리도 여전히 됨
    });
});
