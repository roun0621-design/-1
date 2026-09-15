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

    it('테스트 환경은 sqlite 백엔드여야 한다 (DB 격리 보장)', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.backend).toBe('sqlite');
    });
});
