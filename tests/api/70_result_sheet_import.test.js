/**
 * 결과 문자용 결과표 가져오기 (2026-11-08) — /api/admin/result-sheet/preview · /import → 문자 일괄 발송(종목 × 선수 한 통)
 *   주최가 운영하고 우리는 문자만 보내는 대회: '이름·전화번호·소속·부별·종목·기록' 평평한 파일 → 선수·종목·조·기록
 */
const request = require('supertest');
const XLSX = require('xlsx');
const R = require('../../lib/resultSheetImport');

let app, db; const ADMIN = 'testadmin1234';
const HEADER = ['이름', '전화번호', '소속', '부별', '종목', '기록', '순위'];
const ROWS = [
    ['임수현', '010-1111-2222', '수내초', '남초 3', '80m 예선', '11.52', '1'],
    ['임수현', '010-1111-2222', '수내초', '남초 3', '멀리뛰기', '3m21', '2'],
    ['김서인', '01033334444', '상동초', '남초 3', '80m 예선', '11.80', '2'],
    ['송유정', '010-5555-6666', '판교초', '여자초등부 3학년', '80m 예선', '12.01', '1'],
    ['박의진', '010-7777-8888', '금릉초', '남초 5', '높이뛰기', '1.05', '1'],
    ['나예나', '010-9999-0000', '남양초', '여초 5', '600m 결승', '2:05.3', '3'],
    ['홍길동', '', '모초', '남초 1', '60m', 'DNS', ''],
    ['이상행', '010-1212-3434', '모초', '', '', '9.9', ''],
];
function buf(rows, header = HEADER) {
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '결과');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const post = (path, b, fields) => { let r = request(app).post(path).field('admin_key', ADMIN); for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v)); return r.attach('file', b, 'result.xlsx'); };

