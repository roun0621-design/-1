/**
 * 행사(event) 간편 기록입력 API — 라우트 결선 + 인증 회귀
 *
 * 종목 생성 API 가 별도로 없어 풀 등록흐름 대신, 라우트가 마운트되어 있고
 * 인증/존재여부 가드가 의도대로 동작하는지를 지킨다.
 */
const request = require('supertest');

let app;
const ADMIN_KEY = 'testadmin1234'; // global-setup 의 ADMIN_PW 와 일치

beforeAll(async () => {
    app = require('../../server.js').app;
});

describe('Event 간편 기록입력 API — 회귀', () => {
    it('POST /api/event/:slug/record — 키 없으면 403', async () => {
        const res = await request(app)
            .post('/api/event/nope/record')
            .send({ event_id: 1, name: 'x', distance_meters: 100 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(403);
    });

    it('POST /api/event/:slug/record — 관리자키 + 없는 slug 면 404', async () => {
        const res = await request(app)
            .post('/api/event/__no_such_slug__/record')
            .send({ key: ADMIN_KEY, event_id: 1, name: 'x', distance_meters: 100 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(404);
    });

    it('GET /api/event/:slug/records — 키 없으면 403', async () => {
        const res = await request(app).get('/api/event/nope/records?event_id=1');
        expect(res.status).toBe(403);
    });

    it('POST /api/event/:slug/send-cert — 키 없으면 403', async () => {
        const res = await request(app)
            .post('/api/event/nope/send-cert')
            .send({ entry_id: 1 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(403);
    });

    it('GET /e/:slug/입력 — 입력 페이지 HTML 응답', async () => {
        const res = await request(app).get('/e/anything/' + encodeURIComponent('입력'));
        expect(res.status).toBe(200);
        expect(res.text).toContain('간편 기록입력');
    });
});
