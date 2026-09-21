/**
 * [규정·운영] 한국중·고육상연맹 요강 규칙 — lib/kjafRules.js (Phase 7-③)
 *   1인 2종목 · 계주 학교당 1팀 · 학년부↔본경기 중복 · 믹스릴레이 남2여2 · 예선 5조 준결승 · 타임레이스
 *   + 체크리스트(readiness)에 '중·고연맹 요강' 묶음, 혼성 계주 주자 등록 API 가 세 번째 같은 성별을 거부
 */
const request = require('supertest');
const { applies, checkEntries, checkMixedRelay } = require('../../lib/kjafRules');
let app, db; const fx = {}; const ADMIN = 'testadmin1234', OP = 'testopkey';

describe('순수 규칙', () => {
    const ev = (id, name, gender, division, extra = {}) => ({ id, name, gender, division, category: extra.category || (/mR/.test(name) ? 'relay' : 'track'), round_type: extra.round || 'final', heat_count: extra.heats || 1, parent_event_id: null });
    const en = (id, event_id, athlete_id, athlete_name, team, gender = 'M') => ({ id, event_id, athlete_id, athlete_name, team, gender, status: 'registered' });
    it('applies: 연맹 KJAF 이거나 초·중·고 부 종목이 있으면', () => {
        expect(applies({ federation: 'KJAF' }, [])).toBe(true);
        expect(applies({ federation: 'KTFL' }, [ev(1, '100m', 'M', '일반부')])).toBe(false);
        expect(applies({ federation: '' }, [ev(1, '100m', 'M', '중등부')])).toBe(true);
        expect(applies({ federation: '' }, [ev(1, '100m', 'M', '고2학년부')])).toBe(true);
    });
    it('1인 2종목 초과 — 개인 종목만 세고, 같은 종목의 예선·결승은 하나', () => {
        const events = [ev(1, '100m', 'M', '중등부', { round: 'preliminary' }), ev(2, '100m', 'M', '중등부'), ev(3, '200m', 'M', '중등부'), ev(4, '멀리뛰기', 'M', '중등부', { category: 'field_distance' }), ev(5, '4x100mR', 'M', '중등부')];
        const entries = [en(1, 1, 10, '셋', 'A'), en(2, 2, 10, '셋', 'A'), en(3, 3, 10, '셋', 'A'), en(4, 4, 10, '셋', 'A'), en(5, 5, 10, '셋', 'A'),
            en(6, 1, 11, '둘', 'A'), en(7, 3, 11, '둘', 'A'), en(8, 5, 11, '둘', 'A')];
        const out = checkEntries({ events, entries, members: [] });
        const two = out.find(x => x.key === 'kjaf_two_events');
        expect(two.count).toBe(1); expect(two.detail).toContain('셋(A) 3종목'); expect(two.detail).not.toContain('둘');
    });
    it('계주 학교당 1팀 — "예천중 A"·"예천중 B" 는 같은 학교', () => {
        const events = [ev(5, '4x100mR', 'M', '중등부')];
        const entries = [en(1, 5, 100, '예천중 A', '예천중 A'), en(2, 5, 101, '예천중 B', '예천중 B'), en(3, 5, 102, '안동중', '안동중')];
        const out = checkEntries({ events, entries, members: [] });
        expect(out.find(x => x.key === 'kjaf_relay_one_team')).toMatchObject({ count: 1 });
        expect(out.find(x => x.key === 'kjaf_relay_one_team').detail).toContain('예천중 2팀');
    });
    it('1학년부 100m + 중등부 100m 중복 출전은 경고, 다른 종목이면 아님', () => {
        const events = [ev(1, '100m 중1학년부', 'M', '중1학년부'), ev(2, '100m 중등부', 'M', '중등부'), ev(3, '200m 중등부', 'M', '중등부')];
        const entries = [en(1, 1, 10, '겹침', 'A'), en(2, 2, 10, '겹침', 'A'), en(3, 1, 11, '안겹침', 'A'), en(4, 3, 11, '안겹침', 'A')];
        const out = checkEntries({ events, entries, members: [] });
        const d = out.find(x => x.key === 'kjaf_grade_dup');
        expect(d.count).toBe(1); expect(d.detail).toContain('겹침(A) 100m');
    });
    it('믹스릴레이 남 2·여 2', () => {
        expect(checkMixedRelay(['M', 'F', 'M', 'F']).ok).toBe(true);
        expect(checkMixedRelay(['M', 'F', 'M'], 'M')).toMatchObject({ ok: false, error: expect.stringContaining('남자 3명') });
        expect(checkMixedRelay(['F', 'F'], 'F').ok).toBe(false);
        expect(checkMixedRelay(['M', 'F', 'M', 'F'], 'F').ok).toBe(false);
        expect(checkMixedRelay(['M'], 'F').ok).toBe(true);
        const events = [ev(9, '4x400mR', 'X', '중등부')];
        const entries = [en(1, 9, 200, '예천중', '예천중', 'M'), en(2, 9, 201, '안동중', '안동중', 'M')];
        const members = [{ event_entry_id: 1, athlete_id: 1, gender: 'M' }, { event_entry_id: 1, athlete_id: 2, gender: 'M' }, { event_entry_id: 1, athlete_id: 3, gender: 'M' }, { event_entry_id: 1, athlete_id: 4, gender: 'F' },
            { event_entry_id: 2, athlete_id: 5, gender: 'M' }, { event_entry_id: 2, athlete_id: 6, gender: 'F' }];
        const out = checkEntries({ events, entries, members });
        expect(out.find(x => x.key === 'kjaf_mixed_relay')).toMatchObject({ count: 1 });
        expect(out.find(x => x.key === 'kjaf_mixed_relay').detail).toContain('예천중');
    });
    it('예선 5조 이상인데 준결승이 없으면 안내, 있으면 없음 · 타임레이스 안내', () => {
        const events = [ev(1, '100m', 'M', '중등부', { round: 'preliminary', heats: 6 }), ev(2, '100m', 'M', '중등부'),
            ev(3, '200m', 'M', '중등부', { round: 'preliminary', heats: 5 }), ev(4, '200m', 'M', '중등부', { round: 'semifinal', heats: 2 }),
            ev(5, '1500m', 'M', '중등부', { heats: 2 }), ev(6, '1500m', 'M', '일반부', { heats: 2 }), ev(7, '3000mSC', 'M', '고등부', { heats: 3 })];
        const out = checkEntries({ events, entries: [], members: [] });
        const semi = out.find(x => x.key === 'kjaf_semifinal');
        expect(semi).toMatchObject({ count: 1, level: 'info' }); expect(semi.detail).toContain('100m 중등부 예선 6조');
        const tr = out.find(x => x.key === 'kjaf_time_race');
        expect(tr.count).toBe(2); expect(tr.detail).toContain('1500m 중등부 2조'); expect(tr.detail).toContain('3000mSC 고등부 3조'); expect(tr.detail).not.toContain('일반부');
    });
    it('문제가 없으면 빈 목록', () => {
        expect(checkEntries({ events: [ev(1, '100m', 'M', '중등부')], entries: [en(1, 1, 1, '가', 'A')], members: [] })).toEqual([]);
    });
});

