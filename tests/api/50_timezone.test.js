/**
 * 대회 시간대(competition.timezone, lib/tz.js) — '오늘' 판정이 대회마다 자기 시간대로 (2026-09-30)
 *   UTC 2026-10-01 02:00 → 서울 10/1 11:00, LA 9/30 19:00. end_date 9/30 인 대회: 서울은 종료, LA 는 아직 진행 중
 */
const request = require('supertest');
const TZ = require('../../lib/tz');
let app, db; const ADMIN = 'testadmin1234', OP = 'testopkey';

describe('대회 시간대', () => {
    beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready; });
    afterEach(() => { vi.useRealTimers(); });

    it('lib/tz: todayIn/nowIn/hhmmIn/shiftYmd', () => {
        const at = new Date('2026-10-01T02:00:00Z');
        expect(TZ.todayIn('Asia/Seoul', at)).toBe('2026-10-01');
        expect(TZ.todayIn('America/Los_Angeles', at)).toBe('2026-09-30');
        expect(TZ.nowIn('America/Los_Angeles', at)).toMatchObject({ hm: '19:00', minutes: 19 * 60 });
        expect(TZ.nowStrIn('Asia/Seoul', at)).toBe('2026-10-01 11:00:00');
        expect(TZ.hhmmIn('2026-09-25T19:55:00', 'Asia/Tokyo')).toBe('19:55');          // 오프셋 없음 → 그대로
        expect(TZ.hhmmIn('2026-09-25T10:55:00Z', 'Asia/Tokyo')).toBe('19:55');         // Z → 환산
        expect(TZ.ymdIn('2026-09-25T23:30:00+09:00', 'Europe/London')).toBe('2026-09-25');
        expect(TZ.shiftYmd('2026-09-30', 1)).toBe('2026-10-01');
        expect(TZ.isValidTz('Europe/Paris')).toBe(true); expect(TZ.isValidTz('Mars/Olympus')).toBe(false);
        expect(TZ.compTz({ timezone: 'bogus' })).toBe(TZ.DEFAULT_TZ);
    });

    it('생성·수정: timezone 저장, 잘못된 이름은 400, 기본값 Asia/Seoul', async () => {
        const r = await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'LA 대회', start_date: '2026-09-28', end_date: '2026-09-30', timezone: 'America/Los_Angeles' });
        expect(r.status).toBe(200); expect(r.body.timezone).toBe('America/Los_Angeles');
        const bad = await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'X', start_date: '2026-09-28', end_date: '2026-09-30', timezone: 'Mars/Olympus' });
        expect(bad.status).toBe(400);
        const dflt = await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '서울 대회', start_date: '2026-09-28', end_date: '2026-09-30' });
        expect(dflt.body.timezone).toBe('Asia/Seoul');
        const up = await request(app).put(`/api/competitions/${dflt.body.id}`).send({ admin_key: OP, timezone: 'Europe/Paris' });
        expect(up.status).toBe(200);
        expect((await db.get('SELECT timezone FROM competition WHERE id=?', dflt.body.id)).timezone).toBe('Europe/Paris');
        // timezone 을 안 보내면 유지
        await request(app).put(`/api/competitions/${dflt.body.id}`).send({ admin_key: OP, venue: '파리' });
        expect((await db.get('SELECT timezone FROM competition WHERE id=?', dflt.body.id)).timezone).toBe('Europe/Paris');
    });

    it('자동 상태 전환·종료 잠금·시간표 오늘이 대회 시간대를 따른다', async () => {
        const seoul = (await db.run("INSERT INTO competition (name, start_date, end_date, status, timezone) VALUES ('서울', '2026-09-28', '2026-09-30', 'active', 'Asia/Seoul')")).lastInsertRowid;
        const la = (await db.run("INSERT INTO competition (name, start_date, end_date, status, timezone) VALUES ('LA', '2026-09-28', '2026-09-30', 'active', 'America/Los_Angeles')")).lastInsertRowid;
        const laNext = (await db.run("INSERT INTO competition (name, start_date, end_date, status, timezone) VALUES ('LA 내일', '2026-10-01', '2026-10-02', 'upcoming', 'America/Los_Angeles')")).lastInsertRowid;
        for (const c of [seoul, la]) await db.run("INSERT INTO timetable (competition_id, day, time, event_name, scheduled_date) VALUES (?, 3, '19:30', '100m', '2026-09-30')", c);
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T02:00:00Z'));
        await request(app).get('/api/competitions');   // auto-status
        expect((await db.get('SELECT status FROM competition WHERE id=?', seoul)).status).toBe('completed');   // 서울은 10/1
        expect((await db.get('SELECT status FROM competition WHERE id=?', la)).status).toBe('active');         // LA 는 아직 9/30
        expect((await db.get('SELECT status FROM competition WHERE id=?', laNext)).status).toBe('upcoming');   // LA 10/1 은 아직 안 왔다
        const tt = await request(app).get(`/api/timetable/${la}/today`);
        expect(tt.status).toBe(200); expect(tt.body.length).toBe(1);                  // LA 는 9/30 이 오늘
        const ttSeoul = await request(app).get(`/api/timetable/${seoul}/today`);
        expect(ttSeoul.body.length).toBe(0);                                          // 서울은 10/1 → 9/30 시간표 없음
    });
});

describe('대회명 영문·일문 (name_en/name_ja) → /api/labels text', () => {
    let app, db; const ADMIN = 'testadmin1234', OP = 'testopkey';
    beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready; });
    it('저장·수정되고 /api/labels?lang=en 의 text 에 원문→영문으로 실린다', async () => {
        const r = await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '2026 아이치 나고야 아시안게임 육상 (테스트)', start_date: '2026-09-23', end_date: '2026-09-29', name_en: '2026 Aichi-Nagoya Asian Games Athletics', name_ja: '2026愛知・名古屋アジア競技大会 陸上競技' });
        expect(r.status).toBe(200); expect(r.body.name_en).toBe('2026 Aichi-Nagoya Asian Games Athletics');
        const en = (await request(app).get('/api/labels').query({ lang: 'en' })).body;
        expect(en.text['2026 아이치 나고야 아시안게임 육상 (테스트)']).toBe('2026 Aichi-Nagoya Asian Games Athletics');
        const ja = (await request(app).get('/api/labels').query({ lang: 'ja' })).body;
        expect(ja.text['2026 아이치 나고야 아시안게임 육상 (테스트)']).toBe('2026愛知・名古屋アジア競技大会 陸上競技');
        await request(app).put(`/api/competitions/${r.body.id}`).send({ admin_key: OP, name_en: '' });
        expect((await request(app).get('/api/labels').query({ lang: 'en' })).body.text['2026 아이치 나고야 아시안게임 육상 (테스트)']).toBeUndefined();
        expect((await db.get('SELECT name_ja FROM competition WHERE id=?', r.body.id)).name_ja).toBe('2026愛知・名古屋アジア競技大会 陸上競技');   // 안 보낸 열은 유지
    });
});
