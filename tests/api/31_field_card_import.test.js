/**
 * 필드 수기 기록카드 가져오기 — /api/field-card/preview, /api/field-card/import 통합 테스트
 *
 * 격리된 테스트 DB에 대회→필드 종목(투척/수평도약/수직도약)→선수→엔트리→조→조배정을 직접 삽입한 뒤,
 * AI 전사 xlsx 를 올려 매칭·검산·저장 규칙을 회귀로 고정한다.
 *
 * 고정하는 규칙:
 *  - 관리자 키 필수 (403)
 *  - 미리보기는 DB 를 바꾸지 않음
 *  - 거리: 파울 0 / 패스 -1 / 빈칸은 row 없음, 기록구분은 attempt_number NULL 행
 *  - 풍속: 멀리뛰기·세단뛰기의 유효 시기에만 저장 (파울·패스 시기는 NULL)
 *  - 높이: XXO → 3행(X,X,O), '-' → PASS, 헤더 "165" → 1.65
 *  - 선수 단위 교체: 재업로드 시 중복 없이 갱신, 파일에 없는 선수는 그대로
 *  - round_status 자동 진행중 전환, opLog 기록
 */
const request = require('supertest');
const XLSX = require('xlsx');

let app, db;
const ADMIN_KEY = 'testadmin1234';

const COMMON = ['종별', '세부종목', '라운드', '조', '순서', '배번', '성명', '소속'];
const DIST_HDR = [...COMMON, '1차', '2차', '3차', '4차', '5차', '6차', '최고기록', '순위', '기록구분', '비고'];
const WIND_HDR = [...COMMON, '1차풍속', '2차풍속', '3차풍속', '4차풍속', '5차풍속', '6차풍속'];

function wb(sheets) {
    const book = XLSX.utils.book_new();
    for (const [name, aoa] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), name);
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
async function mkComp() {
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'FIELDCARD_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), '2026-01-01', '2099-12-31', '장');
    return r.lastInsertRowid;
}
async function mkEvent(compId, name, category, gender = 'F', round_status = 'in_progress', division = '일반부') {
    const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, division) VALUES (?,?,?,?, 'final', ?, ?)",
        compId, name, category, gender, round_status, division);
    return r.lastInsertRowid;
}
async function mkHeat(eventId, n = 1) {
    const r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,?)', eventId, n);
    return r.lastInsertRowid;
}
async function mkEntry(compId, eventId, heatId, { name, bib, team = 'T', gender = 'F', lane }) {
    let r = await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?,?)', compId, name, String(bib), team, gender);
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", eventId, r.lastInsertRowid);
    const entryId = r.lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heatId, entryId, lane);
    return entryId;
}
function post(path, compId, buf, key = ADMIN_KEY) {
    const req = request(app).post(path).field('competition_id', String(compId)).attach('file', buf, 'card.xlsx');
    if (key) req.field('admin_key', key);
    return req;
}

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
});

describe('양식/프롬프트', () => {
    it('GET /api/field-card/template — 3종 xlsx 응답', async () => {
        for (const kind of ['throw', 'horizontal', 'vertical']) {
            const res = await request(app).get(`/api/field-card/template?kind=${kind}`);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        }
        const bad = await request(app).get('/api/field-card/template?kind=nope');
        expect(bad.status).toBe(400);
    });
    it('GET /api/field-card/prompt — 텍스트 응답', async () => {
        const res = await request(app).get('/api/field-card/prompt');
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/기록카드/);
    });
});

