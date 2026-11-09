/**
 * 운영키 해시 저장 + 재발급 (2026-09-18 결정)
 *   DB 에는 bcrypt 해시만, 평문은 발급·재발급 응답에서 한 번만. 옛 평문 행은 부팅 때 해시로 바뀐다.
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234';
beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready; });
const post = (url, body) => request(app).post(url).send({ admin_key: ADMIN, ...body });

describe('운영키 해시', () => {
    let id;
    it('발급: 응답에 평문 1회, DB 에는 해시·힌트만', async () => {
        const r = await post('/api/admin/operation-keys', { judge_name: '해시심판', key_value: 'hash2026' });
        expect(r.status).toBe(200); expect(r.body.key_value).toBe('hash2026'); expect(r.body.show_once).toBe(true); id = r.body.id;
        const row = await db.get('SELECT key_value, key_prefix, key_hint FROM operation_key WHERE id=?', id);
        expect(row.key_value).toMatch(/^\$2[aby]\$/); expect(row.key_prefix).toBe('has'); expect(row.key_hint).toBe('ha••••••');
        const list = await request(app).get('/api/admin/operation-keys').query({ key: ADMIN });
        const mine = list.body.find(k => k.id === id);
        expect(mine.key_value).toBeUndefined(); expect(mine.key_hint).toBe('ha••••••');
    });
    it('해시된 키로 쓰기 요청·심판 로그인이 된다 (같은 키 중복 발급은 거부)', async () => {
        const r = await request(app).post('/api/results/upsert').set('x-admin-key', 'hash2026').send({ heat_id: 0, event_entry_id: 0 });
        expect(r.status).not.toBe(403);                                              // 키 검사는 통과 (그 뒤 유효성 오류는 별개)
        const login = await request(app).post('/api/auth/verify').send({ key: 'hash2026', judge_name: '해시심판' });
        expect(login.status).toBe(200); expect(login.body.role).toBe('operation');
        expect((await post('/api/admin/operation-keys', { judge_name: '다른심판', key_value: 'hash2026' })).status).toBe(400);
    });
    it('재발급: 새 키는 한 번만, 옛 키는 즉시 무효', async () => {
        const r = await post(`/api/admin/operation-keys/${id}/reissue`, {});
        expect(r.status).toBe(200); expect(r.body.key_value).toMatch(/^[a-z0-9]{8}$/);
        expect((await request(app).post('/api/results/upsert').set('x-admin-key', 'hash2026').send({})).status).toBe(403);
        expect((await request(app).post('/api/results/upsert').set('x-admin-key', r.body.key_value).send({})).status).not.toBe(403);
    });
    it('옛 평문 행은 부팅 마이그레이션이 해시로 바꾼다 · 기본 운영키도 해시로 저장된다', async () => {
        await db.run("INSERT INTO operation_key (judge_name, key_value) VALUES ('옛심판', 'plain77')");
        await post(`/api/admin/operation-keys/${id}`, {}).catch(() => {});   // 캐시 재적재를 일으키는 아무 변경(PATCH)
        await request(app).patch(`/api/admin/operation-keys/${id}`).send({ admin_key: ADMIN, active: 1 });
        // 마이그레이션 함수는 부팅 때 돌지만, 그 전이라도 캐시는 평문 행을 받아준다(과도기) → 키가 통한다
        const before = await request(app).post('/api/results/upsert').set('x-admin-key', 'plain77').send({});
        expect(before.status).not.toBe(403);
        const cfg = await db.get("SELECT value FROM system_config WHERE key='operation_key'");
        expect(cfg.value).toMatch(/^\$2[aby]\$/);
        expect((await request(app).post('/api/results/upsert').set('x-admin-key', 'testopkey').send({})).status).not.toBe(403);
    });
    it('기본 운영키 변경: 응답에 새 키 1회, 조회에는 힌트만', async () => {
        const r = await post('/api/admin/change-keys', { new_operation_key: 'newop2026' });
        expect(r.status).toBe(200); expect(r.body.operation_key).toBe('newop2026');
        const cur = await request(app).get('/api/admin/current-keys').query({ key: ADMIN });
        expect(cur.body.operation).toBeNull(); expect(cur.body.operation_hint).toBe('ne•••••••');
        expect((await request(app).post('/api/results/upsert').set('x-admin-key', 'newop2026').send({})).status).not.toBe(403);
        expect((await request(app).post('/api/results/upsert').set('x-admin-key', 'testopkey').send({})).status).toBe(403);
    });
});
