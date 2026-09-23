/**
 * 국제대회 동기화 — lib/intl/bornan.js · lib/intl/sync.js · /api/admin/intl (2026-09)
 *   실제 API(2026 나고야 아시안게임 육상)에서 떠 둔 픽스처로: 일정 → 종목·라운드·조·시간표, 엔트리 → 선수(국가)·계주 팀·주자, 결과(가상 형식) → 레인·기록.
 */
const request = require('supertest');
const fs = require('fs'); const path = require('path');
const B = require('../../lib/intl/bornan');
const sync = require('../../lib/intl/sync');
let app, db; const fx = {}; const ADMIN = 'testadmin1234', OP = 'testopkey';
const F = n => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/bornan', n), 'utf8'));
const schedule = F('schedule_ATH.json'), days = F('days.json');

// 픽스처 기반 가짜 API: 일정·KOR 엔트리·두 종목 엔트리·결과(가상)
const fakeResults = {};
const fakeFetch = async (source, tail) => {
    if (tail === 'schedule/days') return days;
    if (tail === 'phases') return F('phases.json');
    let m = tail.match(/^schedule\/daily\/(.+)$/); if (m) return schedule.filter(u => u.DateTimeRaw.startsWith(m[1]));
    m = tail.match(/^entries\/event\/(.+)$/);
    if (m) {
        const key = decodeURIComponent(m[1]);
        if (key === 'W.100M--------------') return F('entries_event_W100M.json');
        if (key === 'M.4X100M------------') return F('entries_event_M4X100M.json');
        const kor = F('entries_org_KOR.json').Events.find(e => e.EvKey === key);
        return kor ? { EvKey: key, Partics: kor.Partics } : { EvKey: key, Partics: [] };
    }
    m = tail.match(/^results\/(.+)$/); if (m) return fakeResults[decodeURIComponent(m[1])] || null;
    return null;
};

describe('어댑터', () => {
    it('일정 272유닛 → 48종목, 라운드·조·세부종목', () => {
        const s = B.parseSchedule(schedule);
        expect(s.events).toHaveLength(48); expect(s.ceremonies).toHaveLength(50);
        const w100 = s.events.find(e => e.gender === 'F' && e.name === '100m');
        expect(w100.rounds.map(r => r.round_type + r.units.length)).toEqual(['preliminary8', 'semifinal3', 'final1']);
        expect(w100.rounds[1].units[0].key).toBe('W.100M--------------.SFNL.000100--');
        const hep = s.events.find(e => e.name === '7종경기');
        expect(hep.category).toBe('combined'); expect(hep.subEvents.map(x => x.name)).toEqual(['100mH', '높이뛰기', '포환던지기', '200m', '멀리뛰기', '창던지기', '800m']);
        expect(s.events.find(e => e.gender === 'X' && /4X400/.test(e.name)).name).toBe('4X400mR(Mixed)');
        expect(s.events.find(e => e.name === '하프마라톤경보').category).toBe('road');
        B.mergePhases(s, F('phases.json'));
        expect(s.events).toHaveLength(50); expect(s.events.find(e => e.name === '마라톤경보' && e.gender === 'M').rounds).toEqual([{ phase: 'FNL-', round_type: 'final', order: 1, units: [] }]);
    });
    it('엔트리: 선수·계주 팀(주자 순서) · 결과 JSON 은 후보 키로 넓게 읽는다', () => {
        const en = B.parseEventEntries(F('entries_event_M4X100M.json'));
        expect(en.teams.length).toBe(14); expect(en.teams[0].members.length).toBeGreaterThanOrEqual(4);
        const w = B.parseEventEntries(F('entries_event_W100M.json'));
        expect(w.athletes.some(a => a.org === 'KOR')).toBe(true); expect(w.athletes[0].gender).toBe('F');
        const r = B.parseResults({ Unit: 'x', Wind: '+0.8', Results: [{ Reg: '1', Name: 'A', Org: 'KOR', Rank: '1', Lane: '4', Result: '10.25', Qual: 'Q', Record: 'GR' }, { Reg: '2', Name: 'B', Org: 'JPN', Lane: '5', IRM: 'DNF' }] });
        expect(r.wind).toBe('+0.8'); expect(r.rows[0]).toMatchObject({ reg: '1', rank: 1, lane: 4, mark: '10.25', qual: 'Q', record: 'GR' }); expect(r.rows[1]).toMatchObject({ status: 'DNF', mark: '' });
        expect(B.parseResults({ Foo: 1 }).rows).toEqual([]);
        expect(B.markToNumber('1:45.30', 'track')).toBeCloseTo(105.3, 5); expect(B.markToNumber('2:08:15', 'road')).toBe(7695); expect(B.markToNumber('7.85', 'field_distance')).toBe(7.85); expect(B.markToNumber('6,123', 'combined')).toBe(6123);
    });
});

