/**
 * 멀티테넌시 4단계 (2026-10-09): 전광판 WebSocket 도 호스트로 조직을 정한다 — 다른 조직 대회는 구독·조회 불가, 구독 안 한 소켓엔 대회 메시지가 가지 않는다.
 */
const request = require('supertest');
const WebSocket = require('ws');
let mod, app, db; const ADMIN = 'testadmin1234'; const fx = {};
const open = (host) => new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${fx.port}/ws/scoreboard`, { headers: host ? { Host: host } : {} }); ws._q = []; ws.on('message', m => ws._q.push(JSON.parse(m))); ws.on('open', () => resolve(ws)); ws.on('error', reject); });
const next = (ws, type, ms = 2000) => new Promise((resolve, reject) => { const t0 = Date.now(); (function poll() { const i = ws._q.findIndex(j => j.type === type); if (i >= 0) return resolve(ws._q.splice(i, 1)[0]); if (Date.now() - t0 > ms) return reject(new Error('timeout ' + type)); setTimeout(poll, 20); })(); });

beforeAll(async () => {
    mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
    await new Promise(r => mod.server.listen(0, '127.0.0.1', r)); fx.port = mod.server.address().port;
    await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'jp', name: 'JP', country: 'JP' });
    fx.kr = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'KR', start_date: '2026-11-01', end_date: '2026-11-02' })).body.id;
    fx.jp = (await request(app).post('/api/competitions').set('Host', 'jp.localhost').send({ admin_key: ADMIN, name: 'JP', start_date: '2026-11-01', end_date: '2026-11-02' })).body.id;
});
afterAll(async () => { try { mod.server.closeAllConnections && mod.server.closeAllConnections(); } catch (e) {} await new Promise(r => mod.server.close(r)); });

describe('전광판 소켓 조직 분리', () => {
    it('JP 호스트 소켓은 JP 대회만 구독할 수 있다', async () => {
        const ws = await open(`jp.localhost:${fx.port}`); await next(ws, 'connected');
        ws.send(JSON.stringify({ type: 'subscribe', competition_id: fx.kr }));
        const err = await next(ws, 'error'); expect(err.competition_id).toBe(fx.kr);
        ws.send(JSON.stringify({ type: 'subscribe', competition_id: fx.jp }));
        expect((await next(ws, 'subscribed')).competition_id).toBe(fx.jp);
        ws.send(JSON.stringify({ type: 'request_current', competition_id: fx.kr }));
        await next(ws, 'error');
        ws.close();
    });
    it('기본 호스트 소켓은 KR 대회만', async () => {
        const ws = await open(); await next(ws, 'connected');
        ws.send(JSON.stringify({ type: 'subscribe', competition_id: fx.jp }));
        await next(ws, 'error');
        ws.send(JSON.stringify({ type: 'subscribe', competition_id: fx.kr }));
        expect((await next(ws, 'subscribed')).competition_id).toBe(fx.kr);
        ws.close();
    });
});
