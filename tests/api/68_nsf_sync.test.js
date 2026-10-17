/**
 * 전국체전 동기화 (2026-10-17): meet.sports.or.kr 일정 HTML·명단 JSON·결과 HTML 픽스처 → 종목(부별·라운드)·조·시간표(시작 시각만)·선수·계주 팀·결과
 */
const request = require('supertest');
const fs = require('fs'); const path = require('path');
let app, db; const ADMIN = 'testadmin1234';
const N = require('../../lib/intl/nsf');
const sync = require('../../lib/intl/sync');
const FX = path.join(__dirname, '..', 'fixtures', 'nsf');
const entrants = JSON.parse(fs.readFileSync(path.join(FX, 'entrants.json'), 'utf8'));
const unfinished = fs.readFileSync(path.join(FX, 'detail_unfinished.html'), 'utf8');
// 종료된 조의 결과표 — 실제 조각(미종료)의 첫 표 몸통을 결과 행으로 바꿔 만든다
const finishedHtml = (rows) => unfinished.replace(/<td colspan="7" class="no-result">[^<]*<\/td>/, '') .replace(/(<tbody[^>]*>)/, '$1' + rows.map(r => `<tr><td>${r.rank || ''}</td><td>${r.sido}</td><td class="tal">${r.name}</td><td class="tal">${r.team}</td><td>${r.grade || ''}</td><td>${r.mark || ''}</td><td>${r.remark || ''}</td></tr>`).join(''));
const fetchStub = (calls) => async (source, kind, p) => {
    calls.push(kind);
    if (kind === 'dates') return p.cls === 'A1' ? ['20261018', '20261020'] : ['20261018'];   // 계주(10/20)까지 보려고 트랙은 이틀
    if (kind === 'schedule') { const f = path.join(FX, `sched_${p.cls}_${p.date}.html`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '<html></html>'; }
    if (kind === 'entrants') return entrants[`${p.dc}/${p.rh}`] || { playerList: [] };
    if (kind === 'detail') {
        if (p.dc === 'A10301' && p.rh === 'A11001') return finishedHtml([{ rank: 1, sido: '울산', name: '김리한', team: '울산스포츠과학고등학교', grade: 1, mark: '10.85', remark: '' }, { rank: 2, sido: '경남', name: '김시훈', team: '경남체육고등학교', grade: 1, mark: '10.91', remark: 'Q' }, { rank: '', sido: '경남', name: '최재혁', team: '경남체육고등학교', grade: 3, mark: 'DNF', remark: '' }]);
        if (p.dc === 'A10307' && p.rh === 'A19000') return finishedHtml([{ rank: 1, sido: '경북', name: '오천미', team: '경북체고', grade: 2, mark: '14:35.20', remark: '' }, { rank: 2, sido: '전남', name: '김오천', team: '전남체고', grade: 3, mark: '14:36.00', remark: '' }]);   // 5000m 결승(조 1개) → 전원 기록 = 완료
        if (p.cls === 'B1') return finishedHtml([{ rank: 1, sido: '서울', name: '정의진', team: '서울시청', grade: '', mark: '18.52m', remark: '대회신' }]);   // 필드는 '종료' 표시 전엔 진행 중
        return unfinished;
    }
    throw new Error('unexpected fetch ' + kind);
};

describe('전국체전 동기화', () => {
    const fx = { calls: [] };
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '제107회 전국체육대회 육상', start_date: '2026-10-18', end_date: '2026-10-21', federation: 'KAAF', venue: '제주 강창학종합경기장' })).body.id;
        fx.calc = { calcWAPoints: mod.calcWAPoints, waKeysFor: mod.waKeysFor };
    });

    it('파서: 일정 행·종목 구조·이름 정규화·결과표', () => {
        const rows = N.parseScheduleRows(fs.readFileSync(path.join(FX, 'sched_A1_20261018.html'), 'utf8'), 'A1');
        expect(rows.length).toBeGreaterThan(50);
        expect(rows[0]).toMatchObject({ dc: 'A10301', rh: 'A11001', kind: '남자18세이하부', event: '100m', round: '예선1', status: '미종료' });
        expect(N.parseWhen(rows[0].when)).toEqual({ date: '2026-10-18', time: '13:25', iso: '2026-10-18T13:25:00+09:00' });   // 끝 시각(13:40)은 버린다
        expect(['100m허들', '4×400mR(Mixed) 4×400mR(Mixed)', '10KM경보', '마라톤(42.195km)', '3000m장애', '10km 10km'].map(N.normEventName)).toEqual(['100mH', '4X400mR(Mixed)', '10kmW', '마라톤', '3000mSC', '10K']);
        const ev = N.buildStructure(rows);
        const dec = ev.find(e => e.key === 'A10317'); expect(dec).toMatchObject({ name: '10종경기', category: 'combined', gender: 'M', division: '18세이하부' }); expect(dec.subEvents.map(s => s.name)).toContain('100m');
        const d = N.parseDetail(unfinished); expect(d.finished).toBe(false); expect(d.results).toHaveLength(0); expect(d.startlist.length).toBe(25);
        const f = N.parseDetail(finishedHtml([{ rank: 1, sido: '울산', name: '김리한', team: 'T', mark: '10.85' }])); expect(f.finished).toBe(true); expect(f.results[0]).toMatchObject({ rank: 1, name: '김리한', mark: '10.85' });
        expect(N.statusOf('DNF', '')).toBe('DNF'); expect(N.statusOf('실격', '')).toBe('DQ'); expect(N.markToNumber('2:15:30', 'road')).toBe(8130);
    });

    it('출처 저장: meet.sports.or.kr 주소면 provider nsf', async () => {
        const r = await request(app).put(`/api/admin/intl/${fx.comp}/source`).send({ admin_key: ADMIN, base: 'https://meet.sports.or.kr', champ: 'NSF2026' });
        expect(r.status).toBe(200); expect(r.body.source).toMatchObject({ provider: 'nsf', champ: 'NSF2026', classes: ['A1', 'B1', 'C1'] });
    });

    it('구조: 부별 종목·라운드·조·시간표(시작 시각만), 종합경기 세부종목은 WA 순서, 혼성계주는 성별 X', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const out = await sync.setupStructure(db, comp, { fetch: fetchStub(fx.calls), calc: fx.calc });
        expect(out.events).toBeGreaterThan(30);   // 픽스처는 1일차(10/18) 세 종목군만
        const e100 = await db.all("SELECT * FROM event WHERE competition_id=? AND external_key LIKE 'A10301#%' ORDER BY round_type", fx.comp);
        expect(e100.map(e => e.round_type).sort()).toEqual(['final', 'preliminary']);
        expect(e100[0]).toMatchObject({ name: '100m 18세이하부', gender: 'M', division: '18세이하부', category: 'track', code: '100' });
        const heats = await db.all('SELECT h.* FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND e.external_key=? ORDER BY heat_number', fx.comp, 'A10301#preliminary');
        expect(heats.map(h => h.external_key)).toEqual(['A10301/A11001', 'A10301/A11002', 'A10301/A11003', 'A10301/A11004']);
        expect(heats[0].scheduled_at).toBe('2026-10-18T13:25:00+09:00');
        const tt = await db.get("SELECT * FROM timetable WHERE competition_id=? AND event_name='100m 18세이하부' AND category='남자' AND round='예선' LIMIT 1", fx.comp);
        expect(tt.time).toBe('13:25'); expect(tt.note).toBe('4조'); expect(tt.event_name).toBe('100m 18세이하부');
        const dec = await db.get("SELECT * FROM event WHERE competition_id=? AND external_key='A10317'", fx.comp);
        const subs = await db.all('SELECT name, sort_order FROM event WHERE parent_event_id=? ORDER BY sort_order', dec.id);
        expect(subs.slice(0, 3).map(s => s.name)).toEqual(['[10종] 100m 18세이하부', '[10종] 멀리뛰기 18세이하부', '[10종] 포환던지기 18세이하부']);   // WA 순서
        const mixed = await db.get("SELECT * FROM event WHERE competition_id=? AND external_key='A11513#final'", fx.comp);
        expect(mixed).toMatchObject({ name: '4X400mR(Mixed) 일반부', gender: 'X', division: '일반부', category: 'relay', code: '4X400X' });
        const road = await db.get("SELECT * FROM event WHERE competition_id=? AND external_key='C10533#final'", fx.comp);
        expect(road).toMatchObject({ name: '마라톤 일반부', category: 'road', division: '일반부', code: 'MAR' });
        // 두 번 돌려도 같은 결과
        const again = await sync.setupStructure(db, comp, { fetch: fetchStub(fx.calls), calc: fx.calc });
        expect(again.stats.heats).toBe(0);
    });

    it('엔트리: 선수(시도=팀, 소속=federation, 배번)·첫 라운드 출전, 계주는 시도 팀 + 주자', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const st = await sync.syncEntries(db, comp, { fetch: fetchStub(fx.calls), calc: fx.calc });
        expect(st.entries).toBeGreaterThan(40);
        const a = await db.get("SELECT * FROM athlete WHERE competition_id=? AND barcode='NSF:0000293'", fx.comp);
        expect(a).toMatchObject({ name: '김리한', team: '울산', federation: '울산스포츠과학고등학교', bib_number: '0152', gender: 'M', grade: 1 });
        const ee = await db.get("SELECT ee.* FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE ee.athlete_id=? AND e.external_key='A10301#preliminary'", a.id);
        expect(ee).toBeTruthy();
        const team = await db.get("SELECT * FROM athlete WHERE competition_id=? AND barcode='RELAY_NSF:울산:M'", fx.comp);
        expect(team).toBeTruthy();
        const members = await db.all('SELECT rm.* FROM relay_member rm JOIN event_entry ee ON ee.id=rm.event_entry_id JOIN event e ON e.id=ee.event_id WHERE ee.athlete_id=? AND e.external_key=?', team.id, 'A10312#preliminary');
        expect(members.length).toBeGreaterThanOrEqual(4);
        const mx = await db.get("SELECT COUNT(*) c FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE e.competition_id=? AND e.external_key='A11513#preliminary'", fx.comp);
        expect(Number(mx.c)).toBeGreaterThan(0);   // 혼성 계주 팀
    });

    it('결과: 종료된 조의 기록·상태·비고가 들어가고 라운드가 진행 중/완료로', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const st = await sync.syncResults(db, comp, { fetch: fetchStub(fx.calls), calc: fx.calc, all: true });
        expect(st.results).toBeGreaterThanOrEqual(4);
        const h = await db.get("SELECT h.id FROM heat h WHERE h.external_key='A10301/A11001'");
        const rs = await db.all('SELECT r.time_seconds, r.status_code, r.remark, a.name FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE r.heat_id=? ORDER BY a.name', h.id);
        expect(rs.find(x => x.name === '김리한')).toMatchObject({ time_seconds: 10.85, status_code: null });
        expect(rs.find(x => x.name === '김시훈')).toMatchObject({ time_seconds: 10.91, remark: 'Q' });
        expect(rs.find(x => x.name === '최재혁')).toMatchObject({ status_code: 'DNF', time_seconds: null });
        expect((await db.get("SELECT round_status FROM event WHERE competition_id=? AND external_key='A10301#preliminary'", fx.comp)).round_status).toBe('in_progress');   // 2~4조는 아직
        expect((await db.get("SELECT round_status FROM event WHERE competition_id=? AND external_key='A10307#final'", fx.comp)).round_status).toBe('completed');   // 결승 한 조 전원 기록
        const fld = await db.get("SELECT e.round_status, r.distance_meters, r.remark FROM result r JOIN heat h ON h.id=r.heat_id JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND h.external_key LIKE 'B1%' LIMIT 1", fx.comp);
        expect(fld).toMatchObject({ distance_meters: 18.52, remark: '대회신', round_status: 'in_progress' });
        // 공개 API 로도 보인다
        const api = await request(app).get(`/api/events?competition_id=${fx.comp}`);
        expect(api.body.length).toBeGreaterThan(30);
    });
});
