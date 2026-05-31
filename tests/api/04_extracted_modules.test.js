/**
 * 추출된 모듈 회귀 테스트 (2단계 모듈 분리 안전망)
 *
 * 보호하는 것:
 *  - lib/routes/federations.js      → GET /api/federations
 *  - lib/routes/home_popups.js      → GET /api/home-popups
 *  - lib/routes/competition_series.js → GET /api/competition-series
 *  - lib/routes/event_links.js      → GET /api/event-links?competition_id=...
 *
 * 모듈 추출 과정에서 라우트 경로/메서드/응답 형태가 바뀌지 않았음을 보장.
 */
const request = require('supertest');

let app;
const ADMIN_KEY = 'testadmin1234';

beforeAll(async () => {
    app = require('../../server.js').app;
});

describe('추출된 모듈 — 라우트 회귀', () => {

    describe('federations.js', () => {
        it('GET /api/federations — 배열로 응답', async () => {
            const res = await request(app).get('/api/federations');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });

        it('POST /api/federations — admin_key 없으면 403', async () => {
            const res = await request(app)
                .post('/api/federations')
                .send({ code: 'TEST_FED' })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(403);
        });

        it('POST /api/federations — code 없으면 400', async () => {
            const res = await request(app)
                .post('/api/federations')
                .send({ admin_key: ADMIN_KEY, code: '' })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(400);
        });

        it('POST → GET → DELETE cycle 정상 동작', async () => {
            const code = 'TEST_REG_' + Date.now();
            const created = await request(app)
                .post('/api/federations')
                .send({ admin_key: ADMIN_KEY, code, name: 'Regression Fed' })
                .set('Content-Type', 'application/json');
            expect(created.status).toBe(200);
            expect(created.body).toHaveProperty('id');

            const list = await request(app).get('/api/federations');
            expect(list.body.some(f => f.code === code.toUpperCase())).toBe(true);

            const del = await request(app)
                .delete(`/api/federations/${created.body.id}`)
                .send({ admin_key: ADMIN_KEY })
                .set('Content-Type', 'application/json');
            expect(del.status).toBe(200);
        });
    });

    describe('home_popups.js', () => {
        it('GET /api/home-popups — 배열로 응답 (인증 불필요)', async () => {
            const res = await request(app).get('/api/home-popups');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });

        it('POST /api/home-popups — admin_key 없으면 403', async () => {
            const res = await request(app)
                .post('/api/home-popups')
                .send({ title: 'no_key' })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(403);
        });
    });

    describe('competition_series.js', () => {
        it('GET /api/competition-series — 배열로 응답', async () => {
            const res = await request(app).get('/api/competition-series');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });

        it('POST /api/competition-series — admin_key 없으면 403', async () => {
            const res = await request(app)
                .post('/api/competition-series')
                .send({ name: 'no_key' })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(403);
        });
    });

    describe('event_links.js', () => {
        it('GET /api/event-links — competition_id 없으면 400', async () => {
            const res = await request(app).get('/api/event-links');
            expect(res.status).toBe(400);
        });

        it('GET /api/event-links?competition_id=1 — 배열로 응답', async () => {
            const res = await request(app).get('/api/event-links').query({ competition_id: 1 });
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });

        it('POST /api/event-links — 인증 없으면 403', async () => {
            const res = await request(app)
                .post('/api/event-links')
                .send({ event_id_a: 1, event_id_b: 2 })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(403);
        });
    });
});