describe('투척 (창던지기)', () => {
    let compId, eventId, heatId, e53, e57, e116, e120;
    beforeAll(async () => {
        compId = await mkComp();
        eventId = await mkEvent(compId, '창던지기', 'field_distance', 'F', 'heats_generated');
        heatId = await mkHeat(eventId);
        e53 = await mkEntry(compId, eventId, heatId, { name: '이금희', bib: 53, lane: 1 });
        e57 = await mkEntry(compId, eventId, heatId, { name: '박보경', bib: 57, lane: 6 });
        e116 = await mkEntry(compId, eventId, heatId, { name: '고현서', bib: 116, lane: 7 });
        e120 = await mkEntry(compId, eventId, heatId, { name: '결장자', bib: 120, lane: 8 });
    });
    const cardRows = () => [DIST_HDR,
        ['여자 일반부', '창던지기', '결승', 1, 1, 53, '이금희', '부천시청', '36.20', '33.43', '35.68', '34.70', '38.03', '33.60', '38.03', 3, '', ''],
        ['여자 일반부', '창던지기', '결승', 1, 6, 57, '박보경', '성남시청', '46.24', '50.45', 'X', '53.20', '50.19', 'X', '53.20', 1, '', ''],
        ['여자 일반부', '창던지기', '결승', 1, 7, 116, '고현서', '음성군청', '46.04', 'X', '46.46', '49.60', 'X', '-', '49.61', 2, '', ''],
        ['여자 일반부', '창던지기', '결승', 1, 8, 120, '결장자', '어디', '', '', '', '', '', '', '', '', 'DNS', ''],
    ];

    it('관리자 키 없으면 403', async () => {
        const res = await post('/api/field-card/preview', compId, wb([['기록', cardRows()]]), null);
        expect(res.status).toBe(403);
    });

    it('미리보기: 배번 매칭·계산·검산 경고, DB 변경 없음', async () => {
        const res = await post('/api/field-card/preview', compId, wb([['기록', cardRows()]]));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.groups.length).toBe(1);
        const g = res.body.groups[0];
        expect(g.matchStatus).toBe('matched');
        expect(g.kind).toBe('distance');
        expect(g.heatInfo.heat_id).toBe(heatId);
        expect(g.heatInfo.needs_wind).toBe(false);
        expect(g.rows.length).toBe(4);
        expect(g.rows.every(r => r.match_method === 'bib')).toBe(true);
        expect(g.rows.every(r => r.will_import)).toBe(true);
        const r57 = g.rows.find(r => r.bib === '57');
        expect(r57.computed.best).toBe(53.2);
        expect(r57.computed.rank).toBe(1);
        expect(r57.attempts['3']).toMatchObject({ kind: 'foul', disp: 'X' });
        expect(r57.changed).toBe(true);           // 기존 기록 없음 → 변경
        expect(r57.existing).toBeNull();
        const r116 = g.rows.find(r => r.bib === '116');
        expect(r116.issues.some(i => /최고기록 불일치/.test(i.msg))).toBe(true);
        expect(g.rows.find(r => r.bib === '120').status).toBe('DNS');
        expect(g.rows.some(r => r._raw !== undefined)).toBe(false);
        const cnt = await db.get('SELECT COUNT(*) AS c FROM result WHERE heat_id=?', heatId);
        expect(Number(cnt.c)).toBe(0);
        const ev = await db.get('SELECT round_status FROM event WHERE id=?', eventId);
        expect(ev.round_status).toBe('heats_generated');
    });

    it('저장: 시기별 row (파울 0 / 패스 -1 / 빈칸 없음), DNS 는 NULL 행, 진행중 전환, opLog', async () => {
        const res = await post('/api/field-card/import', compId, wb([['기록', cardRows()]]));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.results[0].imported).toBe(4);
        expect(res.body.results[0].skipped).toBe(0);

        const rows57 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', heatId, e57);
        expect(rows57.map(r => r.attempt_number)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(rows57.map(r => Number(r.distance_meters))).toEqual([46.24, 50.45, 0, 53.2, 50.19, 0]);
        expect(rows57.every(r => r.wind == null)).toBe(true);
        expect(rows57.every(r => !r.status_code)).toBe(true);

        const rows116 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', heatId, e116);
        expect(rows116.map(r => Number(r.distance_meters))).toEqual([46.04, 0, 46.46, 49.6, 0, -1]);

        const rows120 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heatId, e120);
        expect(rows120.length).toBe(1);
        expect(rows120[0].attempt_number).toBeNull();
        expect(rows120[0].status_code).toBe('DNS');

        const ev = await db.get('SELECT round_status FROM event WHERE id=?', eventId);
        expect(ev.round_status).toBe('in_progress');
        const log = await db.get("SELECT * FROM operation_log WHERE competition_id=? AND message LIKE '필드 기록카드 가져오기:%' ORDER BY id DESC LIMIT 1", compId);
        expect(log).toBeTruthy();
        expect(log.message).toContain('4명 입력');
    });

    it('재업로드: 선수 단위 교체 (중복 없음), 파일에 없는 선수는 그대로, 미리보기 changed 플래그', async () => {
        const changed = [DIST_HDR,
            ['여자 일반부', '창던지기', '결승', 1, 6, 57, '박보경', '성남시청', '46.24', '50.45', 'X', '53.25', '50.19', 'X', '53.25', 1, '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 1, 53, '이금희', '부천시청', '36.20', '33.43', '35.68', '34.70', '38.03', '33.60', '38.03', 3, '', ''],
        ];
        const pv = await post('/api/field-card/preview', compId, wb([['기록', changed]]));
        expect(pv.status).toBe(200);
        const g = pv.body.groups[0];
        expect(g.rows.find(r => r.bib === '57').changed).toBe(true);
        expect(g.rows.find(r => r.bib === '53').changed).toBe(false);
        expect(g.rows.find(r => r.bib === '53').existing.attempts['5'].value).toBe(38.03);

        const res = await post('/api/field-card/import', compId, wb([['기록', changed]]));
        expect(res.status).toBe(200);
        expect(res.body.results[0].imported).toBe(2);
        const rows57 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', heatId, e57);
        expect(rows57.length).toBe(6);
        expect(Number(rows57[3].distance_meters)).toBe(53.25);
        const rows116 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heatId, e116);
        expect(rows116.length).toBe(6);                 // 파일에 없는 선수 → 그대로
        const total = await db.get('SELECT COUNT(*) AS c FROM result WHERE heat_id=?', heatId);
        expect(Number(total.c)).toBe(6 + 6 + 6 + 1);
    });

    it('매칭 실패 행은 건너뛰고(error), 없는 종목은 not_found', async () => {
        const rows = [DIST_HDR,
            ['여자 일반부', '창던지기', '결승', 1, 9, 999, '없는선수', 'X', '30.00', '', '', '', '', '', '30.00', '', '', ''],
            ['여자 일반부', '창던지기', '결승', 1, 1, 53, '이금희', '부천시청', '36.20', '', '', '', '', '', '36.20', '', '', ''],
            ['여자 일반부', '해머던지기', '결승', 1, 1, 53, '이금희', '부천시청', '50.00', '', '', '', '', '', '50.00', '', '', ''],
        ];
        const pv = await post('/api/field-card/preview', compId, wb([['기록', rows]]));
        expect(pv.status).toBe(200);
        expect(pv.body.groups.length).toBe(2);
        const g1 = pv.body.groups.find(g => g.label.includes('창던지기'));
        const g2 = pv.body.groups.find(g => g.label.includes('해머던지기'));
        expect(g1.rows.find(r => r.bib === '999').will_import).toBe(false);
        expect(g1.rows.find(r => r.bib === '999').issues.some(i => i.level === 'error')).toBe(true);
        expect(g2.matchStatus).toBe('not_found');

        const res = await post('/api/field-card/import', compId, wb([['기록', rows]]));
        expect(res.status).toBe(200);
        const r1 = res.body.results.find(g => g.label.includes('창던지기'));
        const r2 = res.body.results.find(g => g.label.includes('해머던지기'));
        expect(r1.imported).toBe(1);
        expect(r1.skipped).toBe(1);
        expect(r2.imported).toBe(0);
        expect(r2.error).toBeTruthy();
        const rows53 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', heatId, e53);
        expect(rows53.length).toBe(1);                  // 선수 단위 교체: 1차만 남음
    });
});

