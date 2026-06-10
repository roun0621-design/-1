/**
 * POST /api/events/:id/create-final — 결승 생성 + WA 시딩/레인 배정 통합 테스트
 *
 * 자격선발된 선수들로 결승 종목·조·레인을 생성하는 가장 복잡한 쓰기 경로.
 * WA 시딩(Q→q→기록순)·레인 배정(waAssignLanesBulk)이 실행되는 곳이라
 * 잠복 버그가 숨기 쉽다. 정상 생성 + 가드(자격자 없음)를 고정한다.
 */
const request = require('supertest');

let app, db;

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
});

async function buildEventWithQualifiers(n, approve) {
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'FINAL_TEST_' + Date.now() + '_' + Math.floor(performance.now()), '2026-01-01', '2099-12-31', '장');
    const compId = r.lastInsertRowid;
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'preliminary', 'in_progress')", compId, '100m');
    const eventId = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', eventId);
    const heatId = r.lastInsertRowid;

    for (let i = 0; i < n; i++) {
        r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, gender) VALUES (?,?,?, 'M')", compId, '선수' + i, String(300 + i));
        const athleteId = r.lastInsertRowid;
        r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", eventId, athleteId);
        const entryId = r.lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heatId, entryId, i + 1);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', heatId, entryId, 10.5 + i * 0.2);
        // 자격선발 (selected + 조건부 approved)
        await db.run('INSERT INTO qualification_selection (event_id, event_entry_id, selected, approved, qualification_type) VALUES (?,?,1,?,?)',
            eventId, entryId, approve ? 1 : 0, 'Q');
    }
    return { compId, eventId };
}

describe('POST /api/events/:id/create-final — WA 시딩/레인', () => {
    it('승인된 자격자로 결승 생성 시 200 + 결승 종목·조·레인 생성', async () => {
        const { compId, eventId } = await buildEventWithQualifiers(6, true);
        const res = await request(app)
            .post(`/api/events/${eventId}/create-final`)
            .send({})
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);

        const final = await db.get(
            "SELECT * FROM event WHERE competition_id=? AND round_type='final' AND id!=?", compId, eventId
        );
        expect(final).toBeTruthy();

        const heats = await db.all('SELECT * FROM heat WHERE event_id=?', final.id);
        expect(heats.length).toBeGreaterThanOrEqual(1);

        // 레인 배정 확인: 결승 조 엔트리에 lane_number 가 부여됨
        const lanes = await db.all(
            'SELECT he.lane_number FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=?', final.id
        );
        expect(lanes.length).toBe(6);
        expect(lanes.every(l => l.lane_number != null)).toBe(true);
    });

    it('승인된 자격자가 없으면 400', async () => {
        const { eventId } = await buildEventWithQualifiers(4, false); // approved=0
        const res = await request(app)
            .post(`/api/events/${eventId}/create-final`)
            .send({})
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(400);
    });
});
