/**
 * POST /api/combined-scores/save — 혼성경기 점수 저장 회귀 테스트
 *
 * 모듈 추출 시 requireAdminAfterCompEnd 미주입으로 종료-잠금이 try/catch에
 * 삼켜져 무력화되던 버그(2026-06)를 고정한다.
 *   - 진행중 대회: 저장 200 + DB 반영
 *   - 종료된 대회: 비관리자 저장 차단(403) ← 잠금 정상 작동
 */
const request = require('supertest');

let app, db;

async function makeFixture(status, endDate) {
    const stamp = Date.now() + Math.floor(performance.now());
    let r = await db.run(
        "INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?,?)",
        'COMBINED_TEST_' + stamp, '2026-01-01', endDate, '장', status
    );
    const compId = r.lastInsertRowid;
    r = await db.run(
        "INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'combined', 'M', 'final', 'in_progress')",
        compId, '10종경기'
    );
    const eventId = r.lastInsertRowid;
    r = await db.run("INSERT INTO athlete (competition_id, name, gender) VALUES (?,?, 'M')", compId, '선수' + stamp);
    const athleteId = r.lastInsertRowid;
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", eventId, athleteId);
    return { compId, entryId: r.lastInsertRowid };
}

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
});

describe('POST /api/combined-scores/save', () => {
    it('진행중 대회: 점수 저장 시 200 + DB 반영 (500 크래시 없음)', async () => {
        const { entryId } = await makeFixture('active', '2099-12-31');
        const res = await request(app)
            .post('/api/combined-scores/save')
            .send({ event_entry_id: entryId, sub_event_name: '100m', sub_event_order: 1, raw_record: 11.5, wa_points: 900 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);

        const row = await db.get('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=1', entryId);
        expect(row).toBeTruthy();
        expect(row.wa_points).toBe(900);
    });

    it('종료된 대회: 비관리자 저장은 차단된다 (종료-잠금 정상 작동)', async () => {
        const { entryId } = await makeFixture('completed', '2020-01-01');
        const res = await request(app)
            .post('/api/combined-scores/save')
            .send({ event_entry_id: entryId, sub_event_name: '100m', sub_event_order: 1, raw_record: 11.5, wa_points: 900 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(403); // requireAdminAfterCompEnd 가 차단
    });
});
