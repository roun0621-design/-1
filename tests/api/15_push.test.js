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

    it('관심 종목 동기화 — 토큰+키 저장 200', async () => {
        const res = await request(app).post('/api/push/interests')
            .send({ token: 'test-token-' + Date.now(), competition_id: 1, keys: ['M|100m', 'F|200m'] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(2);
    });

    it('관심 종목 동기화 — 토큰 없으면 400', async () => {
        const res = await request(app).post('/api/push/interests').send({ keys: ['M|100m'] });
        expect(res.status).toBe(400);
    });
});

describe('네이티브 앱 푸시(앱스토어 iOS·안드로이드)', () => {
    it('토큰 등록에 platform 저장 — 없으면 web, 이상한 값도 web', async () => {
        const db = require('../../server.js').db;
        for (const [plat, want] of [['ios', 'ios'], ['android', 'android'], [undefined, 'web'], ['tv', 'web']]) {
            const token = 'native-' + (plat || 'none') + '-' + Date.now();
            const res = await request(app).post('/api/push/register').send({ token, platform: plat });
            expect(res.status).toBe(200);
            const row = await db.get('SELECT platform FROM push_token WHERE token=?', token);
            expect(row.platform).toBe(want);
        }
    });
    it('플랫폼별 메시지 — iOS 는 notification+apns(alert·sound), 안드로이드는 notification+android, 웹은 data-only', () => {
        const { buildMessage } = require('../../lib/pushSender.js');
        const ios = buildMessage('ios', { title: '결과', body: '여자 100m 결승', data: { event_id: 7, url: '/dashboard.html?comp=63' } });
        expect(ios.notification).toEqual({ title: '결과', body: '여자 100m 결승' });
        expect(ios.apns.payload.aps.sound).toBe('default'); expect(ios.apns.headers['apns-priority']).toBe('10');
        expect(ios.data).toMatchObject({ title: '결과', event_id: '7', url: '/dashboard.html?comp=63' });
        const and = buildMessage('android', { title: 't', body: 'b' });
        expect(and.notification).toEqual({ title: 't', body: 'b' }); expect(and.android.priority).toBe('high');
        const web = buildMessage('web', { title: 't', body: 'b', data: { x: 1 } });
        expect(web.notification).toBeUndefined(); expect(web.data).toEqual({ title: 't', body: 'b', x: '1' }); expect(web.webpush.headers.Urgency).toBe('high');
    });
    it('sendToTokens 는 문자열·{token,platform} 섞어 받아도 안전(미설정이면 skipped)', async () => {
        const { sendToTokens } = require('../../lib/pushSender.js');
        const r = await sendToTokens(['a', { token: 'b', platform: 'ios' }], { title: 't', body: 'b' });
        expect(r.ok).toBe(false); expect(r.skipped).toBe(true);
    });
});
