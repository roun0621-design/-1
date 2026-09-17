/**
 * [규정·운영] 신기록 감지 (NR 한국신 / DR 부문신 / CR 대회신)
 *  - 트랙은 조 풍속(heat.wind)으로 추풍(+2.0 초과) 판정 — 예전엔 result.wind 만 봐서 추풍 기록이 신기록으로 감지됐다
 *  - 기록이 먼저, 풍속이 나중에 들어와도 다시 판정 (추풍 → 대기 감지 제거 / 허용 풍속 → 재감지)
 *  - 비교할 기존 기록이 없으면 감지하지 않는다 (예전: 기록표에 없는 종목은 1위가 전부 신기록 대기)
 *  - 동기록은 신기록이 아니다, DNS/DQ 는 제외, 종목 최고 1명만
 *  - 종합경기: 풍속 세부종목 평균 +2.0 초과면 참고기록
 */
const request = require('supertest');
let app, db;
const fx = {};
const stamp = Date.now();

async function mkEvent(name, category, extra = {}) {
    // 같은 종목명을 여러 번 쓰므로 라운드로 구분 (종목명+성별+라운드 UNIQUE). 신기록 비교는 라운드와 무관하게 종목명으로 한다.
    const r = await db.run(`INSERT INTO event (competition_id, name, category, gender, round_type, round_status, parent_event_id, sort_order) VALUES (?,?,?, 'M', ?, 'in_progress', ?, ?)`, fx.compId, name, category, extra.round || 'final', extra.parent || null, extra.sort || 0);
    const evId = r.lastInsertRowid;
    const h = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', evId);
    return { evId, heatId: h.lastInsertRowid };
}
async function mkEntry(evId, heatId, athleteId, lane) {
    const ee = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", evId, athleteId);
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heatId, ee.lastInsertRowid, lane);
    return ee.lastInsertRowid;
}
const pending = (evId) => db.all("SELECT record_type, new_value_num, wind FROM record_breaking_log WHERE event_id=? AND status='pending' ORDER BY record_type", evId);
const upsert = (body) => request(app).post('/api/results/upsert').send(body);

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    let r = await db.run("INSERT INTO competition_series (name, federation, active) VALUES (?, 'KTFL', 1)", 'REC_SERIES_' + stamp);
    fx.seriesId = r.lastInsertRowid;
    r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, series_id) VALUES (?,?,?,?, 'active', ?)", 'REC_COMP_' + stamp, '2026-01-01', '2099-12-31', 'x', fx.seriesId);
    fx.compId = r.lastInsertRowid;
    fx.ath = [];
    for (let i = 0; i < 3; i++) { r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.compId, '선수' + i, String(i + 1), '팀'); fx.ath.push(r.lastInsertRowid); }
    // 기준 기록: 100m 남 CR 10.50 (이 시리즈), NR 은 다른 테스트 데이터와 섞이지 않게 시리즈 CR 만 사용
    await db.run("INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, approved) VALUES ('competition','100m','M',NULL,?, '10.50','기준선수',1)", fx.seriesId);
    await db.run("INSERT INTO event_record (record_type, event_name, gender, division_code, series_id, record_value, holder_name, approved) VALUES ('competition','10종경기','M',NULL,?, '700','기준선수',1)", fx.seriesId);
});

describe('트랙 풍속 (조 풍속 기준)', () => {
    it('추풍(+2.4)인 조의 10.40 은 감지되지 않는다', async () => {
        const e = await mkEvent('100m', 'track'); fx.e1 = e;
        const entry = await mkEntry(e.evId, e.heatId, fx.ath[0], 4);
        await request(app).post(`/api/heats/${e.heatId}/wind`).send({ wind: 2.4 });
        const r = await upsert({ heat_id: e.heatId, event_entry_id: entry, time_seconds: 10.40 });
        expect(r.status).toBe(200);
        expect(await pending(e.evId)).toEqual([]);
        fx.e1entry = entry;
    });
    it('풍속을 +1.9 로 고치면 다시 감지된다 (CR)', async () => {
        const r = await request(app).post(`/api/heats/${fx.e1.heatId}/wind`).send({ wind: 1.9 });
        expect(r.status).toBe(200);
        const p = await pending(fx.e1.evId);
        expect(p.map(x => x.record_type)).toEqual(['competition']);
        expect(p[0].new_value_num).toBeCloseTo(10.40, 5);
        expect(p[0].wind).toBeCloseTo(1.9, 5);
    });
    it('기록이 먼저, 풍속(+3.1)이 나중에 들어오면 대기 중 감지가 제거된다', async () => {
        const r = await request(app).post(`/api/heats/${fx.e1.heatId}/wind`).send({ wind: 3.1 });
        expect(r.body.record_recheck.removed).toBe(1);
        expect(await pending(fx.e1.evId)).toEqual([]);
    });
    it('+2.0 정확히는 허용 (초과만 참고기록)', async () => {
        await request(app).post(`/api/heats/${fx.e1.heatId}/wind`).send({ wind: 2.0 });
        expect((await pending(fx.e1.evId)).length).toBe(1);
    });
});

