/**
 * 대회 운영 체크리스트 — GET /api/admin/competitions/:id/readiness
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234', OP = 'testopkey';
const fx = {};
beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    fx.empty = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, '2099-01-01', '2099-01-03', 'x', 'upcoming')", 'RD_EMPTY_' + Date.now())).lastInsertRowid;
    fx.done = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, '2026-01-01', '2026-01-03', 'x', 'completed')", 'RD_DONE_' + Date.now())).lastInsertRowid;
    const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '100m', 'track', 'M', 'preliminary', 'completed')", fx.done)).lastInsertRowid;
    await db.run("INSERT INTO heat (event_id, heat_number, scoreboard_key) VALUES (?, 1, '남자 100m 예선 1조')", ev);
    await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, 'A', '', 'T', 'M')", fx.done);
});
const get = (id, key) => request(app).get(`/api/admin/competitions/${id}/readiness`).set('x-admin-key', key);
const find = (body, key) => body.groups.flatMap(g => g.items).find(i => i.key === key);

describe('운영 체크리스트', () => {
    it('관리자만', async () => { expect((await get(fx.empty, OP)).status).toBe(403); expect((await get(fx.empty, ADMIN)).status).toBe(200); });
    it('빈 대회(대회 전): 명단·종목은 문제, 시리즈·시간표는 확인, 당일 그룹은 없음', async () => {
        const r = await get(fx.empty, ADMIN); const b = r.body;
        expect(b.phase).toBe('before');
        expect(find(b, 'roster').status).toBe('fail'); expect(find(b, 'events').status).toBe('fail');
        expect(find(b, 'series').status).toBe('warn'); expect(find(b, 'timetable').status).toBe('warn');
        expect(b.groups.map(g => g.key)).toEqual(['prep', 'ops', 'after']);
        expect(b.summary.fail).toBeGreaterThanOrEqual(2);
    });
    it('종료된 대회: 잠금 정상, 예선만 끝나고 결승이 없는 종목·배번 없는 선수를 잡아낸다', async () => {
        const b = (await get(fx.done, ADMIN)).body;
        expect(b.phase).toBe('after');
        expect(find(b, 'closed').status).toBe('ok');
        expect(find(b, 'nextround').status).toBe('warn'); expect(find(b, 'nextround').detail).toContain('1개');
        expect(find(b, 'bib').status).toBe('warn'); expect(find(b, 'bib').detail).toContain('1명');
        expect(find(b, 'scoreboard').status).toBe('ok');
        expect(find(b, 'offsite').status).toBe('warn');
        expect(find(b, 'snapshot').status).toBe('warn');       // 종료 처리는 됐지만(직접 INSERT) 스냅샷 파일이 없다
    });
});
