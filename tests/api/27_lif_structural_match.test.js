/**
 * .lif(전광판) 가져오기 — 스코어보드 키 불일치 시 구조 매칭 폴백
 *
 * 현장 사례(2026-09 예천): 전광판 .lif 헤더는 "남자 실업부 100 결승" 인데
 * 우리 조의 scoreboard_key 는 "남자 일반부 100m 결승" → 문자열 정확일치 실패로 업로드 불가.
 * 이제 .txt/.xlsx 가져오기와 같은 알고리즘(성별·부·종목·라운드·조 분해)으로 폴백한다.
 *   - 실업↔일반 부 명칭, 띄어쓰기, 단위 m 누락 흡수
 *   - 100m 이 100mH 로 새지 않음 (정확 이름 우선)
 *   - 배번 앞자리 0 무시
 *
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
// (2026-09) 쓰기 가드: 모든 변경 요청은 운영키가 필요 → 테스트도 심판 세션처럼 x-admin-key 를 보낸다

let app, db;
const fx = {};

function lifBuffer(lines) {
    const text = '﻿' + lines.join('\r\n') + '\r\n';
    return Buffer.from(text, 'utf16le');
}

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'LIF_STRUCT_' + Date.now(), '2026-01-01', '2099-12-31', '예천');
    fx.compId = r.lastInsertRowid;

    // 100m 남 일반부 결승 (키: "남자 일반부 100m 결승") + 방해용 100mH 남 일반부 결승
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?,?, 'track', 'M', '일반', 'final', 'in_progress')", fx.compId, '100m');
    fx.ev100 = r.lastInsertRowid;
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?,?, 'track', 'M', '일반', 'final', 'in_progress')", fx.compId, '100mH');
    fx.evH = r.lastInsertRowid;

    r = await db.run('INSERT INTO heat (event_id, heat_number, scoreboard_key) VALUES (?, 1, ?)', fx.ev100, '남자 일반부 100m 결승');
    fx.heat100 = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number, scoreboard_key) VALUES (?, 1, ?)', fx.evH, '남자 일반부 100mH 결승');
    fx.heatH = r.lastInsertRowid;

    const mk = async (evId, heatId, name, bib, lane) => {
        const a = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.compId, name, bib, '테스트팀');
        const ee = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", evId, a.lastInsertRowid);
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', heatId, ee.lastInsertRowid, lane);
        return ee.lastInsertRowid;
    };
    fx.e1 = await mk(fx.ev100, fx.heat100, '김철수', '7', 3);
    fx.e2 = await mk(fx.ev100, fx.heat100, '이영희', '12', 4);
    fx.eH = await mk(fx.evH, fx.heatH, '허들러', '7', 3);
});

const LIF_HDR = '1,1,3,남자 실업부 100 결승,+0.8,m/s,,,,,,2026-09-14 10:00:00';

describe('.lif 구조 매칭 폴백', () => {
    it('preview: 키 불일치("남자 실업부 100 결승") → 100m 결승 조로 구조 매칭 (100mH 아님)', async () => {
        const res = await request(app).post('/api/scoreboard/preview').set('x-admin-key', 'testopkey')
            .field('competition_id', String(fx.compId))
            .attach('files', lifBuffer([LIF_HDR, '1,007,3,,김철수,테스트팀,10.52,,10.52', '2,12,4,,이영희,테스트팀,10.80,,0.28']), 'r.lif');
        expect(res.status).toBe(200);
        const r = res.body.results[0];
        expect(r.matchStatus).toBe('matched');
        expect(r.heatInfo.heat_id).toBe(fx.heat100);
        expect(r.heatInfo.match_via).toBe('structural');
        // 배번 "007" ↔ "7" 매칭
        expect(r.athleteMatches[0].event_entry_id).toBe(fx.e1);
        expect(r.athleteMatches[0].match_method).toBe('bib');
        expect(r.athleteMatches[1].event_entry_id).toBe(fx.e2);
    });

    it('import: 기록이 100m 조에 저장되고 허들 조는 건드리지 않는다', async () => {
        const res = await request(app).post('/api/scoreboard/import').set('x-admin-key', 'testopkey')
            .field('competition_id', String(fx.compId))
            .attach('files', lifBuffer([LIF_HDR, '1,007,3,,김철수,테스트팀,10.52,,10.52', '2,12,4,,이영희,테스트팀,10.80,,0.28']), 'r.lif');
        expect(res.status).toBe(200);
        const r1 = await db.get('SELECT * FROM result WHERE heat_id=? AND event_entry_id=?', fx.heat100, fx.e1);
        expect(r1).toBeTruthy();
        expect(r1.time_seconds).toBeCloseTo(10.52, 5);
        const rH = await db.get('SELECT * FROM result WHERE heat_id=?', fx.heatH);
        expect(rH).toBeFalsy();
    });

    it('정확한 키는 여전히 키 매칭(via=key)', async () => {
        const res = await request(app).post('/api/scoreboard/preview').set('x-admin-key', 'testopkey')
            .field('competition_id', String(fx.compId))
            .attach('files', lifBuffer(['1,1,4,남자 일반부 100mH 결승,,,,,,,,2026-09-14 10:00:00', '1,7,3,,허들러,테스트팀,13.90,,13.90']), 'h.lif');
        expect(res.status).toBe(200);
        expect(res.body.results[0].heatInfo.heat_id).toBe(fx.heatH);
        expect(res.body.results[0].heatInfo.match_via).toBe('key');
    });

    it('종목 자체가 없으면 여전히 not_found', async () => {
        const res = await request(app).post('/api/scoreboard/preview').set('x-admin-key', 'testopkey')
            .field('competition_id', String(fx.compId))
            .attach('files', lifBuffer(['1,1,5,남자 실업부 400 결승,,,,,,,,2026-09-14 10:00:00', '1,7,3,,김철수,테스트팀,48.00,,48.00']), 'x.lif');
        expect(res.status).toBe(200);
        expect(res.body.results[0].matchStatus).toBe('not_found');
    });
});
