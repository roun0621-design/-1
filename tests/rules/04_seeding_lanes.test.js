/**
 * [WA 규정] 다음 라운드 시드·레인 배정 — TR 20.3.2 / TR 20.4
 *   시드 순서: 조 1위들(기록순) → 조 2위들(기록순) → … → 기록 진출 q(기록순)
 *   레인 추첨 그룹(8레인):
 *     직선(100m·100mH·110mH)     상위 4 → 3·4·5·6 / 5~6위 → 2·7 / 7~8위 → 1·8
 *     200m                        상위 3 → 5·6·7  / 4~6위 → 3·4·8 / 7~8위 → 1·2
 *     400m·800m·400mH·릴레이      상위 4 → 4·5·6·7 / 5~6위 → 3·8 / 7~8위 → 1·2
 */
const request = require('supertest');
const { seedOrder } = require('../../lib/seeding');
let app, db, compId;
const ADMIN_KEY = 'testadmin1234';

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'SEED_' + Date.now(), '2026-01-01', '2099-12-31', 'x');
    compId = r.lastInsertRowid;
});

// heats: [[ [name, time], ... ], ...]  qual: {name: 'Q'|'q'}
async function buildPrelim(evName, heats, qual) {
    let r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'preliminary', 'completed')", compId, evName);
    const evId = r.lastInsertRowid; const entryOf = {};
    for (let hi = 0; hi < heats.length; hi++) {
        r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,?)', evId, hi + 1); const heatId = r.lastInsertRowid;
        for (let li = 0; li < heats[hi].length; li++) {
            const [name, t] = heats[hi][li];
            r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", compId, `${evName}_${name}`, `${evId}${hi}${li}`, `팀${name}`);
            r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", evId, r.lastInsertRowid); const ee = r.lastInsertRowid;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heatId, ee, li + 1);
            await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', heatId, ee, t);
            entryOf[name] = ee;
        }
    }
    for (const [name, qt] of Object.entries(qual)) await db.run("INSERT INTO qualification_selection (event_id, event_entry_id, selected, approved, approved_by, qualification_type) VALUES (?,?,1,1,'admin',?)", evId, entryOf[name], qt);
    return evId;
}
async function finalLanes(prelimId, evName) {
    const res = await request(app).post(`/api/events/${prelimId}/create-final`).send({ admin_key: ADMIN_KEY });
    expect(res.status).toBe(200);
    const rows = await db.all(`SELECT a.name, he.lane_number lane FROM heat_entry he JOIN heat h ON h.id=he.heat_id JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE h.event_id=?`, res.body.final_event_id);
    return Object.fromEntries(rows.map(x => [x.name.replace(evName + '_', ''), x.lane]));
}

describe('시드 순서 (TR 20.3.2)', () => {
    it('조 1위들 → 조 2위들 → … → q, 각 묶음 안에서는 기록순', () => {
        const s = seedOrder([
            { id: 'B', qualification_type: 'Q', place: 2, perf: 10.60 }, { id: 'E', qualification_type: 'Q', place: 1, perf: 10.90 },
            { id: 'D', qualification_type: 'q', place: 4, perf: 10.75 }, { id: 'A', qualification_type: 'Q', place: 1, perf: 10.50 },
            { id: 'F', qualification_type: 'Q', place: 2, perf: 10.95 }, { id: 'H', qualification_type: 'q', place: 4, perf: 11.10 },
        ]);
        expect(s.map(x => x.id)).toEqual(['A', 'E', 'B', 'F', 'D', 'H']);
        expect(s.map(x => x.seedRank)).toEqual([1, 2, 3, 4, 5, 6]);
    });
    it('조 순위를 모르면(필드 등) 기록순으로, q 는 아무리 빨라도 Q 뒤', () => {
        const s = seedOrder([{ id: 'x', qualification_type: 'q', perf: 9.9 }, { id: 'y', qualification_type: 'Q', perf: 10.5 }, { id: 'z', qualification_type: 'Q', perf: 10.2 }]);
        expect(s.map(x => x.id)).toEqual(['z', 'y', 'x']);
    });
});

describe('결승 레인 배정 (TR 20.4)', () => {
    it('100m: 빠른 조의 3위보다 느린 조의 1·2위가 앞 시드 — 중앙 레인(3~6)은 조 1·2위 네 명', async () => {
        const ev = await buildPrelim('100m', [[['A', 10.50], ['B', 10.60], ['C', 10.70], ['D', 10.75]], [['E', 10.90], ['F', 10.95], ['G', 11.00], ['H', 11.10]]],
            { A: 'Q', B: 'Q', C: 'Q', E: 'Q', F: 'Q', G: 'Q', D: 'q', H: 'q' });
        const lane = await finalLanes(ev, '100m');
        for (const n of ['A', 'E', 'B', 'F']) expect([3, 4, 5, 6], n).toContain(lane[n]);
        for (const n of ['C', 'G']) expect([2, 7], n).toContain(lane[n]);
        for (const n of ['D', 'H']) expect([1, 8], n).toContain(lane[n]);
        expect(new Set(Object.values(lane)).size).toBe(8);   // 레인 중복 없음
    });
    it('200m: 상위 3 → 5·6·7 / 4~6위 → 3·4·8 / 7~8위 → 1·2', async () => {
        const ev = await buildPrelim('200m', [[['a', 21.0], ['b', 21.1], ['c', 21.2], ['d', 21.3], ['e', 21.4], ['f', 21.5], ['g', 21.6], ['h', 21.7]]],
            { a: 'Q', b: 'Q', c: 'Q', d: 'Q', e: 'Q', f: 'Q', g: 'Q', h: 'Q' });
        const lane = await finalLanes(ev, '200m');
        for (const n of ['a', 'b', 'c']) expect([5, 6, 7], n).toContain(lane[n]);
        for (const n of ['d', 'e', 'f']) expect([3, 4, 8], n).toContain(lane[n]);
        for (const n of ['g', 'h']) expect([1, 2], n).toContain(lane[n]);
    });
    it('400mH: 상위 4 → 4·5·6·7 / 5~6위 → 3·8 / 7~8위 → 1·2', async () => {
        const ev = await buildPrelim('400mH', [[['a', 51.0], ['b', 51.1], ['c', 51.2], ['d', 51.3], ['e', 51.4], ['f', 51.5], ['g', 51.6], ['h', 51.7]]],
            { a: 'Q', b: 'Q', c: 'Q', d: 'Q', e: 'Q', f: 'Q', g: 'Q', h: 'Q' });
        const lane = await finalLanes(ev, '400mH');
        for (const n of ['a', 'b', 'c', 'd']) expect([4, 5, 6, 7], n).toContain(lane[n]);
        for (const n of ['e', 'f']) expect([3, 8], n).toContain(lane[n]);
        for (const n of ['g', 'h']) expect([1, 2], n).toContain(lane[n]);
    });
    it('1500m(레인 없는 종목)은 시드 순서대로 1번부터', async () => {
        const ev = await buildPrelim('1500m', [[['a', 230], ['b', 231], ['c', 232]]], { a: 'Q', b: 'Q', c: 'Q' });
        const lane = await finalLanes(ev, '1500m');
        expect([lane.a, lane.b, lane.c]).toEqual([1, 2, 3]);
    });
});
