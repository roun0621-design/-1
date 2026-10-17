/**
 * 문서 언어(ko 기본 / en) — ?lang=en 이면 기록지·연맹 종합기록지·부별 종합기록지의 라벨·대회명·종목명이 영문 (2026-10, B5)
 *   lib/docLabels.js 사전 + lib/fullRecordExcel · fullRecordPdf · comprehensiveByDivision · lib/routes/pdf_documents 의 lang 인자
 *   ko 출력은 예전과 글자 그대로('성명'·'종목'·대회명 한글)
 */
const request = require('supertest');
const ExcelJS = require('exceljs');
const { docLabels, compName, eventName, roundLabel, fontName } = require('../../lib/docLabels');

let app, db;
let compId, ljEventId;
const COMP_NAME = '문서언어 테스트 대회';
const COMP_NAME_EN = 'Doc Lang Test Meet';

async function parseXlsx(buf) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb;
}
function sheetText(ws) {
    const out = [];
    ws.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, c => { const v = c.value; if (v != null) out.push(typeof v === 'object' && v.richText ? v.richText.map(r => r.text).join('') : String(v)); }));
    return out.join('\n');
}

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db; await mod.ready;

    let r = await db.run("INSERT INTO competition (name, name_en, start_date, end_date, venue, status) VALUES (?,?,?,?,?, 'active')",
        COMP_NAME, COMP_NAME_EN, '2026-01-01', '2099-12-31', '경기장');
    compId = r.lastInsertRowid;

    // 멀리뛰기 남자 결승 + 선수 2명 + 시기 결과
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, sort_order) VALUES (?, '멀리뛰기', 'field_distance', 'M', 'final', 'completed', 1)", compId);
    ljEventId = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', ljEventId);
    const heatId = r.lastInsertRowid;
    const mk = async (name, bib) => {
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?, '테스트팀', 'M')", compId, name, bib)).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", ljEventId, a)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', heatId, ee);
        return ee;
    };
    const p = await mk('점프A', '101'), q = await mk('점프B', '102');
    for (const [ee, att, v] of [[p, 1, 6.50], [p, 2, 7.30], [q, 1, 7.00], [q, 2, 6.90]]) {
        await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters) VALUES (?,?,?,?)', heatId, ee, att, v);
    }
}, 20000);

describe('lib/docLabels', () => {
    it('ko 기본 · en 라벨 · 대회명 · 종목명 · 라운드 · 글꼴', () => {
        const ko = docLabels('ko'), en = docLabels('en');
        expect(ko.name).toBe('성명'); expect(en.name).toBe('Name');
        expect(ko.rank).toBe('등위'); expect(en.rank).toBe('Rank');
        expect(docLabels(undefined).name).toBe('성명');
        expect(docLabels('ja').name).toBe('Name');                 // ja 는 당분간 en
        expect(ko.placeN(1)).toBe('1위'); expect(en.placeN(1)).toBe('1st'); expect(en.placeN(2)).toBe('2nd'); expect(en.placeN(3)).toBe('3rd'); expect(en.placeN(11)).toBe('11th');
        expect(ko.attempt(3)).toBe('3차'); expect(en.attempt(3)).toBe('Att. 3');
        expect(ko.heatTitle(2)).toBe('예선  2조'); expect(en.heatTitle(2)).toBe('Heat 2');
        expect(ko.genderDiv('M')).toBe('남자부'); expect(en.genderDiv('F')).toBe("Women's"); expect(en.genderDiv('X')).toBe('Mixed');
        expect(Object.isFrozen(ko)).toBe(true);
        const comp = { name: COMP_NAME, name_en: COMP_NAME_EN };
        expect(compName(comp, 'ko')).toBe(COMP_NAME); expect(compName(comp, 'en')).toBe(COMP_NAME_EN);
        expect(compName({ name: COMP_NAME, name_en: '' }, 'en')).toBe(COMP_NAME);          // 영문명 없으면 한글
        expect(eventName({ name: '멀리뛰기' }, 'ko')).toBe('멀리뛰기');
        expect(eventName({ name: '멀리뛰기' }, 'en')).toBe('Long Jump');
        expect(eventName({ name: '100m 일반부', code: null }, 'en')).toBe('100m');          // 부 접미는 영문 문서에 안 붙인다
        expect(eventName({ name: '이상한종목' }, 'en')).toBe('이상한종목');                  // 사전에 없으면 원래 이름
        expect(roundLabel('final', 1, 'ko')).toBe('결   승'); expect(roundLabel('semifinal', 1, 'en')).toBe('Semi-Final 1');
        expect(fontName('ko')).toBe('맑은 고딕'); expect(fontName('en')).toBe('Calibri');
    });
});

describe('기록지 PDF (result-sheet) — ?lang=en', () => {
    it('en 도 ko(기본) 도 PDF 가 나온다', async () => {
        const en = await request(app).get(`/api/documents/result-sheet/${ljEventId}?lang=en`).buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(en.status).toBe(200);
        expect(en.headers['content-type']).toMatch(/application\/pdf/);
        expect(en.body.length).toBeGreaterThan(1024);
        expect(en.body.slice(0, 5).toString()).toBe('%PDF-');
        const ko = await request(app).get(`/api/documents/result-sheet/${ljEventId}`).buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(ko.status).toBe(200);
        expect(ko.headers['content-type']).toMatch(/application\/pdf/);
        expect(ko.body.length).toBeGreaterThan(1024);
    });

    it('스타트리스트 PDF 도 ?lang=en 으로 나온다', async () => {
        const r = await request(app).get(`/api/documents/start-list/${ljEventId}?lang=en`).buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toMatch(/application\/pdf/);
        expect(r.body.length).toBeGreaterThan(1024);
    });
});

