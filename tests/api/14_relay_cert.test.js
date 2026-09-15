/**
 * 릴레이 구성원 / 인증서(상장) 양식 통합 테스트
 * 미검증이던 두 도메인의 기본 CRUD·인증 가드를 고정.
 */
const request = require('supertest');

let app, db;
const ADMIN_KEY = 'testadmin1234';

beforeAll(async () => {
    const mod = require('../../server.js');
    app = mod.app;
    db = mod.db;
});

async function comp() {
    const r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')",
        'RC_' + Date.now() + '_' + Math.floor(performance.now()), '2026-01-01', '2099-12-31', '장');
    return r.lastInsertRowid;
}

describe('릴레이 구성원', () => {
    it('구성원 추가 → 200 + 조회에 반영', async () => {
        const c = await comp();
        let r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'relay', 'M', 'final', 'in_progress')", c, '4x100m 계주');
        const ev = r.lastInsertRowid;
        r = await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", c, '계주선수', '700', 'A팀');
        const athleteId = r.lastInsertRowid;
        r = await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, athleteId);
        const teamEntry = r.lastInsertRowid;

        const res = await request(app).post('/api/relay-members')
            .send({ event_entry_id: teamEntry, athlete_id: athleteId, leg_order: 1 })
            .set('Content-Type', 'application/json');
        expect(res.status).not.toBe(500);
        expect([200, 201]).toContain(res.status);

        const list = await request(app).get(`/api/relay-members?event_entry_id=${teamEntry}`);
        expect(list.status).toBe(200);
        expect(Array.isArray(list.body)).toBe(true);
        expect(list.body.length).toBeGreaterThanOrEqual(1);
    });
});

describe('인증서(상장) 양식', () => {
    it('양식 생성(관리자) → 200/201 + 목록 조회', async () => {
        const c = await comp();
        const res = await request(app).post('/api/admin/certificate-templates')
            .send({ admin_key: ADMIN_KEY, competition_id: c, name: '테스트상장', kind: 'medalist' })
            .set('Content-Type', 'application/json');
        expect(res.status).not.toBe(500);
        expect([200, 201]).toContain(res.status);

        const list = await request(app).get(`/api/admin/certificate-templates?competition_id=${c}&admin_key=${ADMIN_KEY}`);
        expect(list.status).toBe(200);
    });

    it('관리자 키 없으면 403', async () => {
        const c = await comp();
        const res = await request(app).post('/api/admin/certificate-templates')
            .send({ competition_id: c, name: '무권한', kind: 'medalist' })
            .set('Content-Type', 'application/json');
        expect(res.status).toBe(403);
    });
});
