/**
 * 2026-10-12: ① 운영 관측 라이트(/api/admin/server-status, 오류 링 버퍼) ② GA 동의 로더(/ga.js — EU 조직은 동의 필요)
 */
const request = require('supertest');
let app, db; const OP = 'testopkey', ADMIN = 'testadmin1234';
const Observe = require('../../lib/observe');

describe('관측 · GA 동의', () => {
    beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready; });

    it('server-status: 관리자만, DB·요청·오류 항목', async () => {
        expect((await request(app).get('/api/admin/server-status').query({ admin_key: OP })).status).toBe(403);
        await request(app).get('/api/competitions');   // 요청 통계가 쌓이도록
        Observe.recordError('custom', new Error('테스트 오류'), { method: 'GET', originalUrl: '/api/x?admin_key=secret' });
        const r = await request(app).get('/api/admin/server-status').query({ admin_key: ADMIN });
        expect(r.status).toBe(200);
        expect(r.body.db).toMatchObject({ backend: 'sqlite', up: true }); expect(typeof r.body.db.latency_ms).toBe('number');
        expect(r.body.requests.total).toBeGreaterThan(0); expect(r.body.uptime_sec).toBeGreaterThanOrEqual(0); expect(typeof r.body.ws_clients).toBe('number');
        expect(r.body.errors.last_24h).toBeGreaterThanOrEqual(1);
        const e = r.body.errors.recent[0];
        expect(e).toMatchObject({ kind: 'custom', message: '테스트 오류', path: '/api/x' });   // 쿼리(키)는 남기지 않는다
        expect(JSON.stringify(e)).not.toContain('secret');
    });

    it('/ga.js: 기본 조직(KR)은 바로 싣고, 독일 조직 호스트는 동의 필요', async () => {
        const ko = await request(app).get('/ga.js');
        expect(ko.status).toBe(200); expect(ko.headers['content-type']).toMatch(/javascript/); expect(ko.text).toContain('PACE_GA_NEEDS_CONSENT=false'); expect(ko.text).toContain('G-3PRW9G7KVQ');
        await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'gade', name: 'DE Verband', country: 'DE' });
        const de = await request(app).get('/ga.js').set('Host', 'gade.localhost');
        expect(de.text).toContain('PACE_GA_NEEDS_CONSENT=true');
        // 페이지는 스니펫 대신 /ga.js 를 싣는다
        const home = await request(app).get('/');
        expect(home.text).toContain('src="/ga.js"'); expect(home.text).not.toContain('googletagmanager.com/gtag/js');
    });
});
