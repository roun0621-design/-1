/**
 * 로그 기간 조회 — 외부 API 호출 로그·운영 로그의 from/to(한국 날짜)·category·CSV (lib/logRange.js)
 */
const request = require('supertest');
let app, db, comp; const ADMIN = 'testadmin1234';

describe('로그 기간 조회', () => {
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES ('로그 테스트', '2026-09-13', '2026-09-16', '예천', 'completed')")).lastInsertRowid;   // PG 는 FK 를 지키므로 대회를 만든다
        // 외부 API 로그 3건: 9/13 09:00 KST(=00:00 UTC) · 9/16 23:30 KST(=14:30 UTC) · 9/17 00:30 KST(=9/16 15:30 UTC)
        const ins = (created, ep, st) => db.run("INSERT INTO external_api_log (api_key_id, key_prefix, endpoint, method, request_ip, user_agent, competition_id, event_id, request_body, response_status, response_code, duration_ms, created_at) VALUES (NULL,'pk_test',?,'GET','127.0.0.1','t',?,NULL,'',?, 'OK', 3, ?)", ep, comp, st, created);
        await ins('2026-09-13 00:00:00', '/api/external/events/search', 200);
        await ins('2026-09-16 14:30:00', '/api/external/event/1', 200);
        await ins('2026-09-16 15:30:00', '/api/external/event/1', 401);
        await db.run("INSERT INTO operation_log (competition_id, message, category, performed_by, created_at) VALUES (?, '기록 저장 100m', 'record', '심판A', '2026-09-14 03:00:00')", comp);
        await db.run("INSERT INTO operation_log (competition_id, message, category, performed_by, created_at) VALUES (?, '소집 완료', 'callroom', '심판B', '2026-09-20 03:00:00')", comp);
    });
    it('외부 API 로그: 9/13~9/16(한국) 은 2건, 9/17 00:30 KST 는 빠진다 · 요약 · CSV', async () => {
        const r = await request(app).get('/api/admin/external-keys/logs').query({ admin_key: ADMIN, from: '2026-09-13', to: '2026-09-16', limit: 5000 });
        expect(r.status).toBe(200);
        const mine = r.body.items.filter(x => x.key_prefix === 'pk_test');
        expect(mine.map(x => x.created_at).sort()).toEqual(['2026-09-13 00:00:00', '2026-09-16 14:30:00']);
        expect(r.body.range).toEqual({ from: '2026-09-13', to: '2026-09-16' });
        expect(r.body.summary.by_endpoint.find(x => x.key === 'GET /api/external/event/1').count).toBeGreaterThanOrEqual(1);
        const csv = await request(app).get('/api/admin/external-keys/logs').query({ admin_key: ADMIN, from: '2026-09-13', to: '2026-09-16', format: 'csv' });
        expect(csv.headers['content-type']).toMatch(/text\/csv/); expect(csv.text.startsWith('﻿시각(UTC),키,')).toBe(true); expect(csv.text).toContain('/api/external/events/search');
        expect((await request(app).get('/api/admin/external-keys/logs').query({ from: '2026-09-13' })).status).toBe(403);
    });
    it('운영 로그: 기간 + 분류(record) + CSV', async () => {
        const r = await request(app).get('/api/operation-log').query({ competition_id: comp, from: '2026-09-13', to: '2026-09-16', category: 'record', limit: 5000 });
        expect(r.status).toBe(200); expect(r.body.map(x => x.message)).toEqual(['기록 저장 100m']);
        const none = await request(app).get('/api/operation-log').query({ competition_id: comp, from: '2026-09-13', to: '2026-09-16', category: 'callroom' });
        expect(none.body).toEqual([]);
        const csv = await request(app).get('/api/operation-log').query({ competition_id: comp, from: '2026-09-14', to: '2026-09-14', format: 'csv' });
        expect(csv.headers['content-type']).toMatch(/text\/csv/); expect(csv.text).toContain('기록 저장 100m');
    });
});
