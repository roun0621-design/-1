/**
 * 한국중·고육상연맹 종합기록지 (GET /api/documents/kjaf-record/:compId/excel) — Phase 7-①
 *   연맹 실제 파일(2026 춘계·회장배·학년별) 배치 기준: 시트 묶음, 순위 8칸, 동순위 이어 쓰기, 풍속 행, 계주 주자 행, 기록 표기, 신기록현황.
 */
const request = require('supertest');
const ExcelJS = require('exceljs');
const { planSheets, parseDivision, recordText } = require('../../lib/kjafRecordSheet');
let app, db; const fx = {}; const OP = 'testopkey';
const binary = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const txt = (ws, addr) => { const v = ws.getCell(addr).value; return v == null ? '' : (typeof v === 'object' && v.richText ? v.richText.map(t => t.text).join('') : String(v)); };

async function addEvent(name, category, gender, division, opts = {}) {
    const id = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status, sort_order) VALUES (?,?,?,?,?,?,'completed',?)", fx.comp, name, category, gender, division, opts.round || 'final', opts.sort || 0)).lastInsertRowid;
    const heat = (await db.run('INSERT INTO heat (event_id, heat_number, wind) VALUES (?,1,?)', id, opts.wind ?? null)).lastInsertRowid;
    return { id, heat };
}
async function addResult(ev, name, team, val, extra = {}) {
    const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, name, extra.bib || String(100 + Math.floor(Math.random() * 900)), team)).lastInsertRowid;
    const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", ev.id, a)).lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', ev.heat, ee);
    if (extra.distance) await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters, wind) VALUES (?,?,1,?,?)', ev.heat, ee, val, extra.wind ?? null);
    else if (extra.height) await db.run("INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,1,'O')", ev.heat, ee, val);
    else if (extra.combined) { await db.run("INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points) VALUES (?, '100m', 1, 11.0, ?)", ee, val); }
    else if (extra.status) await db.run('INSERT INTO result (heat_id, event_entry_id, status_code) VALUES (?,?,?)', ev.heat, ee, extra.status);
    else await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', ev.heat, ee, val);
    return { athlete: a, entry: ee };
}

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, division_type) VALUES (?,?,?,?, 'active', 'middle')", '제99회 한국중고연맹 테스트대회', '2026-04-10', '2026-04-12', '예천스타디움')).lastInsertRowid;
    // 남중 100m: 예선 + 결승(결승만 기록지에), 동순위 2위, 풍속 +1.3
    await addEvent('100m', 'track', 'M', '중등부', { round: 'preliminary' });
    fx.m100 = await addEvent('100m', 'track', 'M', '중등부', { wind: '+1.3' });
    const names = [['김일등', '예천중', 11.10], ['이공동', '안동중', 11.25], ['박공동', '영주중', 11.25], ['최넷', '문경중', 11.40], ['정다섯', '상주중', 11.50], ['강여섯', '구미중', 11.60], ['조일곱', '김천중', 11.70], ['윤여덟', '포항중', 11.80], ['장여덟', '경주중', 11.80], ['한열', '영천중', 11.90]];
    fx.m100rows = []; for (const [n, t, v] of names) fx.m100rows.push(await addResult(fx.m100, n, t, v));
    await addResult(fx.m100, '실격이', '경산중', 0, { status: 'DQ' });
    // 여중 멀리뛰기: 선수별 풍속, 추풍 참고기록
    fx.fLJ = await addEvent('멀리뛰기', 'field_distance', 'F', '중등부');
    await addResult(fx.fLJ, '나멀리', '예천여중', 5.61, { distance: true, wind: 1.8 });
    await addResult(fx.fLJ, '다멀리', '안동여중', 5.40, { distance: true, wind: 2.4 });
    // 남중 높이뛰기(m 떼기), 여중 포환(풍속 행 없음), 남중 4x100mR(주자 행), 혼성 4x400mR(믹스릴레이 시트), 남고 5종(통합점수·부별 시트)
    fx.mHJ = await addEvent('높이뛰기', 'field_height', 'M', '중등부'); await addResult(fx.mHJ, '높이', '예천중', 1.85, { height: true });
    fx.fSP = await addEvent('포환던지기', 'field_distance', 'F', '중등부'); await addResult(fx.fSP, '포환', '예천여중', 12.34, { distance: true });
    fx.mRel = await addEvent('4x100mR', 'relay', 'M', '중등부'); const rel = await addResult(fx.mRel, '예천중', '예천중', 44.12);
    for (const [i, n] of ['주자일', '주자이', '주자삼', '주자사'].entries()) {
        const a = (await db.run("INSERT INTO athlete (competition_id, name, team, gender) VALUES (?,?,'예천중','M')", fx.comp, n)).lastInsertRowid;
        await db.run('INSERT INTO relay_member (event_entry_id, athlete_id, leg_order) VALUES (?,?,?)', rel.entry, a, i + 1);
    }
    fx.xRel = await addEvent('4x400mR', 'relay', 'X', '중등부'); await addResult(fx.xRel, '안동중', '안동중', 230.5);
    fx.hPen = await addEvent('5종경기', 'combined', 'M', '고등부'); await addResult(fx.hPen, '오종', '예천고', 3648, { combined: true });
    // 신기록: 1위 대회신(CR) 승인, 다른 하나는 미승인
    await db.run(`INSERT INTO record_breaking_log (competition_id, event_id, event_entry_id, record_type, event_name, gender, previous_value, new_value, athlete_name, athlete_team, status, reviewed_at)
        VALUES (?,?,?,'competition','100m','M','11.15','11.10','김일등','예천중','approved', datetime('now'))`, fx.comp, fx.m100.id, fx.m100rows[0].entry);
    await db.run(`INSERT INTO record_breaking_log (competition_id, event_id, event_entry_id, record_type, event_name, gender, previous_value, new_value, athlete_name, athlete_team, status)
        VALUES (?,?,?,'division','100m','M','11.20','11.10','김일등','예천중','pending')`, fx.comp, fx.m100.id, fx.m100rows[0].entry);
    // 타이기록(CT): 공동 2위 이공동 — 승인됨
    await db.run(`INSERT INTO record_breaking_log (competition_id, event_id, event_entry_id, record_type, event_name, gender, previous_value, new_value, athlete_name, athlete_team, status, is_tie, reviewed_at)
        VALUES (?,?,?,'competition','100m','M','11.25','11.25','이공동','안동중','approved', 1, datetime('now'))`, fx.comp, fx.m100.id, fx.m100rows[1].entry);
    // 시간표: 결승은 2일차
    await db.run("INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, event_id) VALUES (?,2,'track','10:00','100m','M','결승',?)", fx.comp, fx.m100.id);
});

