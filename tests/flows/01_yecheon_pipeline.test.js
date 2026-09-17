/**
 * 예천 2026 실데이터 파이프라인 회귀 (Phase 0 안전망)
 *
 * 두 대회(대학 KUAF / 실업 KTFL)를 격리 DB에 실제 업로드 API로 끝까지 올린다:
 *   1단계 연맹명단 → 2단계 조편성 → 3단계 당일조편성 1·2·3일차 → 시간표 → 기록표(NR/DR/CR)
 * 대회 중 실제로 일어난 변화(라운드 자동 전환, 종합경기 출전자 축소, A/B 그룹, 시간표 스마트 머지)를 숫자로 고정한다.
 * 이후 Phase 2·3 검증은 이 상태의 DB 위에서 이어 쓴다.
 *
 * 픽스처: tests/fixtures/yecheon2026/ (성명 익명화, README 참조)
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const path = require('path');
const request = require('supertest');

let app, db;
const ADMIN_KEY = 'testadmin1234';
const FX = path.join(__dirname, '..', 'fixtures', 'yecheon2026');
const COMPS = {
    univ: { name: '제80회 전국대학대항육상경기대회', federation: 'KUAF', division_type: 'univ', series: '전국대학대항육상경기대회' },
    pro: { name: '제37회 KTFL 전국실업단대항육상경기대회', federation: 'KTFL', division_type: 'pro', series: 'KTFL 전국실업단대항육상경기대회' },
};
const ids = {};
const post = (url, fields, file) => { let r = request(app).post(url).field('admin_key', ADMIN_KEY); for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v)); return r.attach('file', file); };
const q = (sql, ...p) => db.all(sql, ...p);
const one = (sql, ...p) => db.get(sql, ...p);
// 종목 이름 정규화 비교 — 연맹 명단 가져오기가 릴레이를 '4X100mR'(대문자 X)과 '4×1500mR'(곱셈 기호)로 섞어 만든다 (Phase 3 이슈 #1)
const norm = x => String(x || '').replace(/[,\s]/g, '').toLowerCase().replace(/[×X]/g, 'x');
const ev = async (compId, name, gender) => {
    const rows = await q('SELECT e.*, (SELECT COUNT(*) FROM heat h WHERE h.event_id=e.id) heats, (SELECT COUNT(*) FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=e.id) lanes FROM event e WHERE competition_id=? AND gender=? AND parent_event_id IS NULL', compId, gender);
    return rows.find(e => norm(e.name) === norm(name));
};

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db;
    for (const [key, c] of Object.entries(COMPS)) {
        const r = await request(app).post('/api/competitions').send({ admin_key: ADMIN_KEY, name: c.name, start_date: '2026-09-14', end_date: '2026-09-16', venue: '예천스타디움', federation: c.federation, division_type: c.division_type, mode: 'operation' });
        expect(r.status).toBe(200);
        ids[key] = r.body.id;
    }
});

describe('1단계 연맹 명단', () => {
    it('대학: 선수 191 · 종목 41 · 출전 315 · 조 55 · 릴레이팀 27', async () => {
        const r = await post('/api/federation/import', { competition_id: ids.univ, heat_size: 8 }, path.join(FX, 'univ', '1_federation_roster.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ athletes: 191, events: 41, entries: 315, heats: 55, relayTeams: 27 });
    });
    it('실업: 선수 507 · 종목 47 · 출전 812 · 조 80 · 릴레이팀 49', async () => {
        const r = await post('/api/federation/import', { competition_id: ids.pro, heat_size: 8 }, path.join(FX, 'pro', '1_federation_roster.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ athletes: 507, events: 47, entries: 812, heats: 80, relayTeams: 49 });
    });
    it('종합경기 세부종목이 생성된다 (10종 10개, 7종 7개) — 두 대회 모두', async () => {
        for (const compId of [ids.univ, ids.pro]) {
            const dec = await one("SELECT id FROM event WHERE competition_id=? AND name='10종경기' AND gender='M'", compId);
            const hep = await one("SELECT id FROM event WHERE competition_id=? AND name='7종경기' AND gender='F'", compId);
            expect((await one('SELECT COUNT(*) c FROM event WHERE parent_event_id=?', dec.id)).c).toBe(10);
            expect((await one('SELECT COUNT(*) c FROM event WHERE parent_event_id=?', hep.id)).c).toBe(7);
        }
    });
});

describe('종합경기 세부종목 순서 (점수식은 순서로 선택된다)', () => {
    // results.js·combined_scores.js 는 세부종목의 '순서(sort_order)'로 WA 점수식을 고른다.
    // 순서가 어긋나면 멀리뛰기 기록에 포환 점수식이 적용되는 식으로 조용히 틀린 점수가 나온다 → 생성 순서를 고정.
    const DEC = ['100m', '멀리뛰기', '포환던지기', '높이뛰기', '400m', '110mH', '원반던지기', '장대높이뛰기', '창던지기', '1500m'];
    const HEP = ['100mH', '높이뛰기', '포환던지기', '200m', '멀리뛰기', '창던지기', '800m'];
    it('10종·7종 세부종목이 WA 규정 순서로 생성된다', async () => {
        for (const compId of [ids.univ, ids.pro]) {
            for (const [pname, want] of [['10종경기', DEC], ['7종경기', HEP]]) {
                const parent = await one('SELECT id FROM event WHERE competition_id=? AND name=?', compId, pname);
                const subs = await q('SELECT name FROM event WHERE parent_event_id=? ORDER BY sort_order, id', parent.id);
                expect(subs.map(x => norm(x.name.replace(/^\[[^\]]+\]\s*/, ''))), pname).toEqual(want.map(norm));
            }
        }
    });
});

