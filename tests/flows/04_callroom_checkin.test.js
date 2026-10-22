/**
 * [연동] 소집 출석 — 배번/바코드로 선수 찾기 (Phase 3-①)
 *   남·여가 같은 배번을 쓰는 대회에서, 예전엔 배번이 같은 '첫 선수'를 써서 다른 성별 선수가 다른 종목에 출석 처리됐다.
 *   다른 대회의 같은 배번 선수로 새는 것도 막는다.
 */
const request = require('supertest');
let app, db; const fx = {}; const OP = 'testopkey';

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    const mkComp = async n => (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", n + Date.now(), '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
    fx.comp = await mkComp('CHK_A_'); fx.other = await mkComp('CHK_B_');
    const mkEvent = async (comp, name, g) => { const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', ?, 'final', 'heats_generated')", comp, name, g)).lastInsertRowid; const h = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', ev)).lastInsertRowid; return { ev, h }; };
    const mkAth = async (comp, name, bib, g, ev) => { const a = (await db.run('INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?,?)', comp, name, bib, 'T', g)).lastInsertRowid; if (ev) { const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev.ev, a)).lastInsertRowid; await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', ev.h, ee); return { a, ee }; } return { a }; };
    fx.m100 = await mkEvent(fx.comp, '100m', 'M'); fx.f100 = await mkEvent(fx.comp, '100m', 'F');
    fx.man = await mkAth(fx.comp, '남자25', '25', 'M', fx.m100);     // 먼저 등록 → 예전 코드는 항상 이 선수를 잡았다
    fx.woman = await mkAth(fx.comp, '여자25', '25', 'F', fx.f100);
    fx.otherEv = await mkEvent(fx.other, '100m', 'F');
    fx.stranger = await mkAth(fx.other, '다른대회77', '77', 'F', fx.otherEv);
});
const status = async ee => (await db.get('SELECT status FROM event_entry WHERE id=?', ee)).status;
const checkin = (barcode, event_id) => request(app).post('/api/callroom/checkin').set('x-admin-key', OP).send({ barcode, event_id });

describe('소집 출석 — 배번 조회', () => {
    it('여자 100m 소집에서 "25" → 여자 25번이 출석, 남자 25번은 그대로', async () => {
        const r = await checkin('25', fx.f100.ev);
        expect(r.status).toBe(200);
        expect(r.body.athlete.name).toBe('여자25');
        expect(r.body.event_id).toBe(fx.f100.ev);
        expect(await status(fx.woman.ee)).toBe('checked_in');
        expect(await status(fx.man.ee)).toBe('registered');
    });
    it('남자 100m 소집에서 같은 "25" → 남자 25번', async () => {
        const r = await checkin('25', fx.m100.ev);
        expect(r.body.athlete.name).toBe('남자25');
        expect(await status(fx.man.ee)).toBe('checked_in');
    });
    it('이 대회에 없는 배번은 404 — 다른 대회 선수를 출석 처리하지 않는다', async () => {
        const r = await checkin('77', fx.f100.ev);
        expect(r.status).toBe(404);
        expect(await status(fx.stranger.ee)).toBe('registered');
    });
    it('바코드 표기 변형(PR-25, 025)과 W 접두(여자)도 같은 선수', async () => {
        await db.run("UPDATE event_entry SET status='registered' WHERE id=?", fx.woman.ee);
        expect((await checkin('W25', fx.f100.ev)).body.athlete.name).toBe('여자25');
        expect((await checkin('025', fx.f100.ev)).body.athlete.name).toBe('여자25');
        expect((await checkin('PR-25', fx.m100.ev)).body.athlete.name).toBe('남자25');
    });
});
