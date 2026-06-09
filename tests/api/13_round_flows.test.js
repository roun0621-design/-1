/**
 * 라운드/운영 흐름 통합 테스트 — 준결승 생성 / 소집 완료 / 세부종목 추가
 * 미검증이던 쓰기 경로를 픽스처로 두드려 500 크래시·회귀 방지.
 */
const request = require('supertest');

let app, db;
const ADMIN_KEY = 'testadmin1234'; // global-setup ADMIN_PW

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
});

async function comp() {
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'FLOW_' + Date.now() + '_' + Math.floor(performance.now()), '2026-01-01', '2099-12-31', '장');
    return r.lastInsertRowid;
}

describe('POST /api/events/:id/create-semifinal', () => {
    it('자격자 선택으로 준결승 생성 → 200 + 준결승 종목 생성', async () => {
        const c = await comp();
        let r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'preliminary', 'in_progress')", c, '100m');
        const ev = r.lastInsertRowid;
        r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', ev);
        const heat = r.lastInsertRowid;
        const selections = [];
        for (let i = 0; i < 4; i++) {
            r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, gender) VALUES (?,?,?, 'M')", c, '선수' + i, String(500 + i));
            r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, r.lastInsertRowid);
            const entry = r.lastInsertRowid;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heat, entry, i + 1);
            await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', heat, entry, 11 + i * 0.1);
            selections.push({ event_entry_id: entry, selected: 1 });
        }
        const res = await request(app).post(`/api/events/${ev}/create-semifinal`)
            .send({ group_count: 1, selections }).set('x-admin-key', process.env.OPERATION_KEY).set('Content-Type', 'application/json');
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(200);
        const semi = await db.get("SELECT * FROM event WHERE competition_id=? AND round_type='semifinal' AND id!=?", c, ev);
        expect(semi).toBeTruthy();
    });

    it('자격자(selected) 없으면 400', async () => {
        const c = await comp();
        const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'preliminary', 'in_progress')", c, '200m');
        const res = await request(app).post(`/api/events/${r.lastInsertRowid}/create-semifinal`)
            .send({ group_count: 1, selections: [{ event_entry_id: 1, selected: 0 }] }).set('x-admin-key', process.env.OPERATION_KEY).set('Content-Type', 'application/json');
        expect(res.status).toBe(400);
    });
});

describe('POST /api/events/:id/callroom-complete', () => {
    it('소집 완료 → 200 + 종목 in_progress 전환', async () => {
        const c = await comp();
        let r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'heats_generated')", c, '400m');
        const ev = r.lastInsertRowid;
        r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', ev);
        const heat = r.lastInsertRowid;
        r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, gender) VALUES (?,?,?, 'M')", c, '선수A', '601');
        r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, r.lastInsertRowid);
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', heat, r.lastInsertRowid);

        const res = await request(app).post(`/api/events/${ev}/callroom-complete`)
            .send({ judge_name: '심판A', heat_id: heat }).set('Content-Type', 'application/json');
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(200);
        const updated = await db.get('SELECT round_status FROM event WHERE id=?', ev);
        expect(updated.round_status).toBe('in_progress');
    });
});

describe('POST /api/events/:id/sub-events', () => {
    it('혼성 부모에 세부종목 추가 → 200', async () => {
        const c = await comp();
        const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'combined', 'M', 'final', 'in_progress')", c, '10종경기');
        const res = await request(app).post(`/api/events/${r.lastInsertRowid}/sub-events`)
            .send({ admin_key: ADMIN_KEY, name: '100m', category: 'track' }).set('Content-Type', 'application/json');
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(200);
    });

    it('관리자 키 없으면 403', async () => {
        const c = await comp();
        const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'combined', 'M', 'final', 'in_progress')", c, '7종경기');
        const res = await request(app).post(`/api/events/${r.lastInsertRowid}/sub-events`)
            .send({ name: '100m', category: 'track' }).set('Content-Type', 'application/json');
        expect(res.status).toBe(403);
    });
});
