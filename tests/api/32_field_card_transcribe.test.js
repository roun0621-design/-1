/**
 * POST /api/field-card/transcribe — 사진 → 서버 AI 전사 → 미리보기 + xlsx 통합 테스트
 *
 * 실제 API 는 호출하지 않는다: FIELD_CARD_TRANSCRIBE_FIXTURE(JSON) 로 전사 결과를 주입하고,
 * 그 뒤의 시트 변환 → 매칭 → 검산 → xlsx 응답 → /import 저장까지를 회귀로 고정한다.
 *  - 관리자 키 없으면 403, 사진 없으면 400, 키·픽스처 모두 없으면 503, 풍속 카드만 있으면 422
 *  - 응답 xlsx_base64 를 그대로 /api/field-card/import 에 올리면 저장된다
 *  - AI 불확실 셀은 해당 선수 행의 경고로 표시된다
 */
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { createCanvas } = require('canvas');

let app, db;
const ADMIN_KEY = 'testadmin1234';

function png() { const cv = createCanvas(60, 40); const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 60, 40); return cv.toBuffer('image/png'); }
async function mkComp() {
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'FCTRANS_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), '2026-01-01', '2099-12-31', '장');
    return r.lastInsertRowid;
}
async function mkEvent(compId, name, category, gender = 'F') {
    const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, division) VALUES (?,?,?,?, 'final', 'in_progress', '일반부')", compId, name, category, gender);
    return r.lastInsertRowid;
}
async function mkHeat(eventId) { const r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', eventId); return r.lastInsertRowid; }
async function mkEntry(compId, eventId, heatId, name, bib, lane) {
    let r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'F')", compId, name, String(bib), 'T');
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", eventId, r.lastInsertRowid);
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heatId, r.lastInsertRowid, lane);
    return r.lastInsertRowid;
}
function withFixture(obj, fn) {
    const fx = path.join(os.tmpdir(), `fc_api_fixture_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(fx, JSON.stringify(obj));
    process.env.FIELD_CARD_TRANSCRIBE_FIXTURE = fx;
    return fn().finally(() => { delete process.env.FIELD_CARD_TRANSCRIBE_FIXTURE; try { fs.unlinkSync(fx); } catch (e) {} });
}
const ath = (o) => ({ order: '', bib: '', name: '', team: '', attempts: [], winds: [], marks: [], best: '', rank: '', status: '', remark: '', uncertain: [], ...o });
const CARD = {
    kind: 'distance', division: '여자 일반부', event: '창던지기', round: '결승', heat: '1', bar_heights: [], notes: '',
    athletes: [
        ath({ order: '1', bib: '53', name: '이금희', team: '부천시청', attempts: ['36.20', '33.43', '35.68', '34.70', '38.03', '33.60'], best: '38.03', rank: '2', uncertain: ['3차', '5차'] }),
        ath({ order: '6', bib: '57', name: '박보경', team: '성남시청', attempts: ['46.24', '50.45', 'X', '53.20', '50.19', 'X'], best: '53.20', rank: '1' }),
    ],
};

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
});

describe('POST /api/field-card/transcribe', () => {
    let compId, heatId, e53, e57;
    beforeAll(async () => {
        compId = await mkComp();
        const ev = await mkEvent(compId, '창던지기', 'field_distance');
        heatId = await mkHeat(ev);
        e53 = await mkEntry(compId, ev, heatId, '이금희', 53, 1);
        e57 = await mkEntry(compId, ev, heatId, '박보경', 57, 6);
    });
    const post = (key = ADMIN_KEY, files = 1) => {
        const req = request(app).post('/api/field-card/transcribe').field('competition_id', String(compId));
        if (key) req.field('admin_key', key);
        for (let i = 0; i < files; i++) req.attach('images', png(), `card${i}.png`);
        return req;
    };

    it('관리자 키 없으면 403, 사진 없으면 400', async () => {
        await withFixture({ cards: [CARD] }, async () => {
            expect((await post(null)).status).toBe(403);
            expect((await post(ADMIN_KEY, 0)).status).toBe(400);
        });
    });
    it('키도 픽스처도 없으면 503 (xlsx 경로는 영향 없음)', async () => {
        const saved = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.FIELD_CARD_TRANSCRIBE_FIXTURE;
        try {
            const res = await post();
            expect(res.status).toBe(503);
            expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
        } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
    });
    it('전사 → 매칭·검산 미리보기 + xlsx, 불확실 셀 경고, opLog', async () => {
        await withFixture({ cards: [CARD], usage: { input_tokens: 5000, output_tokens: 900 } }, async () => {
            const res = await post();
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.groups.length).toBe(1);
            const g = res.body.groups[0];
            expect(g.matchStatus).toBe('matched');
            expect(g.heatInfo.heat_id).toBe(heatId);
            const r53 = g.rows.find(r => r.bib === '53');
            expect(r53.will_import).toBe(true);
            expect(r53.computed).toMatchObject({ best: 38.03, rank: 2 });
            expect(r53.issues.some(i => i.level === 'warn' && /AI 판독 불확실: 3차, 5차/.test(i.msg))).toBe(true);
            const r57 = g.rows.find(r => r.bib === '57');
            expect(r57.issues.some(i => /AI 판독 불확실/.test(i.msg))).toBe(false);
            expect(res.body.transcription).toMatchObject({ cards: 1, model: 'fixture', uncertain_cells: 2, fixture: true });
            expect(res.body.transcription.usage.input_tokens).toBe(5000);
            expect(res.body.xlsx_filename).toMatch(/^field_card_ai_\d+\.xlsx$/);
            // xlsx 가 기존 양식과 같은 시트/헤더
            const wb = XLSX.read(Buffer.from(res.body.xlsx_base64, 'base64'), { type: 'buffer' });
            expect(wb.SheetNames).toEqual(['기록']);
            const aoa = XLSX.utils.sheet_to_json(wb.Sheets['기록'], { header: 1 });
            expect(aoa[0].slice(0, 9)).toEqual(['종별', '세부종목', '라운드', '조', '순서', '배번', '성명', '소속', '1차']);
            // DB 는 아직 변경 없음
            const cnt = await db.get('SELECT COUNT(*) AS c FROM result WHERE heat_id=?', heatId);
            expect(Number(cnt.c)).toBe(0);
            const log = await db.get("SELECT * FROM operation_log WHERE competition_id=? AND message LIKE '필드 기록카드 AI 전사:%' ORDER BY id DESC LIMIT 1", compId);
            expect(log).toBeTruthy();
            expect(log.message).toContain('카드 1장');

            // 응답 xlsx 를 그대로 저장 경로에 올리면 저장된다
            const imp = await request(app).post('/api/field-card/import')
                .field('admin_key', ADMIN_KEY).field('competition_id', String(compId))
                .attach('file', Buffer.from(res.body.xlsx_base64, 'base64'), res.body.xlsx_filename);
            expect(imp.status).toBe(200);
            expect(imp.body.results[0].imported).toBe(2);
            const rows57 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', heatId, e57);
            expect(rows57.map(r => Number(r.distance_meters))).toEqual([46.24, 50.45, 0, 53.2, 50.19, 0]);
            const rows53 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heatId, e53);
            expect(rows53.length).toBe(6);
        });
    });
    it('풍속 카드만 인식되면 422, 카드가 없으면 422', async () => {
        await withFixture({ cards: [{ ...CARD, kind: 'wind' }] }, async () => {
            const res = await post();
            expect(res.status).toBe(422);
            expect(res.body.error).toMatch(/풍속 카드만/);
        });
        await withFixture({ cards: [] }, async () => {
            const res = await post();
            expect(res.status).toBe(422);
        });
    });
    it('사진 2장(기록+풍속)도 한 요청으로 처리된다', async () => {
        await withFixture({ cards: [CARD, { ...CARD, kind: 'wind', athletes: [ath({ order: '1', bib: '53', name: '이금희', winds: ['+0.5', '', '', '', '', ''] })] }] }, async () => {
            const res = await post(ADMIN_KEY, 2);
            expect(res.status).toBe(200);
            const wb = XLSX.read(Buffer.from(res.body.xlsx_base64, 'base64'), { type: 'buffer' });
            expect(wb.SheetNames).toEqual(['기록', '풍속']);
            // 창던지기는 풍속 종목이 아니므로 풍속 시트는 무시된다는 안내
            expect(res.body.groups[0].issues.some(i => /풍속 시트는 무시/.test(i.msg))).toBe(true);
        });
    });
});
