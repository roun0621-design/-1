/**
 * WaveLight 프로그램 범위 맞추기 + 에이전트 (2026-11-21) — lib/pacingExport.js fitForProgram · /api/pacing/wavelight.json · scripts/wavelight-agent
 *   실제 장비('Wavelight event tool' 5.0)의 화면 코드로 확인한 규칙:
 *     · Complex 창은 19.2초 미만 구간, (초 × 거리 × 2.5 > 16,777,000)인 구간을 거부한다 → 파일은 합치거나 나눠서 낸다
 *     · 컨트롤러에 올리는 명령(command06)은 구간 {NumberOfLamps, Duration(ms)} · 색 번호 · 출발선 조명 · 255(출발 신호 대기)
 *   컨트롤러는 가짜 HTTP 서버로 — 실제 장비에는 아무것도 보내지 않는다.
 */
const request = require('supertest');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../lib/pacingExport');
const A = require('../../scripts/wavelight-agent/agent');

let app, db; const ADMIN = 'testadmin1234';
const segs = list => list.map(([d, t], i) => ({ segment_order: i, distance_meters: d, lap_seconds: t }));
const one = (key, list, color = 'green') => P.buildFiles({ event_name: key, colors: [{ color_key: color, segments: segs(list) }] }).files[0];
const stepsOf = f => JSON.parse(f.content);
const sum = (a, k) => a.reduce((x, s) => x + Number(s[k]), 0);
// 프로그램 Complex 창의 검사(workoutPopup.js)를 그대로 옮긴 것
const popupAccepts = f => stepsOf(f).every(s => { const pace = s['step-pace'] * 2.5 / 60; return !(pace < 0.8) && !(parseInt(pace * 60 * s['step-distance']) > 16777000); });

// 실제 장비에서 받은 상태 응답(대기 중, 조명 전원 꺼짐, 한 바퀴 400개, 버전 5.00)
const STATUS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 53, 46, 48, 48, 1, 144, 0, 0, 4, 4, 100, 5, 0, 70, 100, 0, 0, 0, 0, 0, 48, 48, 48, 48, 78, 48, 48, 48, 48, 48, 69, 0, 35, 2, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 5, 37];
function fakeController() {
    const slots = new Array(10).fill(0); const posts = [];
    const status = () => { const a = STATUS.slice(); for (let i = 0; i < 10; i++) a[i] = slots[i]; let s = 0; for (let i = 0; i <= 57; i++) s += a[i]; a[58] = s >> 8; a[59] = s & 255; return a; };
    const srv = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/command09') return res.end(JSON.stringify(status()));
        if (req.method === 'GET' && req.url === '/loadSettingsFromAFile') return res.end('{"customStartingLineLampNumbers": ["351"]}');
        let b = ''; req.on('data', d => b += d); req.on('end', () => {
            const body = b ? JSON.parse(b) : {}; posts.push({ url: req.url, body, type: req.headers['content-type'] });
            if (req.url === '/command06') slots[body.runnerArrayNumber - 1] = body.startingDelayInSeconds === 255 ? 2 : 1;
            if (req.url === '/command08') slots[body.runnerArrayNumber - 1] = 0;
            res.end('[]');
        });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, slots, posts, url: 'http://127.0.0.1:' + srv.address().port })));
}

