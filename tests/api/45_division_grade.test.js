/**
 * 학년 단위 부 + 선수 학년 + 부별 기록(DR) 감지 — Phase 7-② (2026-09)
 *   - 부 마스터에 학년 부 20행이 시드되고(/api/divisions 에 grade), 기본 부처럼 삭제 불가
 *   - DR: 종목의 부가 '중등부'·'중1학년부' 라벨이어도 부 마스터 코드로 풀려 부별 기록이 감지된다
 *     (전에는 event.division 이 'M_MID' 같은 코드와 글자 그대로 같을 때만 감지 → 관리자 화면에서 만든 종목은 한 번도 감지 안 됨)
 *   - 선수 학년: 등록·수정 API, 명단 업로드의 '학년' 열
 */
const request = require('supertest');
const ExcelJS = require('exceljs');
let app, db; const fx = {}; const OP = 'testopkey', ADMIN = 'testadmin1234';
const stamp = Date.now();

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'DIV_' + stamp, '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
});

describe('부 마스터 — 학년 단위 부', () => {
    it('/api/divisions 에 M_MID1·F_ELEM6 등 20행이 grade 와 함께 있다', async () => {
        const r = await request(app).get('/api/divisions');
        expect(r.status).toBe(200);
        const byCode = Object.fromEntries(r.body.map(d => [d.code, d]));
        expect(byCode.M_MID1).toMatchObject({ label_ko: '남자중학1학년부', gender: 'M', school_level: 'MID', grade: 1 });
        expect(byCode.F_ELEM6).toMatchObject({ gender: 'F', school_level: 'ELEM', grade: 6 });
        expect(byCode.M_MID.grade == null).toBe(true);
        expect(r.body.filter(d => d.grade != null)).toHaveLength(20);
        // 정렬: 중학부 바로 뒤에 중1·중2·중3
        const codes = r.body.map(d => d.code);
        expect(codes.indexOf('M_MID1')).toBe(codes.indexOf('M_MID') + 1);
        expect(codes.indexOf('M_MID3')).toBe(codes.indexOf('M_MID') + 3);
    });
    it('학년 부는 삭제할 수 없고(부팅 때 다시 시드), 새 부에 grade 를 줄 수 있다', async () => {
        const d = await request(app).delete('/api/admin/divisions/M_MID1').send({ admin_key: ADMIN });
        expect(d.status).toBe(400);
        const c = await request(app).post('/api/admin/divisions').send({ admin_key: ADMIN, code: 'M_TEST_G2_' + stamp, label_ko: '테스트2학년', gender: 'M', school_level: 'MID', grade: '2' });
        expect(c.status).toBe(200); expect(c.body.grade).toBe(2);
        const bad = await request(app).post('/api/admin/divisions').send({ admin_key: ADMIN, code: 'M_TEST_G9_' + stamp, label_ko: 'x', gender: 'M', school_level: 'MID', grade: 9 });
        expect(bad.status).toBe(400);
        const u = await request(app).put('/api/admin/divisions/' + c.body.code).send({ admin_key: ADMIN, grade: '' });
        expect(u.status).toBe(200); expect(u.body.grade == null).toBe(true);
    });
});

