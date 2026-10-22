/**
 * 관심 종목 알림 흐름 — 토큰 등록 → 관심 종목(성별|종목명) 저장 → 결과/소집 트리거가 그 토큰에만 발송 (FCM 은 가짜 발송기로)
 *   대시보드의 종목 창 알림 토글·대표팀 전 종목 알림이 저장하는 키와 서버 트리거 키(event.gender|event.name)가 같은지 고정한다.
 */
const request = require('supertest');
let app, db, comp, ev, push;
const Push = require('../../lib/pushSender');

describe('관심 종목 알림 흐름', () => {
    const sent = [];
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES ('푸시 테스트', '2026-10-01', '2026-10-01', '경기장', 'active')")).lastInsertRowid;
        ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '높이뛰기', 'field_height', 'M', 'final', 'in_progress')", comp)).lastInsertRowid;
        // 가짜 발송기: 켜진 것으로 보이게 하고 보낸 토큰을 기록
        Push.isEnabled = () => true;
        Push.sendToTokens = async (tokens, msg) => { sent.push({ tokens, msg }); return { ok: true, sent: tokens.length, invalidTokens: [] }; };
        push = require('../../lib/routes/push')(require('express')(), { db, isAdminKey: () => true, Push });
    });
    it('등록한 토큰의 관심 종목에만 결과 알림이 간다 (같은 종목·같은 종류는 6시간에 한 번)', async () => {
        expect((await request(app).post('/api/push/register').send({ token: 'tok-A', audience: 'viewer', competition_id: comp })).status).toBe(200);
        expect((await request(app).post('/api/push/register').send({ token: 'tok-B', audience: 'viewer', competition_id: comp })).status).toBe(200);
        // A 는 남자 높이뛰기, B 는 여자 100m 에만 관심 (대시보드 toggleFavorite 이 저장하는 키 모양)
        expect((await request(app).post('/api/push/interests').send({ token: 'tok-A', competition_id: comp, keys: ['M|높이뛰기'] })).body.count).toBe(1);
        expect((await request(app).post('/api/push/interests').send({ token: 'tok-B', competition_id: comp, keys: ['F|100m'] })).body.count).toBe(1);
        const event = await db.get('SELECT * FROM event WHERE id=?', ev);
        const r = await push.notifyEventInterest(event, { kind: 'result', title: '남자 높이뛰기 결승 결과 발표', body: '확인' });
        expect(r.sent).toBe(1); expect(sent[0].tokens).toEqual([{ token: 'tok-A', platform: 'web' }]); expect(sent[0].msg.title).toMatch(/높이뛰기/);
        const r2 = await push.notifyEventInterest(event, { kind: 'result', title: 'x' });
        expect(r2.deduped).toBe(true); expect(sent.length).toBe(1);
        // 관심을 지우면 안 간다 (다른 종류 kind 로 확인 — 중복 방지와 무관)
        await request(app).post('/api/push/interests').send({ token: 'tok-A', competition_id: comp, keys: [] });
        const r3 = await push.notifyEventInterest(event, { kind: 'callroom', title: '소집' });
        expect(r3.sent).toBe(0);
    });
});