describe('2단계 사전 조편성', () => {
    it('대학: 45 갱신 · 종목 신규 0 · 라운드 변경 1', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.univ }, path.join(FX, 'univ', '2_heat_assignment.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ updated: 45, notFound: 0, eventsCreated: 0, roundChanged: 1 });
    });
    it('실업: 62 갱신 · 남 5000m 2조 A/B 그룹 (A 21+B 11 ×2)', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.pro }, path.join(FX, 'pro', '2_heat_assignment.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ updated: 62, notFound: 0, eventsCreated: 0 });
        const e = await ev(ids.pro, '5000m', 'M');
        expect(e.heats).toBe(2);
        const g = await q('SELECT h.heat_number hn, he.sub_group g, COUNT(*) c FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=? GROUP BY hn, g ORDER BY hn, g', e.id);
        expect(g.map(x => `${x.hn}${x.g}:${x.c}`)).toEqual(['1A:21', '1B:11', '2A:21', '2B:11']);
    });
});

describe('3단계 당일 조편성 — 1일차', () => {
    it('대학: 라운드 유지, 명단에 없던 선수 1명 자동 생성(원반던지기)', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.univ }, path.join(FX, 'univ', '3_daily_day1.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ notFound: 0, athletesAdded: 1, eventsCreated: 0 });
        const e100 = await ev(ids.univ, '100m', 'M');
        expect(e100.round_type).toBe('preliminary'); expect(e100.heats).toBe(4); expect(e100.lanes).toBe(32);
    });
    it('실업: 예선 폐지 종목 4개 결승 직행(라운드 자동 전환), 10,000m 2조→1조, 10종 4명·7종 7명', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.pro }, path.join(FX, 'pro', '3_daily_day1.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ notFound: 0, roundChanged: 4 });
        for (const [n, g] of [['1500m', 'M'], ['1500m', 'F'], ['110mH', 'M'], ['4x100mR', 'F']]) {
            const e = await ev(ids.pro, n, g);
            expect(e, `${g} ${n}`).toBeTruthy();
            expect(e.round_type, `${g} ${n}`).toBe('final');
        }
        const e10k = await ev(ids.pro, '10,000m', 'M');
        expect(e10k.heats).toBe(1); expect(e10k.lanes).toBe(19);
        // 종합경기 세부종목(1일차) 출전자 = 부모 스타트리스트 기준 4명/7명
        const sub = await one("SELECT e.id FROM event e JOIN event p ON p.id=e.parent_event_id WHERE p.competition_id=? AND p.name='10종경기' AND e.name LIKE '%100m%'", ids.pro);
        expect((await one('SELECT COUNT(*) c FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=?', sub.id)).c).toBe(4);
        const hsub = await one("SELECT e.id FROM event e JOIN event p ON p.id=e.parent_event_id WHERE p.competition_id=? AND p.name='7종경기' AND e.name LIKE '%100mH%'", ids.pro);
        expect((await one('SELECT COUNT(*) c FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=?', hsub.id)).c).toBe(7);
    });
});