describe('서버 연동', () => {
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db;
        fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, federation) VALUES (?,?,?,?, 'active', 'KJAF')", 'KJAF_RULES_' + Date.now(), '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
        fx.mix = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?, '4x400mR', 'relay', 'X', '중등부', 'final', 'created')", fx.comp)).lastInsertRowid;
        fx.team = (await db.run("INSERT INTO athlete (competition_id, name, team, barcode, gender) VALUES (?, '예천중', '예천중', 'RELAY_예천중', 'M')", fx.comp)).lastInsertRowid;
        fx.entry = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.mix, fx.team)).lastInsertRowid;
        fx.ath = {};
        for (const [k, g] of [['m1', 'M'], ['m2', 'M'], ['m3', 'M'], ['f1', 'F'], ['f2', 'F']]) fx.ath[k] = (await db.run("INSERT INTO athlete (competition_id, name, team, gender) VALUES (?,?,'예천중',?)", fx.comp, k, g)).lastInsertRowid;
    });
    it('연맹 KJAF 대회의 체크리스트에 중·고연맹 요강 묶음이 있다', async () => {
        const r = await request(app).get(`/api/admin/competitions/${fx.comp}/readiness`).set('x-admin-key', ADMIN);
        expect(r.status).toBe(200);
        const g = r.body.groups.find(x => x.key === 'kjaf');
        expect(g).toBeTruthy(); expect(g.items[0].key).toBe('kjaf_ok');
    });
    it('혼성 계주 주자: 남 2 뒤 세 번째 남자는 400, 여자는 등록', async () => {
        const add = id => request(app).post('/api/relay-members').set('x-admin-key', OP).send({ event_entry_id: fx.entry, athlete_id: id });
        expect((await add(fx.ath.m1)).status).toBe(200);
        expect((await add(fx.ath.m2)).status).toBe(200);
        const r3 = await add(fx.ath.m3);
        expect(r3.status).toBe(400); expect(r3.body.error).toContain('남 2·여 2');
        expect((await add(fx.ath.f1)).status).toBe(200);
        expect((await add(fx.ath.f2)).status).toBe(200);
        expect((await add(fx.ath.m1)).status).toBe(200);     // 이미 든 주자 다시 → 무해(IGNORE)
        const n = await db.get('SELECT COUNT(*) c FROM relay_member WHERE event_entry_id=?', fx.entry);
        expect(Number(n.c)).toBe(4);
    });
    it('실업 대회(KTFL)에는 요강 묶음이 없다', async () => {
        const c2 = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, federation) VALUES (?,?,?,?, 'active', 'KTFL')", 'KTFL_' + Date.now(), '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
        await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?, '100m', 'track', 'M', '일반부', 'final', 'created')", c2);
        const r = await request(app).get(`/api/admin/competitions/${c2}/readiness`).set('x-admin-key', ADMIN);
        expect(r.body.groups.find(x => x.key === 'kjaf')).toBeUndefined();
    });
});

