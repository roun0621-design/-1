/**
 * [연동] 문서(결과지 PDF·전체기록 엑셀·종합기록부)의 순위가 화면과 같은 규칙을 쓰는가 (Phase 3-④)
 *   점검 전: 문서 생성기 4곳(server.js 결과지·상장용 순위, fullRecordExcel, comprehensiveByDivision)이 각자 순위를 계산했고
 *     - 거리 종목: 최고 기록만 비교 → 동률 순서가 임의, 결과지는 rank++ 라 동률도 1·2위로 갈림
 *     - 높이 종목: 카운트백을 경기 전체 실패 수로 계산
 *   이제 모두 public/lib/ranking.js 를 쓴다. 여기서는 종합기록부 계산 경로로 실제 DB 데이터를 넣어 확인한다.
 */
const request = require('supertest');
let app, db; const fx = {};
const OP = 'testopkey';

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'DOC_RANK_' + Date.now(), '2026-01-01', '2099-12-31', 'x'); fx.comp = r.lastInsertRowid;
    const mkAth = async (n, b) => (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, n, b, '팀' + n)).lastInsertRowid;
    // 멀리뛰기: A·B 최고 7.20 동률 — B 의 두 번째 기록(7.10)이 A(7.05)보다 좋다 → B 1위
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'field_distance', 'M', 'final', 'completed')", fx.comp, '멀리뛰기'); fx.lj = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', fx.lj); const hLJ = r.lastInsertRowid;
    for (const [n, b, marks] of [['가', '1', [7.20, 7.05, 0]], ['나', '2', [7.10, 7.20, 6.90]], ['다', '3', [6.80, 0, 0]]]) {
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.lj, await mkAth(n, b))).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', hLJ, ee, +b);
        for (let i = 0; i < marks.length; i++) await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters, wind) VALUES (?,?,?,?,0.5)', hLJ, ee, i + 1, marks[i]);
    }
    // 높이뛰기: 라·마 모두 1.90 을 1차에 성공, 1.95 에서 라 XXX / 마 X 후 기권 → 규정상 동률(예전 계산은 마를 위로)
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'field_height', 'M', 'final', 'completed')", fx.comp, '높이뛰기'); fx.hj = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', fx.hj); const hHJ = r.lastInsertRowid;
    for (const [n, b, spec] of [['라', '4', { 1.90: 'O', 1.95: 'XXX' }], ['마', '5', { 1.90: 'O', 1.95: 'X' }], ['바', '6', { 1.90: 'XO', 1.95: 'XXX' }]]) {
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.hj, await mkAth(n, b))).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', hHJ, ee, +b);
        for (const [h, m] of Object.entries(spec)) for (let i = 0; i < m.length; i++) await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', hHJ, ee, +h, i + 1, m[i]);
    }
});

describe('문서 순위 = 화면 순위', () => {
    const XLSX = require('xlsx');
    const ADMIN = 'testadmin1234';
    const binary = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
    // 시트의 모든 셀을 읽는 순서대로 이어붙인 문자열 — 이름이 나오는 순서로 순위를 확인한다
    const flat = (buf) => { const wb = XLSX.read(buf, { type: 'buffer' }); return wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }).map(r => r.join('|')).join('\n')).join('\n'); };

    it('종합기록부(엑셀): 멀리뛰기 동률(7.20)은 두 번째 기록이 좋은 "나"가 "가"보다 앞', async () => {
        const r = await request(app).get(`/api/documents/comprehensive/${fx.comp}/excel?key=${ADMIN}&admin_key=${ADMIN}`).buffer(true).parse(binary);
        expect(r.status).toBe(200);
        const t = flat(r.body);
        expect(t.indexOf('나')).toBeGreaterThan(-1);
        expect(t.indexOf('나')).toBeLessThan(t.indexOf('가'));
    });
    it('부별 종합기록부·전체기록 엑셀도 같은 순서', async () => {
        for (const url of [`/api/documents/comprehensive-by-division/${fx.comp}/excel`, `/api/documents/full-record/${fx.comp}/excel`]) {
            const r = await request(app).get(`${url}?key=${ADMIN}&admin_key=${ADMIN}`).buffer(true).parse(binary);
            expect(r.status, url).toBe(200);
            const t = flat(r.body);
            if (t.includes('나') && t.includes('가')) expect(t.indexOf('나'), url).toBeLessThan(t.indexOf('가'));
        }
    });
    it('결과지 PDF 가 오류 없이 생성된다 (거리·높이)', async () => {
        for (const ev of [fx.lj, fx.hj]) {
            const r = await request(app).get(`/api/documents/result-sheet/${ev}?key=${ADMIN}&admin_key=${ADMIN}`).buffer(true).parse(binary);
            expect(r.status).toBe(200);
            expect(r.body.slice(0, 4).toString()).toBe('%PDF');
        }
    });
});
