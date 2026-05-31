/**
 * Smoke 테스트 — "서버가 부팅되고 기본 라우트가 살아있는가"
 *
 * 이게 통과해야 다음 테스트들이 의미가 있음.
 * 가장 중요한 회귀 안전망: server.js 가 require 만으로 깨지지 않는다는 보장.
 */
// globals: true 옵션으로 describe/it/expect/beforeAll 자동 사용 가능 (vitest.config.js 참조)
const request = require('supertest');

let app;

beforeAll(async () => {
    // server.js 는 require 시점에 app/server 를 module.exports 로 노출 (테스트 모드)
    const mod = require('../../server.js');
    app = mod.app;
    // DB 초기화가 module-scope 에서 동기로 끝나므로 await 불필요
});

describe('Smoke — 서버 부팅 및 기본 라우트', () => {
    it('server.js 가 app 인스턴스를 export 해야 한다', () => {
        expect(app).toBeDefined();
        expect(typeof app).toBe('function'); // Express app 은 callable function
    });

    it('루트 / 가 200 또는 302 를 반환해야 한다 (정적 페이지)', async () => {
        const res = await request(app).get('/');
        expect([200, 301, 302]).toContain(res.status);
    });

    it('/admin.html 정적 파일이 200 으로 응답해야 한다', async () => {
        const res = await request(app).get('/admin.html');
        expect(res.status).toBe(200);
        // HTML 컨텐츠인지 가볍게 확인 (대소문자 무관)
        expect(res.text.toLowerCase()).toContain('<!doctype html');
    });

    it('존재하지 않는 API 는 404 를 반환해야 한다', async () => {
        const res = await request(app).get('/api/__definitely_not_a_real_route__');
        expect([404, 400]).toContain(res.status);
    });
});
