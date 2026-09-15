/**
 * POST /api/results/upsert — 기록 입력 hot-path 통합 테스트
 *
 * CLAUDE.md: 기록 입력은 동시쓰기 위험이 가장 큰 핵심 경로인데 테스트가 없었음.
 * 격리된 테스트 DB에 "종료되지 않은 대회"의 전체 체인
 * (대회→종목(in_progress)→선수→엔트리→조→조배정)을 직접 삽입한 뒤,
 * 실제 기록 저장·갱신·검증을 회귀로 고정한다.
 */
const request = require('supertest');

let app, db;
let fx = {}; // fixture ids

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;

    const stamp = Date.now();

    // 1) 종료되지 않은 대회 (status active, 종료일 먼 미래 → 종료잠금 회피)
    let r = await db.run(
        "INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'HOTPATH_TEST_' + stamp, '2026-01-01', '2099-12-31', '테스트장'
    );
    fx.compId = r.lastInsertRowid;

    // 2) 트랙 종목 — 기록 입력 가능하도록 in_progress
    r = await db.run(
        "INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'in_progress')",
        fx.compId, '100m'
    );
    fx.eventId = r.lastInsertRowid;

    // 3) 선수
    r = await db.run(
        "INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')",
        fx.compId, '홍길동', '101', '테스트팀'
    );
    fx.athleteId = r.lastInsertRowid;

    // 4) 출전 엔트리
    r = await db.run(
        "INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')",
        fx.eventId, fx.athleteId
    );
    fx.entryId = r.lastInsertRowid;

    // 5) 조 + 6) 조 배정(레인)
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.eventId);
    fx.heatId = r.lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', fx.heatId, fx.entryId);
});

describe('POST /api/results/upsert — hot-path', () => {
    it('정상 기록 입력 시 200 + DB 에 저장된다', async () => {
        const res = await request(app)
            .post('/api/results/upsert')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, time_seconds: 11.52 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);

        const row = await db.get(
            'SELECT * FROM result WHERE heat_id=? AND event_entry_id=?',
            fx.heatId, fx.entryId
        );
        expect(row).toBeTruthy();
        expect(row.time_seconds).toBeCloseTo(11.52, 2);
    });

    it('같은 엔트리에 재입력하면 새 값으로 갱신된다 (upsert)', async () => {
        const res = await request(app)
            .post('/api/results/upsert')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, time_seconds: 11.30 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);

        const rows = await db.all(
            'SELECT * FROM result WHERE heat_id=? AND event_entry_id=?',
            fx.heatId, fx.entryId
        );
        // 중복 누적이 아니라 갱신이어야 함
        expect(rows.length).toBe(1);
        expect(rows[0].time_seconds).toBeCloseTo(11.30, 2);
    });

    it('음수/0 등 비정상 기록은 400 으로 거부된다', async () => {
        const res = await request(app)
            .post('/api/results/upsert')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, time_seconds: -5 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(400);
    });

    it('DNS 상태코드는 정상 처리된다', async () => {
        const res = await request(app)
            .post('/api/results/upsert')
            .send({ heat_id: fx.heatId, event_entry_id: fx.entryId, status_code: 'DNS' })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);
    });
});
