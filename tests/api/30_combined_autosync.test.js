/**
 * 종합경기 세부종목 기록 저장 → combined_score 서버 자동 동기화
 *   results.js 의 _syncCombinedScoresForAthlete 가 DECATHLON_KEYS/HEPTATHLON_KEYS 를 쓰는데
 *   mount deps 에 주입되지 않아 ReferenceError 로 조용히 실패 → 종합 점수가 안 붙던 버그 (2026-09 예천 검증에서 발견).
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
// (2026-09) 쓰기 가드: 모든 변경 요청은 운영키가 필요 → 테스트도 심판 세션처럼 x-admin-key 를 보낸다

let app, db;
const fx = {};

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db;
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'CMB_SYNC_' + Date.now(), '2026-01-01', '2099-12-31', '예천');
    fx.compId = r.lastInsertRowid;
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'combined', 'M', 'final', 'in_progress')", fx.compId, '10종경기');
    fx.parent = r.lastInsertRowid;
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, parent_event_id, sort_order) VALUES (?,?, 'track', 'M', 'final', 'in_progress', ?, 1)", fx.compId, '[10종] 100m', fx.parent);
    fx.sub = r.lastInsertRowid;
    r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.compId, '이정수', '237', '진주시청');
    fx.ath = r.lastInsertRowid;
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.parent, fx.ath);
    fx.parentEntry = r.lastInsertRowid;
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.sub, fx.ath);
    fx.subEntry = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.sub);
    fx.heat = r.lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,3)', fx.heat, fx.subEntry);
});

describe('세부종목 기록 → combined_score 자동 동기화', () => {
    it('100m 11.20 저장 시 부모 combined_score 1번에 WA 점수가 붙는다', async () => {
        const res = await request(app).post('/api/results/upsert').set('x-admin-key', 'testopkey').send({ heat_id: fx.heat, event_entry_id: fx.subEntry, time_seconds: 11.2 });
        expect(res.status).toBe(200);
        const cs = await db.get('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=1', fx.parentEntry);
        expect(cs).toBeTruthy();
        expect(cs.raw_record).toBeCloseTo(11.2, 5);
        expect(cs.wa_points).toBeGreaterThan(700);
    });
});
