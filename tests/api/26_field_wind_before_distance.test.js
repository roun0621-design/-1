/**
 * 필드(멀리뛰기) — 기록(거리) 입력 전 풍속만 먼저 저장
 *
 * 현장 순서: 풍속계 수치가 먼저 나오고 거리 계측이 뒤따른다.
 * 예전 클라이언트는 result 행이 있어야만 풍속을 보냈다 → 기록 없이는 풍속 입력 불가.
 * 서버 upsert 는 distance_meters 를 안 보내면 '기존값 유지 / 신규 NULL' 이므로
 * (1) 풍속만 → distance NULL + wind 저장, (2) 이후 거리 입력 → 풍속 유지 를 회귀로 고정.
 *
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
// (2026-09) 쓰기 가드: 모든 변경 요청은 운영키가 필요 → 테스트도 심판 세션처럼 x-admin-key 를 보낸다

let app, db;
const fx = {};

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
    let r = await db.run(
        "INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'WIND_FIRST_' + Date.now(), '2026-01-01', '2099-12-31', '테스트장'
    );
    fx.compId = r.lastInsertRowid;
    r = await db.run(
        "INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'field_distance', 'M', 'final', 'in_progress')",
        fx.compId, '멀리뛰기'
    );
    fx.eventId = r.lastInsertRowid;
    r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.compId, '김민석', '25', '국립경국대');
    fx.athleteId = r.lastInsertRowid;
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.eventId, fx.athleteId);
    fx.entryId = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.eventId);
    fx.heatId = r.lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,6)', fx.heatId, fx.entryId);
});

const row = () => db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number=3', fx.heatId, fx.entryId);

describe('필드 풍속 선입력', () => {
    it('기록 없이 풍속만 저장 → distance NULL, wind 저장', async () => {
        const res = await request(app).post('/api/results/upsert').set('x-admin-key', 'testopkey')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, attempt_number: 3, wind: 0.6 });
        expect(res.status).toBe(200);
        const r = await row();
        expect(r).toBeTruthy();
        expect(r.distance_meters).toBeNull();
        expect(r.wind).toBeCloseTo(0.6, 5);
        expect(r.status_code || '').toBe('');
    });

    it('이후 거리 입력(풍속 미전송) → 풍속 유지', async () => {
        const res = await request(app).post('/api/results/upsert').set('x-admin-key', 'testopkey')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, attempt_number: 3, distance_meters: 7.02 });
        expect(res.status).toBe(200);
        const r = await row();
        expect(r.distance_meters).toBeCloseTo(7.02, 5);
        expect(r.wind).toBeCloseTo(0.6, 5);
    });

    it('풍속만 다시 갱신 → 거리 유지', async () => {
        const res = await request(app).post('/api/results/upsert').set('x-admin-key', 'testopkey')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, attempt_number: 3, wind: -1.1 });
        expect(res.status).toBe(200);
        const r = await row();
        expect(r.distance_meters).toBeCloseTo(7.02, 5);
        expect(r.wind).toBeCloseTo(-1.1, 5);
    });

    it('풍속만 있는 빈 시기는 GET /api/results 에 distance NULL 로 노출 (클라이언트가 미입력으로 취급)', async () => {
        await request(app).post('/api/results/upsert').set('x-admin-key', 'testopkey')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, attempt_number: 4, wind: 1.3 });
        const res = await request(app).get(`/api/results?heat_id=${fx.heatId}`);
        expect(res.status).toBe(200);
        const a4 = res.body.find(x => x.event_entry_id === fx.entryId && x.attempt_number === 4);
        expect(a4).toBeTruthy();
        expect(a4.distance_meters).toBeNull();
        expect(a4.wind).toBeCloseTo(1.3, 5);
    });
});
