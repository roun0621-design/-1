/**
 * 상장 링크(/c/:token) 내구성 + 대회별 문자 문구 (2026-11-05)
 *
 * 운영 문의: "예전에 보낸 문자의 PDF 주소를 열어도 안 뜬다", "어떤 건 눌러도 다른 사람의 정보가 뜬다".
 *   옛 링크는 (대회:종목:선수) 번호를 HMAC 으로 서명한 무상태 토큰이라 ① 서버 키가 바뀌면 전부 죽고
 *   ② 명단을 다시 올려 같은 번호에 다른 선수가 들어오면 남의 상장이 열렸다.
 *   이제 문자·이메일 링크는 cert_link 에 발급 기록(선수 이름·배번 스냅샷)을 남기는 난수 토큰이고,
 *   공개 라우트는 지금 선수와 다르면 410 으로 닫는다. 옛 토큰은 계속 받되 문자 발송 시각과 선수 행 생성 시각을 대조한다.
 */
const request = require('supertest');
const pdfParse = require('pdf-parse');
const { buildCertToken } = require('../../lib/certLink');
const getPdf = url => request(app).get(url).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
let app, db; const ADMIN = 'testadmin1234'; const fx = {}; const stamp = Date.now();

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    await db.run("INSERT OR IGNORE INTO sms_config (id, provider, sim_mode) VALUES (1, 'aligo', 1)");
    await db.run("UPDATE sms_config SET sim_mode=1, api_key='', monthly_quota=0 WHERE id=1");
    // 기본 상장 양식은 부팅 시드가 넣지만(이번에 순서를 고쳤다), 혹시 비어 있으면 하나 넣어 공개 링크가 양식 없음으로 막히지 않게
    const n = await db.get('SELECT COUNT(*) AS c FROM certificate_template WHERE organization_id=1');
    if (!Number(n.c)) await db.run("INSERT INTO certificate_template (competition_id, name, kind, title_text, body_template, organization_id, is_default) VALUES (NULL, '테스트 시상장', 'award', '상  장', '{athlete_name}', 1, 1)");
    fx.comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", 'CL_' + stamp, '2026-01-01', '2099-12-31', 'x')).lastInsertRowid;
});

/** 100m 결승 한 종목 + 선수 1명 + 기록 하나 */
async function seedRace(name, bib, phone, time) {
    const ev = (await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'completed')", fx.comp, `100m ${name}`)).lastInsertRowid;
    const ath = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender, phone) VALUES (?,?,?,?, 'M', ?)", fx.comp, name, bib, '테스트팀', phone)).lastInsertRowid;
    const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'registered')", ev, ath)).lastInsertRowid;
    const heat = (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?, 1)', ev)).lastInsertRowid;
    await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', heat, ee);
    await db.run('INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds) VALUES (?,?,NULL,?)', heat, ee, time);
    return { ev, ath, ee, heat };
}
const batch = body => request(app).post('/api/admin/sms/batch-send').send({ admin_key: ADMIN, competition_id: fx.comp, rank_from: 1, rank_to: 3, cert_url_base: 'https://t.example', skip_sent: false, ...body });
const lastMsg = async athId => (await db.get('SELECT message FROM sms_log WHERE competition_id=? AND athlete_id=? ORDER BY id DESC LIMIT 1', fx.comp, athId)).message;

