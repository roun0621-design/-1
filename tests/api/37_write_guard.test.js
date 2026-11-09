/**
 * 쓰기 가드 — /api 의 모든 변경 요청은 유효한 키(운영키·관리자·기록위원 또는 JWT 세션)가 필요 (2026-09)
 *   점검 전: 기록 입력(진행 중 종목)·기록 초기화·결승 생성·레인 변경·소집 처리·풍속·.lif 가져오기 등 40개 라우트가 무인증이었다.
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
let app, db; const fx = {};
const OP = 'testopkey', ADMIN = 'testadmin1234';

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'GUARD_' + Date.now(), '2026-01-01', '2099-12-31', 'x'); fx.comp = r.lastInsertRowid;
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'in_progress')", fx.comp, '100m'); fx.ev = r.lastInsertRowid;
    r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, '가드', '1', 'T');
    r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", fx.ev, r.lastInsertRowid); fx.entry = r.lastInsertRowid;
    r = await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', fx.ev); fx.heat = r.lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', fx.heat, fx.entry);
});

describe('쓰기 가드', () => {
    const body = () => ({ heat_id: fx.heat, event_entry_id: fx.entry, time_seconds: 10.99 });
    it('키 없는 기록 입력·초기화·결승 생성·풍속·소집은 403', async () => {
        for (const [m, url, b] of [
            ['post', '/api/results/upsert', body()], ['post', '/api/results/reset-sub-event', { event_id: fx.ev }],
            ['post', `/api/events/${fx.ev}/create-final`, {}], ['post', `/api/heats/${fx.heat}/wind`, { wind: 1.0 }],
            ['post', '/api/callroom/checkin', { event_entry_id: fx.entry }], ['delete', '/api/results', { heat_id: fx.heat, event_entry_id: fx.entry }],
            ['post', '/api/height-attempts/save', { heat_id: fx.heat, event_entry_id: fx.entry, bar_height: 1.8, attempt_number: 1, result_mark: 'O' }],
        ]) {
            const r = await request(app)[m](url).send(b);
            expect(r.status, `${m.toUpperCase()} ${url}`).toBe(403);
        }
        expect(await db.get('SELECT COUNT(*) c FROM result WHERE heat_id=?', fx.heat)).toMatchObject({ c: 0 });
    });
    it('잘못된 키도 403, 운영키는 헤더·본문·쿼리 어디에 실어도 통과', async () => {
        expect((await request(app).post('/api/results/upsert').set('x-admin-key', 'nope').send(body())).status).toBe(403);
        expect((await request(app).post('/api/results/upsert').set('x-admin-key', OP).send(body())).status).toBe(200);
        expect((await request(app).post('/api/results/upsert').send({ ...body(), admin_key: OP })).status).toBe(200);
        expect((await request(app).post('/api/results/upsert?key=' + OP).send(body())).status).toBe(200);
        expect((await request(app).post('/api/results/upsert').send({ ...body(), admin_key: ADMIN })).status).toBe(200);
    });
    it('멀티파트 업로드도 키가 없으면 403 (파싱 직후 검사)', async () => {
        const lif = Buffer.from('﻿1,1,1,남자 100m 결승,,,,,,,,2026\r\n', 'utf16le');
        const no = await request(app).post('/api/scoreboard/import').field('competition_id', String(fx.comp)).attach('files', lif, 'a.lif');
        expect(no.status).toBe(403);
        const ok = await request(app).post('/api/scoreboard/preview').field('competition_id', String(fx.comp)).field('admin_key', OP).attach('files', lif, 'a.lif');
        expect(ok.status).toBe(200);
    });
    it('공개 경로는 가드 대상이 아니다 (로그인·푸시 구독), 조회(GET)는 영향 없음', async () => {
        expect((await request(app).post('/api/auth/verify').send({ key: OP })).status).toBe(200);
        expect((await request(app).post('/api/push/register').send({})).status).not.toBe(403);
        expect((await request(app).get(`/api/results?heat_id=${fx.heat}`)).status).toBe(200);
    });
    it('라우트별 세부 권한은 그대로: 운영키로 관리자 전용 기능은 여전히 403', async () => {
        const r = await request(app).post('/api/admin/change-keys').send({ admin_key: OP, new_operation_key: 'whatever-long' });
        expect(r.status).toBe(403);
    });
});