describe('부(division) 해석과 시트 묶음 규칙', () => {
    it('부 라벨 → 학교급·학년', () => {
        expect(parseDivision('중등부')).toEqual({ level: 'MID', grade: null });
        expect(parseDivision('고등부')).toEqual({ level: 'HIGH', grade: null });
        expect(parseDivision('중1학년부')).toEqual({ level: 'MID', grade: 1 });
        expect(parseDivision('초등 5학년부')).toEqual({ level: 'ELEM', grade: 5 });
        expect(parseDivision('일반부')).toEqual({ level: null, grade: null });
    });
    const ev = (name, gender, level, grade = null) => ({ id: Math.random(), name, gender, category: 'track', _level: level, _grade: grade });
    it('학년 없는 중·고 대회: 남중·여중·남고·여고 시트', () => {
        const names = planSheets([ev('100m', 'M', 'MID'), ev('100m', 'F', 'MID'), ev('100m', 'M', 'HIGH'), ev('100m', 'F', 'HIGH')]).map(s => s.name);
        expect(names).toEqual(['남중', '여중', '남고', '여고']);
    });
    it('1학년부만 있는 대회(춘계형): 남중·여중 + "중 1학년부"(남·여 블록)', () => {
        const plan = planSheets([ev('100m', 'M', 'MID'), ev('100m', 'F', 'MID'), ev('100m', 'M', 'MID', 1), ev('100m', 'F', 'MID', 1)]);
        expect(plan.map(s => s.name)).toEqual(['남중', '여중', '중 1학년부']);
        expect(plan[2].blocks.map(b => b.title)).toEqual(['남중 1학년부', '여중 1학년부']);
    });
    it('학년별 대회: 초등 3,4학년부·5학년부·6학년부 + 중1~3학년부, 학년 없는 종목은 통합경기, 혼성은 믹스릴레이', () => {
        const plan = planSheets([ev('100m', 'M', 'ELEM', 3), ev('100m', 'F', 'ELEM', 4), ev('100m', 'M', 'ELEM', 5), ev('100m', 'M', 'ELEM', 6),
            ev('100m', 'M', 'MID', 1), ev('100m', 'F', 'MID', 2), ev('100m', 'M', 'MID', 3), ev('4x100mR', 'M', 'MID'), ev('4x400mR', 'X', 'MID')]);
        expect(plan.map(s => s.name)).toEqual(['3,4학년부', '5학년부', '6학년부', '중1학년부', '중2학년부', '중3학년부', '믹스릴레이', '통합경기']);
        expect(plan[0].blocks.map(b => b.title)).toEqual(['남초3학년부', '여초4학년부']);
        expect(plan[6].blocks[0].title).toBe('중학교부');
        expect(plan[7].blocks[0].title).toBe('남자중학교부');
    });
    it('기록 표기: 도약·투척은 m 없이, 종합은 천단위 콤마+점, 트랙은 그대로', () => {
        expect(recordText({ category: 'field_distance' }, { finished: true, record_value: '7.30m' })).toBe('7.30');
        expect(recordText({ category: 'combined' }, { finished: true, record_value: '3648점' })).toBe('3,648점');
        expect(recordText({ category: 'track' }, { finished: true, record_value: '11.10' })).toBe('11.10');
    });
});