describe('문자 일괄 발송 → 발급 기록이 남는 난수 링크', () => {
    it('문자에 /c/<난수 22자> 가 들어가고 cert_link 에 선수 스냅샷이 남는다', async () => {
        fx.a = await seedRace('홍길동', '101', '01012345678', 11.23);
        const r = await batch({ event_ids: [fx.a.ev] });
        expect(r.status).toBe(200); expect(r.body.total).toBe(1);
        const m = (await lastMsg(fx.a.ath)).match(/https:\/\/t\.example\/c\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_.-])/);
        expect(m).toBeTruthy(); fx.token = m[1];
        const link = await db.get('SELECT * FROM cert_link WHERE token=?', fx.token);
        expect(link).toMatchObject({ competition_id: fx.comp, event_id: fx.a.ev, athlete_id: fx.a.ath, athlete_name: '홍길동', bib_number: '101', team: '테스트팀', channel: 'sms' });
    });
    it('링크를 열면 그 선수의 PDF 가 나오고 열람 횟수가 는다', async () => {
        const r = await request(app).get(`/c/${fx.token}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
        expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('application/pdf');
        expect((await db.get('SELECT opened_count FROM cert_link WHERE token=?', fx.token)).opened_count).toBe(1);
    });
    it('명단이 바뀌어 같은 번호가 다른 선수가 되면 410 으로 닫힌다 (남의 상장이 열리지 않는다)', async () => {
        await db.run("UPDATE athlete SET name='다른선수' WHERE id=?", fx.a.ath);
        const r = await request(app).get(`/c/${fx.token}`);
        expect(r.status).toBe(410); expect(r.text).toContain('발급 때와 달라');
        await db.run("UPDATE athlete SET name='홍길동' WHERE id=?", fx.a.ath);
        expect((await request(app).get(`/c/${fx.token}`)).status).toBe(200);
    });
    it('엉뚱한 토큰은 404 안내 페이지 (만료라는 말은 쓰지 않는다)', async () => {
        const r = await request(app).get('/c/AAAAAAAAAAAAAAAAAAAAAA');
        expect(r.status).toBe(404); expect(r.text).toContain('링크를 확인할 수 없습니다'); expect(r.text).not.toContain('만료');
    });
});

describe('옛 서명 토큰 — 계속 열리되 명단 재등록 흔적이 있으면 닫는다', () => {
    it('문자 기록이 없는 옛 토큰은 그대로 열린다', async () => {
        fx.legacy = await buildCertToken(db, { competitionId: fx.comp, eventId: fx.a.ev, athleteId: fx.a.ath });
        expect(fx.legacy).toContain('.');
        expect((await request(app).get(`/c/${fx.legacy}`)).status).toBe(200);
    });
    it('그 링크를 보낸 문자가 선수 행보다 먼저 있었으면(= 문자 뒤에 명단을 다시 올림) 410', async () => {
        await db.run(`INSERT INTO sms_log (competition_id, athlete_id, event_id, phone_number, message, status, provider, sent_at, triggered_by) VALUES (?,?,?,?,?,?,?,?,?)`,
            fx.comp, fx.a.ath, fx.a.ev, '01012345678', `옛 문자 https://t.example/c/${fx.legacy}`, 'sent', 'aligo', '2020-01-01T00:00:00.000Z', 'cert_batch');
        const r = await request(app).get(`/c/${fx.legacy}`);
        expect(r.status).toBe(410);
    });
});

describe('링크 진단 (관리자)', () => {
    it('링크 전체를 붙여 넣으면 발급 정보·지금 선수·판정·발송 이력을 돌려준다', async () => {
        const r = await request(app).get('/api/admin/cert-links/inspect').query({ admin_key: ADMIN, token: `https://t.example/c/${fx.token}` });
        expect(r.status).toBe(200); expect(r.body.ok).toBe(true); expect(r.body.kind).toBe('db'); expect(r.body.verdict).toBe('ok');
        expect(r.body.issued.athlete_name).toBe('홍길동'); expect(r.body.current_athlete.name).toBe('홍길동');
        expect(r.body.sms.length).toBeGreaterThanOrEqual(1); expect(r.body.sms[0].phone).toBe('010****5678');
    });
    it('옛 토큰(명단 재등록 흔적)은 changed, 깨진 토큰은 ok:false', async () => {
        const r = await request(app).get('/api/admin/cert-links/inspect').query({ admin_key: ADMIN, token: fx.legacy });
        expect(r.body.kind).toBe('legacy'); expect(r.body.verdict).toBe('changed');
        const bad = await request(app).get('/api/admin/cert-links/inspect').query({ admin_key: ADMIN, token: 'x.y' });
        expect(bad.status).toBe(200); expect(bad.body.ok).toBe(false);
        expect((await request(app).get('/api/admin/cert-links/inspect').query({ token: fx.token })).status).toBe(403);
    });
});