describe('3단계 당일 조편성 — 2일차 (1일차 기록 보존)', () => {
    let resultCountBefore;
    it('1일차 세부종목에 기록 1건 입력 (보존 확인용)', async () => {
        const sub = await one("SELECT e.id FROM event e JOIN event p ON p.id=e.parent_event_id WHERE p.competition_id=? AND p.name='10종경기' AND e.name LIKE '%100m%'", ids.pro);
        const h = await one('SELECT id FROM heat WHERE event_id=? LIMIT 1', sub.id);
        const he = await one('SELECT event_entry_id FROM heat_entry WHERE heat_id=? LIMIT 1', h.id);
        await db.run("UPDATE event SET round_status='in_progress' WHERE id=?", sub.id);
        const rr = await request(app).post('/api/results/upsert').send({ heat_id: h.id, event_entry_id: he.event_entry_id, time_seconds: 11.2, admin_key: ADMIN_KEY });
        expect(rr.status).toBe(200);
        // 서버 자동 동기화로 종합 점수가 붙는다 (2026-09 수정)
        const pe = await one("SELECT ee.id FROM event_entry ee JOIN event p ON p.id=ee.event_id WHERE p.competition_id=? AND p.name='10종경기' AND ee.athlete_id=(SELECT athlete_id FROM event_entry WHERE id=?)", ids.pro, he.event_entry_id);
        const cs = await one('SELECT * FROM combined_score WHERE event_entry_id=? AND sub_event_order=1', pe.id);
        expect(cs && cs.wa_points).toBeGreaterThan(0);
        resultCountBefore = (await one('SELECT COUNT(*) c FROM result r JOIN heat h ON h.id=r.heat_id JOIN event e ON e.id=h.event_id WHERE e.competition_id=?', ids.pro)).c;
    });
    it('대학: 여 200m 예선 2조 → 결승 직행(자동 전환) 8명', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.univ }, path.join(FX, 'univ', '3_daily_day2.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ notFound: 0, roundChanged: 1 });
        const e = await ev(ids.univ, '200m', 'F');
        expect(e.round_type).toBe('final'); expect(e.heats).toBe(1); expect(e.lanes).toBe(8);
        const m = await ev(ids.univ, '200m', 'M');
        expect(m.round_type).toBe('preliminary'); expect(m.heats).toBe(3); expect(m.lanes).toBe(19);
    });
    it('실업: 26 갱신, 남 200m 5→3조 20명, 혼성 4x400mR 3팀, 1일차 기록 유지', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.pro }, path.join(FX, 'pro', '3_daily_day2.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ updated: 26, notFound: 0 });
        const e = await ev(ids.pro, '200m', 'M');
        expect(e.heats).toBe(3); expect(e.lanes).toBe(20);
        const mx = await ev(ids.pro, '4x400mR(Mixed)', 'X');
        expect(mx.lanes).toBe(3);
        const after = (await one('SELECT COUNT(*) c FROM result r JOIN heat h ON h.id=r.heat_id JOIN event e ON e.id=h.event_id WHERE e.competition_id=?', ids.pro)).c;
        expect(after).toBe(resultCountBefore);
        const e100 = await ev(ids.pro, '100m', 'M');
        expect(e100.heats).toBe(4); expect(e100.lanes).toBe(25);
    });
});

