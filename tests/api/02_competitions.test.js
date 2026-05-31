/**
 * 대회(Competition) API 회귀 테스트
 *
 * 현재 인증 모델 (audit P0 — 향후 JWT 로 통일 예정):
 *  - POST /api/competitions       → admin_key 필수
 *  - PUT  /api/competitions/:id   → operation_key (admin_key 도 통과)
 *  - GET  /api/competitions       → 공개
 *
 * 시드 DB: 부팅 시 init.js 가 'sample competition' 1건을 자동 생성
 */
const request = require('supertest');

let app;
const ADMIN_KEY = 'testadmin1234'; // global-setup 의 ADMIN_PW 와 일치

beforeAll(async () => {
    app = require('../../server.js').app;
});

describe('Competition API — 회귀', () => {

    it('GET /api/competitions — 배열로 응답 (인증 불필요)', async () => {
        const res = await request(app).get('/api/competitions');
        expect(res.status).toBe(200);
        const list = Array.isArray(res.body) ? res.body : (res.body.competitions || res.body.data);
        expect(Array.isArray(list)).toBe(true);
    });

    it('POST /api/competitions — admin_key 없으면 403', async () => {
        const res = await request(app)
            .post('/api/competitions')
            .send({ name: 'no_key_test', start_date: '2026-06-01', end_date: '2026-06-02' })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(403);
    });

    it('POST /api/competitions — admin_key 와 함께면 생성 성공', async () => {
        const payload = {
            admin_key: ADMIN_KEY,
            name: 'TEST_REGRESSION_COMP_' + Date.now(),
            start_date: '2026-06-01',
            end_date: '2026-06-03',
            venue: '테스트 경기장',
        };
        const res = await request(app)
            .post('/api/competitions')
            .send(payload)
            .set('Content-Type', 'application/json');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('id');
        expect(typeof res.body.id).toBe('number');
        expect(res.body.name).toBe(payload.name);

        global.__createdCompId = res.body.id;
    });

    it('GET /api/competitions/:id — 방금 만든 대회 조회', async () => {
        const id = global.__createdCompId;
        expect(id).toBeDefined();

        const res = await request(app).get(`/api/competitions/${id}`);
        expect(res.status).toBe(200);
        const comp = res.body.competition || res.body;
        expect(comp).toHaveProperty('id', id);
        expect(comp.name).toMatch(/^TEST_REGRESSION_COMP_/);
    });

    it('PUT /api/competitions/:id — admin_key 로 수정', async () => {
        const id = global.__createdCompId;
        const res = await request(app)
            .put(`/api/competitions/${id}`)
            .send({
                admin_key: ADMIN_KEY,
                name: 'TEST_REGRESSION_COMP_UPDATED',
                venue: '수정 경기장',
            })
            .set('Content-Type', 'application/json');

        expect(res.status).toBe(200);

        // 수정 반영 확인
        const verify = await request(app).get(`/api/competitions/${id}`);
        const comp = verify.body.competition || verify.body;
        expect(comp.name).toBe('TEST_REGRESSION_COMP_UPDATED');
        expect(comp.venue).toBe('수정 경기장');
    });
});