describe('대회별 문자 링크 상장 양식 (입상 / 그 외)', () => {
    it('고르기 전엔 자동(기본 시상장), 기록증 양식을 고르면 1위도 그 양식으로 열린다', async () => {
        fx.recTpl = (await db.run("INSERT INTO certificate_template (competition_id, name, kind, title_text, body_template, organization_id) VALUES (NULL, 'RECTPL71', 'record', '기 록 증', '{athlete_name}', 1)")).lastInsertRowid;
        let g = await request(app).get('/api/admin/sms/competition-template').query({ admin_key: ADMIN, competition_id: fx.comp });
        expect(g.status).toBe(200); expect(g.body.cert_tpl_award_id).toBeNull(); expect(g.body.auto_award && g.body.auto_award.kind).toBe('award');
        expect(g.body.templates.some(t => t.id === fx.recTpl)).toBe(true);
        let pdf = await pdfParse((await getPdf(`/c/${fx.token}`)).body);
        expect(pdf.info.Title.startsWith('RECTPL71')).toBe(false);

        const p = await request(app).post('/api/admin/sms/competition-template').send({ admin_key: ADMIN, competition_id: fx.comp, cert_tpl_award_id: fx.recTpl, cert_tpl_other_id: fx.recTpl });
        expect(p.status).toBe(200); expect(p.body.cert_tpl_award_id).toBe(fx.recTpl);
        g = await request(app).get('/api/admin/sms/competition-template').query({ admin_key: ADMIN, competition_id: fx.comp });
        expect(g.body.cert_tpl_award_id).toBe(fx.recTpl); expect(g.body.cert_tpl_other_id).toBe(fx.recTpl);
        pdf = await pdfParse((await getPdf(`/c/${fx.token}`)).body);
        expect(pdf.info.Title.startsWith('RECTPL71')).toBe(true);
        expect(pdf.text.replace(/\s+/g, '')).toContain('기록증');
        // 진단에도 어떤 양식이 쓰일지 나온다
        const ins = await request(app).get('/api/admin/cert-links/inspect').query({ admin_key: ADMIN, token: fx.token });
        expect(ins.body.template).toMatchObject({ id: fx.recTpl, source: 'competition', slot: 'award' });
    });
    it('없는 양식 id 는 400, 비우면 다시 자동', async () => {
        expect((await request(app).post('/api/admin/sms/competition-template').send({ admin_key: ADMIN, competition_id: fx.comp, cert_tpl_award_id: 99999999 })).status).toBe(400);
        const p = await request(app).post('/api/admin/sms/competition-template').send({ admin_key: ADMIN, competition_id: fx.comp, cert_tpl_award_id: null, cert_tpl_other_id: '' });
        expect(p.status).toBe(200); expect(p.body.cert_tpl_award_id).toBeNull(); expect(p.body.cert_tpl_other_id).toBeNull();
        const pdf = await pdfParse((await getPdf(`/c/${fx.token}`)).body);
        expect(pdf.info.Title.startsWith('RECTPL71')).toBe(false);
        const ins = await request(app).get('/api/admin/cert-links/inspect').query({ admin_key: ADMIN, token: fx.token });
        expect(ins.body.template && ins.body.template.source).toBe('auto');
    });
});

describe('대회별 문자 문구', () => {
    it('저장 전엔 조직 기본 문구, 저장하면 이 대회 문구가 일괄 발송에 쓰인다', async () => {
        let g = await request(app).get('/api/admin/sms/competition-template').query({ admin_key: ADMIN, competition_id: fx.comp });
        expect(g.status).toBe(200); expect(g.body.source).toBe('org'); expect(g.body.effective).toBe(g.body.org_default);
        const p = await request(app).post('/api/admin/sms/competition-template').send({ admin_key: ADMIN, competition_id: fx.comp, template: '[대회문구] {athlete_name} {event_name} {cert_url}' });
        expect(p.status).toBe(200); expect(p.body.source).toBe('competition');
        g = await request(app).get('/api/admin/sms/competition-template').query({ admin_key: ADMIN, competition_id: fx.comp });
        expect(g.body.source).toBe('competition'); expect(g.body.effective).toContain('[대회문구]');

        fx.b = await seedRace('김철수', '102', '01098765432', 11.50);
        const r = await batch({ event_ids: [fx.b.ev] });
        expect(r.status).toBe(200); expect(r.body.total).toBe(1);
        expect(await lastMsg(fx.b.ath)).toMatch(/^\[대회문구\] 김철수 100m 김철수 https:\/\/t\.example\/c\//);
    });
    it('요청에 적어 보낸 문구가 대회 문구보다 우선하고, 빈 문자열로 저장하면 기본 문구로 돌아간다', async () => {
        fx.c = await seedRace('이영희', '103', '01011112222', 11.80);
        const r = await batch({ event_ids: [fx.c.ev], template: '[요청문구] {athlete_name}' });
        expect(r.status).toBe(200); expect(await lastMsg(fx.c.ath)).toBe('[요청문구] 이영희');
        await request(app).post('/api/admin/sms/competition-template').send({ admin_key: ADMIN, competition_id: fx.comp, template: '' });
        const g = await request(app).get('/api/admin/sms/competition-template').query({ admin_key: ADMIN, competition_id: fx.comp });
        expect(g.body.source).toBe('org');
    });
});
