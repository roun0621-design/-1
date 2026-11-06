/**
 * 문자 발송 보호 — 월 한도(monthly_quota) 적용 · 휴대폰 번호 형식 검사 (Phase 3-⑧ 잔여 #13)
 *   시뮬레이션 모드에서는 실제 발송이 없으므로 한도를 세지 않는다.
 */
const request = require('supertest');
const SMS = require('../../lib/smsSender');
let app, db; const ADMIN = 'testadmin1234';
beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; await db.run("INSERT INTO sms_config (id, provider, sim_mode) VALUES (1, 'aligo', 1) ON CONFLICT(id) DO NOTHING"); });
const send = (body) => request(app).post('/api/admin/sms/send').send({ admin_key: ADMIN, message: '테스트', ...body });

describe('번호 정규화·검증', () => {
    it('+8210·82·하이픈 → 010… / 국내 0820… 은 그대로', () => {
        expect(SMS.normalizePhone('+82 10-1234-5678')).toBe('01012345678'); expect(SMS.normalizePhone('821012345678')).toBe('01012345678');
        expect(SMS.normalizePhone('010-1234-5678')).toBe('01012345678');
        expect(SMS.isValidMobile('010-1234-5678')).toBe(true); expect(SMS.isValidMobile('02-123-4567')).toBe(false); expect(SMS.isValidMobile('')).toBe(false); expect(SMS.isValidMobile('1234')).toBe(false);
    });
    it('형식이 아닌 번호는 발송하지 않고 400', async () => {
        const r = await send({ phone: '02-123-4567' });
        expect(r.status).toBe(400); expect(r.body.error).toContain('형식');
    });
});
describe('월 한도', () => {
    it('시뮬레이션 모드는 한도를 세지 않는다', async () => {
        await db.run("UPDATE sms_config SET monthly_quota=1, sent_this_month=5, sim_mode=1 WHERE id=1");
        const r = await send({ phone: '01012345678' });
        expect(r.status).toBe(200); expect(r.body.status || r.body.result?.status || 'simulated').toMatch(/simulated|sent/);
    });
    it('실제 발송 모드에서 한도를 넘으면 429 — 발송하지 않는다', async () => {
        await db.run("UPDATE sms_config SET monthly_quota=5, sent_this_month=5, sim_mode=0, api_key='dummy', sender_number='0212345678' WHERE id=1");
        const before = (await db.get('SELECT COUNT(*) c FROM sms_log')).c;
        const r = await send({ phone: '01012345678', force_real: true });
        expect(r.status).toBe(429); expect(r.body.quota_exceeded).toBe(true);
        expect((await db.get('SELECT COUNT(*) c FROM sms_log')).c).toBe(before);
        await db.run("UPDATE sms_config SET monthly_quota=0, sim_mode=1, api_key='' WHERE id=1");
    });
});
