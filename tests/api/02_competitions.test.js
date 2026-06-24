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

    // ---- 홈 노출 강제 설정 (home_visibility: auto | pinned | hidden) ----
    describe('home_visibility — 홈 노출 강제 설정', () => {
        const today = new Date().toISOString().slice(0, 10);

        async function createComp(payload) {
            const res = await request(app).post('/api/competitions')
                .send({ admin_key: ADMIN_KEY, venue: '', ...payload })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(200);
            return res.body.id;
        }

        async function setVisibility(id, home_visibility) {
            const res = await request(app).put(`/api/competitions/${id}`)
                .send({ admin_key: ADMIN_KEY, home_visibility })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(200);
            return res.body;
        }

        it('PUT 으로 home_visibility 저장 + 잘못된 값은 기존값 유지', async () => {
            const id = await createComp({ name: 'HV_PUT_' + Date.now(), start_date: today, end_date: today });
            const updated = await setVisibility(id, 'pinned');
            expect(updated.home_visibility).toBe('pinned');

            // 허용되지 않는 값 → 기존값(pinned) 유지
            const bad = await setVisibility(id, 'bogus');
            expect(bad.home_visibility).toBe('pinned');
        });

        it('pinned — 윈도우 밖 과거 대회도 /recent 에 항상 노출 + 최상단', async () => {
            const id = await createComp({ name: 'HV_PINNED_OLD_' + Date.now(), start_date: '2020-01-01', end_date: '2020-01-02' });
            await setVisibility(id, 'pinned');

            const res = await request(app).get('/api/competitions/recent?window=active');
            expect(res.status).toBe(200);
            const items = res.body.items || res.body;
            expect(items.length).toBeGreaterThan(0);
            expect(items.some(c => c.id === id)).toBe(true);
            expect(items[0].home_visibility).toBe('pinned'); // 고정이 최상단
        });

        it('hidden — 진행중(active) 대회여도 /recent 에서 제외', async () => {
            const id = await createComp({ name: 'HV_HIDDEN_LIVE_' + Date.now(), start_date: today, end_date: today });
            await setVisibility(id, 'hidden');

            const res = await request(app).get('/api/competitions/recent?window=active');
            const items = res.body.items || res.body;
            expect(items.some(c => c.id === id)).toBe(false);

            // 전체 펼침(window=all)에는 표시 유지
            const all = await request(app).get('/api/competitions/recent?window=all');
            expect(all.body.some(c => c.id === id)).toBe(true);
        });
    });

    // ---- 대회 재개(reopen) 재잠금 방지 — manual_status_lock ----
    describe('reopen — 종료일 지난 대회 재개 후 재잠금되지 않음', () => {
        const today = new Date().toISOString().slice(0, 10);

        async function createComp(payload) {
            const res = await request(app).post('/api/competitions')
                .send({ admin_key: ADMIN_KEY, venue: '', ...payload })
                .set('Content-Type', 'application/json');
            expect(res.status).toBe(200);
            return res.body.id;
        }
        async function getComp(id) {
            const res = await request(app).get(`/api/competitions/${id}`);
            return res.body.competition || res.body;
        }

        it('종료일이 지난 대회를 재개하면 active 가 되고, GET /api/competitions(자동갱신) 후에도 다시 completed 로 잠기지 않는다', async () => {
            // 과거에 끝난 대회 생성 → 자동갱신으로 completed 가 됨
            const id = await createComp({ name: 'REOPEN_' + Date.now(), start_date: '2020-01-01', end_date: '2020-01-02' });
            await request(app).get('/api/competitions'); // autoUpdateCompetitionStatus 트리거
            expect((await getComp(id)).status).toBe('completed');

            // 재개
            const re = await request(app).post(`/api/admin/competitions/${id}/reopen`)
                .send({ admin_key: ADMIN_KEY }).set('Content-Type', 'application/json');
            expect(re.status).toBe(200);
            expect(re.body.status).toBe('active');

            // 다른 창 이동 시뮬레이션: 목록 조회로 자동갱신 재실행
            await request(app).get('/api/competitions');

            // 재잠금되지 않아야 함 (버그 회귀 방지)
            const after = await getComp(id);
            expect(after.status).toBe('active');
            expect(Number(after.manual_status_lock)).toBe(1);
        });

        it('재개 후 수동 종료(close)하면 manual_status_lock 이 해제된다', async () => {
            const id = await createComp({ name: 'REOPEN_CLOSE_' + Date.now(), start_date: '2020-01-01', end_date: '2020-01-02' });
            await request(app).post(`/api/admin/competitions/${id}/reopen`)
                .send({ admin_key: ADMIN_KEY }).set('Content-Type', 'application/json');
            const closed = await request(app).post(`/api/admin/competitions/${id}/close`)
                .send({ admin_key: ADMIN_KEY }).set('Content-Type', 'application/json');
            expect(closed.status).toBe(200);
            const after = await getComp(id);
            expect(after.status).toBe('completed');
            expect(Number(after.manual_status_lock)).toBe(0);
        });
    });
});
