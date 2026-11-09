/**
 * [규정·운영] DNS/DNF/DQ/NM 표기·정렬 — 결과지·전광판·문서 전부 같은 규칙 (Phase 2, 2026-09)
 *   완주(순위) → NM → DNF → DQ → DNS. 상태코드 선수는 순위가 없고, 기록이 남아 있어도 순위에 들지 않는다.
 *   공용 구현: public/lib/ranking.js (isStatus · compareStatus · withStatusLast · statusText)
 *   전에는 결과지·전광판·문서 생성기 10곳이 각자 목록·순서를 갖고 있었다 (NM 을 빼먹거나 DQ·NM 순서가 달랐다).
 */
const request = require('supertest');
const ExcelJS = require('exceljs');
const R = require('../../public/lib/ranking');
let app, db; const fx = {}; const OP = 'testopkey';
const binary = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

describe('공용 규칙', () => {
    it('상태코드 판정·순서·표기', () => {
        expect(['DNS', 'dnf', 'DQ', 'NM'].every(R.isStatus)).toBe(true);
        expect(['X', 'FOUL', '', null, 'Q'].some(R.isStatus)).toBe(false);
        const rows = [{ n: 'dns', status_code: 'DNS' }, { n: 'b', best: 2 }, { n: 'dq', status_code: 'DQ' }, { n: 'a', best: 3 }, { n: 'nm', status_code: 'NM' }, { n: 'dnf', status_code: 'dnf' }];
        expect(rows.sort(R.withStatusLast((a, b) => b.best - a.best)).map(r => r.n)).toEqual(['a', 'b', 'nm', 'dnf', 'dq', 'dns']);
        expect(R.compareStatus({ status_code: '' }, { status_code: null })).toBeNull();
        expect(R.statusText('DQ', 'TR 16.8')).toBe('DQ (TR 16.8)');
        expect(R.statusText('DNS', '메모')).toBe('DNS');
        expect(R.statusText('', 'x')).toBe('');
    });
});

describe('서버 문서·결과 — 같은 순서', () => {
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db;
        fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'STATUS_' + Date.now(), '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
        fx.ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '100m', 'track', 'M', 'final', 'completed')", fx.comp)).lastInsertRowid;
        const heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', fx.ev)).lastInsertRowid;
        // 입력 순서를 일부러 뒤섞는다: DNS, 완주 2, DQ(기록 있음), NM, DNF, 완주 1
        const spec = [['불참', null, 'DNS'], ['둘째', 11.20, null], ['실격', 10.90, 'DQ'], ['무기록', null, 'NM'], ['포기', null, 'DNF'], ['첫째', 11.10, null]];
        let lane = 1;
        for (const [name, t, sc] of spec) {
            const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, name, String(lane), '팀')).lastInsertRowid;
            const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.ev, a)).lastInsertRowid;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heat, ee, lane++);
            await db.run("INSERT INTO result (heat_id, event_entry_id, time_seconds, status_code, remark) VALUES (?,?,?,?,?)", heat, ee, t, sc, sc === 'DQ' ? 'TR 16.8' : '');
        }
    });
    it('상장·기록증용 결과: 첫째·둘째 → NM → DNF → DQ → DNS, 실격은 기록이 있어도 순위 없음', async () => {
        const { getEventResultsForCert } = require('../../lib/routes/certificate');
        const r = await getEventResultsForCert(fx.ev);
        expect(r.rows.map(x => x.athlete_name)).toEqual(['첫째', '둘째', '무기록', '포기', '실격', '불참']);
        expect(r.rows.map(x => x.rank)).toEqual([1, 2, null, null, null, null]);
        expect(r.rows[4].record_value).toBe('DQ');
    });
    it('종합기록지 Excel 종목 시트도 같은 순서, 상태코드는 비고에만', async () => {
        const res = await request(app).get(`/api/documents/full-record/${fx.comp}/excel`).query({ gender: 'M', key: OP }).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.body);
        const ws = wb.worksheets.find(w => /100m/.test(w.name)) || wb.worksheets[1];
        const names = [], remarks = [];
        ws.eachRow(row => { const v = row.values; const n = ['첫째', '둘째', '무기록', '포기', '실격', '불참'].find(x => v.includes(x)); if (n) { names.push(n); remarks.push(String(v[v.length - 1] ?? '')); } });
        expect(names).toEqual(['첫째', '둘째', '무기록', '포기', '실격']);     // DNS 는 종목 시트에서 뺀다 (기존 규칙)
        expect(remarks.slice(2)).toEqual(['NM', 'DNF', 'DQ']);
    });
    it('결과지 PDF 가 만들어진다 (상태코드 행 포함)', async () => {
        const res = await request(app).get(`/api/documents/result-sheet/${fx.ev}`).query({ key: OP }).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('pdf');
    });
});
