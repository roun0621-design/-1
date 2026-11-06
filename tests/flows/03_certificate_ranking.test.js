/**
 * [연동] 상장·기록증·문자 발송의 순위 (lib/routes/certificate.js getEventResultsForCert) — Phase 3-④
 *   예전: 순위 = 목록 위치(idx+1) → 동기록도 1·2위로 갈림 / 높이 종목은 result.distance_meters 를 봐서 순위·기록 없음 /
 *        필드 DQ 선수가 기록이 있으면 순위에 들어감 / 종합경기 미지원 / 기록 없는 선수에게도 순위
 *   지금: 화면·결과지와 같은 공용 규칙(public/lib/ranking.js)
 */
let db, getRows; const fx = {};

beforeAll(async () => {
    const mod = require('../../server.js'); db = mod.db;
    getRows = require('../../lib/routes/certificate').getEventResultsForCert;
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'CERT_' + Date.now(), '2026-01-01', '2099-12-31', 'x');
    fx.comp = r.lastInsertRowid;
});
let bibSeq = 1;
async function mkEvent(name, category, round = 'final', parent = null) {
    const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, parent_event_id) VALUES (?,?,?, 'M', ?, 'completed', ?)", fx.comp, name, category, round, parent);
    return r.lastInsertRowid;
}
async function mkHeat(evId, n = 1, wind = null) { return (await db.run('INSERT INTO heat (event_id, heat_number, wind) VALUES (?,?,?)', evId, n, wind)).lastInsertRowid; }
async function mkEntry(evId, heatId, name) {
    const a = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, name, String(bibSeq++), '팀');
    const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", evId, a.lastInsertRowid)).lastInsertRowid;
    if (heatId) await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heatId, ee, bibSeq % 8 + 1);
    return ee;
}
const byName = (rows) => Object.fromEntries(rows.map(r => [r.athlete_name, r]));

describe('상장 순위', () => {
    it('트랙: 동기록은 공동 순위(1·1·3), DQ 는 기록이 있어도 순위 없음, 기록 없는 선수도 순위 없음', async () => {
        const ev = await mkEvent('100m', 'track'); const h = await mkHeat(ev, 1, '1.2 m/s');
        const A = await mkEntry(ev, h, 'A'), B = await mkEntry(ev, h, 'B'), C = await mkEntry(ev, h, 'C'), D = await mkEntry(ev, h, 'D'); await mkEntry(ev, h, 'E');
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.52)', h, A);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.52)', h, B);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.60)', h, C);
        await db.run("INSERT INTO result (heat_id, event_entry_id, time_seconds, status_code) VALUES (?,?,10.30,'DQ')", h, D);
        const m = byName((await getRows(ev)).rows);
        expect([m.A.rank, m.B.rank, m.C.rank]).toEqual([1, 1, 3]);
        expect(m.D.rank).toBe(null); expect(m.D.finished).toBe(false); expect(m.D.record_value).toBe('DQ');
        expect(m.E.rank).toBe(null); expect(m.E.finished).toBe(false);
        expect(m.A.record_value).toBe('10.52'); expect(m.A.wind).toBeCloseTo(1.2, 5);
    });
    it('트랙 예선 2조: 전체 순위와 조 내 순위(heat_rank)가 따로 나온다', async () => {
        const ev = await mkEvent('200m', 'track', 'preliminary'); const h1 = await mkHeat(ev, 1), h2 = await mkHeat(ev, 2);
        const a = await mkEntry(ev, h1, 'h1a'), b = await mkEntry(ev, h1, 'h1b'), c = await mkEntry(ev, h2, 'h2a');
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,21.50)', h1, a);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,21.90)', h1, b);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,21.70)', h2, c);
        const out = await getRows(ev); const m = byName(out.rows);
        expect([m.h1a.rank, m.h2a.rank, m.h1b.rank]).toEqual([1, 2, 3]);
        expect([m.h1a.heat_rank, m.h1b.heat_rank, m.h2a.heat_rank]).toEqual([1, 2, 1]);
        expect(out.heatCount).toBe(2);
    });
    it('높이뛰기: height_attempt 에서 기록·순위(카운트백), 한 번도 못 넘으면 NM', async () => {
        const ev = await mkEvent('높이뛰기', 'field_height'); const h = await mkHeat(ev);
        const mk = async (name, spec) => { const ee = await mkEntry(ev, h, name); for (const [bar, marks] of Object.entries(spec)) for (let i = 0; i < marks.length; i++) await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', h, ee, +bar, i + 1, marks[i]); return ee; };
        await mk('가', { 1.85: 'O', 1.90: 'XO', 1.95: 'XXX' }); await mk('나', { 1.85: 'O', 1.90: 'O', 1.95: 'XXX' }); await mk('다', { 1.85: 'XXX' });
        const m = byName((await getRows(ev)).rows);
        expect([m['나'].rank, m['가'].rank]).toEqual([1, 2]);
        expect(m['나'].record_value).toBe('1.90m');
        expect(m['다'].rank).toBe(null); expect(m['다'].record_value).toBe('NM');
    });
    it('멀리뛰기: 최고 동률은 두 번째 기록으로, DQ 는 기록이 있어도 제외, 풍속은 최고 기록 시기의 값', async () => {
        const ev = await mkEvent('멀리뛰기', 'field_distance'); const h = await mkHeat(ev);
        const put = async (ee, marks, winds) => { for (let i = 0; i < marks.length; i++) await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters, wind) VALUES (?,?,?,?,?)', h, ee, i + 1, marks[i], winds ? winds[i] : null); };
        const x = await mkEntry(ev, h, 'x'), y = await mkEntry(ev, h, 'y'), z = await mkEntry(ev, h, 'z');
        await put(x, [7.20, 7.05, 0], [0.4, 1.1, null]); await put(y, [7.10, 7.20, 6.90], [0.2, 1.8, 0.1]); await put(z, [7.50, 7.40], [0.5, 0.5]);
        await db.run("INSERT INTO result (heat_id, event_entry_id, attempt_number, status_code) VALUES (?,?,NULL,'DQ')", h, z);
        const m = byName((await getRows(ev)).rows);
        expect([m.y.rank, m.x.rank, m.z.rank]).toEqual([1, 2, null]);
        expect(m.y.record_value).toBe('7.20m'); expect(m.y.wind).toBeCloseTo(1.8, 5);
        expect(m.z.record_value).toBe('DQ');
    });
    it('10종경기: 세부 점수 합계로 순위', async () => {
        const ev = await mkEvent('10종경기', 'combined');
        const p = await mkEntry(ev, null, '십종1'), q = await mkEntry(ev, null, '십종2');
        for (const [ee, pts] of [[p, [900, 850]], [q, [880, 900]]]) for (let i = 0; i < pts.length; i++) await db.run("INSERT INTO combined_score (event_entry_id, sub_event_name, sub_event_order, raw_record, wa_points) VALUES (?,?,?,?,?)", ee, 's' + i, i + 1, 1, pts[i]);
        const m = byName((await getRows(ev)).rows);
        expect([m['십종2'].rank, m['십종1'].rank]).toEqual([1, 2]);
        expect(m['십종2'].record_value).toBe('1780점');
    });
});