describe('연맹 종합기록지 Excel (full-record) — ?lang=en', () => {
    it('ko: 성명·종목·한글 대회명 / en: Name·Event·영문 대회명·Long Jump 시트', async () => {
        const ko = await request(app).get(`/api/documents/full-record/${compId}/excel?gender=M`).buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(ko.status).toBe(200);
        const wbKo = await parseXlsx(ko.body);
        const koSummary = wbKo.getWorksheet('종합기록');
        expect(koSummary).toBeTruthy();
        const koText = sheetText(koSummary);
        expect(koText).toContain('성명');
        expect(koText).toContain('종목');
        expect(koText).toContain(COMP_NAME);
        expect(wbKo.getWorksheet('멀리뛰기')).toBeTruthy();

        const en = await request(app).get(`/api/documents/full-record/${compId}/excel?gender=M&lang=en`).buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(en.status).toBe(200);
        const wbEn = await parseXlsx(en.body);
        const enSummary = wbEn.getWorksheet('Summary');
        expect(enSummary).toBeTruthy();                          // server.js 가 ?lang 을 넘겨야 통과
        const enText = sheetText(enSummary);
        expect(enText).toContain('Name');
        expect(enText).toContain('Event');
        expect(enText).toContain(COMP_NAME_EN);
        expect(enText).not.toContain('성명');
        const lj = wbEn.getWorksheet('Long Jump');
        expect(lj).toBeTruthy();
        const ljText = sheetText(lj);
        expect(ljText).toContain('Rank');
        expect(ljText).toContain('Event: Long Jump');
        expect(ljText).toContain('Record Comparison');
        expect(ljText).toContain('National Record (NR)');
    });
});

describe('부별 종합기록지 Excel (comprehensive-by-division) — ?lang=en', () => {
    it('ko: 종목·성명·한글 대회명 / en: Event·Name·영문 대회명·Long Jump', async () => {
        const ko = await request(app).get(`/api/documents/comprehensive-by-division/${compId}/excel`).buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(ko.status).toBe(200);
        const wbKo = await parseXlsx(ko.body);
        const koText = wbKo.worksheets.map(sheetText).join('\n');
        expect(koText).toContain('종목');
        expect(koText).toContain('성명');
        expect(koText).toContain(COMP_NAME);
        expect(koText).toContain('멀리뛰기');
        expect(wbKo.worksheets.some(ws => ws.name.includes('미분류'))).toBe(true);     // division 없는 종목 → '미분류 (남자)'

        const en = await request(app).get(`/api/documents/comprehensive-by-division/${compId}/excel?lang=en`).buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(en.status).toBe(200);
        const wbEn = await parseXlsx(en.body);
        const enText = wbEn.worksheets.map(sheetText).join('\n');
        expect(enText).toContain('Event');                      // server.js 가 ?lang 을 넘겨야 통과
        expect(enText).toContain('Name');
        expect(enText).toContain('1st');
        expect(enText).toContain(COMP_NAME_EN);
        expect(enText).toContain('Long Jump');
        expect(enText).not.toContain('성명');
        expect(wbEn.worksheets.some(ws => ws.name.includes('Unclassified'))).toBe(true);
    });
});

describe('직접 호출 — generate*(…, lang) 기본값은 ko', () => {
    it('generateComprehensiveByDivision(db, comp) 와 (db, comp, "ko") 는 같은 라벨', async () => {
        const { generateComprehensiveByDivision } = require('../../lib/comprehensiveByDivision');
        const comp = await db.get('SELECT * FROM competition WHERE id=?', compId);
        const a = await generateComprehensiveByDivision(db, comp);
        const b = await generateComprehensiveByDivision(db, comp, 'ko');
        const c = await generateComprehensiveByDivision(db, comp, 'en');
        expect(a.worksheets.map(sheetText).join('\n')).toBe(b.worksheets.map(sheetText).join('\n'));
        expect(c.worksheets.map(sheetText).join('\n')).toContain('Long Jump');
        expect(a.worksheets[0].getCell('A1').font.name).toBe('맑은 고딕');
        expect(c.worksheets[0].getCell('A1').font.name).toBe('Calibri');
    });
    it('generateFullRecordExcel(db, comp, "M", getDocTemplate, "en") — 영문 시트·라벨', async () => {
        const { generateFullRecordExcel } = require('../../lib/fullRecordExcel');
        const comp = await db.get('SELECT * FROM competition WHERE id=?', compId);
        const wb = await generateFullRecordExcel(db, comp, 'M', async () => null, 'en');
        expect(wb.getWorksheet('Summary')).toBeTruthy();
        expect(wb.getWorksheet('Long Jump')).toBeTruthy();
        expect(sheetText(wb.getWorksheet('Summary'))).toContain("Men's");
        const wbKo = await generateFullRecordExcel(db, comp, 'M', async () => null);
        expect(wbKo.getWorksheet('종합기록')).toBeTruthy();
        expect(sheetText(wbKo.getWorksheet('종합기록'))).toContain("남자부 (MEN'S)");
    });
});
