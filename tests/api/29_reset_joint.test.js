/**
 * POST /api/results/reset-sub-event — 합동 종목 초기화
 *   합동(joint_group) 종목은 화면에 멤버 대회 기록이 함께 보이는데, 초기화가 선택 종목의 조만 지워서
 *   "기록 초기화가 안 된다"고 보였다. include_joint=true 면 그룹 멤버 종목 조까지 모두 초기화.
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');

let app, db;
const fx = {};

async function mkEvent(compId, name) {
    const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'field_distance', 'F', 'final', 'in_progress')", compId, name);
    const evId = r.lastInsertRowid;
    const h = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', evId);
    const a = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'F')", compId, '선수' + evId, String(evId), '팀');
    const ee = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", evId, a.lastInsertRowid);
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', h.lastInsertRowid, ee.lastInsertRowid);
    await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters) VALUES (?,?,1, 40.5)', h.lastInsertRowid, ee.lastInsertRowid);
    return { evId, heatId: h.lastInsertRowid };
}
const cnt = async heatId => (await db.get('SELECT COUNT(*) as c FROM result WHERE heat_id=?', heatId)).c;

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db;
    const stamp = Date.now();
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'RESET_J_A_' + stamp, '2026-01-01', '2099-12-31', '예천');
    fx.compA = r.lastInsertRowid;
    r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'RESET_J_B_' + stamp, '2026-01-01', '2099-12-31', '예천');
    fx.compB = r.lastInsertRowid;
    fx.a = await mkEvent(fx.compA, '창던지기');
    fx.b = await mkEvent(fx.compB, '창던지기');
    r = await db.run("INSERT INTO joint_group (name, joint_scoreboard_key) VALUES (?, ?)", '합동 여자 창던지기', '합동 여자 창던지기 결승');
    fx.jg = r.lastInsertRowid;
    await db.run('INSERT INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?,?,?,0)', fx.jg, fx.a.evId, fx.compA);
    await db.run('INSERT INTO joint_group_member (joint_group_id, event_id, competition_id, sort_order) VALUES (?,?,?,1)', fx.jg, fx.b.evId, fx.compB);
});

describe('합동 종목 기록 초기화', () => {
    it('include_joint 없이는 선택 종목만 초기화 (기존 동작 유지)', async () => {
        const res = await request(app).post('/api/results/reset-sub-event').send({ event_id: fx.a.evId });
        expect(res.status).toBe(200);
        expect(await cnt(fx.a.heatId)).toBe(0);
        expect(await cnt(fx.b.heatId)).toBe(1);
        expect(res.body.jointEvents).toBe(0);
    });
    it('include_joint=true 면 멤버 종목까지 초기화 + 상태 heats_generated', async () => {
        await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters) SELECT ?, event_entry_id, 2, 41.0 FROM heat_entry WHERE heat_id=?', fx.a.heatId, fx.a.heatId);
        const res = await request(app).post('/api/results/reset-sub-event').send({ event_id: fx.a.evId, include_joint: true });
        expect(res.status).toBe(200);
        expect(res.body.jointEvents).toBe(1);
        expect(res.body.deletedResults).toBe(2);
        expect(await cnt(fx.a.heatId)).toBe(0);
        expect(await cnt(fx.b.heatId)).toBe(0);
        const evB = await db.get('SELECT round_status FROM event WHERE id=?', fx.b.evId);
        expect(evB.round_status).toBe('heats_generated');
    });
});