describe('서버: 구조 → 엔트리 → 결과', () => {
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db;
        fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, federation) VALUES (?,?,?,?, 'upcoming', 'INTL')", '2026 나고야 아시안게임 육상', '2026-09-23', '2026-09-29', 'Nagoya')).lastInsertRowid;
    });
    it('출처 저장 (관리자), 잘못된 base 는 400', async () => {
        expect((await request(app).put(`/api/admin/intl/${fx.comp}/source`).send({ admin_key: ADMIN, base: 'http://x', champ: 'AG2026' })).status).toBe(400);
        const r = await request(app).put(`/api/admin/intl/${fx.comp}/source`).send({ admin_key: ADMIN, base: 'https://back.results.asiangames2026.org/', champ: 'AG2026', disc: 'ATH', spotlight: 'kor', referer: 'https://results.asiangames2026.org/' });
        expect(r.status).toBe(200); expect(r.body.source).toMatchObject({ provider: 'bornan', base: 'https://back.results.asiangames2026.org', champ: 'AG2026', disc: 'ATH', spotlight: 'KOR', enabled: true });
    });
    it('구조: 48종목(+라운드·세부) · 조 · 시간표, 두 번 돌려도 그대로', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const a = await sync.setupStructure(db, comp, { fetch: fakeFetch });
        expect(a.events).toBe(50); expect(a.stats.heats).toBeGreaterThan(200); expect(a.days).toHaveLength(7);     // 일정 48 + phases 로 보탠 마라톤 경보 남·여 (유닛 없이)
        const b = await sync.setupStructure(db, comp, { fetch: fakeFetch });
        expect(b.stats.heats).toBe(0); expect(b.stats.timetable).toBe(0);
        const evs = await db.all('SELECT name, gender, round_type, category, parent_event_id, external_key FROM event WHERE competition_id=? ORDER BY id', fx.comp);
        const w100 = evs.filter(e => e.name === '100m' && e.gender === 'F');
        expect(w100.map(e => e.round_type)).toEqual(['preliminary', 'semifinal', 'final']);
        const finalHeats = await db.all("SELECT h.heat_number, h.external_key, h.scheduled_at FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND e.external_key='W.100M--------------#SFNL' ORDER BY heat_number", fx.comp);
        expect(finalHeats.map(h => h.heat_number)).toEqual([1, 2, 3]); expect(finalHeats[0].scheduled_at).toBe('2026-09-25T19:13:00+09:00');
        const hep = evs.find(e => e.name === '7종경기'); const subs = evs.filter(e => e.parent_event_id && evs.find(p => p.id === e.parent_event_id));
        expect(evs.filter(e => e.parent_event_id).length).toBeGreaterThanOrEqual(14);      // 7종 7 + 10종(공식 일정에 아직 110mH·원반·장대 유닛이 없음 → 올라오면 setup 이 더한다)
        const tt = await db.all('SELECT day, section, time, event_name, category, round, note, scheduled_date FROM timetable WHERE competition_id=? ORDER BY day, time', fx.comp);
        expect(tt[0]).toMatchObject({ day: 1, section: 'road', time: '07:30', event_name: '하프마라톤경보', category: '남자', round: '결승', scheduled_date: '2026-09-23' });
        expect(tt.find(t => t.event_name === '100m' && t.category === '여자' && t.round === '예선')).toMatchObject({ day: 2, note: '8조' });
        expect(tt.some(t => t.section === 'ceremony')).toBe(false);      // 시상식은 싣지 않는다
    });
    it('엔트리: 여자 100m 전 국가 선수 + 남자 4x100mR 팀·주자, KOR 표시', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const st = await sync.syncEntries(db, comp, { fetch: fakeFetch });
        expect(st.spotlight).toBeGreaterThan(0);
        const w100pre = await db.get("SELECT id FROM event WHERE competition_id=? AND external_key='W.100M--------------#RND1'", fx.comp);
        const entries = await db.all('SELECT a.name, a.team, a.federation, a.gender, a.barcode FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id WHERE ee.event_id=? ORDER BY a.name', w100pre.id);
        expect(entries.length).toBeGreaterThan(20);
        const kor = entries.filter(e => e.team === 'KOR'); expect(kor.map(e => e.name).sort()).toEqual(['KIM Juha', 'SEO Jihyun']);
        expect(kor[0]).toMatchObject({ federation: 'KOR', gender: 'F' }); expect(kor[0].barcode).toMatch(/^BN:\d+$/);
        const relPre = await db.get("SELECT id FROM event WHERE competition_id=? AND external_key='M.4X100M------------#RND1'", fx.comp);
        const teams = await db.all("SELECT a.id, a.name, a.team FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id WHERE ee.event_id=? AND a.barcode LIKE 'RELAY_BN:%'", relPre.id);
        expect(teams.length).toBe(14);
        const korTeam = teams.find(t => t.team === 'KOR'); expect(korTeam.name).toBe('Republic of Korea');
        const members = await db.all('SELECT a.name, rm.leg_order FROM relay_member rm JOIN athlete a ON a.id=rm.athlete_id JOIN event_entry ee ON ee.id=rm.event_entry_id WHERE ee.event_id=? AND ee.athlete_id=? ORDER BY rm.leg_order', relPre.id, korTeam.id);
        expect(members.length).toBeGreaterThanOrEqual(4); expect(members.filter(m => m.leg_order != null).map(m => m.leg_order)).toEqual([1, 2, 3, 4]);   // 5·6번째는 예비(순서 없음)
        // 다시 돌려도 중복 없음
        await sync.syncEntries(db, comp, { fetch: fakeFetch });
        expect((await db.all('SELECT id FROM event_entry WHERE event_id=?', w100pre.id)).length).toBe(entries.length);
    });
    it('엔트리 변경: 공식 명단에서 빠진 선수는 출전이 지워지고(조·기록 없을 때), 계주 주자 교체는 주자 명단을 맞추며, 변경 이력이 남는다', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const w = F('entries_event_W100M.json'), r = F('entries_event_M4X100M.json');
        const gone = w.Partics.find(p => p.Org !== 'KOR');                       // 외국 선수 하나 기권
        const korTeam = r.Partics.find(p => p.Org === 'KOR' && p.hasMembers);      // 계주 팀 하나: 주자 한 명 교체
        const membersKey = 'Members';
        const dropped = korTeam[membersKey][0];
        const altFetch = async (source, tail) => {
            if (tail === 'entries/event/W.100M--------------') return { ...w, Partics: w.Partics.filter(p => p !== gone) };
            if (tail === 'entries/event/M.4X100M------------') return { ...r, Partics: r.Partics.map(p => p === korTeam ? { ...p, [membersKey]: p[membersKey].slice(1) } : p) };
            return fakeFetch(source, tail);
        };
        const st = await sync.syncEntries(db, comp, { fetch: altFetch });
        expect(st.removed).toBeGreaterThanOrEqual(1);
        expect(await db.get("SELECT COUNT(*) c FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id JOIN event e ON e.id=ee.event_id WHERE e.external_key='W.100M--------------#RND1' AND a.barcode=?", 'BN:' + gone.Reg)).toMatchObject({ c: 0 });
        if (korTeam.Org === 'KOR') { expect(st.relay_changed).toBeGreaterThanOrEqual(1); expect(st.changes.some(c => c.type === 'relay')).toBe(true); }
        const state = JSON.parse((await db.get('SELECT sync_state FROM competition WHERE id=?', fx.comp)).sync_state);
        expect(Array.isArray(state.entries_changes)).toBe(true);
        // 원래 명단으로 다시 동기화하면 되살아난다 (added)
        const back = await sync.syncEntries(db, comp, { fetch: fakeFetch });
        expect(back.added).toBeGreaterThanOrEqual(1);
        expect((await db.get("SELECT COUNT(*) c FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id JOIN event e ON e.id=ee.event_id WHERE e.external_key='W.100M--------------#RND1' AND a.barcode=?", 'BN:' + gone.Reg)).c).toBe(1);
    });
    it('결과(가상 형식): 스타트리스트 레인 → 기록·상태·풍속·순위, 화면 규칙으로 정렬', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const kor = F('entries_org_KOR.json').Events.find(e => e.EvKey === 'W.100M--------------').Partics;
        const all = F('entries_event_W100M.json').Partics;
        const unit = 'W.100M--------------.SFNL.000100--';
        fakeResults[unit] = { Key: unit, Wind: '-0.3', Results: [
            { Reg: kor[0].Reg, Name: kor[0].Name, Org: 'KOR', Rank: 2, Lane: 4, Result: '11.42', Qual: 'Q' },
            { Reg: all[3].Reg, Name: all[3].Name, Org: all[3].Org, Rank: 1, Lane: 5, Result: '11.20', Qual: 'Q', Record: 'GR' },
            { Reg: all[1].Reg, Name: all[1].Name, Org: all[1].Org, Lane: 3, IRM: 'DNS' },
        ] };
        const st = await sync.syncResults(db, comp, { fetch: fakeFetch, onlyKeys: [unit] });
        expect(st.updated).toBe(1); expect(st.results).toBe(3);
        const heat = await db.get('SELECT h.id, h.wind, e.id AS ev_id, e.round_status FROM heat h JOIN event e ON e.id=h.event_id WHERE h.external_key=?', unit);
        expect(Number(heat.wind)).toBeCloseTo(-0.3, 5); expect(heat.round_status).toBe('in_progress');
        const { getEventResultsForCert } = require('../../lib/routes/certificate');
        const r = await getEventResultsForCert(heat.ev_id);
        expect(r.rows.map(x => [x.athlete_name, x.rank, x.record_value])).toEqual([[all[3].Name, 1, '11.20'], [kor[0].Name, 2, '11.42'], [all[1].Name, null, 'DNS']]);
        const lane = await db.get('SELECT he.lane_number FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? AND a.barcode=?', heat.id, 'BN:' + kor[0].Reg);
        expect(lane.lane_number).toBe(4);
        expect((await db.get('SELECT remark FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE r.heat_id=? AND a.barcode=?', heat.id, 'BN:' + all[3].Reg)).remark).toBe('GR Q');
        // 모양을 모르는 결과는 unknown 에 남는다
        fakeResults['W.100M--------------.SFNL.000200--'] = { Weird: { Thing: [1, 2] } };
        const st2 = await sync.syncResults(db, comp, { fetch: fakeFetch, onlyKeys: ['W.100M--------------.SFNL.000200--'] });
        expect(st2.unknown[0].shape).toContain('Weird');
        const state = JSON.parse((await db.get('SELECT sync_state FROM competition WHERE id=?', fx.comp)).sync_state);
        expect(state.unknown[0].key).toBe('W.100M--------------.SFNL.000200--');
    });
    it('공식 결과: 조마다 Official 이 들어오면 종목의 모든 조가 공식일 때 라운드 완료 + 결과 알림 훅(completed) — Unofficial 은 완료로 치지 않는다', async () => {
        expect(B.parseResults({ Status: 'Unofficial', Results: [{ Reg: '1', Name: 'A', Result: '10.00' }] }).official).toBe(false);
        expect(B.parseResults({ StatusDesc: 'Official', Results: [{ Reg: '1', Name: 'A', Result: '10.00' }] }).official).toBe(true);
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const all = F('entries_event_W100M.json').Partics.filter(p => p.Org !== 'KOR');   // 한국 선수 결과(다른 테스트가 봄)는 건드리지 않는다
        const units = ['W.100M--------------.SFNL.000100--', 'W.100M--------------.SFNL.000200--', 'W.100M--------------.SFNL.000300--'];
        const mk = (i, status) => ({ Key: units[i], Status: status, Results: [{ Reg: all[10 + i].Reg, Name: all[10 + i].Name, Org: all[10 + i].Org, Rank: 1, Lane: 4, Result: '11.5' + i }] });
        fakeResults[units[0]] = mk(0, 'Official'); fakeResults[units[1]] = mk(1, 'Unofficial'); fakeResults[units[2]] = mk(2, 'Official');
        const done = [];
        await sync.syncResults(db, comp, { fetch: fakeFetch, onlyKeys: units, onApplied: a => { if (a.completed) done.push(a.event_id); } });
        const ev = await db.get("SELECT id, round_status FROM event WHERE competition_id=? AND external_key='W.100M--------------#SFNL'", fx.comp);
        expect(ev.round_status).toBe('in_progress'); expect(done).toEqual([]);           // 2조가 아직 Unofficial
        fakeResults[units[1]] = mk(1, 'Official');
        await sync.syncResults(db, comp, { fetch: fakeFetch, onlyKeys: [units[1]], onApplied: a => { if (a.completed) done.push(a.event_id); } });
        expect((await db.get('SELECT round_status FROM event WHERE id=?', ev.id)).round_status).toBe('completed'); expect(done).toEqual([ev.id]);
        // 다시 읽어도 또 완료 알림을 내지 않는다
        await sync.syncResults(db, comp, { fetch: fakeFetch, onlyKeys: [units[1]], onApplied: a => { if (a.completed) done.push(a.event_id); } });
        expect(done).toEqual([ev.id]);
    });
    it('선수 보조 정보(한글 이름·PB·SB): 영문 이름으로 찾아 넣고, 다음 동기화가 한글 이름을 덮지 않는다', async () => {
        const r = await request(app).post(`/api/admin/intl/${fx.comp}/athlete-info`).send({ admin_key: ADMIN, rows: [
            { 영문이름: 'seo jihyun', 한글이름: '서지현', PB: '11.30', SB: '11.45' }, { name: 'KIM Juha', name_ko: '김주하', pb: '11.36' }, { name: 'NOBODY X', name_ko: '없음' }] });
        expect(r.status).toBe(200); expect(r.body.matched).toBe(2); expect(r.body.unmatched).toEqual(['없음 / NOBODY X']);
        const a = await db.get("SELECT name, name_alt, personal_best, season_best FROM athlete WHERE competition_id=? AND name_alt='SEO Jihyun'", fx.comp);
        expect(a).toEqual({ name: '서지현', name_alt: 'SEO Jihyun', personal_best: '11.30', season_best: '11.45' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        await sync.syncEntries(db, comp, { fetch: fakeFetch });
        expect((await db.get("SELECT name FROM athlete WHERE competition_id=? AND name_alt='SEO Jihyun'", fx.comp)).name).toBe('서지현');
        // 결과 화면 데이터에 한글·PB·SB 가 실린다
        const heat = await db.get('SELECT h.id, e.id AS ev_id FROM heat h JOIN event e ON e.id=h.event_id WHERE h.external_key=?', 'W.100M--------------.SFNL.000100--');
        const live = await request(app).get(`/api/events/${heat.ev_id}/live-results`);
        const row = live.body.heats[0].entries.find(x => x.name_alt === 'SEO Jihyun' || x.name === '서지현');
        expect(row).toBeTruthy(); expect(row.personal_best).toBe('11.30');
        // 종목 목록에 KOR 표시 (예선에 엔트리 → 준결승·결승 행에도)
        const evs = await request(app).get('/api/events').query({ competition_id: fx.comp });
        const w100 = evs.body.filter(e => e.name === '100m' && e.gender === 'F');
        expect(w100.map(e => e.spotlight)).toEqual(['KOR', 'KOR', 'KOR']);
        expect(evs.body.find(e => e.name === '100mH' && e.gender === 'F' && !e.parent_event_id).spotlight).toBeNull();     // 여자 100mH 에 한국 선수 없음
        // 시간표 API: 한국 선수 출전 종목 행에 spotlight, 시상식 행 없음
        const tt = await request(app).get(`/api/timetable/${fx.comp}`);
        const day2 = tt.body.days['2'];
        const w100tt = [...day2.track, ...day2.field].find(t => t.event_name === '100m' && t.category === '여자');
        expect(w100tt.spotlight).toBe('KOR');
        expect(Object.values(tt.body.days).flatMap(d => [...d.track, ...d.field]).some(t => /시상식/.test(t.event_name))).toBe(false);
        // 조편성 전 '엔트리' 버튼용: 출전 인원 + 엔트리 API 에 국가·한글·생년·PB/SB
        expect(w100[0].entry_count).toBeGreaterThan(20); expect(w100[0].heat_count).toBe(8);
        const en = await request(app).get(`/api/events/${w100[0].id}/entries`);
        const seo = en.body.find(x => x.name === '서지현');
        expect(seo).toMatchObject({ team: 'KOR', federation: 'KOR', name_alt: 'SEO Jihyun', personal_best: '11.30' }); expect(seo.date_of_birth).toMatch(/^\d{4}-/);
    });
    it('선수 × 종목 표(한글 이름·성별·출생·세부종목·SB·PB): 성별·출생년·종목으로 KOR 선수를 찾아 출전마다 PB/SB, 계주는 팀 출전에', async () => {
        const kor = F('entries_org_KOR.json');
        const woo = kor.Events.find(e => e.EvDesc === "Men's High Jump").Partics[0];     // WOO Sanghyeok 1996
        const matrix = [['2026 아시안게임 육상 국가대표 SB·PB (대한육상연맹 기준)'], ['출처: …'], [], ['No', '종목군', '선수', '성별', '출생', '소속', '세부종목', 'SB (2026)', 'PB'],
            [1, '도약', '우상혁', '남', woo.BirthDateRaw.slice(0, 4), '용인시청', '높이뛰기', '2.30', '2.36'],
            [2, '단거리', '김주하', '여', '2001', '시흥시청', '100m', '11.76', '11.76'], [2, '단거리', '김주하', '여', '2001', '시흥시청', '4x100mR', '45.50', '45.50'],
            [3, '단거리', '서민준', '남', '2004', '서천군청', '4x100mR', '40.33', '38.49'], [3, '단거리', '서민준', '남', '2004', '서천군청', '100m', '10.41', '10.35']];
        const rows = sync.rowsFromSheet(matrix);
        expect(rows).toHaveLength(5); expect(Object.keys(rows[0])).toContain('세부종목');
        const st = await sync.applyAthleteInfo(db, fx.comp, rows);
        expect(st.matched).toBe(3); expect(st.ambiguous).toEqual([]); expect(st.skipped_events).toEqual(['서민준 100m']);      // 서민준은 계주만 출전
        const w = await db.get("SELECT a.name, a.name_alt, ee.personal_best, ee.season_best FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id JOIN event e ON e.id=ee.event_id WHERE a.competition_id=? AND a.barcode=?", fx.comp, 'BN:' + woo.Reg);
        expect(w).toEqual({ name: '우상혁', name_alt: 'WOO Sanghyeok', personal_best: '2.36', season_best: '2.30' });
        const team = await db.get("SELECT ee.personal_best, ee.season_best FROM event_entry ee JOIN athlete a ON a.id=ee.athlete_id JOIN event e ON e.id=ee.event_id WHERE a.competition_id=? AND a.barcode='RELAY_BN:KOR:F' AND e.name='4X100mR'", fx.comp);
        expect(team).toEqual({ personal_best: '45.50', season_best: '45.50' });
        expect((await db.get("SELECT name FROM athlete WHERE competition_id=? AND name_alt='SEO Minjun'", fx.comp)).name).toBe('서민준');
    });
    it('대표팀 명단(공개): 선수 기준으로 종목·조 시각·PB/SB, 계주 멤버는 팀 종목이 붙고 다음 경기 순 정렬', async () => {
        const r = await request(app).get(`/api/competitions/${fx.comp}/roster`);
        expect(r.status).toBe(200); expect(r.body.team).toBe('KOR');
        expect(r.body.athletes.length).toBeGreaterThan(0); expect(r.body.athletes.every(a => !a.is_team)).toBe(true);
        const woo = r.body.athletes.find(a => a.name === '우상혁');
        expect(woo).toMatchObject({ name_alt: 'WOO Sanghyeok', birth_year: '1996' });
        const hj = woo.events.find(e => e.event_name === '높이뛰기');
        expect(hj).toMatchObject({ gender: 'M', round_type: 'preliminary', personal_best: '2.36', season_best: '2.30' }); expect(hj.scheduled_at).toMatch(/^2026-/);
        // 계주만 뛰는 서민준: 팀 종목이 relay:true 로 붙는다
        const seo = r.body.athletes.find(a => a.name === '서민준');
        expect(seo.events.some(e => e.relay && e.event_name === '4X100mR' && e.personal_best === '38.49')).toBe(true);
        expect(seo.events.every(e => !e.relay || e.members.length >= 4)).toBe(true);
        expect(r.body.teams.length).toBeGreaterThan(0); expect(r.body.teams[0].is_team).toBe(true);
        // 결과가 들어온 조: 여자 100m 준결승 1조 — 한국 선수 11.42 는 2위, 풍속 -0.3 (결승이 아니니 조 번호와 조 수도 함께)
        const korW100 = F('entries_org_KOR.json').Events.find(e => e.EvKey === 'W.100M--------------').Partics[0];
        const runner = r.body.athletes.find(a => a.name_alt === korW100.Name || a.name === korW100.Name);
        const semi = runner.events.find(e => e.event_name === '100m' && e.round_type === 'semifinal');
        expect(semi.result).toMatchObject({ time_seconds: 11.42, place: 2, heat_count: 3 }); expect(Number(semi.result.wind)).toBeCloseTo(-0.3, 5); expect(semi.heat_number).toBe(1);
        // PB/SB 경신 판정: 11.42 는 PB 11.30 보다 느리고 SB 11.95 보다 빠르다
        expect(semi.result.pb_improved).toBe(false); expect(semi.result.sb_improved).toBe(true);
        // 결승 공식 결과에서 한국 선수 3위 → 메달 집계 동 1, 그 종목은 완료
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const others = F('entries_event_W100M.json').Partics.filter(p => p.Org !== 'KOR');
        fakeResults['W.100M--------------.FNL-.000100--'] = { Key: 'W.100M--------------.FNL-.000100--', Status: 'Official', Results: [
            { Reg: others[0].Reg, Name: others[0].Name, Org: others[0].Org, Rank: 1, Lane: 4, Result: '11.05' },
            { Reg: others[1].Reg, Name: others[1].Name, Org: others[1].Org, Rank: 2, Lane: 5, Result: '11.15' },
            { Reg: korW100.Reg, Name: korW100.Name, Org: 'KOR', Rank: 3, Lane: 6, Result: '11.28' } ] };
        await sync.syncResults(db, comp, { fetch: fakeFetch, onlyKeys: ['W.100M--------------.FNL-.000100--'] });
        const r2 = await request(app).get(`/api/competitions/${fx.comp}/roster`);
        expect(r2.body.medals).toMatchObject({ gold: 0, silver: 0, bronze: 1 });
        expect(r2.body.medals.events[0]).toMatchObject({ event_name: '100m', gender: 'F', place: 3 });
        const fin = r2.body.athletes.find(a => a.id === runner.id).events.find(e => e.round_type === 'final' && e.event_name === '100m');
        expect(fin.result).toMatchObject({ place: 3, pb_improved: true, sb_improved: true }); expect(fin.round_status).toBe('completed');
        // 관심 국가 없는 대회는 400 (team 파라미터로는 조회 가능)
        const other = await db.get("SELECT id FROM competition WHERE id<>? ORDER BY id LIMIT 1", fx.comp);
        if (other) expect((await request(app).get(`/api/competitions/${other.id}/roster`)).status).toBe(400);
        expect((await request(app).get(`/api/competitions/${fx.comp}/roster?team=JPN`)).body.athletes.length).toBeGreaterThan(0);
    });
    it('상태 API 와 권한', async () => {
        const s = await request(app).get(`/api/admin/intl/${fx.comp}/status`).set('x-admin-key', OP);
        expect(s.status).toBe(200); expect(s.body.counts.events).toBeGreaterThan(48); expect(s.body.source.champ).toBe('AG2026'); expect(s.body.state.structure_at).toBeTruthy();
        expect((await request(app).post(`/api/admin/intl/${fx.comp}/setup`).send({ admin_key: OP })).status).toBe(403);
    });
});
