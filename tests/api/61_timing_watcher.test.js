/**
 * 계측 파일 워처 (C1, 2026-10-09) — 폴더의 .lif 를 미리보기 → 매칭되면 적용 → done/, 못 찾으면 review/
 *   서버를 실제 포트에 띄우고 워처의 processFile() 을 그 서버로 돌린다 (워처는 fetch 만 쓴다)
 */
const request = require('supertest');
const fs = require('fs'); const os = require('os'); const path = require('path');
let mod, app, db; const fx = {}; const OP = 'testopkey', ADMIN = 'testadmin1234';
const lif = lines => Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf16le');
const W = require('../../scripts/timing-watcher/watch.js');

beforeAll(async () => {
    mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
    await new Promise(r => mod.server.listen(0, '127.0.0.1', r)); fx.port = mod.server.address().port;
    fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '워처 대회', start_date: '2026-01-01', end_date: '2099-12-31' })).body.id;
    fx.ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?, '100m', 'track', 'M', '일반', 'final', 'in_progress')", fx.comp)).lastInsertRowid;
    fx.heat = (await db.run("INSERT INTO heat (event_id, heat_number, scoreboard_key) VALUES (?, 1, '남자 일반부 100m 결승')", fx.ev)).lastInsertRowid;
    const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, '워처선수', '77', 'T', 'M')", fx.comp)).lastInsertRowid;
    fx.ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.ev, a)).lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', fx.heat, fx.ee);
    fx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-'));
    fx.cfg = W.loadConfig(['--dir', fx.dir, '--server', `http://127.0.0.1:${fx.port}`, '--key', OP, '--comp', String(fx.comp), '--interval', '1']);
});
afterAll(async () => { try { mod.server.closeAllConnections && mod.server.closeAllConnections(); } catch (e) {} await new Promise(r => mod.server.close(r)); });

describe('워처', () => {
    it('설정 파싱', () => { expect(fx.cfg).toMatchObject({ mode: 'auto', comp: fx.comp, interval: 1 }); expect(W.kindOf('a.LIF')).toBe('lif'); expect(W.kindOf('a.csv')).toBeNull(); });

    it('매칭되는 .lif → 적용 → done/ + 기록 저장', async () => {
        const f = path.join(fx.dir, 'm100f.lif');
        fs.writeFileSync(f, lif(['1,1,1,남자 일반부 100m 결승,+0.8,m/s,,,,,,2026-10-09 10:00:00', '1,77,4,,워처선수,T,10.52,,10.52']));
        const r = await W.processFile(fx.cfg, f);
        expect(r).toBe('done');
        expect(fs.existsSync(f)).toBe(false); expect(fs.existsSync(path.join(fx.dir, 'done', 'm100f.lif'))).toBe(true);
        expect(fs.readFileSync(path.join(fx.dir, 'done', 'm100f.lif.log'), 'utf8')).toContain('1건 적용');
        expect((await db.get('SELECT time_seconds FROM result WHERE event_entry_id=?', fx.ee)).time_seconds).toBe(10.52);
    });

    it('조를 못 찾는 .lif → 적용 안 함 → review/ + 사유', async () => {
        const f = path.join(fx.dir, 'unknown.lif');
        fs.writeFileSync(f, lif(['1,1,2,여자 일반부 800m 결승,,,,,,,,2026-10-09 10:05:00', '1,99,1,,아무개,T,2:05.10,,2:05.10']));
        const r = await W.processFile(fx.cfg, f);
        expect(r).toBe('review');
        expect(fs.existsSync(path.join(fx.dir, 'review', 'unknown.lif'))).toBe(true);
        expect(fs.readFileSync(path.join(fx.dir, 'review', 'unknown.lif.log'), 'utf8')).toContain('조를 못 찾음');
    });

    it('confirm 모드는 매칭돼도 review/ 로', async () => {
        const f = path.join(fx.dir, 'again.lif');
        fs.writeFileSync(f, lif(['1,1,1,남자 일반부 100m 결승,,,,,,,,2026-10-09 10:10:00', '1,77,4,,워처선수,T,10.49,,10.49']));
        const r = await W.processFile({ ...fx.cfg, mode: 'confirm' }, f);
        expect(r).toBe('review');
        expect((await db.get('SELECT time_seconds FROM result WHERE event_entry_id=?', fx.ee)).time_seconds).toBe(10.52);   // 바뀌지 않음
    });

    it('잘못된 키 → failed/', async () => {
        const f = path.join(fx.dir, 'badkey.lif');
        fs.writeFileSync(f, lif(['1,1,1,남자 일반부 100m 결승,,,,,,,,2026-10-09 10:20:00', '1,77,4,,워처선수,T,10.60,,10.60']));
        expect(await W.processFile({ ...fx.cfg, key: 'wrong-key' }, f)).toBe('failed');
        expect(fs.existsSync(path.join(fx.dir, 'failed', 'badkey.lif'))).toBe(true);
    });

    it('에이전트(2026-10-10): config.json 병합 — 인자 > 환경변수 > 파일, 틀의 키 자리표시는 빈 키로', () => {
        const c = W.loadConfig(['--comp', '9'], { server: 'https://x.test/', key: 'filekey', competition_id: 3, mode: 'confirm', interval: 7, name: 'PC-1' });
        expect(c).toMatchObject({ server: 'https://x.test', key: 'filekey', comp: 9, mode: 'confirm', interval: 7, name: 'PC-1', pingInterval: 30 });
        expect(W.loadConfig([], W.CONFIG_TEMPLATE).key).toBe('');
    });

    it('에이전트 핑 → 관리자 상태 조회(대회별, 연결됨/처리 건수) · 키 없으면 403', async () => {
        W.stats.done = 2; W.stats.review = 1; W.stats.lastFile = 'm100f.lif';
        await W.ping({ ...fx.cfg, name: '계측PC-1' });
        const r = await request(app).get(`/api/timing-agent/status?competition_id=${fx.comp}`).set('x-admin-key', OP);
        expect(r.status).toBe(200); expect(r.body.agents).toHaveLength(1);
        expect(r.body.agents[0]).toMatchObject({ name: '계측PC-1', online: true, mode: 'auto', done: 2, review: 1, failed: 0, last_file: 'm100f.lif', version: W.AGENT_VERSION });
        expect(r.body.agents[0].seconds_ago).toBeLessThan(5);
        expect((await request(app).get(`/api/timing-agent/status?competition_id=${fx.comp + 1}`).set('x-admin-key', OP)).body.agents).toHaveLength(0);   // 다른 대회
        expect((await request(app).post('/api/timing-agent/ping').send({ competition_id: fx.comp, name: 'x' })).status).toBe(403);
        expect((await request(app).post('/api/timing-agent/ping').set('x-admin-key', OP).send({ name: 'x' })).status).toBe(400);
    });
});
