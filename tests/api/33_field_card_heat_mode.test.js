/**
 * 필드 기록카드 — 조 고정 모드(기록 입력창) 통합 테스트
 *   /api/field-card/transcribe|preview|analyze-json|import-json 에 heat_id 를 주면
 *   종목·조를 해석하지 않고 그 조로 고정, 선수만 배번 → 순서 → 성명 순 매칭.
 *
 * 고정하는 규칙:
 *  - heat_id 있으면 운영키도 허용, 없으면 관리자 키만 (403)
 *  - 사진 전사(픽스처): 기록카드 + 풍속카드가 편집용 card 한 장으로 합쳐지고, 카드의 종목명이 틀려도 대상 조로 고정
 *  - analyze-json: 배번을 고치면 매칭 실패 → 성공으로 바뀜, 카드에 없는 선수 목록(unmatched_entries) 제공
 *  - import-json: 편집한 카드가 저장됨 (풍속은 유효 시기에만), 종료된 대회는 운영키 403 / 관리자 200
 *  - preview(xlsx)+heat_id: 편집용 card 동봉, 여러 조가 섞인 파일은 422
 */
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { createCanvas } = require('canvas');

let app, db;
const ADMIN_KEY = 'testadmin1234';
const OP_KEY = 'testopkey';
const COMMON = ['종별', '세부종목', '라운드', '조', '순서', '배번', '성명', '소속'];
const DIST_HDR = [...COMMON, '1차', '2차', '3차', '4차', '5차', '6차', '최고기록', '순위', '기록구분', '비고'];