describe('WaveLight 프로그램 범위 · 에이전트', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'WaveLight 에이전트 대회', start_date: '2026-11-25', end_date: '2026-11-26', venue: '예천' })).body.id;
        const save = async (event_name, colors) => (await request(app).post('/api/pacing').send({ admin_key: ADMIN, competition_id: fx.comp, event_name, notice: '', colors })).body.id;
        fx.cSC = await save('3000mSC (남)', [{ color_key: 'green', segments: segs([[3000, 510]]) }, { color_key: 'red', segments: segs([[3000, 525]]) }]);
        fx.c10k = await save('10,000m (남) [대학부]', [{ color_key: 'blue', segments: segs([[10000, 1850]]) }, { color_key: 'white', segments: segs([[10000, 0]]) }]);
        fx.ctl = await fakeController();
        fx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-agent-'));
        fx.web = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        fx.cfg = { server: 'http://127.0.0.1:' + fx.web.address().port, comp: fx.comp, controller: fx.ctl.url, dir: fx.dir, port: 0, host: '' };
    });
    afterAll(async () => { fx.ctl.srv.close(); fx.web.close(); if (fx.page) fx.page.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });

    it('긴 구간은 나눈다: 10,000m 한 구간은 프로그램이 거부 → 5000m 둘, 합은 그대로', () => {
        const f = one('10,000m (남)', [[10000, 1850]]);
        expect(f.content).toBe('[{"step-distance": "5000", "step-pace": 925.0}, {"step-distance": "5000", "step-pace": 925.0}]');
        expect(f.notes).toEqual(['split']); expect(popupAccepts(f)).toBe(true);
        expect(f.controller.steps).toEqual([{ NumberOfLamps: 10000, Duration: 1850000 }]);      // 컨트롤러에는 원래 구간 그대로
        expect(one('5000m (여)', [[5000, 900]]).notes).toEqual([]);                              // 5000m 한 구간은 그대로 통과
    });

    it('19.2초 미만 구간은 이웃과 합친다: 남자 3000m 장애물 8:30 의 마지막 100m(17초), 1500m 의 첫 100m', () => {
        const sc = one('3000mSC (남)', [[3000, 510]]);
        const st = stepsOf(sc);
        expect(st).toHaveLength(14); expect(sc.notes).toEqual(['merged']); expect(popupAccepts(sc)).toBe(true);
        expect(st[13]).toEqual({ 'step-distance': '200', 'step-pace': 37.64 });
        expect(sum(st, 'step-distance')).toBe(2850);
        expect(sc.controller.steps).toHaveLength(15);                                           // 직접 올릴 때는 15구간 그대로
        expect(sc.controller.steps[14]).toEqual({ NumberOfLamps: 100, Duration: 17000 });
        const m = one('1500m (남)', [[100, 14.5], [400, 58], [400, 59], [400, 59], [200, 28]]);
        expect(stepsOf(m)[0]).toEqual({ 'step-distance': '500', 'step-pace': 72.5 });
        expect(sum(stepsOf(m), 'step-pace')).toBeCloseTo(218.5, 2); expect(popupAccepts(m)).toBe(true);
        expect(one('3000mSC (여)', [[3000, 690]]).notes).toEqual([]);                            // 예시 파일 빠르기는 손대지 않는다
        expect(P.fitForProgram([{ distance: 100, seconds: 12 }]).notes).toEqual(['too_short']);
    });

    it('출발선 조명·색 번호: 결승선에서 끝나게 — 800m 0 · 1500m 100 · 3000m 200 · 3000m 장애물 350', () => {
        expect(one('800m (남)', [[800, 110]]).controller.startLamp).toBe(0);
        expect(one('1500m (남)', [[1500, 225]]).controller.startLamp).toBe(100);
        expect(one('3000m (여)', [[3000, 540]]).controller.startLamp).toBe(200);
        expect(one('3000mSC (여)', [[3000, 690]]).controller.startLamp).toBe(350);
        expect(['green', 'blue', 'white', 'red'].map(c => one('800m (남)', [[800, 110]], c).controller.colourNumber)).toEqual([0, 1, 2, 3]);
    });

    it('GET /api/pacing/wavelight.json: 종목마다 파일 내용 + 컨트롤러 값, 목록에는 notes', async () => {
        const r = await request(app).get('/api/pacing/wavelight.json?competition_id=' + fx.comp);
        expect(r.status).toBe(200); expect(r.body.rev).toMatch(/^[0-9a-f]{12}$/); expect(r.body.events).toHaveLength(2);
        const sc = r.body.events.find(e => e.id === fx.cSC);
        expect(sc.label).toBe('3000mSC Men'); expect(sc.files.map(f => f.filename)).toEqual(['3000mSC_Men_8-30_Green.pc2', '3000mSC_Men_8-45_Red.pc2']);
        expect(sc.files[0].controller.steps).toHaveLength(15);
        const k = r.body.events.find(e => e.id === fx.c10k);
        expect(k.label).toBe('10000m Men Univ'); expect(k.files).toHaveLength(1); expect(k.skipped).toEqual([{ color_key: 'white', reason: 'empty_lap' }]);
        expect((await request(app).get('/api/pacing/wavelight.json')).status).toBe(400);
        const list = await request(app).get(`/api/pacing/${fx.cSC}/wavelight?list=1`);
        expect(list.body.files[0].notes).toEqual(['merged']); expect(list.body.files[0].steps).toBe(14);
    });

    it('에이전트 — 폴더 맞추기: 서버 내용대로 쓰고, 자기가 만든 파일만 지운다', async () => {
        fs.writeFileSync(path.join(fx.dir, 'my_own.pc2'), '[]');                                  // 운영자가 손으로 둔 파일
        const plan = await A.fetchPlan(fx.cfg);
        expect(A.syncFolder(fx.dir, plan)).toEqual({ written: 3, removed: 0, total: 3 });
        expect(fs.readFileSync(path.join(fx.dir, '10000m_Men_Univ_30-50_Blue.pc2'), 'utf8')).toBe('[{"step-distance": "5000", "step-pace": 925.0}, {"step-distance": "5000", "step-pace": 925.0}]');
        expect(A.syncFolder(fx.dir, plan)).toEqual({ written: 0, removed: 0, total: 3 });         // 같으면 다시 쓰지 않는다
        const less = { ...plan, events: plan.events.filter(e => e.id !== fx.c10k) };
        expect(A.syncFolder(fx.dir, less)).toEqual({ written: 0, removed: 1, total: 2 });
        expect(fs.readdirSync(fx.dir).filter(n => n.endsWith('.pc2')).sort()).toEqual(['3000mSC_Men_8-30_Green.pc2', '3000mSC_Men_8-45_Red.pc2', 'my_own.pc2']);
        const evil = { rev: 'x', events: [{ files: [{ filename: '../evil.pc2', content: 'x' }] }] };   // 폴더 밖으로 나가는 이름은 무시
        A.syncFolder(fx.dir, evil); expect(fs.existsSync(path.join(fx.dir, '..', 'evil.pc2'))).toBe(false);
    });

    it('에이전트 — 컨트롤러에 올리기: 색마다 빈 줄, 항상 출발 신호 대기(255), 현장 출발선(351) 사용', async () => {
        expect(A.parseStatus(STATUS)).toMatchObject({ lampsOn: false, version: '5.00', lampsInRound: 400, lampPower: 100 });
        expect(A.parseStatus(STATUS.map((v, i) => (i === 59 ? v + 1 : v)))).toBeNull();           // 합이 안 맞는 응답은 버린다
        const plan = await A.fetchPlan(fx.cfg);
        const sc = plan.events.find(e => e.id === fx.cSC);
        fx.ctl.slots[0] = 1;                                                                    // 줄 1 은 누가 쓰는 중 → 줄 2·3 에 들어간다
        const r = await A.sendEvent(fx.cfg, sc, { settleMs: 0 });
        expect(r.ok).toBe(true); expect(r.startLamp).toBe(351); expect(r.lines.map(l => [l.slot, l.color_key, l.state])).toEqual([[2, 'green', 2], [3, 'red', 2]]);
        const p = fx.ctl.posts.filter(x => x.url === '/command06');
        expect(p).toHaveLength(2); expect(p[0].type).toBe('application/json;charset=UTF-8');
        expect(p[0].body).toMatchObject({ runnerArrayNumber: 2, colourNumber: 0, startingDelay: 351, startingDelayInSeconds: 255, isHideEnabled: 0, isPilotEnabled: 0 });
        expect(p[0].body.Steps).toHaveLength(15); expect(p[0].body.Steps[0]).toEqual({ NumberOfLamps: 250, Duration: 42500 });
        expect(p[1].body).toMatchObject({ runnerArrayNumber: 3, colourNumber: 3 });
        expect(fx.ctl.posts.some(x => /command1[02]/.test(x.url))).toBe(false);                    // 전원(10)·Fire(12)는 보내지 않는다
        // 평지 종목은 계산한 출발선 그대로, 운영자가 고친 값이 있으면 그 값
        const k = plan.events.find(e => e.id === fx.c10k);
        expect(A.defaultStartLamp(k, [351])).toBe(0);
        expect((await A.sendEvent(fx.cfg, k, { settleMs: 0, startLamp: 12 })).startLamp).toBe(12);
        // 빈 줄이 모자라면 아무것도 보내지 않는다
        for (let i = 0; i < 10; i++) if (fx.ctl.slots[i] === 0 && i < 9) fx.ctl.slots[i] = 1;
        const before = fx.ctl.posts.length;
        const full = await A.sendEvent(fx.cfg, sc, { settleMs: 0 });
        expect(full.ok).toBe(false); expect(full.error).toContain('빈 줄'); expect(fx.ctl.posts.length).toBe(before);
    });

    it('에이전트 — 취소는 자기가 올린 줄만, 보내기 화면은 이 화면에서 온 요청만 받는다', async () => {
        const r = await A.cancelSent(fx.cfg);
        expect(r.cancelled).toEqual([2, 3, 4]);                                                  // 줄 1 과 시험에서 채운 줄은 그대로
        expect(fx.ctl.slots[0]).toBe(1); expect(fx.ctl.slots[1]).toBe(0);
        await A.syncOnce(fx.cfg);
        fx.page = await A.startPage(fx.cfg);
        const base = 'http://127.0.0.1:' + fx.page.address().port;
        expect(await (await fetch(base + '/')).text()).toContain('WaveLight 보내기');
        const st = await (await fetch(base + '/api/state')).json();
        expect(st.controller.lampsInRound).toBe(400); expect(st.events.find(e => e.id === fx.cSC).start_lamp).toBe(351);
        const n = fx.ctl.posts.length;
        const no = await fetch(base + '/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: fx.cSC }) });
        expect(no.status).toBe(403);
        const cross = await fetch(base + '/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PaceRise-Agent': '1', Origin: 'https://example.com' }, body: JSON.stringify({ event_id: fx.cSC }) });
        expect(cross.status).toBe(403); expect(fx.ctl.posts.length).toBe(n);
    });
});
