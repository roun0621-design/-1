/**
 * 전광판·방송 오버레이 WebSocket (/ws/scoreboard) — Phase 3-⑤
 *   ① 현재 조 = 기록이 가장 최근에 들어온 조 (예전엔 마지막 조)   ② 거리 종목은 최고 기록·높이 종목은 height_attempt 로 순위
 *   ③ 실격은 순위 없음, 동률은 같은 순위   ④ 다른 대회의 변경은 구독한 오버레이에 오지 않는다
 */
const WebSocket = require('ws');
let mod, db; const fx = {};
// 메시지는 큐에 쌓아 두고 꺼내 본다 (open 직후 오는 'connected' 를 놓치지 않게)
const open = () => new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${fx.port}/ws/scoreboard`); ws._q = []; ws.on('message', m => ws._q.push(JSON.parse(m))); ws.on('open', () => resolve(ws)); ws.on('error', reject); });
const next = (ws, type, ms = 2000) => new Promise((resolve, reject) => { const t0 = Date.now(); (function poll() { const i = ws._q.findIndex(j => j.type === type); if (i >= 0) return resolve(ws._q.splice(i, 1)[0]); if (Date.now() - t0 > ms) return reject(new Error('timeout ' + type)); setTimeout(poll, 20); })(); });
const state = async (ws, comp) => { ws.send(JSON.stringify({ type: 'request_current', competition_id: comp })); return (await next(ws, 'scoreboard_state')).data; };

beforeAll(async () => {
    mod = require('../../server.js'); db = mod.db;
    await new Promise(r => mod.server.listen(0, '127.0.0.1', r)); fx.port = mod.server.address().port;
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, '2026-01-01', '2099-12-31', 'x', 'active')", 'WS_A_' + Date.now())).lastInsertRowid;
    fx.other = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, '2026-01-01', '2099-12-31', 'x', 'active')", 'WS_B_' + Date.now())).lastInsertRowid;
    const mkEv = async (comp, name, cat, status, sort) => (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, sort_order) VALUES (?,?,?, 'M', 'final', ?, ?)", comp, name, cat, status, sort)).lastInsertRowid;
    const mkHeat = async (ev, n) => (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,?)', ev, n)).lastInsertRowid;
    const mkEntry = async (comp, ev, heat, name, bib, lane) => { const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?, 'T', 'M')", comp, name, bib)).lastInsertRowid; const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", ev, a)).lastInsertRowid; await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heat, ee, lane); return ee; };
    // 100m 예선 3개 조 — 1조에만 기록
    fx.ev = await mkEv(fx.comp, '100m', 'track', 'in_progress', 1);
    fx.h1 = await mkHeat(fx.ev, 1); fx.h2 = await mkHeat(fx.ev, 2); fx.h3 = await mkHeat(fx.ev, 3);
    fx.a = await mkEntry(fx.comp, fx.ev, fx.h1, '동률갑', '1', 1); fx.b = await mkEntry(fx.comp, fx.ev, fx.h1, '동률을', '2', 2); fx.c = await mkEntry(fx.comp, fx.ev, fx.h1, '실격자', '3', 3); fx.d = await mkEntry(fx.comp, fx.ev, fx.h1, '삼등', '4', 4);
    await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.52)', fx.h1, fx.a);
    await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.52)', fx.h1, fx.b);
    await db.run("INSERT INTO result (heat_id, event_entry_id, time_seconds, status_code) VALUES (?,?,10.10,'DQ')", fx.h1, fx.c);
    await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.80)', fx.h1, fx.d);
    await mkEntry(fx.comp, fx.ev, fx.h3, '삼조선수', '9', 1);
    // 다른 대회의 진행 중 종목
    fx.oev = await mkEv(fx.other, '200m', 'track', 'in_progress', 1); fx.oh = await mkHeat(fx.oev, 1);
});
afterAll(async () => { try { mod.server.closeAllConnections && mod.server.closeAllConnections(); } catch (e) {} await new Promise(r => mod.server.close(r)); });

describe('현재 상태', () => {
    it('① 기록이 들어온 1조를 보여준다 (마지막 3조가 아니라) ③ 동률 같은 순위 · 실격 순위 없음 · 기록 표기', async () => {
        const ws = await open(); await next(ws, 'connected');
        const d = await state(ws, fx.comp);
        expect(d.event.id).toBe(fx.ev); expect(d.heat.id).toBe(fx.h1); expect(d.total_heats).toBe(3);
        const by = Object.fromEntries(d.entries.map(e => [e.name, e]));
        expect([by['동률갑'].rank, by['동률을'].rank, by['삼등'].rank, by['실격자'].rank]).toEqual([1, 1, 3, null]);
        expect(by['실격자'].status_code).toBe('DQ'); expect(by['동률갑'].record_text).toBe('10.52');
        ws.close();
    });
    it('② 거리 종목은 최고 기록으로, 높이 종목은 height_attempt 로 순위·기록이 나온다', async () => {
        await db.run("UPDATE event SET round_status='completed' WHERE id=?", fx.ev);
        const lj = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, sort_order) VALUES (?, '멀리뛰기', 'field_distance', 'M', 'final', 'in_progress', 2)", fx.comp)).lastInsertRowid;
        const lh = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', lj)).lastInsertRowid;
        const mk = async (name, bib) => { const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?, 'T', 'M')", fx.comp, name, bib)).lastInsertRowid; const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", lj, a)).lastInsertRowid; await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', lh, ee); return ee; };
        const p = await mk('일차약함', '21'), q = await mk('일차강함', '22');
        for (const [ee, att, v] of [[p, 1, 6.50], [p, 2, 7.30], [q, 1, 7.00], [q, 2, 6.90]]) await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, distance_meters) VALUES (?,?,?,?)', lh, ee, att, v);
        const ws = await open(); await next(ws, 'connected');
        const d = await state(ws, fx.comp);
        const by = Object.fromEntries(d.entries.map(e => [e.name, e]));
        expect(by['일차약함'].rank).toBe(1); expect(by['일차약함'].record_text).toBe('7.30m'); expect(by['일차강함'].rank).toBe(2);   // 예전엔 1차 시기(6.50 vs 7.00)로 매겨 반대였다
        await db.run("UPDATE event SET round_status='completed' WHERE id=?", lj);
        const hj = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status, sort_order) VALUES (?, '높이뛰기', 'field_height', 'M', 'final', 'in_progress', 3)", fx.comp)).lastInsertRowid;
        const hh = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', hj)).lastInsertRowid;
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, '높이선수', '31', 'T', 'M')", fx.comp)).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", hj, a)).lastInsertRowid; await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', hh, ee);
        for (const [h, n, m] of [[1.80, 1, 'O'], [1.85, 1, 'X'], [1.85, 2, 'O']]) await db.run('INSERT INTO height_attempt (heat_id, event_entry_id, bar_height, attempt_number, result_mark) VALUES (?,?,?,?,?)', hh, ee, h, n, m);
        const d2 = await state(ws, fx.comp);
        expect(d2.entries[0].record_text).toBe('1m85'); expect(d2.entries[0].rank).toBe(1);       // 예전엔 높이 종목 기록이 아예 안 나왔다
        ws.close();
    });
    it('④ 다른 대회의 결과 변경은 구독한 오버레이에 오지 않는다 (구독하지 않은 클라이언트에는 온다)', async () => {
        const mine = await open(); await next(mine, 'connected'); mine.send(JSON.stringify({ type: 'subscribe', competition_id: fx.comp })); await next(mine, 'subscribed');
        const any = await open(); await next(any, 'connected');
        const request = require('supertest');
        const got = () => mine._q.filter(j => j.type === 'scoreboard_result_update');
        const pAny = next(any, 'scoreboard_result_update');
        // 다른 대회 조의 풍속 → result 아님. 다른 대회 heat 로 result_update 를 흉내: 실제 API 로 결과 입력
        const oa = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, '남의대회', '7', 'T', 'M')", fx.other)).lastInsertRowid;
        const oee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.oev, oa)).lastInsertRowid; await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,1)', fx.oh, oee);
        const r = await request(mod.app).post('/api/results/upsert').set('x-admin-key', 'testopkey').send({ heat_id: fx.oh, event_entry_id: oee, time_seconds: 21.5 });
        expect(r.status).toBe(200);
        const anyMsg = await pAny; expect(anyMsg.data.competition_id).toBe(fx.other);
        await new Promise(r => setTimeout(r, 200));
        expect(got().length).toBe(0);
        mine.close(); any.close();
    });
});
