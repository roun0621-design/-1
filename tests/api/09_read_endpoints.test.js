/**
 * 핵심 읽기 엔드포인트 통합 테스트 — 잠복 크래시(500) 탐지
 *
 * 대시보드·결과·모니터 화면을 그리는 조회 API들을 "실제 데이터가 있는"
 * 풀 픽스처로 두드려 본다. 이 경로들이 500 을 내면 곧 버그(추출 누락 헬퍼,
 * 잘못된 SQL 등). 특히 live-results/full-results 는 조·자격·순위를 조립해
 * 잠복 버그가 숨기 쉬운 곳이라 회귀로 고정한다.
 */
const request = require('supertest');

let app, db;
let fx = {};

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;

    let r = await db.run(
        "INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'READ_TEST_' + Date.now(), '2026-01-01', '2099-12-31', '장'
    );
    fx.compId = r.lastInsertRowid;

    r = await db.run(
        "INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'in_progress')",
        fx.compId, '100m'
    );
    fx.eventId = r.lastInsertRowid;

    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.eventId);
    fx.heatId = r.lastInsertRowid;

    // 선수 2명 + 엔트리 + 조배정 + 결과
    for (let i = 0; i < 2; i++) {
        r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')",
            fx.compId, '선수' + i, String(100 + i), '팀' + i);
        const athleteId = r.lastInsertRowid;
        r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.eventId, athleteId);
        const entryId = r.lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', fx.heatId, entryId, i + 1);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', fx.heatId, entryId, 11.5 + i * 0.3);
    }
});

// 헬퍼: 200 (또는 허용된 상태)인지 확인하고 500 이 아님을 보장
async function expectOk(pathStr, allowed = [200]) {
    const res = await request(app).get(pathStr);
    expect([...allowed]).toContain(res.status);
    expect(res.status).not.toBe(500); // 핵심: 크래시 없음
    return res;
}

describe('핵심 읽기 엔드포인트 — 500 크래시 없음', () => {
    it('GET /api/events?competition_id', async () => {
        const res = await expectOk(`/api/events?competition_id=${fx.compId}`);
        expect(Array.isArray(res.body)).toBe(true);
    });
    it('GET /api/events/:id', () => expectOk(`/api/events/${fx.eventId}`));
    it('GET /api/events/:id/entries', async () => {
        const res = await expectOk(`/api/events/${fx.eventId}/entries`);
        expect(Array.isArray(res.body)).toBe(true);
    });
    it('GET /api/events/:id/live-results (조·자격·순위 조립)', () => expectOk(`/api/events/${fx.eventId}/live-results`));
    it('GET /api/events/:id/full-results (종합 순위)', () => expectOk(`/api/events/${fx.eventId}/full-results`));
    it('GET /api/heats?event_id', async () => {
        const res = await expectOk(`/api/heats?event_id=${fx.eventId}`);
        expect(Array.isArray(res.body)).toBe(true);
    });
    it('GET /api/heats/:id/entries', () => expectOk(`/api/heats/${fx.heatId}/entries`));
    it('GET /api/athletes?competition_id', async () => {
        const res = await expectOk(`/api/athletes?competition_id=${fx.compId}`);
        expect(Array.isArray(res.body)).toBe(true);
    });
    it('GET /api/qualifications?event_id', () => expectOk(`/api/qualifications?event_id=${fx.eventId}`));
    it('GET /api/results?heat_id', async () => {
        const res = await expectOk(`/api/results?heat_id=${fx.heatId}`);
        expect(Array.isArray(res.body)).toBe(true);
    });
    it('GET /api/record-breaks?competition_id', () => expectOk(`/api/record-breaks?competition_id=${fx.compId}`, [200]));
});
