/**
 * C5·C6 (2026-10-09): 참가기준기록·타깃 타임·승상 높이표(종목 필드), 도로 건타임(result.gun_time), 동시 편집 보호(expected_updated_at)
 */
const request = require('supertest');
let app, db; const OP = 'testopkey', ADMIN = 'testadmin1234';

describe('기준기록·건타임·동시 편집 보호', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'C56 대회', start_date: '2026-11-01', end_date: '2026-11-02' })).body.id;
        fx.ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '10K', 'road', 'M', 'final', 'in_progress')", fx.comp)).lastInsertRowid;
        fx.heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.ev)).lastInsertRowid;
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, '러너', '1', 'T', 'M')", fx.comp)).lastInsertRowid;
        fx.ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.ev, a)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', fx.heat, fx.ee);
    });

    it('종목 필드: 참가기준기록·타깃 타임·승상 높이표 저장·조회 (공백 정리)', async () => {
        const r = await request(app).put(`/api/admin/events/${fx.ev}`).send({ admin_key: OP, entry_standard: ' 31:00 ', target_time: '30:30', height_progression: '1.80, 1.85, 1.90' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ entry_standard: '31:00', target_time: '30:30', height_progression: '1.80,1.85,1.90' });
        // 다른 필드만 바꿔도 유지
        await request(app).put(`/api/admin/events/${fx.ev}`).send({ admin_key: OP, sort_order: 5 });
        expect((await db.get('SELECT entry_standard, height_progression FROM event WHERE id=?', fx.ev))).toEqual({ entry_standard: '31:00', height_progression: '1.80,1.85,1.90' });
        const list = await request(app).get(`/api/events?competition_id=${fx.comp}`);
        const ev = (Array.isArray(list.body) ? list.body : list.body.events || []).find(e => e.id === fx.ev);
        expect(ev.entry_standard).toBe('31:00');
    });

    it('도로 건타임: 넷타임과 따로 저장·보존', async () => {
        const r1 = await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: fx.heat, event_entry_id: fx.ee, time_seconds: 1830.5 });
        expect(r1.status).toBe(200); expect(r1.body.gun_time).toBeNull();
        const r2 = await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: fx.heat, event_entry_id: fx.ee, gun_time: 1835 });
        expect(r2.status).toBe(200); expect(r2.body).toMatchObject({ time_seconds: 1830.5, gun_time: 1835 });
        const r3 = await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: fx.heat, event_entry_id: fx.ee, remark: '메모' });
        expect(r3.body).toMatchObject({ gun_time: 1835, remark: '메모' });
    });

    it('동시 편집 보호: 오래된 updated_at 을 보내면 409, 최신이면 저장', async () => {
        const cur = await db.get('SELECT updated_at FROM result WHERE heat_id=? AND event_entry_id=?', fx.heat, fx.ee);
        const ok = await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: fx.heat, event_entry_id: fx.ee, time_seconds: 1829.0, expected_updated_at: cur.updated_at });
        expect(ok.status).toBe(200);
        // 1초 뒤 다시 저장해 updated_at 이 바뀌도록 (datetime('now') 초 단위)
        await new Promise(r => setTimeout(r, 1100));
        await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: fx.heat, event_entry_id: fx.ee, remark: '다른 입력자' });
        const stale = await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: fx.heat, event_entry_id: fx.ee, time_seconds: 1828.0, expected_updated_at: cur.updated_at });
        expect(stale.status).toBe(409); expect(stale.body.error).toBe('CONFLICT_STALE'); expect(stale.body.server_value.time_seconds).toBe(1829);
        expect((await db.get('SELECT time_seconds FROM result WHERE heat_id=? AND event_entry_id=?', fx.heat, fx.ee)).time_seconds).toBe(1829);
        // expected_updated_at 없이 보내면 예전처럼 덮어쓴다
        expect((await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: fx.heat, event_entry_id: fx.ee, time_seconds: 1828.0 })).status).toBe(200);
    });
});
