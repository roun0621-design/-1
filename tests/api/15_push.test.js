/**
 * 웹푸시(FCM) 라우트 통합 테스트
 * Firebase 미설정(테스트 환경)에서도 앱이 깨지지 않고, 토큰 등록/상태/발송이
 * '비활성(no-op)' 으로 안전하게 동작하는지 고정.
 */
const request = require('supertest');

let app;
const ADMIN_KEY = 'testadmin1234';

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
});

describe('웹푸시(FCM)', () => {
    it('web-config — 미설정이면 configured:false', async () => {
        const res = await request(app).get('/api/push/web-config');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('configured');
        expect(res.body.configured).toBe(false); // 테스트 env에 키 없음
    });

    it('토큰 등록 — 키 없어도 200 + 토큰 저장', async () => {
        const res = await request(app).post('/api/push/register')
            .send({ token: 'test-token-' + Date.now(), audience: 'public' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.push_enabled).toBe(false); // firebase 미설정
    });

    it('토큰 없이 등록 → 400', async () => {
        const res = await request(app).post('/api/push/register').send({});
        expect(res.status).toBe(400);
    });

    it('관리자 상태 — enabled:false + 토큰 수 반환', async () => {
        const res = await request(app).get('/api/admin/push/status').query({ admin_key: ADMIN_KEY });
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);
        expect(typeof res.body.tokens).toBe('number');
    });

    it('공지 발송 — 미설정이면 안전(skipped 또는 발송0)', async () => {
        const res = await request(app).post('/api/admin/push/send')
            .send({ admin_key: ADMIN_KEY, title: 't', body: '본문', audience: 'all' });
        expect(res.status).toBe(200);
        // firebase 미설정 → skipped, 토큰 없으면 sent:0. 둘 중 하나면 OK(앱 안 깨짐).
        expect(res.body.skipped === true || res.body.sent === 0).toBe(true);
    });

    it('공지 발송 — 관리자 키 없으면 403', async () => {
        const res = await request(app).post('/api/admin/push/send').send({ body: 'x' });
        expect(res.status).toBe(403);
    });
});