describe('종합기록지 Excel', () => {
    let wb;
    beforeAll(async () => {
        const res = await request(app).get(`/api/documents/kjaf-record/${fx.comp}/excel`).query({ key: OP }).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('spreadsheetml');
        expect(decodeURIComponent(res.headers['content-disposition'])).toContain('중고연맹_종합기록지_');
        if (process.env.KJAF_DUMP) require('fs').writeFileSync(process.env.KJAF_DUMP, res.body);   // 눈으로 비교할 때
        wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.body);
    });
    it('시트: 남중·여중·남고·믹스릴레이·신기록현황', () => {
        expect(wb.worksheets.map(w => w.name)).toEqual(['남중', '여중', '남고', '믹스릴레이', '신기록현황']);
    });
    it('머리: 대회명·심판장·부 이름·기간, 순위 1위~8위, 종목/성명/소속/기록', () => {
        const ws = wb.getWorksheet('남중');
        expect(txt(ws, 'E2')).toBe('제99회 한국중고연맹 테스트대회');
        expect(txt(ws, 'U2')).toContain('심판장'); expect(txt(ws, 'U2')).toContain('(인)');
        expect(txt(ws, 'B3')).toBe('남자중학교부');
        expect(txt(ws, 'F3')).toBe('( 예천  2026년 4월10일 ∼ 4월12일 )');
        expect(txt(ws, 'B5')).toBe('순위'); expect(txt(ws, 'D5')).toBe('1위'); expect(txt(ws, 'Y5')).toBe('8위');
        expect([txt(ws, 'B6'), txt(ws, 'C6'), txt(ws, 'D6'), txt(ws, 'E6')]).toEqual(['종목', '성명', '소속', '기록']);
        expect(ws.getColumn(1).width).toBeCloseTo(2.33, 1);
        expect(ws.pageSetup.orientation).toBe('landscape');
    });
    it('100m: 결승만, 순서대로 8칸, 공동 2위 표기, 대회신 CR, 공동 8위는 같은 칸 아래 행, 9위 이하·실격 제외, 풍속 행, 2일차', () => {
        const ws = wb.getWorksheet('남중');
        expect(txt(ws, 'B7')).toBe('100m'); expect(txt(ws, 'A7')).toBe('2');
        expect([txt(ws, 'C7'), txt(ws, 'D7'), txt(ws, 'E7')]).toEqual(['김일등', '예천중', '11.10 CR']);
        expect(txt(ws, 'H7')).toBe('11.25 CT(공동2위)'); expect(txt(ws, 'K7')).toBe('11.25(공동2위)');    // 타이기록 CT
        expect(txt(ws, 'L7')).toBe('최넷');                                   // 4위 칸(L·M·N)
        expect(txt(ws, 'X7')).toBe('윤여덟'); expect(txt(ws, 'Z7')).toBe('11.80 공동8위');
        expect(txt(ws, 'X8')).toBe('장여덟'); expect(txt(ws, 'Z8')).toBe('11.80 공동8위');   // 이어지는 행, 같은 칸
        expect(txt(ws, 'C8')).toBe(''); expect(txt(ws, 'F7')).not.toBe('기록경기');
        const all = []; ws.eachRow(r => r.eachCell(c => all.push(String(c.value))));
        expect(all).not.toContain('한열'); expect(all).not.toContain('실격이');
        expect(txt(ws, 'B9')).toBe('풍향풍속'); expect(txt(ws, 'D9')).toBe('1.3');            // 연맹 양식은 + 부호 없음
        // 100m 결승 종목 수: 예선은 들어가지 않는다
        expect(all.filter(v => v === '100m').length).toBe(1);
    });
    it('높이뛰기 m 없음 · 4x100mR 팀명은 소속 칸, 주자 4명 병합 행', () => {
        const ws = wb.getWorksheet('남중');
        const rows = []; ws.eachRow((r, n) => rows.push([n, txt(ws, `B${n}`)]));
        const hj = rows.find(r => r[1] === '높이뛰기')[0]; expect(txt(ws, `E${hj}`)).toBe('1.85');
        const rl = rows.find(r => r[1] === '4x100mR')[0];
        expect(txt(ws, `C${rl}`)).toBe(''); expect(txt(ws, `D${rl}`)).toBe('예천중'); expect(txt(ws, `E${rl}`)).toBe('44.12');
        expect(txt(ws, `C${rl + 1}`)).toBe('주자일 주자이 주자삼 주자사');
        expect(ws.getCell(`C${rl + 1}`).isMerged).toBe(true);
        expect(txt(ws, `B${rows[rows.length - 1][0]}`)).toContain('CR:대회신');
    });
    it('여중: 멀리뛰기 선수별 풍속·추풍 참고기록·기록경기, 포환은 풍속 행 없음', () => {
        const ws = wb.getWorksheet('여중');
        const rows = []; ws.eachRow((r, n) => rows.push([n, txt(ws, `B${n}`)]));
        const lj = rows.find(r => r[1] === '멀리뛰기')[0];
        expect(txt(ws, `E${lj}`)).toBe('5.61'); expect(txt(ws, `H${lj}`)).toBe('5.40');
        expect(txt(ws, `B${lj + 1}`)).toBe('풍향풍속'); expect(txt(ws, `D${lj + 1}`)).toBe('1.8'); expect(txt(ws, `G${lj + 1}`)).toBe('2.4참고기록');
        expect(txt(ws, `I${lj}`)).toBe('기록경기');                                        // 완주 2명 → 기록경기
        const sp = rows.find(r => r[1] === '포환던지기')[0];
        expect(txt(ws, `E${sp}`)).toBe('12.34'); expect(txt(ws, `B${sp + 1}`)).not.toBe('풍향풍속');
    });
    it('남고 5종경기 점수 콤마, 믹스릴레이 (Mixed) 표기', () => {
        expect(txt(wb.getWorksheet('남고'), 'E7')).toBe('3,648점');
        const ws = wb.getWorksheet('믹스릴레이');
        expect(txt(ws, 'B3')).toBe('중학교부'); expect(txt(ws, 'B7')).toBe('4x400mR'); expect(txt(ws, 'D7')).toBe('안동중'); expect(txt(ws, 'B8')).toBe('(Mixed)');
    });
    it('신기록현황: 승인된 것만, 일시·종별·종전기록·비고', () => {
        const ws = wb.getWorksheet('신기록현황');
        expect(txt(ws, 'A1')).toBe('신 기 록 현 황');
        expect([txt(ws, 'A5'), txt(ws, 'B5'), txt(ws, 'C5'), txt(ws, 'H5'), txt(ws, 'I5')]).toEqual(['순', '일시', '종별', '종전기록', '비고']);
        expect([txt(ws, 'B6'), txt(ws, 'C6'), txt(ws, 'D6'), txt(ws, 'E6'), txt(ws, 'G6'), txt(ws, 'H6'), txt(ws, 'I6')]).toEqual(['2일', '남중부', '100m', '김일등', '11.10', '11.15', '대회신']);
        expect([txt(ws, 'D7'), txt(ws, 'E7'), txt(ws, 'I7')]).toEqual(['100m', '이공동', '대회타이']);
        expect(txt(ws, 'A8')).toBe('');
    });
    it('없는 대회는 404', async () => {
        expect((await request(app).get('/api/documents/kjaf-record/999999/excel').query({ key: OP })).status).toBe(404);
    });
});
