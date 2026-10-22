/**
 * 공개 읽기 API v1 (2026-10-12): 외부 API 키로 대회·종목·선수·스타트리스트·순위표 읽기, 조직·대회 범위, 명세
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234';

describe('공개 읽기 API v1', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'V1 대회', name_en: 'V1 Meet', start_date: '2026-11-01', end_date: '2026-11-02', venue: '잠실' })).body.id;
        fx.hidden = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '숨김 대회', start_date: '2026-11-05', end_date: '2026-11-06' })).body.id;
        await request(app).put(`/api/competitions/${fx.hidden}/home-visibility`).send({ admin_key: ADMIN, home_visibility: 'hidden' });
        fx.ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status, sort_order) VALUES (?, '100m', 'track', 'M', '일반', 'final', 'completed', 1)", fx.comp)).lastInsertRowid;
        fx.heat = (await db.run('INSERT INTO heat (event_id, heat_number, wind) VALUES (?, 1, 1.2)', fx.ev)).lastInsertRowid;
        const mk = async (name, bib, t, lane, status) => {
            const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender, date_of_birth, phone) VALUES (?,?,?, 'T', 'M', '2000-01-01', '01012345678')", fx.comp, name, bib)).lastInsertRowid;
            const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.ev, a)).lastInsertRowid;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', fx.heat, ee, lane);
            if (t != null) await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds, status_code) VALUES (?,?,?,?)', fx.heat, ee, t, status || null);
            return ee;
        };
        await mk('빠른이', '1', 10.52, 3); await mk('둘째', '2', 10.80, 4); await mk('동률', '3', 10.80, 5); await mk('실격', '4', 10.10, 6, 'DQ');
        const k = await request(app).post('/api/admin/external-keys').send({ admin_key: ADMIN, label: 'scoreboard vendor' });
        fx.key = k.body.api_key; expect(fx.key).toBeTruthy();
        fx.keyOne = (await request(app).post('/api/admin/external-keys').send({ admin_key: ADMIN, label: 'one comp', allowed_competition_id: fx.hidden })).body.api_key;
    });
    const get = (url, key) => request(app).get(url).set('X-API-Key', key || fx.key);

    it('키 없으면 401, 명세는 키 없이', async () => {
        expect((await request(app).get('/api/v1/competitions')).status).toBe(401);
        const spec = await request(app).get('/api/v1/openapi.json');
        expect(spec.status).toBe(200); expect(spec.body.openapi).toBe('3.0.3'); expect(Object.keys(spec.body.paths)).toContain('/api/v1/events/{id}/results');
    });

    it('대회 목록(숨김 제외)·상세', async () => {
        const r = await get('/api/v1/competitions');
        expect(r.status).toBe(200); expect(r.body.success).toBe(true); expect(r.body.meta.version).toBe('v1');
        const ids = r.body.data.map(c => c.id); expect(ids).toContain(fx.comp); expect(ids).not.toContain(fx.hidden);
        const d = await get(`/api/v1/competitions/${fx.comp}`);
        expect(d.body.data).toMatchObject({ id: fx.comp, name: 'V1 대회', name_en: 'V1 Meet', venue: '잠실', event_count: 1, athlete_count: 4 });
        expect(d.body.data.status_label).toBeTruthy();
    });

    it('종목·선수(개인정보 없음)·스타트리스트', async () => {
        const ev = await get(`/api/v1/competitions/${fx.comp}/events`);
        expect(ev.body.data[0]).toMatchObject({ id: fx.ev, code: '100', name_en: '100m', gender: 'M', round: 'final', round_status: 'completed', heat_count: 1, entry_count: 4, wind_affected: true });
        const at = await get(`/api/v1/competitions/${fx.comp}/athletes`);
        expect(at.body.data).toHaveLength(4); expect(at.body.data[0]).toMatchObject({ bib: '1', name: '빠른이', team: 'T' });
        expect(Object.keys(at.body.data[0])).not.toContain('date_of_birth'); expect(JSON.stringify(at.body)).not.toContain('01012345678');
        const sl = await get(`/api/v1/events/${fx.ev}/startlist`);
        expect(sl.body.data.heats[0].heat_number).toBe(1); expect(sl.body.data.heats[0].entries.map(e => e.lane)).toEqual([3, 4, 5, 6]);
        expect(sl.body.data.heats[0].entries[0]).toMatchObject({ bib: '1', status: 'checked_in' });
    });

    it('순위표: 동률 같은 순위, DQ 는 순위 없음, 숫자·문자 기록 둘 다', async () => {
        const r = await get(`/api/v1/events/${fx.ev}/results`);
        expect(r.status).toBe(200);
        const rows = r.body.data.results;
        expect(rows.map(x => [x.bib, x.rank, x.mark])).toEqual([['1', 1, '10.52'], ['2', 2, '10.80'], ['3', 2, '10.80'], ['4', null, null]]);
        expect(rows[0]).toMatchObject({ time_seconds: 10.52, heat_number: 1, lane: 3, wind: 1.2 });
        expect(rows[3]).toMatchObject({ status: 'DQ', status_label: 'DQ' });
        const latest = await get(`/api/v1/competitions/${fx.comp}/results/latest?limit=5`);
        expect(latest.body.data).toHaveLength(1); expect(latest.body.data[0].event.id).toBe(fx.ev); expect(latest.body.data[0].results[0].rank).toBe(1);
    });

    it('대회 전용 키는 그 대회만, 다른 조직 키는 404', async () => {
        expect((await get(`/api/v1/competitions/${fx.comp}`, fx.keyOne)).status).toBe(403);
        expect((await get('/api/v1/competitions', fx.keyOne)).body.data.map(c => c.id)).toEqual([]);   // 숨김 대회 전용이라 목록엔 안 나옴
        expect((await get(`/api/v1/competitions/${fx.hidden}/events`, fx.keyOne)).status).toBe(200);
        await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'v1jp', name: 'JP', country: 'JP' });
        const jpKey = (await request(app).post('/api/admin/external-keys').set('Host', 'v1jp.localhost').send({ admin_key: ADMIN, label: 'jp' })).body.api_key;
        expect(jpKey).toBeTruthy();
        expect((await get(`/api/v1/competitions/${fx.comp}`, jpKey)).status).toBe(403);
        expect((await get(`/api/v1/events/${fx.ev}/results`, jpKey)).status).toBe(403);
        expect((await get('/api/v1/events/999999', fx.key)).status).toBe(404);
    });
});
