/**
 * 쓰기 흐름 통합 테스트 — 자격선발 / 높이뛰기 입력
 *
 * 라운드 진행(자격선발)과 필드 높이 종목(O/X/PASS)은 핵심 운영 경로인데
 * 커버리지가 없었다. upsert(ON CONFLICT, SQLite/PG 분기)·시기 기록 저장을 고정.
 */
const request = require('supertest');

let app, db;

async function comp() {
    const r = await db.run(
        "INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'WRITE_TEST_' + Date.now() + '_' + Math.floor(performance.now()), '2026-01-01', '2099-12-31', '장'
    );
    return r.lastInsertRowid;
}
async function eventOf(compId, category) {
    const r = await db.run(
        "INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?,?, 'M', 'final', 'in_progress')",
        compId, category === 'field_height' ? '높이뛰기' : '100m', category
    );
    return r.lastInsertRowid;
}
async function entryOf(compId, eventId, i) {
    let r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, gender) VALUES (?,?,?, 'M')", compId, '선수' + i, String(200 + i));
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", eventId, r.lastInsertRowid);
    return r.lastInsertRowid;
}

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
});

describe('POST /api/qualifications/save', () => {
    it('선발 저장 시 200 + DB 반영 (upsert)', async () => {
        const c = await comp();
        const ev = await eventOf(c, 'track');
        const e1 = await entryOf(c, ev, 1);
        const res = await request(app)
            .post('/api/qualifications/save')
            .send({ event_id: ev, selections: [{ event_entry_id: e1, selected: 1, qualification_type: 'Q' }] })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);

        const row = await db.get('SELECT * FROM qualification_selection WHERE event_id=? AND event_entry_id=?', ev, e1);
        expect(row).toBeTruthy();
        expect(row.selected).toBe(1);
    });

    it('같은 선발 재저장 시 갱신(중복 누적 없음)', async () => {
        const c = await comp();
        const ev = await eventOf(c, 'track');
        const e1 = await entryOf(c, ev, 1);
        const send = (sel) => request(app).post('/api/qualifications/save')
            .send({ event_id: ev, selections: [{ event_entry_id: e1, selected: sel, qualification_type: 'q' }] })
            .set('Content-Type', 'application/json');
        await send(1);
        await send(0);
        const rows = await db.all('SELECT * FROM qualification_selection WHERE event_id=? AND event_entry_id=?', ev, e1);
        expect(rows.length).toBe(1);
        expect(rows[0].selected).toBe(0);
    });
});

describe('POST /api/height-attempts/save', () => {
    it("높이뛰기 'O'(성공) 저장 시 200 + DB 반영", async () => {
        const c = await comp();
        const ev = await eventOf(c, 'field_height');
        const e1 = await entryOf(c, ev, 1);
        let r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', ev);
        const heatId = r.lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id) VALUES (?,?)', heatId, e1);

        const res = await request(app)
            .post('/api/height-attempts/save')
            .send({ heat_id: heatId, event_entry_id: e1, bar_height: 1.80, attempt_number: 1, result_mark: 'O' })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);

        const row = await db.get('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? AND bar_height=?', heatId, e1, 1.80);
        expect(row).toBeTruthy();
        expect(row.result_mark).toBe('O');
    });

    it('필수 필드 누락 시 400', async () => {
        const res = await request(app)
            .post('/api/height-attempts/save')
            .send({ heat_id: 1 })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(400);
    });
});