describe('기준 기록·동기록·상태코드', () => {
    it('기준 기록이 없는 종목(400m CR 없음)은 1위여도 감지하지 않는다', async () => {
        const e = await mkEvent('400m', 'track');
        const entry = await mkEntry(e.evId, e.heatId, fx.ath[0], 3);
        await upsert({ heat_id: e.heatId, event_entry_id: entry, time_seconds: 45.00 });
        expect(await pending(e.evId)).toEqual([]);
    });
    it('동기록(10.50)은 신기록이 아니다, 0.01 빠르면 신기록', async () => {
        const e = await mkEvent('100m', 'track', { round: 'semifinal' });
        const a = await mkEntry(e.evId, e.heatId, fx.ath[1], 3);
        await upsert({ heat_id: e.heatId, event_entry_id: a, time_seconds: 10.50 });
        expect(await pending(e.evId)).toEqual([]);
        await upsert({ heat_id: e.heatId, event_entry_id: a, time_seconds: 10.49 });
        expect((await pending(e.evId)).length).toBe(1);
    });
    it('같은 종목에서 더 빠른 선수가 있으면 그 1명만 남는다, DQ 는 감지하지 않는다', async () => {
        const e = await mkEvent('100m', 'track', { round: 'preliminary' });
        const a = await mkEntry(e.evId, e.heatId, fx.ath[0], 3), b = await mkEntry(e.evId, e.heatId, fx.ath[1], 4), c = await mkEntry(e.evId, e.heatId, fx.ath[2], 5);
        await upsert({ heat_id: e.heatId, event_entry_id: a, time_seconds: 10.45 });
        await upsert({ heat_id: e.heatId, event_entry_id: b, time_seconds: 10.38 });
        await upsert({ heat_id: e.heatId, event_entry_id: c, time_seconds: 10.30, status_code: 'DQ' });
        const p = await pending(e.evId);
        expect(p.length).toBe(1);
        expect(p[0].new_value_num).toBeCloseTo(10.38, 5);
    });
});

describe('종합경기 평균 풍속', () => {
    it('풍속 세부종목 평균이 +2.0 을 넘으면 총점이 기준을 넘어도 감지하지 않는다 → 평균이 내려가면 감지', async () => {
        const pr = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'combined', 'M', 'final', 'in_progress')", fx.compId, '10종경기');
        const parent = pr.lastInsertRowid;
        await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", parent, fx.ath[2]);
        // 세부종목 2개만 둔 축소판 (점수식은 순서로 정해지므로 10종 순서대로: 100m → 멀리뛰기). 둘 다 풍속 대상.
        const s1 = await mkEvent('[10종] 100m', 'track', { parent, sort: 1 });
        const s2 = await mkEvent('[10종] 멀리뛰기', 'field_distance', { parent, sort: 2 });
        const e1 = await mkEntry(s1.evId, s1.heatId, fx.ath[2], 4), e2 = await mkEntry(s2.evId, s2.heatId, fx.ath[2], 1);
        await request(app).post(`/api/heats/${s1.heatId}/wind`).send({ wind: 3.0 });
        await upsert({ heat_id: s1.heatId, event_entry_id: e1, time_seconds: 10.80 });
        await upsert({ heat_id: s2.heatId, event_entry_id: e2, attempt_number: 1, distance_meters: 7.20, wind: 3.0 });
        expect(await pending(parent)).toEqual([]);           // 평균 (3.0+3.0)/2 = +3.0 → 참고기록
        // 100m 풍속 정정(+1.0), 멀리뛰기 최고 기록이 허용 풍속(+1.0) 시기로 바뀜 → 평균 +1.0 → 감지
        await db.run("UPDATE heat SET wind='1.0 m/s' WHERE id=?", s1.heatId);
        await upsert({ heat_id: s2.heatId, event_entry_id: e2, attempt_number: 2, distance_meters: 7.30, wind: 1.0 });
        const p = await pending(parent);
        expect(p.map(x => x.record_type)).toEqual(['competition']);
    });
});