describe('3단계 당일 조편성 — 3일차', () => {
    it('대학: 7종목, 남 5000m 15명·4x400mR 4팀', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.univ }, path.join(FX, 'univ', '3_daily_day3.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ notFound: 0 });
        expect((await ev(ids.univ, '5000m', 'M')).lanes).toBe(15);
        expect((await ev(ids.univ, '4x400mR', 'M')).lanes).toBe(4);
    });
    it('실업: 5000m "결승(A,B)" → 결승 1조 A/B 그룹, 순서 이어짐 (남 A1~14·B15~20, 여 A1~17·B18~25)', async () => {
        const r = await post('/api/heat-assignment/apply', { competition_id: ids.pro }, path.join(FX, 'pro', '3_daily_day3.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.stats).toMatchObject({ notFound: 0 });
        for (const [g, want] of [['M', ['A:14:1-14', 'B:6:15-20']], ['F', ['A:17:1-17', 'B:8:18-25']]]) {
            const e = await ev(ids.pro, '5000m', g);
            expect(e.heats).toBe(1);
            const rows = await q('SELECT he.sub_group g, COUNT(*) c, MIN(he.lane_number) mn, MAX(he.lane_number) mx FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=? GROUP BY he.sub_group ORDER BY he.sub_group', e.id);
            expect(rows.map(x => `${x.g}:${x.c}:${x.mn}-${x.mx}`)).toEqual(want);
        }
    });
    it('종목 이름·성별 중복 생성 없음', async () => {
        for (const compId of [ids.univ, ids.pro]) {
            const dup = await q('SELECT name, gender, COUNT(*) c FROM event WHERE competition_id=? AND parent_event_id IS NULL GROUP BY name, gender HAVING c>1', compId);
            expect(dup).toEqual([]);
        }
    });
});

describe('시간표 (스마트 머지)', () => {
    it('지난 일차만 든 파일을 스마트 모드로 올리면 "반영 없음"을 분명히 알린다 (needs_force)', async () => {
        const r = await post('/api/timetable/upload', { competition_id: ids.univ }, path.join(FX, 'univ', 'timetable.xlsx'));
        expect(r.status).toBe(200);
        expect(r.body.needs_force).toBe(true);
        expect(r.body.message).toContain('반영된 내용이 없습니다');
        expect((await one('SELECT COUNT(*) c FROM timetable WHERE competition_id=?', ids.univ)).c).toBe(0);
    });
    it('대학: 1일차 26 · 2일차 18 · 3일차 7 행, 미연결은 결승 대기·출전자 없음뿐', async () => {
        // 스마트 머지는 '오늘' 기준 지난 일차를 보존하므로(대회가 끝난 뒤엔 아무것도 안 올라감) 회귀 테스트는 force 로 올린다 — Phase 3 이슈 #2
        const r = await post('/api/timetable/upload', { competition_id: ids.univ, overwrite_mode: 'force' }, path.join(FX, 'univ', 'timetable.xlsx'));
        expect(r.status).toBe(200);
        const byDay = await q('SELECT day, COUNT(*) c, SUM(CASE WHEN event_id IS NULL THEN 1 ELSE 0 END) u FROM timetable WHERE competition_id=? GROUP BY day ORDER BY day', ids.univ);
        expect(byDay.map(x => `${x.day}:${x.c}:${x.u}`)).toEqual(['1:26:4', '2:18:2', '3:7:0']);
        const unl = await q('SELECT event_name, category, round FROM timetable WHERE competition_id=? AND event_id IS NULL', ids.univ);
        // 미연결: 예선 종목의 결승 행(결승 생성 시 연결) 또는 대학 출전자 없는 합동 행
        for (const u of unl) expect(u.round === '결승' || /대학\/실업/.test(u.category), JSON.stringify(u)).toBe(true);
    });
    it('실업: 1일차 31 · 2일차 30 · 3일차 10 행, 3일차 전부 연결', async () => {
        const r = await post('/api/timetable/upload', { competition_id: ids.pro, overwrite_mode: 'force' }, path.join(FX, 'pro', 'timetable.xlsx'));
        expect(r.status).toBe(200);
        const byDay = await q('SELECT day, COUNT(*) c, SUM(CASE WHEN event_id IS NULL THEN 1 ELSE 0 END) u FROM timetable WHERE competition_id=? GROUP BY day ORDER BY day', ids.pro);
        expect(byDay.map(x => `${x.day}:${x.c}:${x.u}`)).toEqual(['1:31:4', '2:30:6', '3:10:0']);
    });
    it('연결된 행은 종목·라운드가 맞다 (오연결 0)', async () => {
        const norm = x => String(x).replace(/[,\s]/g, '').toLowerCase().replace(/[×X]/g, 'x');
        for (const compId of [ids.univ, ids.pro]) {
            const rows = await q('SELECT t.event_name, t.round, e.name ename, e.round_type eround FROM timetable t JOIN event e ON e.id=t.event_id WHERE t.competition_id=?', compId);
            for (const x of rows) {
                const cm = x.round.match(/^(10종|7종)\(/);
                const wantName = cm ? cm[1] + '경기' : x.event_name;
                const wantRound = cm ? 'final' : (/^\d+-\d+\+\d+$/.test(x.round) ? 'preliminary' : 'final');
                expect(norm(x.ename), `${x.event_name} ${x.round}`).toBe(norm(wantName));
                expect(x.eround, `${x.event_name} ${x.round}`).toBe(wantRound);
            }
        }
    });
});

describe('기록표 (NR/DR/CR)', () => {
    // 테스트 파일들이 임시 DB 하나를 공유한다(실행 순서는 vitest 가 소요시간 기준으로 정함).
    // NR/DR 은 대회와 무관한 전역 기록이라 남겨두면 다른 테스트(24_records_bulk)의 '신규' 판정을 깨뜨린다 → 이 테스트가 넣은 행은 지운다.
    let maxIdBefore = 0;
    beforeAll(async () => { maxIdBefore = ((await one('SELECT MAX(id) m FROM event_record')) || {}).m || 0; });
    afterAll(async () => { await db.run('DELETE FROM event_record WHERE id > ?', maxIdBefore); });
    it('대학 143행 · 실업 151행 오류 0건 가져오기', async () => {
        for (const [key, c] of Object.entries(COMPS)) {
            const s = await request(app).post('/api/competition-series').send({ admin_key: ADMIN_KEY, name: c.series, federation: c.federation }).set('Content-Type', 'application/json');
            expect(s.status).toBe(200);
            const r = await post('/api/records/bulk-import', { series_id: s.body.id }, path.join(FX, key, 'records_nr_dr_cr.xlsx'));
            expect(r.status).toBe(200);
            const st = r.body.stats;
            expect(st.inserted + st.updated + st.unchanged).toBe(key === 'univ' ? 143 : 151);
            expect(st.skippedWorse).toBe(0);
        }
    });
});

describe('계주 종목명 표기 (Phase 6 용어 통일)', () => {
    it("저장된 종목명에 곱셈 기호(4×)가 없다 — 모두 '4X…mR'", async () => {
        const { db } = require('../../server.js');
        const bad = await db.all("SELECT name FROM event WHERE name LIKE '%4×%'");
        expect(bad.map(r => r.name)).toEqual([]);
        const relays = (await db.all("SELECT DISTINCT name FROM event WHERE category='relay' AND name LIKE '4%'")).map(r => r.name);
        expect(relays.length).toBeGreaterThan(0);
        for (const n of relays) expect(n).toMatch(/^4X\d+mR(\(Mixed\))?$/);
    });
});

describe('연맹 데일리 원본(▣ 섹션형)을 그대로 업로드 (Phase 5)', () => {
    const FD = require('../../lib/federationDaily');
    const XLSX = require('xlsx');
    const sheet = f => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false }); };
    it('양식 판별: 연맹 데일리는 true, 시스템 표는 false', () => {
        expect(FD.isFederationDaily(sheet(path.join(FX, 'pro', 'src_federation_daily_day3.xlsx')))).toBe(true);
        expect(FD.isFederationDaily(sheet(path.join(FX, 'pro', '3_daily_day3.xlsx')))).toBe(false);
    });
    it('실업 3일차: A열 공백 보정 · 5000m "▣ A/▣ B" 그룹 순서 이어 매기기 · 계주 팀 행', () => {
        const out = FD.convertIfFederationDaily(sheet(path.join(FX, 'pro', 'src_federation_daily_day3.xlsx')), []);
        const key = r => r.slice(0, 9).map(x => String(x).trim()).join('|');
        expect(new Set(out.aoa.slice(1).map(key))).toEqual(new Set(sheet(path.join(FX, 'pro', '3_daily_day3.xlsx')).slice(1).map(key)));
        const g5000 = out.aoa.filter(r => r[1] === '5000m' && r[0] === '남');
        expect(new Set(g5000.map(r => r[4]))).toEqual(new Set(['A', 'B']));
        expect(g5000.map(r => r[5])).toEqual(g5000.map((_, i) => i + 1));          // 순서: A 1..n → B 이어서
    });
    for (const [key, file, std] of [['univ', 'src_federation_daily_day3.xlsx', '3_daily_day3.xlsx'], ['pro', 'src_federation_daily_day3.xlsx', '3_daily_day3.xlsx'], ['univ', 'src_federation_daily_day2.xlsx', '3_daily_day2.xlsx']]) {
        it(`${key} ${file}: 미리보기 결과가 손으로 변환해 올렸던 파일과 같다 (동명이인 표기는 명단으로 맞춘다)`, async () => {
            const a = await post('/api/heat-assignment/preview', { competition_id: ids[key] }, path.join(FX, key, file));
            const b = await post('/api/heat-assignment/preview', { competition_id: ids[key] }, path.join(FX, key, std));
            expect(a.status).toBe(200); expect(a.body.sourceFormat).toBe('federation_daily'); expect(b.body.sourceFormat).toBe('table');
            expect(a.body.mergeWarnings[0]).toContain('연맹 데일리 양식을 자동 변환');
            expect(a.body.eventCount).toBe(b.body.eventCount);
            expect(a.body.totalRows).toBe(b.body.totalRows);
            const slim = p => p.map(x => ({ n: x.eventName, g: x.gender, r: x.round, s: x.status, c: x.excelEntries, ch: (x.changes || []).length })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
            expect(slim(a.body.preview)).toEqual(slim(b.body.preview));
        });
    }
});
