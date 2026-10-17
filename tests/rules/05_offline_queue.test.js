/**
 * [오프라인] 서비스워커 재전송 큐 (public/sw.js) — 브라우저 없이 핵심 판단만 검증한다.
 *   ① 큐에 넣는 요청은 '다시 보내도 안전한 심판 입력'뿐 (로그인·문자 발송·결승 생성은 실패를 그대로 알린다)
 *   ② 같은 칸을 고쳐 쓴 경우 마지막 값만 보낸다 ③ 저장해 둔 키를 함께 보낸다
 *   ④ 서버가 거부한 항목은 큐에서 빼고 목록으로 알린다 / 로그인 만료(403)·서버 오류는 남겨서 다시 시도
 *   ⑤ 동시에 두 번 돌지 않는다
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

function loadSW() {
    const posted = [];
    const ctx = {
        self: { addEventListener() {}, clients: { matchAll: async () => [{ postMessage: m => posted.push(m) }] }, location: { origin: 'https://x' }, skipWaiting() {} },
        caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], match: async () => null },
        indexedDB: {}, console, setTimeout, clearTimeout, AbortController, URL, Response: class {}, Promise, JSON, Date, Map, Object, String, Math, Array,
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8'), ctx);
    // IndexedDB 대신 메모리 큐
    const store = [];
    ctx.getQueuedRequests = async () => store.filter(r => !r.synced).map(r => ({ ...r }));
    ctx.updateQueued = async (id, patch) => { Object.assign(store.find(r => r.id === id), patch); };
    ctx.clearSyncedQueue = async () => {};
    const sent = [];
    ctx.__respond = () => ({ ok: true, status: 200 });
    ctx.fetch = async (url, opts) => { sent.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null }); const r = await ctx.__respond(url, opts); return { ...r, clone: () => ({ json: async () => r.json || {} }) }; };
    let id = 0;
    const push = (method, url, body, headers) => store.push({ id: ++id, method, url, body, headers: headers || {}, tries: 0, synced: false });
    return { ctx, store, sent, posted, push, sync: () => vm.runInContext('syncQueuedRequests()', ctx), q: (m, p) => vm.runInContext(`isQueueable(${JSON.stringify(m)}, ${JSON.stringify(p)})`, ctx) };
}

describe('① 큐에 넣는 요청', () => {
    const { q } = loadSW();
    it('심판 기록 입력 · 소집 출석은 큐에 넣는다', () => {
        expect(q('POST', '/api/results/upsert')).toBe(true);
        expect(q('POST', '/api/height-attempts/save')).toBe(true);
        expect(q('POST', '/api/heats/12/wind')).toBe(true);
        expect(q('PATCH', '/api/event-entries/7/status')).toBe(true);
        expect(q('POST', '/api/callroom/checkin')).toBe(true);
    });
    it('로그인 · 문자 발송 · 결승 생성 · 초기화 · 삭제는 넣지 않는다', () => {
        for (const [m, p] of [['POST', '/api/auth/login'], ['POST', '/api/event/abc/send-cert'], ['POST', '/api/admin/sms/send-batch'], ['POST', '/api/events/3/create-final'],
            ['POST', '/api/results/reset-sub-event'], ['DELETE', '/api/results'], ['POST', '/api/events/3/complete'], ['POST', '/api/admin/change-keys']]) expect([p, q(m, p)]).toEqual([p, false]);
    });
});

describe('재전송', () => {
    it('② 같은 칸을 고쳐 쓴 경우 마지막 값만, ③ 저장해 둔 키와 함께', async () => {
        const sw = loadSW();
        sw.push('POST', '/api/height-attempts/save', { heat_id: 1, event_entry_id: 5, bar_height: 1.8, attempt_number: 1, result_mark: 'X' }, { 'x-admin-key': 'OPKEY' });
        sw.push('POST', '/api/height-attempts/save', { heat_id: 1, event_entry_id: 5, bar_height: 1.8, attempt_number: 1, result_mark: 'O' }, { 'x-admin-key': 'OPKEY' });   // 심판이 고침
        sw.push('POST', '/api/height-attempts/save', { heat_id: 1, event_entry_id: 5, bar_height: 1.8, attempt_number: 2, result_mark: 'X' }, { 'x-admin-key': 'OPKEY' });   // 다른 칸
        sw.push('PATCH', '/api/event-entries/9/status', { status: 'checked_in' }, { 'x-admin-key': 'OPKEY' });
        const r = await sw.sync();
        expect(sw.sent.map(s => s.body.result_mark || s.body.status)).toEqual(['O', 'X', 'checked_in']);
        expect(sw.sent.every(s => s.opts.headers['x-admin-key'] === 'OPKEY')).toBe(true);
        expect(r.synced).toBe(3); expect(sw.store.every(i => i.synced)).toBe(true);
    });
    it('④ 서버가 거부한 항목(400)은 큐에서 빼고 목록으로 알린다 · 403/500 은 남겨서 다시 시도', async () => {
        const sw = loadSW();
        sw.push('POST', '/api/results/upsert', { heat_id: 1, event_entry_id: 1, time_seconds: 10.5 });
        sw.push('POST', '/api/results/upsert', { heat_id: 1, event_entry_id: 2, time_seconds: 10.6 });
        sw.push('POST', '/api/results/upsert', { heat_id: 1, event_entry_id: 3, time_seconds: 10.7 });
        sw.ctx.__respond = (url, opts) => { const id = JSON.parse(opts.body).event_entry_id; return id === 1 ? { ok: false, status: 400, json: { error: '소집이 완료되지 않았습니다' } } : id === 2 ? { ok: false, status: 403, json: { error: '인증 키가 필요합니다.' } } : { ok: false, status: 502, json: {} }; };
        await sw.sync();
        const msg = sw.posted.find(m => m.type === 'SYNC_COMPLETE');
        expect(msg.dropped.map(d => [d.body.event_entry_id, d.status, d.error])).toEqual([[1, 400, '소집이 완료되지 않았습니다']]);
        expect(sw.store.map(i => [i.body.event_entry_id, i.synced, i.tries])).toEqual([[1, true, 0], [2, false, 1], [3, false, 1]]);
        expect(msg.remaining).toBe(2);
    });
    it('④-2 서버가 더 최신이라 거부(409)한 항목은 충돌 목록으로', async () => {
        const sw = loadSW();
        sw.push('POST', '/api/results/upsert', { heat_id: 1, event_entry_id: 1, time_seconds: 10.5 });
        sw.ctx.__respond = () => ({ ok: false, status: 409, json: { error: 'CONFLICT_NEWER_ON_SERVER', server_value: { time_seconds: 10.4 } } });
        await sw.sync();
        const msg = sw.posted.find(m => m.type === 'SYNC_COMPLETE');
        expect(msg.conflicts.length).toBe(1); expect(msg.dropped.length).toBe(0); expect(sw.store[0].synced).toBe(true);
    });
    it('⑤ 동시에 불려도 한 번만 전송한다', async () => {
        const sw = loadSW();
        sw.push('POST', '/api/results/upsert', { heat_id: 1, event_entry_id: 1, time_seconds: 10.5 });
        sw.ctx.__respond = () => new Promise(r => setTimeout(() => r({ ok: true, status: 200 }), 30));
        await Promise.all([sw.sync(), sw.sync(), sw.sync()]);
        expect(sw.sent.length).toBe(1);
    });
    it('네트워크가 아직 안 되면 아무것도 버리지 않는다', async () => {
        const sw = loadSW();
        sw.push('POST', '/api/results/upsert', { heat_id: 1, event_entry_id: 1, time_seconds: 10.5 });
        sw.ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
        await sw.sync();
        expect(sw.store[0].synced).toBe(false);
    });
});