describe('부별 기록(DR) 감지 — 부 라벨로', () => {
    // 한 대회에 부가 여럿이면 종목명에 부를 붙인다('100m 중1학년부', 종목 UNIQUE 규칙) — 기록 대조는 접미를 떼고 '100m' 으로
    async function runEvent(division, timeSec, name = `100m ${division}`) {
        const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?, ?, 'track', 'M', ?, 'final', 'in_progress')", fx.comp, name, division)).lastInsertRowid;
        const heat = (await db.run('INSERT INTO heat (event_id, heat_number, wind) VALUES (?,1,?)', ev, '+0.5')).lastInsertRowid;
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, '선수' + division, String(Math.floor(Math.random() * 9000) + 1000), '팀')).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, a)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,3)', heat, ee);
        const r = await request(app).post('/api/results/upsert').set('x-admin-key', OP).send({ heat_id: heat, event_entry_id: ee, time_seconds: timeSec });
        expect(r.status).toBe(200);
        return db.all("SELECT record_type, division_code FROM record_breaking_log WHERE event_id=? AND status='pending'", ev);
    }
    beforeAll(async () => {
        await db.run("INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, approved) VALUES ('division','100m','M','M_MID',NULL,'11.50','중등기준',1)");
        await db.run("INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, approved) VALUES ('division','100m','M','M_MID1',NULL,'12.00','중1기준',1)");
    });
    it("'중등부' 라벨 종목의 11.40 → M_MID 부별 기록 감지", async () => {
        expect(await runEvent('중등부', 11.40)).toEqual([{ record_type: 'division', division_code: 'M_MID' }]);
    });
    it("'중1학년부' 종목의 11.90 → M_MID1 (중등부 기준 11.50 보다 느려도 1학년부 기록)", async () => {
        expect(await runEvent('중1학년부', 11.90)).toEqual([{ record_type: 'division', division_code: 'M_MID1' }]);
    });
    it("'중2학년부' 는 기준 기록이 없어 감지 없음, 코드 'M_MID' 그대로도 된다", async () => {
        expect(await runEvent('중2학년부', 10.90)).toEqual([]);
        expect(await runEvent('M_MID', 11.45, '100m')).toEqual([{ record_type: 'division', division_code: 'M_MID' }]);
    });
    it('기록 대조 화면(event-record-matching)도 같은 규칙으로 부 코드를 푼다', async () => {
        const r = await request(app).get('/api/admin/event-record-matching').query({ competition_id: fx.comp, key: ADMIN });
        expect(r.status).toBe(200);
        const rows = r.body.results || r.body.events || r.body;
        const mid = rows.find(x => x.division_code === 'M_MID' && x.event_name === '100m 중등부');
        expect(mid).toBeTruthy(); expect(['exact', 'normalized']).toContain(mid.division.status); expect(mid.division.record_value).toBe('11.50');   // '100m 중등부' → 접미 떼고 대조
        expect(rows.find(x => x.division_code === 'M_MID1').division.record_value).toBe('12.00');
    });
});

describe('선수 학년', () => {
    it('등록·수정: 1~6 만, 그 밖은 비움', async () => {
        const c = await request(app).post('/api/admin/athletes').send({ admin_key: OP, competition_id: fx.comp, name: '학년이', gender: 'M', bib_number: '77', grade: '3학년' });
        expect(c.status).toBe(200); expect(c.body.grade).toBe(3);
        const u = await request(app).put('/api/admin/athletes/' + c.body.id).send({ admin_key: OP, grade: 9 });
        expect(u.status).toBe(200);
        expect((await db.get('SELECT grade FROM athlete WHERE id=?', c.body.id)).grade == null).toBe(true);
        const u2 = await request(app).put('/api/admin/athletes/' + c.body.id).send({ admin_key: OP, team: '새팀' });      // grade 미지정 → 유지
        expect(u2.status).toBe(200);
    });
    it("명단 업로드의 '학년' 열", async () => {
        const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('선수명단');
        ws.addRow(['성명', '소속', '성별', '배번', '학년']);
        ws.addRow(['업로드일', '예천중', '남', '501', '2']);
        ws.addRow(['업로드이', '예천중', '여', '502', '1학년']);
        ws.addRow(['업로드삼', '예천중', '남', '503', '']);
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        const r = await request(app).post('/api/athletes/upload').field('competition_id', String(fx.comp)).field('admin_key', ADMIN).attach('file', buf, 'roster.xlsx');
        expect(r.status).toBe(200);
        const rows = await db.all("SELECT name, grade FROM athlete WHERE competition_id=? AND name LIKE '업로드%' ORDER BY name", fx.comp);
        expect(rows).toEqual([{ name: '업로드삼', grade: null }, { name: '업로드이', grade: 1 }, { name: '업로드일', grade: 2 }]);
    });
});