describe('수평도약 (멀리뛰기, 풍속 시트)', () => {
    let compId, eventId, heatId, e63, e217;
    beforeAll(async () => {
        compId = await mkComp();
        eventId = await mkEvent(compId, '멀리뛰기', 'field_distance');
        heatId = await mkHeat(eventId);
        e63 = await mkEntry(compId, eventId, heatId, { name: '임지현', bib: 63, lane: 1 });
        e217 = await mkEntry(compId, eventId, heatId, { name: '이하은', bib: 217, lane: 2 });
    });
    it('풍속은 유효 시기에만 저장, 파울·패스 시기는 NULL, 누락은 경고', async () => {
        const buf = wb([
            ['기록', [DIST_HDR,
                ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '임지현', 'A', '5.94', 'X', '6.05', '5.88', '-', '', '6.05', 1, '', ''],
                ['여자 일반부', '멀리뛰기', '결승', 1, 2, 217, '이하은', 'B', '5.85', '5.59', '', '', '', '', '5.85', 2, '', ''],
            ]],
            ['풍속', [WIND_HDR,
                ['여자 일반부', '멀리뛰기', '결승', 1, 1, 63, '임지현', 'A', '+0.8', '+0.3', '+1.2', '0.0', '-0.5', ''],
                ['여자 일반부', '멀리뛰기', '결승', 1, 2, 217, '이하은', 'B', '-0.3', '', '', '', '', ''],
            ]],
        ]);
        const pv = await post('/api/field-card/preview', compId, buf);
        expect(pv.status).toBe(200);
        const g = pv.body.groups[0];
        expect(g.heatInfo.needs_wind).toBe(true);
        const r217 = g.rows.find(r => r.bib === '217');
        expect(r217.issues.some(i => i.level === 'warn' && /2차 유효 기록/.test(i.msg))).toBe(true);
        expect(g.rows.find(r => r.bib === '63').computed.bestWind).toBe(1.2);

        const res = await post('/api/field-card/import', compId, buf);
        expect(res.status).toBe(200);
        expect(res.body.results[0].imported).toBe(2);
        const rows63 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', heatId, e63);
        expect(rows63.map(r => r.attempt_number)).toEqual([1, 2, 3, 4, 5]);
        expect(rows63.map(r => (r.wind == null ? null : Number(r.wind)))).toEqual([0.8, null, 1.2, 0, null]);
        expect(rows63.map(r => Number(r.distance_meters))).toEqual([5.94, 0, 6.05, 5.88, -1]);
        const rows217 = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', heatId, e217);
        expect(rows217.map(r => (r.wind == null ? null : Number(r.wind)))).toEqual([-0.3, null]);
    });
});

