/**
 * 되돌리기 (lib/undo.js · /api/undo) — Phase 6 (2026-09)
 *   기록 전체 초기화 · 선수 삭제 · 종목 삭제 · 조 삭제 가 24시간 안에 그대로 되살아난다 (같은 id, 같은 값).
 *   전에는 잘못 누르면 백업 복원뿐이었다.
 */
const request = require('supertest');
let app, db; const fx = {}; const OP = 'testopkey', ADMIN = 'testadmin1234';

async function seedEvent(name, opts = {}) {
    const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?,?, 'M', 'final', 'in_progress')", fx.comp, name, opts.category || 'track')).lastInsertRowid;
    const heat = (await db.run('INSERT INTO heat (event_id, heat_number, wind) VALUES (?,1,?)', ev, '+0.3')).lastInsertRowid;
    const rows = [];
    for (const [n, t] of opts.athletes || [['가', 11.1], ['나', 11.2]]) {
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, n + name, String(100 + rows.length), '팀')).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", ev, a)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heat, ee, rows.length + 1);
        if (t != null) await db.run("INSERT INTO result (heat_id, event_entry_id, time_seconds, remark) VALUES (?,?,?,?)", heat, ee, t, 'r' + n);
        rows.push({ a, ee });
    }
    return { ev, heat, rows };
}
const count = async (sql, ...p) => Number((await db.get(sql, ...p)).c);

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'UNDO_' + Date.now(), '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
});

describe('기록 전체 초기화 → 되돌리기', () => {
    it('초기화 응답에 undo_id, 되돌리면 기록·비고·종목 상태가 그대로', async () => {
        const e = await seedEvent('100m');
        await db.run("UPDATE event SET round_status='completed' WHERE id=?", e.ev);
        const r = await request(app).post('/api/results/reset-sub-event').set('x-admin-key', OP).send({ event_id: e.ev });
        expect(r.status).toBe(200); expect(r.body.deletedResults).toBe(2); expect(r.body.undo_id).toBeTruthy();
        expect(await count('SELECT COUNT(*) c FROM result WHERE heat_id=?', e.heat)).toBe(0);
        const list = await request(app).get('/api/undo').query({ competition_id: fx.comp }).set('x-admin-key', OP);
        expect(list.status).toBe(200); expect(list.body[0]).toMatchObject({ id: r.body.undo_id, kind: 'results_reset' }); expect(list.body[0].label).toContain('100m');
        const u = await request(app).post(`/api/undo/${r.body.undo_id}/restore`).set('x-admin-key', OP).send({});
        expect(u.status).toBe(200); expect(u.body.restored.result).toBe(2); expect(u.body.event_ids).toEqual([e.ev]);
        expect((await db.get('SELECT round_status FROM event WHERE id=?', e.ev)).round_status).toBe('completed');     // 초기화가 바꾼 상태도 원위치
        const rows = await db.all('SELECT event_entry_id, time_seconds, remark FROM result WHERE heat_id=? ORDER BY event_entry_id', e.heat);
        expect(rows).toEqual([{ event_entry_id: e.rows[0].ee, time_seconds: 11.1, remark: 'r가' }, { event_entry_id: e.rows[1].ee, time_seconds: 11.2, remark: 'r나' }]);
        // 두 번은 안 된다, 목록에서도 빠진다
        expect((await request(app).post(`/api/undo/${r.body.undo_id}/restore`).set('x-admin-key', OP).send({})).status).toBe(400);
        const list2 = await request(app).get('/api/undo').query({ competition_id: fx.comp }).set('x-admin-key', OP);
        expect(list2.body.find(x => x.id === r.body.undo_id)).toBeUndefined();
    });
    it('되돌리기 전에 새 기록이 들어갔으면 새 기록이 남고, 나머지만 되살아난다', async () => {
        const e = await seedEvent('200m');
        const r = await request(app).post('/api/results/reset-sub-event').set('x-admin-key', OP).send({ event_id: e.ev });
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', e.heat, e.rows[0].ee, 22.5);   // 새로 입력
        const u = await request(app).post(`/api/undo/${r.body.undo_id}/restore`).set('x-admin-key', OP).send({});
        expect(u.status).toBe(200);
        const rows = await db.all('SELECT event_entry_id, time_seconds FROM result WHERE heat_id=? ORDER BY event_entry_id', e.heat);
        // 같은 선수의 트랙 기록은 한 행(부분 유니크) → 새로 넣은 22.5 가 남고 옛 11.1 은 건너뛴다; 나머지는 되살아난다
        expect(rows).toEqual([{ event_entry_id: e.rows[0].ee, time_seconds: 22.5 }, { event_entry_id: e.rows[1].ee, time_seconds: 11.2 }]);
    });
});

