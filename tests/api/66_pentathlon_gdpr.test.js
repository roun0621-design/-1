/**
 * 2026-10-12: ① 5종경기 전용 WA 키(예전엔 10종/7종 키로 채점) ② 개인정보 삭제(익명화) 요청 처리
 */
const request = require('supertest');
let app, db, mod; const OP = 'testopkey', ADMIN = 'testadmin1234';

describe('5종 채점 · 개인정보 삭제', () => {
    const fx = {};
    beforeAll(async () => {
        mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '5종 대회', start_date: '2026-11-01', end_date: '2026-11-02' })).body.id;
    });

    it('waKeysFor: 5종은 성별별 5개 키, 10종/7종은 그대로', () => {
        expect(mod.waKeysFor({ name: '5종경기', gender: 'M' })).toEqual(['M_100m', 'M_shot_put', 'M_110m_hurdles', 'M_high_jump', 'M_800m']);
        expect(mod.waKeysFor({ name: '5종경기', gender: 'F' })).toEqual(['F_100m', 'F_shot_put', 'F_100m_hurdles', 'F_high_jump', 'F_800m']);
        expect(mod.waKeysFor({ name: '10종경기', gender: 'M' })).toHaveLength(10);
        expect(mod.waKeysFor({ name: '7종경기', gender: 'F' })).toHaveLength(7);
        expect(mod.calcWAPoints('M_800m', 120)).toBe(Math.floor(0.13279 * Math.pow(235 - 120, 1.85)));
        expect(mod.calcWAPoints('F_100m', 12.5)).toBe(Math.floor(17.857 * Math.pow(21 - 12.5, 1.81)));
    });

    it('5종 세부종목(800m) 기록 저장 → combined_score 에 M_800m 계수로 점수', async () => {
        const parent = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, code) VALUES (?, '5종경기', 'combined', 'M', 'final', 'in_progress', 'PEN')", fx.comp)).lastInsertRowid;
        const subs = [['100m', 'track'], ['포환던지기', 'field_distance'], ['110mH', 'track'], ['높이뛰기', 'field_height'], ['800m', 'track']];
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, '오종', '5', 'T', 'M')", fx.comp)).lastInsertRowid;
        await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", parent, a);
        const subIds = [];
        for (let i = 0; i < subs.length; i++) {
            const id = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, parent_event_id, sort_order) VALUES (?,?,?, 'M', 'final', 'in_progress', ?, ?)", fx.comp, `[5종] ${subs[i][0]}`, subs[i][1], parent, i + 1)).lastInsertRowid;
            const heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', id)).lastInsertRowid;
            const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", id, a)).lastInsertRowid;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', heat, ee);
            subIds.push({ id, heat, ee });
        }
        const r = await request(app).post('/api/results/upsert').send({ admin_key: OP, heat_id: subIds[4].heat, event_entry_id: subIds[4].ee, time_seconds: 120 });
        expect(r.status).toBe(200);
        const parentEntry = await db.get('SELECT id FROM event_entry WHERE event_id=? AND athlete_id=?', parent, a);
        const cs = await db.get('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=5', parentEntry.id);
        expect(cs).toBeTruthy();
        expect(cs.wa_points).toBe(mod.calcWAPoints('M_800m', 120));
        expect(cs.wa_points).not.toBe(mod.calcWAPoints('M_400m', 120));   // 예전 버그: 5번째 = 10종의 400m 키
    });

    it('개인정보 삭제: 이름 비공개·연락처/이메일/생년월일 삭제, 기록은 보존, 운영키는 403', async () => {
        const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '100m', 'track', 'F', 'final', 'completed')", fx.comp)).lastInsertRowid;
        const heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', ev)).lastInsertRowid;
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender, phone, email, date_of_birth, barcode) VALUES (?, '김개인', '9', 'T', 'F', '01012345678', 'p@example.com', '2001-02-03', 'BC9')", fx.comp)).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", ev, a)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,3)', heat, ee);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,12.34)', heat, ee);
        await db.run("INSERT INTO sms_log (competition_id, athlete_id, phone_number, message, status, provider, sent_at) VALUES (?,?,?, 'm', 'sent', 'aligo', '2026-10-01')", fx.comp, a, '01012345678');
        expect((await request(app).post(`/api/admin/athletes/${a}/anonymize`).send({ admin_key: OP })).status).toBe(403);
        const r = await request(app).post(`/api/admin/athletes/${a}/anonymize`).send({ admin_key: ADMIN });
        expect(r.status).toBe(200);
        expect(r.body.athlete).toMatchObject({ name: '비공개 선수', phone: '', email: '', date_of_birth: '', barcode: '', bib_number: '9', team: 'T' });
        expect((await db.get('SELECT time_seconds FROM result WHERE event_entry_id=?', ee)).time_seconds).toBe(12.34);
        expect((await db.get('SELECT phone_number FROM sms_log WHERE athlete_id=?', a)).phone_number).toBe('***');
        expect((await db.get("SELECT COUNT(*) AS n FROM operation_log WHERE message LIKE '개인정보 삭제 처리%'")).n).toBeGreaterThan(0);
        expect((await request(app).post('/api/admin/athletes/999999/anonymize').send({ admin_key: ADMIN })).status).toBe(404);
    });
});