describe('수직도약 (높이뛰기)', () => {
    let compId, eventId, heatId, e34, e83, e110;
    beforeAll(async () => {
        compId = await mkComp();
        eventId = await mkEvent(compId, '높이뛰기', 'field_height', 'M');
        heatId = await mkHeat(eventId);
        e34 = await mkEntry(compId, eventId, heatId, { name: '박준호', bib: 34, gender: 'M', lane: 1 });
        e83 = await mkEntry(compId, eventId, heatId, { name: '김민수', bib: 83, gender: 'M', lane: 2 });
        e110 = await mkEntry(compId, eventId, heatId, { name: '무기록', bib: 110, gender: 'M', lane: 3 });
    });
    const HDR = [...COMMON, '155', '160', '165', '170', '175', '최고기록', '순위', '기록구분', '비고'];
    const rows = () => [HDR,
        ['남자 일반부', '높이뛰기', '결승', 1, 1, 34, '박준호', 'T', '-', 'O', 'XO', 'O', 'XXX', '1.70', 1, '', ''],
        ['남자 일반부', '높이뛰기', '결승', 1, 2, 83, '김민수', 'T', 'O', 'O', 'O', 'XO', 'XXX', '1.70', 2, '', ''],
        ['남자 일반부', '높이뛰기', '결승', 1, 3, 110, '무기록', 'T', 'XXX', '', '', '', '', '', '', 'NM', ''],
    ];
    it('거리 양식으로 올리면 kind_mismatch', async () => {
        const bad = [DIST_HDR, ['남자 일반부', '높이뛰기', '결승', 1, 1, 34, '박준호', 'T', '1.70', '', '', '', '', '', '1.70', 1, '', '']];
        const pv = await post('/api/field-card/preview', compId, wb([['기록', bad]]));
        expect(pv.status).toBe(200);
        expect(pv.body.groups[0].matchStatus).toBe('kind_mismatch');
        const res = await post('/api/field-card/import', compId, wb([['기록', bad]]));
        expect(res.body.results[0].imported).toBe(0);
    });
    it('미리보기 계산 + 저장: XXO → 3행, - → PASS, 헤더 165 → 1.65, NM 은 NULL 행', async () => {
        const pv = await post('/api/field-card/preview', compId, wb([['기록', rows()]]));
        expect(pv.status).toBe(200);
        const g = pv.body.groups[0];
        expect(g.kind).toBe('height');
        expect(g.heights).toEqual([1.55, 1.6, 1.65, 1.7, 1.75]);
        expect(g.rows.find(r => r.bib === '34').computed).toMatchObject({ best: 1.7, rank: 1 });
        expect(g.rows.find(r => r.bib === '83').computed).toMatchObject({ best: 1.7, rank: 2 });
        expect(g.rows.find(r => r.bib === '34').marks['1.65']).toBe('XO');

        const res = await post('/api/field-card/import', compId, wb([['기록', rows()]]));
        expect(res.status).toBe(200);
        expect(res.body.results[0].imported).toBe(3);
        const a34 = await db.all('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=? ORDER BY bar_height, attempt_number', heatId, e34);
        const byH = {};
        for (const a of a34) { const k = Number(a.bar_height).toFixed(2); byH[k] = (byH[k] || '') + a.result_mark; }
        expect(byH).toEqual({ '1.55': 'PASS', '1.60': 'O', '1.65': 'XO', '1.70': 'O', '1.75': 'XXX' });
        const a110 = await db.all('SELECT * FROM height_attempt WHERE heat_id=? AND event_entry_id=?', heatId, e110);
        expect(a110.map(a => a.result_mark)).toEqual(['X', 'X', 'X']);
        const s110 = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? AND attempt_number IS NULL', heatId, e110);
        expect(s110.status_code).toBe('NM');
        // GET /api/height-attempts 로 조회 가능 (record.html 이 바 높이 목록을 여기서 만든다)
        const api = await request(app).get(`/api/height-attempts?heat_id=${heatId}`);
        expect(api.status).toBe(200);
        expect(api.body.length).toBe(a34.length + 5 + 3 + 3);
    });
    it('재업로드 시 높이 시도가 중복되지 않는다', async () => {
        const before = await db.get('SELECT COUNT(*) AS c FROM height_attempt WHERE heat_id=?', heatId);
        const res = await post('/api/field-card/import', compId, wb([['기록', rows()]]));
        expect(res.status).toBe(200);
        const after = await db.get('SELECT COUNT(*) AS c FROM height_attempt WHERE heat_id=?', heatId);
        expect(Number(after.c)).toBe(Number(before.c));
        const pv = await post('/api/field-card/preview', compId, wb([['기록', rows()]]));
        expect(pv.body.groups[0].rows.every(r => r.changed === false)).toBe(true);
    });
});