describe('선수·종목·조 삭제 → 되돌리기', () => {
    it('선수 삭제: 선수·출전·조·기록이 같은 id 로 돌아온다', async () => {
        const e = await seedEvent('400m');
        const { a, ee } = e.rows[0];
        const d = await request(app).delete('/api/admin/athletes/' + a).send({ admin_key: OP });
        expect(d.status).toBe(200); expect(d.body.undo_id).toBeTruthy();
        expect(await count('SELECT COUNT(*) c FROM athlete WHERE id=?', a)).toBe(0);
        const u = await request(app).post(`/api/undo/${d.body.undo_id}/restore`).set('x-admin-key', OP).send({});
        expect(u.status).toBe(200); expect(u.body.restored).toMatchObject({ athlete: 1, event_entry: 1, heat_entry: 1, result: 1 });
        expect((await db.get('SELECT name FROM athlete WHERE id=?', a)).name).toBe('가400m');
        expect(await count('SELECT COUNT(*) c FROM result WHERE event_entry_id=?', ee)).toBe(1);
    });
    it('종목 삭제(관리자): 운영키로는 못 되돌리고 관리자는 되돌린다 — 종목·조·출전·기록 전부', async () => {
        const e = await seedEvent('800m');
        const d = await request(app).delete('/api/admin/events/' + e.ev).send({ admin_key: ADMIN });
        expect(d.status).toBe(200); expect(d.body.undo_id).toBeTruthy();
        expect(await count('SELECT COUNT(*) c FROM event WHERE id=?', e.ev)).toBe(0);
        expect((await request(app).post(`/api/undo/${d.body.undo_id}/restore`).set('x-admin-key', OP).send({})).status).toBe(403);
        const u = await request(app).post(`/api/undo/${d.body.undo_id}/restore`).set('x-admin-key', ADMIN).send({});
        expect(u.status).toBe(200); expect(u.body.restored).toMatchObject({ event: 1, heat: 1, event_entry: 2, heat_entry: 2, result: 2 });
        expect((await db.get('SELECT name, round_status FROM event WHERE id=?', e.ev))).toEqual({ name: '800m', round_status: 'in_progress' });
        expect(await count('SELECT COUNT(*) c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', e.ev)).toBe(2);
    });
    it('조 삭제 → 되돌리기 (조·레인·기록)', async () => {
        const e = await seedEvent('1500m');
        const d = await request(app).delete('/api/admin/heats/' + e.heat).send({ admin_key: OP });
        expect(d.status).toBe(200); expect(d.body.undo_id).toBeTruthy();
        const u = await request(app).post(`/api/undo/${d.body.undo_id}/restore`).set('x-admin-key', OP).send({});
        expect(u.status).toBe(200); expect(u.body.restored).toMatchObject({ heat: 1, heat_entry: 2, result: 2 });
        expect(Number((await db.get('SELECT wind FROM heat WHERE id=?', e.heat)).wind)).toBeCloseTo(0.3, 5);
    });
    it('없는 id 는 404, 키 없으면 403, 24시간 지난 것은 400', async () => {
        expect((await request(app).post('/api/undo/999999/restore').set('x-admin-key', OP).send({})).status).toBe(404);
        expect((await request(app).post('/api/undo/1/restore').send({})).status).toBe(403);
        const old = (await db.run("INSERT INTO undo_snapshot (competition_id, kind, label, payload, created_at) VALUES (?,?,?,?,?)", fx.comp, 'x', 'old', '{"meta":{},"data":[]}', '2020-01-01 00:00:00')).lastInsertRowid;
        const r = await request(app).post(`/api/undo/${old}/restore`).set('x-admin-key', OP).send({});
        expect(r.status).toBe(400); expect(r.body.error).toContain('24시간');
        const list = await request(app).get('/api/undo').query({ competition_id: fx.comp }).set('x-admin-key', OP);
        expect(list.body.find(x => x.id === old)).toBeUndefined();
    });
});
