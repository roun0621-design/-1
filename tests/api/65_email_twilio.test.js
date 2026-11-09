/**
 * 이메일 발송 + 문자 어댑터 Twilio (D12, 2026-10-12)
 *   이메일: 조직별 설정(비밀번호 마스킹), 시험 발송(시뮬레이션 → 이력), 기록증 일괄 발송(순위 범위·이메일 없는 선수·중복 방지·조직 분리)
 *   Twilio: 국제 번호 정규화(toE164), provider 별 번호 검증, 시뮬레이션 발송
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234';
const SMS = require('../../lib/smsSender');
const Mail = require('../../lib/mailer');

describe('이메일 · Twilio', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '메일 대회', start_date: '2026-11-01', end_date: '2026-11-02' })).body.id;
        fx.ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?, '100m', 'track', 'M', 'final', 'completed')", fx.comp)).lastInsertRowid;
        fx.heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', fx.ev)).lastInsertRowid;
        const mk = async (name, bib, t, email) => {
            const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender, email) VALUES (?,?,?, 'T', 'M', ?)", fx.comp, name, bib, email)).lastInsertRowid;
            const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.ev, a)).lastInsertRowid;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', fx.heat, ee, bib);
            await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', fx.heat, ee, t);
            return a;
        };
        fx.a1 = await mk('일등', 1, 10.5, 'first@example.com'); fx.a2 = await mk('이등', 2, 10.8, ''); fx.a3 = await mk('삼등', 3, 10.9, 'third@example.com'); fx.a4 = await mk('사등', 4, 11.2, 'fourth@example.com');
    });

    it('설정 저장·조회 — 비밀번호는 설정 여부만, 기본 제목·본문 제공', async () => {
        const save = await request(app).post('/api/admin/email/config').send({ admin_key: ADMIN, smtp_host: 'smtp.test', smtp_port: 2525, smtp_user: 'u', smtp_pass: 'secret', from_address: 'r@test.org', from_name: '사무국', sim_mode: true });
        expect(save.status).toBe(200);
        const r = await request(app).get('/api/admin/email/config').query({ admin_key: ADMIN });
        expect(r.body.config).toMatchObject({ smtp_host: 'smtp.test', smtp_port: 2525, smtp_pass_set: true, from_address: 'r@test.org', sim_mode: 1 });
        expect(r.body.config.smtp_pass).toBeUndefined(); expect(r.body.config.default_subject).toContain('{competition_name}');
        // UNCHANGED 면 유지
        await request(app).post('/api/admin/email/config').send({ admin_key: ADMIN, smtp_pass: '***UNCHANGED***', from_name: '바뀜' });
        expect((await db.get('SELECT smtp_pass, from_name FROM email_config WHERE organization_id=1'))).toEqual({ smtp_pass: 'secret', from_name: '바뀜' });
        expect((await request(app).post('/api/admin/email/config').send({ admin_key: ADMIN, from_address: 'not-an-email' })).status).toBe(400);
        expect((await request(app).get('/api/admin/email/config')).status).toBe(403);
    });

    it('시험 발송(시뮬레이션) → 이력, 잘못된 주소는 400', async () => {
        const r = await request(app).post('/api/admin/email/test').send({ admin_key: ADMIN, to: 'me@example.com' });
        expect(r.status).toBe(200); expect(r.body.status).toBe('simulated');
        expect((await request(app).post('/api/admin/email/test').send({ admin_key: ADMIN, to: 'nope' })).status).toBe(400);
        const log = await request(app).get('/api/admin/email/log').query({ admin_key: ADMIN });
        expect(log.body.logs[0]).toMatchObject({ to_address: 'me@example.com', status: 'simulated', triggered_by: 'test' });
    });

    it('기록증 일괄 발송: 1~3위 중 이메일 있는 선수만, 링크·변수 치환, 두 번째는 건너뜀', async () => {
        const r = await request(app).post('/api/admin/email/send-certificates').send({ admin_key: ADMIN, competition_id: fx.comp, rank_from: 1, rank_to: 3 });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ total: 2, simulated: 2, no_email: 1, skipped_sent: 0 });
        expect(r.body.results.map(x => x.to).sort()).toEqual(['first@example.com', 'third@example.com']);
        const logs = await db.all('SELECT * FROM email_log WHERE competition_id=? ORDER BY id', fx.comp);
        expect(logs).toHaveLength(2); expect(logs[0].subject).toContain('메일 대회'); expect(logs[0].subject).toContain('우승');
        const again = await request(app).post('/api/admin/email/send-certificates').send({ admin_key: ADMIN, competition_id: fx.comp, rank_from: 1, rank_to: 3 });
        expect(again.body).toMatchObject({ total: 0, skipped_sent: 2 });
        const all = await request(app).post('/api/admin/email/send-certificates').send({ admin_key: ADMIN, competition_id: fx.comp, include_finishers: true, skip_sent: false, body: '{athlete_name} {rank_label} {cert_url}' });
        expect(all.body.total).toBe(3);   // 4등(완주자)까지, 이메일 없는 2등 제외
        const l4 = await db.get('SELECT subject, status FROM email_log WHERE competition_id=? AND athlete_id=?', fx.comp, fx.a4);
        expect(l4.status).toBe('simulated');
        // 다른 조직 호스트에서는 이 대회가 보이지 않아 404
        await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'mailjp', name: 'JP', country: 'JP' });
        expect((await request(app).post('/api/admin/email/send-certificates').set('Host', 'mailjp.localhost').send({ admin_key: ADMIN, competition_id: fx.comp })).status).toBe(404);
    });

    it('이메일 어댑터: 주소 검증·템플릿·호스트 없으면 시뮬레이션', async () => {
        expect(Mail.isValidEmail('a@b.co')).toBe(true); expect(Mail.isValidEmail('a@b')).toBe(false);
        expect(Mail.fillTemplate('{a}-{b}-{c}', { a: 1, b: 'x' })).toBe('1-x-');
        expect((await Mail.sendOne({ sim_mode: 0, smtp_host: '' }, { to: 'a@b.co', subject: 's', text: 't' })).status).toBe('simulated');
        expect((await Mail.sendOne({ sim_mode: 0, smtp_host: 'x' }, { to: '', subject: 's', text: 't' })).status).toBe('skipped');
    });

    it('Twilio: 국제 번호 정규화와 provider 별 검증, 시뮬레이션 발송', async () => {
        expect(SMS.toE164('010-1234-5678')).toBe('+821012345678'); expect(SMS.toE164('+1 (202) 555-0123')).toBe('+12025550123'); expect(SMS.toE164('81 90 1234 5678')).toBe('+819012345678');
        expect(SMS.toE164('12345')).toBe(''); expect(SMS.toE164('')).toBe('');
        expect(SMS.isValidMobile('+12025550123')).toBe(false); expect(SMS.isValidMobile('+12025550123', 'twilio')).toBe(true); expect(SMS.isValidMobile('01012345678', 'twilio')).toBe(true);
        const sim = await SMS.sendOne({ provider: 'twilio', sim_mode: 1, user_id: 'AC', api_key: 'tok', sender_number: '+15550000000' }, { phone: '+12025550123', message: 'hi' });
        expect(sim.status).toBe('simulated');
        expect((await SMS.sendOne({ provider: 'twilio', sim_mode: 1, user_id: 'AC', api_key: 'tok' }, { phone: '123', message: 'hi' })).status).toBe('skipped');
        // 설정 저장에 twilio 가 들어가고, 단건 발송이 국제 번호를 받는다(시뮬레이션)
        await request(app).post('/api/admin/sms/config').send({ admin_key: ADMIN, provider: 'twilio', user_id: 'AC123', api_key: 'tok', sender_number: '+15550000000', sim_mode: true });
        const r = await request(app).post('/api/admin/sms/send').send({ admin_key: ADMIN, phone: '+12025550123', message: 'hello', competition_id: fx.comp });
        expect(r.status).toBe(200); expect(r.body.status || (r.body.result && r.body.result.status)).toBe('simulated');
        await request(app).post('/api/admin/sms/config').send({ admin_key: ADMIN, provider: 'aligo', api_key: '***UNCHANGED***' });
    });
});
