/**
 * 다음 대회 복제 (POST /api/competitions/:id/clone) — Phase 3-⑦ (2026-09)
 *   종목 구조(세부종목 포함, 출전·조·기록 없이)·문서 양식·상장 양식·시간표 틀을 새 대회로. 선수·기록은 복사하지 않는다.
 */
const request = require('supertest');
let app, db; const fx = {}; const ADMIN = 'testadmin1234', OP = 'testopkey';

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, federation, division_type) VALUES (?,?,?,?, 'completed', 'KJAF', 'middle')", '제1회 복제원본', '2026-04-10', '2026-04-12', '예천')).lastInsertRowid;
    fx.ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status, sort_order) VALUES (?, '100m', 'track', 'M', '중등부', 'final', 'completed', 3)", fx.comp)).lastInsertRowid;
    const pen = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status, sort_order) VALUES (?, '5종경기', 'combined', 'M', '중등부', 'final', 'completed', 9)", fx.comp)).lastInsertRowid;
    await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, parent_event_id, sort_order) VALUES (?, '110mH', 'track', 'M', 'final', 'completed', ?, 1)", fx.comp, pen);
    const heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', fx.ev)).lastInsertRowid;
    const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, '선수', '1', '팀', 'M')", fx.comp)).lastInsertRowid;
    const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.ev, a)).lastInsertRowid;
    await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,11.1)', heat, ee);
    await db.run("INSERT INTO doc_template (competition_id, result_sheet) VALUES (?, ?)", fx.comp, JSON.stringify({ chief_judge: '홍심판' }));
    await db.run("INSERT INTO award_docx_template (scope_key, config, updated_at) VALUES (?, ?, '2026-01-01')", `c${fx.comp}`, JSON.stringify({ signer_org: '중고연맹' }));
    await db.run("INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, event_id) VALUES (?, 2, 'track', '10:00', '100m', 'M', '결승', ?)", fx.comp, fx.ev);
    await db.run("INSERT INTO timetable (competition_id, day, section, time, event_name, category, round) VALUES (?, 1, 'field', '09:00', '멀리뛰기', 'F', '결승')", fx.comp);
});

describe('대회 복제', () => {
    it('관리자만, 이름·날짜 필수', async () => {
        expect((await request(app).post(`/api/competitions/${fx.comp}/clone`).send({ admin_key: OP, name: 'x', start_date: '2027-04-10', end_date: '2027-04-12' })).status).toBe(403);
        expect((await request(app).post(`/api/competitions/${fx.comp}/clone`).send({ admin_key: ADMIN, name: 'x' })).status).toBe(400);
        expect((await request(app).post(`/api/competitions/${fx.comp}/clone`).send({ admin_key: ADMIN, name: 'x', start_date: '2027-04-12', end_date: '2027-04-10' })).status).toBe(400);
    });
    it('종목·세부종목·양식·시간표는 오고, 선수·기록·조는 오지 않는다', async () => {
        const r = await request(app).post(`/api/competitions/${fx.comp}/clone`).send({ admin_key: ADMIN, name: '제2회 복제본', start_date: '2027-04-09', end_date: '2027-04-11' });
        expect(r.status).toBe(200);
        const c = r.body.competition; fx.clone = c.id;
        expect(c).toMatchObject({ name: '제2회 복제본', start_date: '2027-04-09', end_date: '2027-04-11', venue: '예천', federation: 'KJAF', division_type: 'middle', status: 'upcoming' });
        expect(r.body.stats).toMatchObject({ events: 2, sub_events: 1, timetable: 2 });
        const evs = await db.all('SELECT id, name, division, round_status, sort_order, parent_event_id FROM event WHERE competition_id=? ORDER BY id', c.id);
        expect(evs.map(e => e.name)).toEqual(['100m', '5종경기', '110mH']);
        expect(evs.every(e => e.round_status === 'created')).toBe(true);
        expect(evs[0].division).toBe('중등부'); expect(evs[0].sort_order).toBe(3);
        expect(evs[2].parent_event_id).toBe(evs[1].id);                                        // 세부종목은 새 상위 종목에
        expect(Number((await db.get('SELECT COUNT(*) c FROM athlete WHERE competition_id=?', c.id)).c)).toBe(0);
        expect(Number((await db.get('SELECT COUNT(*) c FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=?', c.id)).c)).toBe(0);
        expect(JSON.parse((await db.get('SELECT result_sheet FROM doc_template WHERE competition_id=?', c.id)).result_sheet).chief_judge).toBe('홍심판');
        expect(JSON.parse((await db.get('SELECT config FROM award_docx_template WHERE scope_key=?', `c${c.id}`)).config).signer_org).toBe('중고연맹');
        const tt = await db.all('SELECT day, time, event_name, scheduled_date, event_id FROM timetable WHERE competition_id=? ORDER BY day', c.id);
        expect(tt.map(t => t.scheduled_date)).toEqual(['2027-04-09', '2027-04-10']);          // 새 시작일 기준
        const new100 = await db.get("SELECT id FROM event WHERE competition_id=? AND name='100m'", c.id);
        expect(tt[1].event_id).toBe(new100.id);                                                // 종목 연결은 새 id 로
    });
    it('원본은 그대로', async () => {
        expect(Number((await db.get('SELECT COUNT(*) c FROM result r JOIN heat h ON h.id=r.heat_id JOIN event e ON e.id=h.event_id WHERE e.competition_id=?', fx.comp)).c)).toBe(1);
        expect((await db.get('SELECT status FROM competition WHERE id=?', fx.comp)).status).toBe('completed');
    });
});