describe('혼성경기 세부종목', () => {
    it('"10종 포환던지기" 가 부모 10종경기의 세부종목에 매칭된다', async () => {
        const compId = await mkComp();
        const parent = await mkEvent(compId, '10종경기', 'combined', 'M');
        const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, parent_event_id) VALUES (?,?,?,?, 'final', 'in_progress', ?)",
            compId, '[10종] 포환던지기', 'field_distance', 'M', parent);
        const sub = r.lastInsertRowid;
        const heatId = await mkHeat(sub);
        const e1 = await mkEntry(compId, sub, heatId, { name: '십종', bib: 7, gender: 'M', lane: 1 });
        const rows = [DIST_HDR, ['남자 일반부', '10종 포환던지기', '결승', 1, 1, 7, '십종', 'T', '12.10', 'X', '12.55', '', '', '', '12.55', 1, '', '']];
        const pv = await post('/api/field-card/preview', compId, wb([['기록', rows]]));
        expect(pv.status).toBe(200);
        expect(pv.body.groups[0].matchStatus).toBe('matched');
        expect(pv.body.groups[0].heatInfo.event_id).toBe(sub);
        const res = await post('/api/field-card/import', compId, wb([['기록', rows]]));
        expect(res.status).toBe(200);
        expect(res.body.results[0].imported).toBe(1);
        const saved = await db.all('SELECT * FROM result WHERE heat_id=? AND event_entry_id=? ORDER BY attempt_number', heatId, e1);
        expect(saved.map(x => Number(x.distance_meters))).toEqual([12.1, 0, 12.55]);
    });
});
