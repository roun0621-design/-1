/**
 * 인증 잠금 회귀 테스트 — 보안 점검(6/10)에서 잠근 변경 엔드포인트
 *
 * 운영키 없이 호출하면 403 이어야 한다. 이 테스트가 깨지면
 * 누군가 인증 체크를 지운 것이므로 절대 그냥 통과시키지 말 것.
 */
const request = require('supertest');

let app;

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
});

describe('운영키 없는 변경 요청은 403', () => {
    const cases = [
        ['POST /api/heats/:id/wind', () => request(app).post('/api/heats/1/wind').send({ wind: '2.0' })],
        ['POST /api/qualifications/save', () => request(app).post('/api/qualifications/save').send({ event_id: 1, selections: [] })],
        ['POST /api/qualifications/approve', () => request(app).post('/api/qualifications/approve').send({ event_id: 1 })],
        ['POST /api/events/:id/create-final', () => request(app).post('/api/events/1/create-final').send({})],
        ['POST /api/events/:id/create-semifinal', () => request(app).post('/api/events/1/create-semifinal').send({ group_count: 1, selections: [{ event_entry_id: 1, selected: 1 }] })],
        ['POST /api/lanes/bulk-update', () => request(app).post('/api/lanes/bulk-update').send({ assignments: [] })],
        ['POST /api/wa-correct/:id', () => request(app).post('/api/wa-correct/1').send({})],
        ['POST /api/combined/sync-checkin', () => request(app).post('/api/combined/sync-checkin').send({ event_id: 1 })],
    ];

    for (const [name, call] of cases) {
        it(`${name} — 키 없으면 403`, async () => {
            const res = await call().set('Content-Type', 'application/json');
            expect(res.status).toBe(403);
        });
    }

    it('운영키가 있으면 403이 아님 (wind 기준 스모크)', async () => {
        const res = await request(app).post('/api/heats/999999/wind')
            .send({ wind: '1.0' })
            .set('x-admin-key', process.env.OPERATION_KEY)
            .set('Content-Type', 'application/json');
        // 인증 통과 후 존재하지 않는 heat → 404 (403이면 인증이 잘못 막은 것)
        expect(res.status).toBe(404);
    });
});
