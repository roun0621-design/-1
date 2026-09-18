/**
 * 계측 결과 가져오기 안전성 (Phase 3-③) — .lif / .txt
 *   ① "DQ(TR16.8)" 같은 사유 붙은 상태가 16.8초 기록이 되지 않는다   ② 준결승 결과가 결승 조에 들어가지 않는다
 *   ③ .lif 재가져오기가 심판이 적은 비고를 지우지 않고, 시간 없는 행이 기록을 지우지 않는다   ④ 신기록 감지가 돈다
 *   ⑤ 성별·부를 못 가리면(후보 2개) 첫 후보에 넣지 않고 거부한다
 */
const request = require('supertest');
let app, db; const fx = {}; const OP = 'testopkey';
const lif = lines => Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf16le');

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?, '2026-01-01', '2099-12-31', 'x', 'active')", 'TIMING_' + Date.now())).lastInsertRowid;
    const mkEvent = async (name, g, div, round, key) => {
        const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?,?, 'track', ?, ?, ?, 'in_progress')", fx.comp, name, g, div, round)).lastInsertRowid;
        const heat = (await db.run('INSERT INTO heat (event_id, heat_number, scoreboard_key) VALUES (?, 1, ?)', ev, key)).lastInsertRowid;
        return { ev, heat };
    };
    const mkAth = async (e, name, bib, lane, g) => {
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?, 'T', ?)", fx.comp, name, bib, g || 'M')).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", e.ev, a)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', e.heat, ee, lane); return ee;
    };
    fx.semi = await mkEvent('200m', 'M', '일반', 'semifinal', '남자 일반부 200m 준결승');
    fx.fin = await mkEvent('200m', 'M', '일반', 'final', '남자 일반부 200m 결승');
    fx.s1 = await mkAth(fx.semi, '준결선수', '31', 3); fx.f1 = await mkAth(fx.fin, '결승선수', '32', 3);
    fx.m400 = await mkEvent('400m', 'M', '일반', 'final', '남자 일반부 400m 결승'); fx.m1 = await mkAth(fx.m400, '남사백', '41', 2);
    fx.f400 = await mkEvent('400m', 'F', '일반', 'final', '여자 일반부 400m 결승'); await mkAth(fx.f400, '여사백', '41', 2, 'F');
});
const result = async ee => db.get('SELECT * FROM result WHERE event_entry_id=? AND attempt_number IS NULL', ee);
const lifImport = (lines, name = 'a.lif') => request(app).post('/api/scoreboard/import').set('x-admin-key', OP).field('competition_id', String(fx.comp)).attach('files', lif(lines), name);
const T = (...cells) => cells.join('\t');   // 계측 .txt 는 탭 구분
const txtImport = (text, preview) => { let r = request(app).post('/api/timing-txt/import').set('x-admin-key', OP).field('competition_id', String(fx.comp)); if (preview) r = r.field('preview', 'true'); return r.attach('files', Buffer.from(text, 'utf8'), 't.txt'); };

describe('.lif', () => {
    it('② 준결승 라벨(키 불일치 → 구조 매칭)은 준결승 조로 간다 — 결승이 아니다', async () => {
        const r = await lifImport(['1,1,3,남자 실업부 200 준결승,+0.5,m/s,,,,,,2026-09-14 10:00:00', '1,31,3,,준결선수,T,21.50,,21.50']);
        expect(r.status).toBe(200);
        expect((await result(fx.s1)).time_seconds).toBe(21.5);
        expect(await result(fx.f1)).toBeUndefined();
    });
    it('① 순위 칸의 "DQ(TR16.8)" 은 실격 — 시간이 아니다', async () => {
        const r = await lifImport(['1,1,3,남자 일반부 200m 결승,+0.5,m/s,,,,,,2026-09-14 10:00:00', 'DQ(TR16.8),32,3,,결승선수,T,,,']);
        expect(r.status).toBe(200);
        const row = await result(fx.f1);
        expect(row.status_code).toBe('DQ'); expect(row.time_seconds).toBeNull();
    });
    it('③ 심판이 적은 비고는 재가져오기에도 남고, 시간 없는 결과 행은 기존 기록을 지우지 않는다', async () => {
        await db.run("UPDATE result SET remark='TR16.8 레인 침범', status_code='', time_seconds=22.10 WHERE event_entry_id=?", fx.f1);
        const r = await lifImport(['1,1,3,남자 일반부 200m 결승,+0.5,m/s,,,,,,2026-09-14 10:00:00', '1,32,3,,결승선수,T,21.98,,21.98']);
        expect(r.body.results[0].overwritten.length).toBe(1);        // 22.10 → 21.98 덮어씀을 알린다
        let row = await result(fx.f1); expect(row.time_seconds).toBe(21.98); expect(row.remark).toBe('TR16.8 레인 침범');
        const r2 = await lifImport(['1,1,3,남자 일반부 200m 결승,+0.5,m/s,,,,,,2026-09-14 10:00:00', '1,32,3,,결승선수,T,,,']);
        expect(r2.body.results[0].skipped).toBe(1);
        row = await result(fx.f1); expect(row.time_seconds).toBe(21.98);
    });
});

describe('.txt', () => {
    it('⑤ 성별 없는 라벨 "400m 결승" 은 남·여 후보 2개 → 거부 (첫 후보에 넣지 않는다)', async () => {
        const r = await txtImport([T('400m 결승'), T('순위','배번','성명','소속','기록'), T('1','41','남사백','T','48.20')].join('\n') + '\n');
        expect(r.status).toBe(200);
        expect(r.body.results[0].error).toContain('둘 이상');
        expect(await result(fx.m1)).toBeUndefined();
    });
    it('①④ "DQ(TR17.3)" 은 실격, 정상 기록은 저장되고 신기록 감지가 돈다 (기록표에 없어 로그는 남지 않아도 오류 없이)', async () => {
        const r = await txtImport([T('남자 일반부 400m 결승'), T('순위','배번','성명','소속','기록'), T('1','41','남사백','T','DQ(TR17.3)')].join('\n') + '\n');
        expect(r.status).toBe(200); expect(r.body.results[0].imported).toBe(1);
        expect((await result(fx.m1)).status_code).toBe('DQ');
        const r2 = await txtImport([T('남자 일반부 400m 결승'), T('순위','배번','성명','소속','기록'), T('1','41','남사백','T','1:02:15.3')].join('\n') + '\n');
        expect(r2.status).toBe(200);
        expect((await result(fx.m1)).time_seconds).toBeCloseTo(3735.3, 5);
    });
});
