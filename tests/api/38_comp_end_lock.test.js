/**
 * [잠금] 대회 종료 후 쓰기 잠금 (Phase 3-⑥)
 *   전역 잠금은 본문의 event_id/heat_id 만 보고 대회를 찾았다 → URL 에만 id 가 있는 요청(풍속, 경기 완료, 소집 메모 …)은
 *   종료된 대회에서도 운영키로 그대로 수정됐다. 또 x-admin-key 헤더를 보지 않아 헤더로만 키를 보내는 관리자 요청은 거꾸로 막혔다.
 */
const request = require('supertest');
let app, db; const fx = {}; const OP = 'testopkey', ADMIN = 'testadmin1234';

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    const mk = async (status) => {
        const comp = (await db.run('INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?,?)', `LOCK_${status}_${Date.now()}`, '2026-01-01', '2099-12-31', 'x', status)).lastInsertRowid;
        const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '100m', 'track', 'M', 'final', 'in_progress')", comp)).lastInsertRowid;
        const heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', ev)).lastInsertRowid;
        const ath = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?, 'LOCKER', '9', 'T', 'M')", comp)).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, ath)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', heat, ee);
        return { comp, ev, heat, ath, ee };
    };
    fx.done = await mk('completed'); fx.live = await mk('active');
});

const asOp = r => r.set('x-admin-key', OP);
describe('종료된 대회 — 운영키는 URL 에만 id 가 있는 요청도 막힌다', () => {
    const cases = () => [
        ['풍속', request(app).post(`/api/heats/${fx.done.heat}/wind`).send({ wind: 1.2 })],
        ['경기 완료', request(app).post(`/api/events/${fx.done.ev}/complete`).send({})],
        ['소집 메모', request(app).patch(`/api/event-entries/${fx.done.ee}/memo`).send({ memo: 'x' })],
        ['종목 메모', request(app).patch(`/api/events/${fx.done.ev}/callroom-memo`).send({ memo: 'x' })],
        ['소집 출석(본문 event_id)', request(app).post('/api/callroom/checkin').send({ barcode: '9', event_id: fx.done.ev })],
        ['소집 일괄 완료(event_ids)', request(app).post('/api/events/callroom-complete-batch').send({ event_ids: [fx.done.ev] })],
        ['기록 입력', request(app).post('/api/results/upsert').send({ heat_id: fx.done.heat, event_entry_id: fx.done.ee, time_seconds: 10.5 })],
    ];
    it('모두 403 + competition_ended', async () => {
        for (const [name, req] of cases()) {
            const r = await asOp(req);
            expect([name, r.status, r.body.competition_ended]).toEqual([name, 403, true]);
        }
        expect((await db.get('SELECT wind FROM heat WHERE id=?', fx.done.heat)).wind == null).toBe(true);
        expect((await db.get('SELECT round_status FROM event WHERE id=?', fx.done.ev)).round_status).toBe('in_progress');
    });
});

describe('관리자 · 진행 중 대회 · 면제 경로', () => {
    it('관리자는 헤더로만 키를 보내도 수정할 수 있다', async () => {
        const r = await request(app).post(`/api/heats/${fx.done.heat}/wind`).set('x-admin-key', ADMIN).send({ wind: 0.8 });
        expect(r.status).toBe(200);
    });
    it('진행 중 대회는 운영키로 그대로 된다', async () => {
        const r = await asOp(request(app).post(`/api/heats/${fx.live.heat}/wind`).send({ wind: 1.1 }));
        expect(r.status).toBe(200);
    });
    it('상장 발급은 종료된 대회에서도 운영키로 가능 (잠금 면제 — 대회 데이터를 바꾸지 않는다)', async () => {
        const r = await asOp(request(app).post('/api/certificates/event-award').send({ event_id: fx.done.ev }));
        expect(r.body.competition_ended).toBeUndefined();     // 다른 사유(미완료 종목 등)로 거절될 수는 있어도 '종료 잠금'은 아니다
    });
});

describe('백업', () => {
    const fs = require('fs'), path = require('path');
    const BK = path.join(__dirname, '..', '..', 'backups');
    const made = [];
    afterAll(() => { for (const f of made) { try { fs.unlinkSync(path.join(BK, f)); } catch (e) {} } });
    it('대회를 종료하면 영구 스냅샷(final<대회id>)이 남는다', async () => {
        const r = await request(app).post(`/api/admin/competitions/${fx.live.comp}/close`).send({ admin_key: ADMIN });
        expect(r.status).toBe(200);
        expect(r.body.snapshot).toMatch(new RegExp(`^backup_final${fx.live.comp}_.+\\.db$`));
        made.push(r.body.snapshot);
        expect(fs.existsSync(path.join(BK, r.body.snapshot))).toBe(true);
    });
    it('수동 백업이 동작한다 (await 누락으로 항상 500 이던 것)', async () => {
        const r = await request(app).post('/api/admin/db-backup/trigger').send({ admin_key: OP, tag: 'vitest' });
        expect(r.status).toBe(200);
        expect(r.body.file).toMatch(/^backup_vitest_/);
        made.push(r.body.file);
    });
    it('상태 조회에 오프사이트(S3) 설정 여부와 종료 스냅샷이 나온다', async () => {
        const r = await request(app).get('/api/admin/db-backup/status').query({ key: OP });
        expect(r.body.offsite_s3).toBe(false);
        expect(r.body.final_snapshots.some(n => n.startsWith(`backup_final${fx.live.comp}_`))).toBe(true);
    });
});
