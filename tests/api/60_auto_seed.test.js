/**
 * 1라운드 자동 조편성 (C2, 2026-10-09) — SB/PB 순위 → 지그재그 조 분배 → 같은 소속 분리 → WA 레인
 */
const request = require('supertest');
let app, db; const OP = 'testopkey', ADMIN = 'testadmin1234';
const { serpentine } = require('../../lib/routes/auto_seed')._internal;

describe('자동 조편성', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '시드 대회', start_date: '2026-11-01', end_date: '2026-11-02' })).body.id;
        fx.ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '100m', 'track', 'M', 'preliminary', 'created')", fx.comp)).lastInsertRowid;
        await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.ev);   // 기존 단일 조 (지워져야 함)
        const teams = ['A', 'A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'E', 'E', 'F', 'G', 'H'];
        fx.ids = [];
        for (let i = 0; i < 14; i++) {
            const sb = i < 12 ? (10.40 + i * 0.05).toFixed(2) : '';   // 12명 기록, 2명 없음
            const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender, season_best) VALUES (?,?,?,?, 'M', ?)", fx.comp, `선수${i + 1}`, String(100 + i), teams[i], sb)).lastInsertRowid;
            fx.ids.push((await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.ev, a)).lastInsertRowid);
        }
    });

    it('지그재그 분배: 1위 1조, 2위 2조, 3위 2조, 4위 1조 …', () => {
        const ranked = Array.from({ length: 6 }, (_, i) => ({ seed: i + 1, team: '' }));
        const g = serpentine(ranked, 2, false);
        expect(g[0].map(x => x.seed)).toEqual([1, 4, 5]); expect(g[1].map(x => x.seed)).toEqual([2, 3, 6]);
    });

    it('미리보기(dry_run): DB 는 그대로, 14명 → 2조, 기록 있는 선수가 앞 시드, 같은 소속 분리 경고 없음', async () => {
        const r = await request(app).post(`/api/events/${fx.ev}/auto-seed`).send({ admin_key: OP, dry_run: '1' });
        expect(r.status).toBe(200); expect(r.body.applied).toBe(false);
        expect(r.body.heat_size).toBe(8); expect(r.body.heats.length).toBe(2);
        const all = r.body.heats.flatMap(h => h.entries);
        expect(all.length).toBe(14); expect(r.body.unseeded).toBe(2);
        const top = all.find(e => e.seed === 1); expect(top.perf_text).toBe('10.40'); expect(top.name).toBe('선수1');
        expect(all.filter(e => e.seed > 12).every(e => !e.perf_text)).toBe(true);     // 기록 없는 둘이 13·14번 시드
        for (const h of r.body.heats) { const lanes = h.entries.map(e => e.lane); expect(new Set(lanes).size).toBe(lanes.length); expect(Math.max(...lanes)).toBeLessThanOrEqual(8); }
        expect((await db.get('SELECT COUNT(*) c FROM heat WHERE event_id=?', fx.ev)).c).toBe(1);   // 아직 안 바뀜
        const dupWarn = r.body.warnings.filter(w => w.includes('같은 소속')).join(' ');   // A 3명은 2조로 나누면 한 조에 2명이 불가피 — 경고는 A 만, B~E 는 분리돼야 함
        expect(dupWarn).toContain('A×2'); expect(dupWarn).not.toMatch(/[B-E]×/);
    });

    it('적용: 조·레인·전광판 키 생성, 종목 상태 heats_generated, 기록 있으면 force 필요', async () => {
        const r = await request(app).post(`/api/events/${fx.ev}/auto-seed`).send({ admin_key: OP, heat_size: 7 });
        expect(r.status).toBe(200); expect(r.body.applied).toBe(true); expect(r.body.heats.length).toBe(2);
        const heats = await db.all('SELECT * FROM heat WHERE event_id=? ORDER BY heat_number', fx.ev);
        expect(heats.length).toBe(2); expect(heats[0].scoreboard_key).toContain('100m'); expect(heats[0].scoreboard_key).toContain('1조');
        expect((await db.get('SELECT COUNT(*) c FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=?', fx.ev)).c).toBe(14);
        expect((await db.get('SELECT round_status FROM event WHERE id=?', fx.ev)).round_status).toBe('heats_generated');
        // 기록을 넣은 뒤엔 force 없이 거부
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,10.55)', heats[0].id, fx.ids[0]);
        const blocked = await request(app).post(`/api/events/${fx.ev}/auto-seed`).send({ admin_key: OP });
        expect(blocked.status).toBe(409); expect(blocked.body.needs_force).toBe(true);
        const forced = await request(app).post(`/api/events/${fx.ev}/auto-seed`).send({ admin_key: OP, force: '1', basis: 'pb' });
        expect(forced.status).toBe(200); expect(forced.body.unseeded).toBe(14);   // PB 기준이면 아무도 기록 없음 → 전원 무작위
        expect((await db.get('SELECT COUNT(*) c FROM result r JOIN heat h ON h.id=r.heat_id WHERE h.event_id=?', fx.ev)).c).toBe(0);
    });

    it('혼성경기·출전 없음·권한 없음', async () => {
        expect((await request(app).post(`/api/events/${fx.ev}/auto-seed`).send({})).status).toBe(403);
        const dec = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '10종경기', 'combined', 'M', 'final', 'created')", fx.comp)).lastInsertRowid;
        expect((await request(app).post(`/api/events/${dec}/auto-seed`).send({ admin_key: OP })).status).toBe(400);
        const empty = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '200m', 'track', 'F', 'final', 'created')", fx.comp)).lastInsertRowid;
        expect((await request(app).post(`/api/events/${empty}/auto-seed`).send({ admin_key: OP })).status).toBe(400);
    });
});
