/**
 * POST /api/events/:id/complete — 기록 없이 / 진행중 아니어도 강제 완료 (현장 요청 2026-09)
 *   예전엔 round_status 가 in_progress 가 아니면 400 → 기록도 소집도 없는 종목을 닫을 수 없었다.
 *   되돌리기(/revert-complete)는 그대로 관리자 키.
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');

let app, db;
const fx = {};
const OP_KEY = 'testopkey';
const ADMIN_KEY = 'testadmin1234';

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db;
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'FORCE_DONE_' + Date.now(), '2026-01-01', '2099-12-31', '예천');
    fx.compId = r.lastInsertRowid;
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'heats_generated')", fx.compId, '5000m');
    fx.evNoRec = r.lastInsertRowid;
    await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.evNoRec);
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'completed')", fx.compId, '100m');
    fx.evDone = r.lastInsertRowid;
});

describe('경기 강제 완료', () => {
    it('기록 0건 + heats_generated 상태여도 운영키로 완료된다', async () => {
        const res = await request(app).post(`/api/events/${fx.evNoRec}/complete`).send({ admin_key: OP_KEY, judge_name: '홍심판' });
        expect(res.status).toBe(200);
        expect(res.body.event.round_status).toBe('completed');
        const log = await db.get("SELECT * FROM operation_log WHERE competition_id=? AND message LIKE '%강제 완료%' ORDER BY id DESC LIMIT 1", fx.compId);
        expect(log).toBeTruthy();
    });
    it('이미 완료된 경기는 여전히 400', async () => {
        const res = await request(app).post(`/api/events/${fx.evDone}/complete`).send({ admin_key: OP_KEY, judge_name: '홍심판' });
        expect(res.status).toBe(400);
    });
    it('관리자 되돌리기 후 다시 완료 가능', async () => {
        let res = await request(app).post(`/api/events/${fx.evNoRec}/revert-complete`).send({ admin_key: ADMIN_KEY });
        expect(res.status).toBe(200);
        expect(res.body.event.round_status).toBe('in_progress');
        res = await request(app).post(`/api/events/${fx.evNoRec}/complete`).send({ admin_key: OP_KEY, judge_name: '홍심판' });
        expect(res.status).toBe(200);
    });
});
