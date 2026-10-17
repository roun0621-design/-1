/**
 * PB/SB 자동 누적 (C4, 2026-10-09)
 *   ① 종목 완료 → 출전 PB/SB 갱신(풍속 초과·DQ 제외, 더 좋을 때만)   ② 다음 대회에서 같은 선수·종목의 PB/SB 끌어오기(같은 조직, 생년월일 매칭)
 */
const request = require('supertest');
let app, db; const OP = 'testopkey', ADMIN = 'testadmin1234';
const PBSB = require('../../lib/pbsb');

describe('PB/SB 누적', () => {
    const fx = {};
    const mkEvent = async (comp, name, cat, g = 'M') => (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?,?,?, 'final', 'in_progress')", comp, name, cat, g)).lastInsertRowid;
    const mkHeat = async (ev, wind, n = 1) => (await db.run('INSERT INTO heat (event_id, heat_number, wind) VALUES (?, ?, ?)', ev, n, wind == null ? null : wind)).lastInsertRowid;
    const mkAth = async (comp, name, dob, pb, sb, team = 'T') => (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender, date_of_birth, personal_best, season_best) VALUES (?,?, '1', ?, 'M', ?, ?, ?)", comp, name, team, dob, pb || '', sb || '')).lastInsertRowid;
    const mkEntry = async (ev, a, heat) => { const id = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", ev, a)).lastInsertRowid; await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', heat, id); return id; };
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.c25 = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '2025 대회', start_date: '2025-06-01', end_date: '2025-06-02' })).body.id;
        fx.c26 = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '2026 대회', start_date: '2026-06-01', end_date: '2026-06-02' })).body.id;
    });

    it('① 100m 완료: 풍속 +2.5 기록은 제외, 합법 기록이 PB·SB 가 된다 / 더 나쁘면 유지 / DQ 제외', async () => {
        const ev = await mkEvent(fx.c25, '100m', 'track');
        const hWindy = await mkHeat(ev, 2.5, 1), hLegal = await mkHeat(ev, 1.0, 2);
        fx.a25 = await mkAth(fx.c25, '홍길동', '2000-01-01', '', '');
        const e1 = await mkEntry(ev, fx.a25, hLegal);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.40)', hWindy, e1);   // 풍속 초과 (다른 조)
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.60)', hLegal, e1);
        const slow = await mkAth(fx.c25, '느린이', '', '10.50', '10.50'); const e2 = await mkEntry(ev, slow, hLegal);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.90)', hLegal, e2);
        const dq = await mkAth(fx.c25, '실격자', '', '', ''); const e3 = await mkEntry(ev, dq, hLegal);
        await db.run("INSERT INTO result (heat_id, event_entry_id, time_seconds, status_code) VALUES (?,?,10.20,'DQ')", hLegal, e3);
        const r = await request(app).post(`/api/events/${ev}/complete`).send({ admin_key: OP, judge_name: '심판' });
        expect(r.status).toBe(200);
        const got = await db.get('SELECT personal_best, season_best FROM event_entry WHERE id=?', e1);
        expect(got).toEqual({ personal_best: '10.60', season_best: '10.60' });
        expect((await db.get('SELECT personal_best FROM athlete WHERE id=?', fx.a25)).personal_best).toBe('10.60');   // 한 종목만 뛰므로 선수 행도
        expect((await db.get('SELECT personal_best FROM event_entry WHERE id=?', e2)).personal_best).toBe('');            // 10.90 은 10.50 보다 나쁨 → 그대로(엔트리는 비어 있고 선수 PB 10.50 유지)
        expect((await db.get('SELECT personal_best FROM event_entry WHERE id=?', e3)).personal_best).toBe('');
    });

    it('① 필드: 멀리뛰기 7.70 은 PB 7.80 보다 나쁨 → 유지, 높이뛰기 1.95 O 가 PB', async () => {
        const lj = await mkEvent(fx.c25, '멀리뛰기', 'field_distance', 'F'); const hl = await mkHeat(lj, 0.5);
        const a = (await db.run("INSERT INTO athlete (competition_id, name, team, gender, personal_best) VALUES (?, '점프', 'T', 'F', '7.80')", fx.c25)).lastInsertRowid;
        const e = await mkEntry(lj, a, hl);
        await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters) VALUES (?,?,1,7.70)', hl, e);
        expect(await PBSB.updateEntryMarks(db, await db.get('SELECT * FROM event WHERE id=?', lj))).toEqual({ pb: 0, sb: 1 });
        expect((await db.get('SELECT personal_best, season_best FROM event_entry WHERE id=?', e))).toEqual({ personal_best: '', season_best: '7.70' });
        const hj = await mkEvent(fx.c25, '높이뛰기', 'field_height'); const hh = await mkHeat(hj, null);
        const b = (await db.run("INSERT INTO athlete (competition_id, name, team, gender) VALUES (?, '높이', 'T', 'M')", fx.c25)).lastInsertRowid;
        const eh = await mkEntry(hj, b, hh);
        for (const [h, m] of [[1.90, 'O'], [1.95, 'O'], [2.00, 'X']]) await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,1,?)', hh, eh, h, m);
        await PBSB.updateEntryMarks(db, await db.get('SELECT * FROM event WHERE id=?', hj));
        expect((await db.get('SELECT personal_best FROM event_entry WHERE id=?', eh)).personal_best).toBe('1.95');
    });

    it('② 2026 대회에 같은 선수(이름+생년월일)가 100m 에 나오면 2025 PB 를 끌어오고 SB 는 해가 달라 비움', async () => {
        const ev26 = await mkEvent(fx.c26, '100m', 'track'); const h = await mkHeat(ev26, null);
        const a26 = await mkAth(fx.c26, '홍길동', '2000-01-01', '', '');
        const e26 = await mkEntry(ev26, a26, h);
        const other = await mkAth(fx.c26, '홍길동', '1999-05-05', '', '', 'U'); const eo = await mkEntry(ev26, other, h);   // 동명이인(생년월일 다름)
        const r = await request(app).post(`/api/competitions/${fx.c26}/marks/carry-over`).send({ admin_key: OP });
        expect(r.status).toBe(200); expect(r.body.entries).toBe(1); expect(r.body.pb).toBe(1); expect(r.body.sb).toBe(0);
        expect((await db.get('SELECT personal_best, season_best FROM event_entry WHERE id=?', e26))).toEqual({ personal_best: '10.60', season_best: '' });
        expect((await db.get('SELECT personal_best FROM event_entry WHERE id=?', eo)).personal_best).toBe('');
        // 다른 조직의 대회는 보지 않는다
        await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'jp', name: 'JP', country: 'JP' });
        const cjp = (await request(app).post('/api/competitions').set('Host', 'jp.localhost').send({ admin_key: ADMIN, name: 'JP 2026', start_date: '2026-07-01', end_date: '2026-07-02' })).body.id;
        const evj = await mkEvent(cjp, '100m', 'track'); const hj = await mkHeat(evj, null);
        const aj = await mkAth(cjp, '홍길동', '2000-01-01', '', ''); const ej = await mkEntry(evj, aj, hj);
        expect((await request(app).post(`/api/competitions/${cjp}/marks/carry-over`).set('Host', 'jp.localhost').send({ admin_key: ADMIN })).body.entries).toBe(0);
        expect((await db.get('SELECT personal_best FROM event_entry WHERE id=?', ej)).personal_best).toBe('');
    });
});