describe('결과표 가져오기 (문자 발송용)', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '2026 유소년 기초종목 육상 페스티벌 (문자)', start_date: '2026-11-15', end_date: '2026-11-15', venue: '성남' })).body.id;
        expect(fx.comp).toBeTruthy();
    });

    it('파서: 부별·종목 칸 해석(남초 3 / 여자초등부 3학년 / 종목 칸의 라운드), 기록(시간·3m21·높이·DNS), 전화 정규화', () => {
        expect(R.parseDivision('남초 3')).toEqual({ gender: 'M', division: '초등부 3학년' });
        expect(R.parseDivision('여자초등부 3학년 (5~7세 포함)')).toEqual({ gender: 'F', division: '초등부 3학년' });
        expect(R.parseDivision('남.여초 5.6')).toEqual({ gender: 'X', division: '초등부 5·6학년' });
        expect(R.parseEventText('80m 예선')).toMatchObject({ name: '80m', round: 'preliminary' });
        expect(R.parseEventText('남초6 100m 결승')).toMatchObject({ name: '100m', round: 'final', rest: '남초6' });
        expect(R.parseEventText('멀리뛰기')).toMatchObject({ name: '멀리뛰기', round: null });
        expect(R.parseRecord('11.52', 'track')).toEqual({ status: null, value: 11.52 });
        expect(R.parseRecord('2:05.3', 'track').value).toBeCloseTo(125.3, 5);
        expect(R.parseRecord('3m21', 'field_distance')).toEqual({ status: null, value: 3.21 });
        expect(R.parseRecord('321cm', 'field_distance')).toEqual({ status: null, value: 3.21 });
        expect(R.parseRecord('1.05', 'field_height')).toEqual({ status: null, value: 1.05 });
        expect(R.parseRecord('기권', 'track')).toEqual({ status: 'DNF', value: null });
        expect(R.parseRecord('abc', 'track').bad).toBe(true);
        expect(R.normPhone('010-1111-2222')).toBe('01011112222'); expect(R.normPhone('+82 10 1111 2222')).toBe('01011112222'); expect(R.normPhone('1011112222')).toBe('01011112222');
        const p = R.parseResultSheet(buf(ROWS));
        expect(p.rows).toHaveLength(8);
        expect(p.rows[0]).toMatchObject({ name: '임수현', phone: '01011112222', team: '수내초', eventKey: { gender: 'M', division: '초등부 3학년', name: '80m', round: 'preliminary', category: 'track' }, value: 11.52, rank: 1, issues: [] });
        expect(p.rows[3].eventKey).toMatchObject({ gender: 'F', division: '초등부 3학년', name: '80m', round: 'preliminary' });
        expect(p.rows[6]).toMatchObject({ status: 'DNS', value: null }); expect(p.rows[6].issues.join()).toMatch(/전화번호 없음/);
        expect(p.rows[7].issues.join()).toMatch(/종목을 읽지 못함/);
    });

    it('미리보기: 종목 묶음·새 선수·보낼 수 있는 행 수, DB 는 그대로', async () => {
        expect((await request(app).post(`/api/admin/result-sheet/preview`).field('competition_id', fx.comp).attach('file', buf(ROWS), 'r.xlsx')).status).toBe(403);
        const pre = await post('/api/admin/result-sheet/preview', buf(ROWS), { competition_id: fx.comp });
        expect(pre.status).toBe(200);
        expect(pre.body.stats).toMatchObject({ rows: 8, events_new: 7, athletes_new: 7, sendable: 6, no_phone: 1 });
        expect(pre.body.header).toMatchObject({ name: '이름', phone: '전화번호', team: '소속', division: '부별', event: '종목', record: '기록', rank: '순위' });
        const g80 = pre.body.groups.find(g => g.label === '남자 초등부 3학년 80m 예선'); expect(g80).toMatchObject({ count: 2, writable: 2, event: null });
        expect(pre.body.rows.filter(r => r.writable)).toHaveLength(7);
        expect(Number((await db.get('SELECT COUNT(*) c FROM event WHERE competition_id=?', fx.comp)).c)).toBe(0);
        expect(Number((await db.get('SELECT COUNT(*) c FROM athlete WHERE competition_id=?', fx.comp)).c)).toBe(0);
    });

    it('반영: 종목·조·선수(이름+전화 동일인)·기록(트랙/거리/높이/DNS) 생성, 다시 올려도 같음', async () => {
        const ap = await post('/api/admin/result-sheet/import', buf(ROWS), { competition_id: fx.comp });
        expect(ap.status).toBe(200);
        expect(ap.body).toMatchObject({ results: 7, events_created: 6, athletes_created: 6, skipped: 1 });
        const ev80 = await db.get("SELECT * FROM event WHERE competition_id=? AND name='80m' AND gender='M' AND round_type='preliminary'", fx.comp);
        expect(ev80).toMatchObject({ division: '초등부 3학년', category: 'track', round_status: 'completed' });
        const lim = await db.get("SELECT * FROM athlete WHERE competition_id=? AND name='임수현'", fx.comp);
        expect(lim).toMatchObject({ team: '수내초', phone: '01011112222', gender: 'M' });
        expect(Number((await db.get('SELECT COUNT(*) c FROM event_entry WHERE athlete_id=?', lim.id)).c)).toBe(2);
        const t = await db.get('SELECT r.time_seconds FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id WHERE ee.athlete_id=? AND ee.event_id=?', lim.id, ev80.id);
        expect(t.time_seconds).toBeCloseTo(11.52, 5);
        const lj = await db.get("SELECT e.id FROM event e WHERE e.competition_id=? AND e.name='멀리뛰기' AND e.gender='M'", fx.comp);
        const d = await db.get('SELECT r.attempt_number, r.distance_meters FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id WHERE ee.athlete_id=? AND ee.event_id=?', lim.id, lj.id);
        expect(d).toMatchObject({ attempt_number: 1 }); expect(d.distance_meters).toBeCloseTo(3.21, 5);
        const hj = await db.get("SELECT e.id FROM event e WHERE e.competition_id=? AND e.name='높이뛰기'", fx.comp);
        const ha = await db.all('SELECT bar_height, result_mark FROM height_attempt ha JOIN heat h ON h.id=ha.heat_id WHERE h.event_id=?', hj.id);
        expect(ha).toEqual([{ bar_height: 1.05, result_mark: 'O' }]);
        const dns = await db.get("SELECT r.status_code, ee.status FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE a.competition_id=? AND a.name='홍길동'", fx.comp);
        expect(dns).toMatchObject({ status_code: 'DNS', status: 'no_show' });
        // 멱등
        const again = await post('/api/admin/result-sheet/import', buf(ROWS), { competition_id: fx.comp });
        expect(again.body).toMatchObject({ results: 7, events_created: 0, athletes_created: 0, heats_created: 0 });
        expect(Number((await db.get('SELECT COUNT(*) c FROM athlete WHERE competition_id=?', fx.comp)).c)).toBe(6);
        expect(Number((await db.get('SELECT COUNT(*) c FROM result r JOIN event_entry ee ON ee.id=r.event_entry_id WHERE ee.athlete_id=?', lim.id)).c)).toBe(2);
        // 결승 파일이 나중에 오면: 같은 선수, 결승 라운드는 별개 종목으로 추가
        const fin = await post('/api/admin/result-sheet/import', buf([['임수현', '010-1111-2222', '수내초', '남초 3', '80m 결승', '11.40', '1']]), { competition_id: fx.comp });
        expect(fin.body).toMatchObject({ results: 1, events_created: 1, athletes_created: 0 });
        expect(Number((await db.get('SELECT COUNT(*) c FROM event_entry WHERE athlete_id=?', lim.id)).c)).toBe(3);
    });

    it('문자 일괄 발송(시뮬레이션): 종목마다 한 통 — 두 종목 선수는 두 통, 예선·결승도 각각', async () => {
        await db.run('UPDATE sms_config SET sim_mode=1');
        const finals = await request(app).post('/api/admin/sms/batch-send').send({ admin_key: ADMIN, competition_id: fx.comp, event_ids: [], rank_from: 1, rank_to: 99, include_finishers: true });
        expect(finals.status).toBe(200);
        // 결승 종목: 멀리뛰기(임수현)·높이뛰기(박의진)·600m(나예나)·80m 결승(임수현) — 60m 의 홍길동은 DNS·전화 없음이라 빠짐
        expect(finals.body.total).toBe(4);
        const prelimIds = (await db.all("SELECT id FROM event WHERE competition_id=? AND round_type='preliminary'", fx.comp)).map(e => e.id);
        const pre = await request(app).post('/api/admin/sms/batch-send').send({ admin_key: ADMIN, competition_id: fx.comp, event_ids: prelimIds, rank_scope: 'heat', rank_from: 1, rank_to: 99, include_finishers: true });
        expect(pre.body.total).toBe(3);
        const lim = await db.get("SELECT id FROM athlete WHERE competition_id=? AND name='임수현'", fx.comp);
        const logs = await db.all('SELECT message FROM sms_log WHERE competition_id=? AND athlete_id=? ORDER BY id', fx.comp, lim.id);
        expect(logs).toHaveLength(3);
        expect(logs.map(l => l.message).join('\n')).toMatch(/멀리뛰기/); expect(logs.map(l => l.message).join('\n')).toMatch(/3\.21/); expect(logs.map(l => l.message).join('\n')).toMatch(/11\.52/);
        // 같은 파일로 다시 보내면 중복 발송 없음
        const dup = await request(app).post('/api/admin/sms/batch-send').send({ admin_key: ADMIN, competition_id: fx.comp, event_ids: prelimIds, rank_scope: 'heat', rank_from: 1, rank_to: 99, include_finishers: true });
        expect(dup.body.total).toBe(0); expect(dup.body.skipped_already_sent).toBe(3);
    });
});