function png() { const cv = createCanvas(40, 30); const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 40, 30); return cv.toBuffer('image/png'); }
function wb(sheets) { const book = XLSX.utils.book_new(); for (const [n, aoa] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), n); return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }); }
async function mkComp(status = 'active') {
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?,?)", 'FCHEAT_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), '2026-01-01', '2099-12-31', '장', status);
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
    const fx = path.join(os.tmpdir(), `fc_heat_fixture_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(fx, JSON.stringify(obj));
    process.env.FIELD_CARD_TRANSCRIBE_FIXTURE = fx;
    return fn().finally(() => { delete process.env.FIELD_CARD_TRANSCRIBE_FIXTURE; try { fs.unlinkSync(fx); } catch (e) {} });
}
const ath = (o) => ({ order: '', bib: '', name: '', team: '', attempts: [], winds: [], marks: [], best: '', rank: '', status: '', remark: '', uncertain: [], ...o });
const json = (url, body) => request(app).post(url).send(body).set('Content-Type', 'application/json');

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app; db = mod.db;
});

describe('조 고정 모드 — 멀리뛰기', () => {
    let compId, ljEvent, ljHeat, e63, e217, jtHeat;
    beforeAll(async () => {
        compId = await mkComp();
        ljEvent = await mkEvent(compId, '멀리뛰기', 'field_distance');
        ljHeat = await mkHeat(ljEvent);
        e63 = await mkEntry(compId, ljEvent, ljHeat, '임지현', 63, 1);
        e217 = await mkEntry(compId, ljEvent, ljHeat, '이하은', 217, 2);
        const jt = await mkEvent(compId, '창던지기', 'field_distance');
        jtHeat = await mkHeat(jt);
        await mkEntry(compId, jt, jtHeat, '이금희', 53, 1);
    });
    // AI 가 종목을 '창던지기' 로 잘못 읽고, 63 배번을 '68', 이름을 '임지헌' 으로 오독하고 순서를 못 읽은 상황
    // (배번 → 순서 → 성명 순 매칭이 모두 실패 → 사용자가 배번을 고쳐야 매칭됨)
    const CARDS = {
        cards: [
            { kind: 'distance', division: '여자 일반부', event: '창던지기', round: '결승', heat: '1', bar_heights: [], notes: '', athletes: [
                ath({ order: '', bib: '68', name: '임지헌', team: 'A', attempts: ['5.94', 'X', '6.05', '5.88', '-', ''], best: '6.05', rank: '1', uncertain: ['배번'] }),
                ath({ order: '2', bib: '217', name: '이하은', team: 'B', attempts: ['5.85', '5.59', '', '', '', ''], best: '5.85', rank: '2' }),
            ] },
            { kind: 'wind', division: '여자 일반부', event: '멀리뛰기', round: '결승', heat: '1', bar_heights: [], notes: '', athletes: [
                ath({ order: '', bib: '68', name: '임지헌', winds: ['+0.8', '+0.3', '+1.2', '0.0', '', ''], uncertain: ['3차풍속'] }),
                ath({ order: '2', bib: '217', name: '이하은', winds: ['-0.3', '', '', '', '', ''] }),
            ] },
        ],
    };
    const post = (key, extra = {}, files = 1) => {
        const req = request(app).post('/api/field-card/transcribe').field('competition_id', String(compId)).field('heat_id', String(ljHeat));
        if (key) req.field('admin_key', key);
        for (const [k, v] of Object.entries(extra)) req.field(k, String(v));
        for (let i = 0; i < files; i++) req.attach('images', png(), `c${i}.png`);
        return req;
    };
    let card;

    it('heat_id 없이 운영키면 403, heat_id 있으면 운영키 허용', async () => {
        await withFixture(CARDS, async () => {
            const bulk = await request(app).post('/api/field-card/transcribe').field('competition_id', String(compId)).field('admin_key', OP_KEY).attach('images', png(), 'c.png');
            expect(bulk.status).toBe(403);
            const none = await post(null);
            expect(none.status).toBe(403);
            const res = await post(OP_KEY, {}, 2);
            expect(res.status).toBe(200);
            expect(res.body.target).toMatchObject({ event: '멀리뛰기', heat: '1', kind: 'distance', needs_wind: true });
            expect(res.body.groups.length).toBe(1);
            expect(res.body.groups[0].heatInfo.heat_id).toBe(ljHeat);          // 카드의 '창던지기'가 아니라 고정된 조
            card = res.body.card;
            expect(card.kind).toBe('distance');
            expect(card.athletes.length).toBe(2);
            expect(card.athletes[0].winds).toEqual(['+0.8', '+0.3', '+1.2', '0.0', '', '']);   // 풍속 카드 병합
            expect(card.athletes[0].uncertain).toEqual(expect.arrayContaining(['배번', '3차풍속']));
            const r0 = res.body.groups[0].rows[0];
            expect(r0.db).toBeNull();                                            // 68 은 없는 배번 → 매칭 실패
            expect(r0.will_import).toBe(false);
            expect(res.body.groups[0].rows[1].db.event_entry_id).toBe(e217);
            expect(res.body.groups[0].unmatched_entries.map(u => u.bib)).toEqual(['63']);
            expect(res.body.transcription.uncertain_cells).toBe(2);
            expect(res.body.xlsx_base64).toBeTruthy();
        });
    });
    it('analyze-json: 배번을 63 으로 고치면 매칭되고 풍속 경고가 정리된다', async () => {
        card.athletes[0].bib = '63';
        card.athletes[0].uncertain = ['3차풍속'];
        const res = await json('/api/field-card/analyze-json', { admin_key: OP_KEY, competition_id: compId, heat_id: ljHeat, card });
        expect(res.status).toBe(200);
        const g = res.body.groups[0];
        expect(g.rows[0].db.event_entry_id).toBe(e63);
        expect(g.rows[0].will_import).toBe(true);
        expect(g.rows[0].computed).toMatchObject({ best: 6.05, rank: 1, bestWind: 1.2 });
        expect(g.rows[0].issues.some(i => /AI 판독 불확실: 3차풍속/.test(i.msg))).toBe(true);
        expect(g.rows[0].issues.some(i => /2차 파울·패스 시기의 풍속/.test(i.msg))).toBe(true);
        expect(g.rows[1].issues.some(i => /2차 유효 기록 5.59에 풍속 없음/.test(i.msg))).toBe(true);
        expect(g.unmatched_entries).toEqual([]);
        expect(res.body.card.athletes[0].bib).toBe('63');
        // heat_id 없으면 400, 잘못된 카드는 422
        expect((await json('/api/field-card/analyze-json', { admin_key: ADMIN_KEY, competition_id: compId, card })).status).toBe(400);
        expect((await json('/api/field-card/analyze-json', { admin_key: OP_KEY, competition_id: compId, heat_id: ljHeat, card: { kind: 'distance', athletes: [] } })).status).toBe(422);
    });
    it('import-json: 편집한 카드가 저장된다 (풍속은 유효 시기에만, 파울 시기는 NULL)', async () => {
        const res = await json('/api/field-card/import-json', { admin_key: OP_KEY, competition_id: compId, heat_id: ljHeat, card });
        expect(res.status).toBe(200);
        expect(res.body.results[0].imported).toBe(2);
        const rows63 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', ljHeat, e63);
        expect(rows63.map(r => Number(r.distance_meters))).toEqual([5.94, 0, 6.05, 5.88, -1]);
        expect(rows63.map(r => (r.wind == null ? null : Number(r.wind)))).toEqual([0.8, null, 1.2, 0, null]);
        const log = await db.get("SELECT * FROM operation_log WHERE competition_id=? AND message LIKE '필드 기록카드 가져오기:%' ORDER BY id DESC LIMIT 1", compId);
        expect(log.performed_by).toBe('operator');
        // 저장 후 재분석하면 '동일'
        const again = await json('/api/field-card/analyze-json', { admin_key: OP_KEY, competition_id: compId, heat_id: ljHeat, card });
        expect(again.body.groups[0].rows.every(r => r.changed === false)).toBe(true);
    });
    it('preview(xlsx)+heat_id: 편집용 card 동봉, 다른 조로 고정하면 선수 매칭 실패, 여러 조 섞이면 422', async () => {
        const rows = [DIST_HDR, ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '임지현', 'A', '5.94', 'X', '6.05', '', '', '', '6.05', 1, '', '']];
        const res = await request(app).post('/api/field-card/preview').field('admin_key', OP_KEY).field('competition_id', String(compId)).field('heat_id', String(ljHeat)).attach('file', wb([['기록', rows]]), 'a.xlsx');
        expect(res.status).toBe(200);
        expect(res.body.card.athletes[0].attempts).toEqual(['5.94', 'X', '6.05', '', '', '']);
        expect(res.body.groups[0].rows[0].db.event_entry_id).toBe(e63);
        // 창던지기 조로 고정하면 63 번·5번 순서·임지현 모두 없으므로 매칭 실패 (종목 해석을 하지 않음)
        const rows5 = [DIST_HDR, ['여자 일반부', '멀리뛰기', '결승', 1, 5, 63, '임지현', 'A', '5.94', 'X', '6.05', '', '', '', '6.05', 1, '', '']];
        const wrong = await request(app).post('/api/field-card/preview').field('admin_key', OP_KEY).field('competition_id', String(compId)).field('heat_id', String(jtHeat)).attach('file', wb([['기록', rows5]]), 'a.xlsx');
        expect(wrong.status).toBe(200);
        expect(wrong.body.groups[0].heatInfo.heat_id).toBe(jtHeat);
        expect(wrong.body.groups[0].rows[0].db).toBeNull();
        const mixed = [DIST_HDR, rows[1], ['여자 일반부', '창던지기', '결승', 1, 1, 53, '이금희', 'B', '40.00', '', '', '', '', '', '40.00', 1, '', '']];
        const m = await request(app).post('/api/field-card/preview').field('admin_key', OP_KEY).field('competition_id', String(compId)).field('heat_id', String(ljHeat)).attach('file', wb([['기록', mixed]]), 'm.xlsx');
        expect(m.status).toBe(422);
        expect(m.body.error).toMatch(/여러 종목/);
    });
    it('풍속 카드만 있으면 422, 다른 대회의 조면 400', async () => {
        await withFixture({ cards: [CARDS.cards[1]] }, async () => {
            const res = await post(OP_KEY);
            expect(res.status).toBe(422);
            expect(res.body.error).toMatch(/풍속 카드만/);
        });
        const otherComp = await mkComp();
        const res = await json('/api/field-card/analyze-json', { admin_key: OP_KEY, competition_id: otherComp, heat_id: ljHeat, card });
        expect(res.status).toBe(400);
    });
});

describe('조 고정 모드 — 높이뛰기 + 종료된 대회 잠금', () => {
    it('높이 카드 편집(바 높이 추가) → 저장', async () => {
        const compId = await mkComp();
        const ev = await mkEvent(compId, '높이뛰기', 'field_height', 'M');
        const heat = await mkHeat(ev);
        const e34 = await mkEntry(compId, ev, heat, '박준호', 34, 1);
        const card = { kind: 'height', bar_heights: ['1.55', '1.60'], athletes: [ath({ order: '1', bib: '34', name: '박준호', marks: ['O', 'XO'], best: '1.60', rank: '1' })] };
        let res = await json('/api/field-card/analyze-json', { admin_key: OP_KEY, competition_id: compId, heat_id: heat, card });
        expect(res.status).toBe(200);
        expect(res.body.groups[0].rows[0].computed).toMatchObject({ best: 1.6, rank: 1 });
        // 바 높이 1.65 추가 + XXX
        card.bar_heights.push('1.65'); card.athletes[0].marks.push('XXX');
        res = await json('/api/field-card/import-json', { admin_key: OP_KEY, competition_id: compId, heat_id: heat, card });
        expect(res.status).toBe(200);
        expect(res.body.results[0].imported).toBe(1);
        const rows = await db.all('SELECT bar_height, attempt_number, result_mark FROM height_attempt WHERE heat_id=? AND event_entry_id=? ORDER BY bar_height, attempt_number', heat, e34);
        expect(rows.map(r => `${Number(r.bar_height).toFixed(2)}:${r.result_mark}`)).toEqual(['1.55:O', '1.60:X', '1.60:O', '1.65:X', '1.65:X', '1.65:X']);
        // 거리 양식 카드를 높이 조에 올리면 kind_mismatch → 저장 0
        const bad = await json('/api/field-card/import-json', { admin_key: OP_KEY, competition_id: compId, heat_id: heat, card: { kind: 'distance', athletes: [ath({ bib: '34', attempts: ['1.70'] })] } });
        expect(bad.status).toBe(200);
        expect(bad.body.results[0].imported).toBe(0);
    });
    it('종료된 대회: 운영키는 분석·저장 모두 403 (전역 종료 잠금), 관리자 저장은 200', async () => {
        const compId = await mkComp('completed');
        const ev = await mkEvent(compId, '포환던지기', 'field_distance', 'M');
        const heat = await mkHeat(ev);
        await mkEntry(compId, ev, heat, '김포환', 7, 1);
        const card = { kind: 'distance', athletes: [ath({ bib: '7', name: '김포환', attempts: ['12.10', 'X', '12.55', '', '', ''] })] };
        // server.js 전역 가드: 종료된 대회의 competition_id 가 본문에 있는 쓰기 요청은 관리자 키 없이는 403
        expect((await json('/api/field-card/analyze-json', { admin_key: OP_KEY, competition_id: compId, heat_id: heat, card })).status).toBe(403);
        expect((await json('/api/field-card/import-json', { admin_key: OP_KEY, competition_id: compId, heat_id: heat, card })).status).toBe(403);
        // multipart 는 전역 가드가 본문을 못 읽으므로 모듈의 requireAdminAfterCompEnd 가 막는다
        const mp = await request(app).post('/api/field-card/import').field('admin_key', OP_KEY).field('competition_id', String(compId)).field('heat_id', String(heat))
            .attach('file', wb([['기록', [DIST_HDR, ['남자 일반부', '포환던지기', '결승', 1, 1, 7, '김포환', 'T', '12.10', '', '', '', '', '', '12.10', 1, '', '']]]]), 'a.xlsx');
        expect(mp.status).toBe(403);
        const ok = await json('/api/field-card/import-json', { admin_key: ADMIN_KEY, competition_id: compId, heat_id: heat, card });
        expect(ok.status).toBe(200);
        expect(ok.body.results[0].imported).toBe(1);
    });
});
