/**
 * 문서 생성 엔드포인트 통합 테스트 — 연맹 종합기록지 Excel/PDF
 *
 * lib/fullRecordExcel.js (exceljs) / lib/fullRecordPdf.js (pdfkit) 는 큰 레이아웃
 * 코드인데 완전 미검증. 실제 데이터로 생성 시 500(크래시) 없이 문서 버퍼가
 * 나오는지 회귀로 고정한다. (트랙·필드거리·높이 종목을 섞어 경로 커버)
 */
const request = require('supertest');

let app, db;
let compId;

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;

    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'DOC_TEST_' + Date.now(), '2026-01-01', '2099-12-31', '장');
    compId = r.lastInsertRowid;

    // 트랙 종목 + 결과
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'completed')", compId, '100m');
    const trackEv = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', trackEv);
    const trackHeat = r.lastInsertRowid;
    for (let i = 0; i < 3; i++) {
        r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", compId, '선수T' + i, String(400 + i), '팀' + i);
        r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", trackEv, r.lastInsertRowid);
        const entry = r.lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', trackHeat, entry, i + 1);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', trackHeat, entry, 10.8 + i * 0.15);
    }

    // 필드거리(멀리뛰기) 종목 + 결과
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'field_distance', 'M', 'final', 'completed')", compId, '멀리뛰기');
    const fdEv = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fdEv);
    const fdHeat = r.lastInsertRowid;
    r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, gender) VALUES (?,?,?, 'M')", compId, '점프선수', '450');
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fdEv, r.lastInsertRowid);
    const fdEntry = r.lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', fdHeat, fdEntry);
    await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters) VALUES (?,?,1,?)', fdHeat, fdEntry, 6.85);
}, 20000);

describe('문서 생성 — 연맹 종합기록지', () => {
    it('GET full-record Excel (남자) → 200 + spreadsheet, 500 없음', async () => {
        const res = await request(app).get(`/api/documents/full-record/${compId}/excel?gender=M`);
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheet/);
        expect(res.headers['content-disposition']).toMatch(/attachment/);
    }, 20000);

    it('GET full-record PDF (남자) → 200 + pdf, 500 없음', async () => {
        const res = await request(app).get(`/api/documents/full-record/${compId}/pdf?gender=M`);
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/pdf/);
    }, 20000);

    it('존재하지 않는 대회 → 404', async () => {
        const res = await request(app).get('/api/documents/full-record/999999/excel?gender=M');
        expect(res.status).toBe(404);
    });
});