describe('계주 팀 구성 (WA TR 24)', () => {
    let ev, teamA, teamB, entryA, entryB, ath;
    beforeAll(async () => {
        ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?, '4x100mR', 'relay', 'M', '중등부', 'final', 'created')", fx.comp)).lastInsertRowid;
        teamA = (await db.run("INSERT INTO athlete (competition_id, name, team, barcode, gender) VALUES (?, '예천중A', '예천중A', 'RELAY_예천중_M', 'M')", fx.comp)).lastInsertRowid;
        teamB = (await db.run("INSERT INTO athlete (competition_id, name, team, barcode, gender) VALUES (?, '안동중A', '안동중A', 'RELAY_안동중_M', 'M')", fx.comp)).lastInsertRowid;
        entryA = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, teamA)).lastInsertRowid;
        entryB = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, teamB)).lastInsertRowid;
        ath = [];
        for (let i = 0; i < 8; i++) ath.push((await db.run("INSERT INTO athlete (competition_id, name, team, gender) VALUES (?,?,'예천중',?)", fx.comp, '주자' + i, i === 7 ? 'F' : 'M')).lastInsertRowid);
    });
    const add = (entry, id) => request(app).post('/api/relay-members').set('x-admin-key', OP).send({ event_entry_id: entry, athlete_id: id });
    it('6명(주자 4 + 예비 2)까지, 7번째는 400', async () => {
        for (let i = 0; i < 6; i++) expect((await add(entryA, ath[i])).status).toBe(200);
        const r = await add(entryA, ath[6]);
        expect(r.status).toBe(400); expect(r.body.error).toContain('6명');
    });
    it('같은 종목의 다른 팀에 든 선수는 400, 남자 계주에 여자 선수는 400', async () => {
        const r = await add(entryB, ath[0]);
        expect(r.status).toBe(400); expect(r.body.error).toContain('예천중A');
        const g = await add(entryB, ath[7]);
        expect(g.status).toBe(400); expect(g.body.error).toContain('여자 선수');
    });
    it('주자 순서는 1~4 이고 같은 구간 중복 불가, 예비는 비움', async () => {
        const order = members => request(app).put('/api/relay-members/order').set('x-admin-key', OP).send({ event_entry_id: entryA, members });
        expect((await order([{ athlete_id: ath[0], leg_order: 1 }, { athlete_id: ath[1], leg_order: 5 }])).status).toBe(400);
        expect((await order([{ athlete_id: ath[0], leg_order: 1 }, { athlete_id: ath[1], leg_order: 1 }])).status).toBe(400);
        const ok = await order([{ athlete_id: ath[0], leg_order: 1 }, { athlete_id: ath[1], leg_order: 2 }, { athlete_id: ath[2], leg_order: '3' }, { athlete_id: ath[3], leg_order: 4 }, { athlete_id: ath[4], leg_order: '' }, { athlete_id: ath[5], leg_order: null }]);
        expect(ok.status).toBe(200);
        const rows = await db.all('SELECT athlete_id, leg_order FROM relay_member WHERE event_entry_id=? ORDER BY athlete_id', entryA);
        expect(rows.map(r => r.leg_order)).toEqual([1, 2, 3, 4, null, null]);
    });
});
