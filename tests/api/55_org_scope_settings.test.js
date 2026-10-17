/**
 * 멀티테넌시 2단계-B/C (2026-10-02): 상장 양식(PDF·워드)·문자 설정·푸시 토큰·외부 API 키가 조직별로 갈린다.
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234';
const JP = 'jp.localhost';

describe('조직 스코프 — 상장 양식·문자·푸시·외부 API 키', () => {
    let jpOrg, jpComp, krComp;
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        jpOrg = (await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'jp', name: 'JP', country: 'JP' })).body;
        jpComp = (await request(app).post('/api/competitions').set('Host', JP).send({ admin_key: ADMIN, name: 'JP 大会', start_date: '2026-11-01', end_date: '2026-11-02' })).body;
        krComp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'KR 대회', start_date: '2026-11-01', end_date: '2026-11-02' })).body;
    });

    it('PDF 상장 양식: 목록·조회·수정·삭제가 조직별', async () => {
        const krBefore = (await request(app).get('/api/admin/certificate-templates').query({ admin_key: ADMIN })).body.templates.length;
        const mk = await request(app).post('/api/admin/certificate-templates').set('Host', JP).send({ admin_key: ADMIN, name: 'JP 양식', kind: 'award' });
        expect(mk.status).toBe(200); const id = mk.body.template.id;
        expect(mk.body.template.organization_id).toBe(jpOrg.id);
        const jpList = (await request(app).get('/api/admin/certificate-templates').set('Host', JP).query({ admin_key: ADMIN })).body.templates;
        expect(jpList.map(t => t.id)).toContain(id); expect(jpList.every(t => t.organization_id === jpOrg.id)).toBe(true);   // 기본 조직 양식은 안 보이고, 새 조직엔 자기 시드 양식 + 방금 만든 것
        const krList = (await request(app).get('/api/admin/certificate-templates').query({ admin_key: ADMIN })).body.templates;
        expect(krList.length).toBe(krBefore); expect(krList.map(t => t.id)).not.toContain(id);
        expect((await request(app).get(`/api/admin/certificate-templates/${id}`).query({ admin_key: ADMIN })).status).toBe(404);
        expect((await request(app).put(`/api/admin/certificate-templates/${id}`).send({ admin_key: ADMIN, name: 'x' })).status).toBe(404);
        await request(app).delete(`/api/admin/certificate-templates/${id}`).send({ admin_key: ADMIN });   // 다른 조직에서는 지워지지 않는다
        expect((await db.get('SELECT id FROM certificate_template WHERE id=?', id))).toBeTruthy();
        expect((await request(app).delete(`/api/admin/certificate-templates/${id}`).set('Host', JP).send({ admin_key: ADMIN })).status).toBe(200);
    });

    it('워드 상장 양식: 조직마다 자기 전체 기본', async () => {
        const put = await request(app).put('/api/award-docx-template').set('Host', JP).send({ admin_key: ADMIN, config: { signer_org: 'JAAF' } });
        expect(put.status).toBe(200);
        const jp = (await request(app).get('/api/award-docx-template').set('Host', JP).query({ admin_key: ADMIN })).body;
        expect(jp.source).toBe('global'); expect(jp.config.signer_org).toBe('JAAF');
        const kr = (await request(app).get('/api/award-docx-template').query({ admin_key: ADMIN })).body;
        expect(kr.config.signer_org).not.toBe('JAAF');
        expect((await db.get("SELECT organization_id FROM award_docx_template WHERE scope_key=?", `o${jpOrg.id}`)).organization_id).toBe(jpOrg.id);
    });

    it('문자 설정: 조직마다 한 행, 기본 조직은 예전 행 그대로', async () => {
        const kr0 = (await request(app).get('/api/admin/sms/config').query({ admin_key: ADMIN })).body.config;
        const save = await request(app).post('/api/admin/sms/config').set('Host', JP).send({ admin_key: ADMIN, sender_number: '0312345678', sender_name: 'JAAF', sim_mode: true, monthly_quota: 50 });
        expect(save.status).toBe(200);
        const jp = (await request(app).get('/api/admin/sms/config').set('Host', JP).query({ admin_key: ADMIN })).body.config;
        expect(jp.sender_name).toBe('JAAF');
        const kr = (await request(app).get('/api/admin/sms/config').query({ admin_key: ADMIN })).body.config;
        expect(kr.sender_name).toBe(kr0.sender_name || ''); expect(kr.sender_name).not.toBe('JAAF');
        const rows = await db.all('SELECT organization_id FROM sms_config ORDER BY organization_id');
        expect(rows.map(r => r.organization_id)).toEqual([1, jpOrg.id]);
    });

    it('푸시 토큰: 조직별 집계', async () => {
        const r = await request(app).post('/api/push/register').set('Host', JP).send({ token: 'tok-jp-1', audience: 'public' });
        expect([200, 503]).toContain(r.status);   // 푸시 미설정 환경이면 503 일 수 있음
        if (r.status === 200) {
            expect((await db.get('SELECT organization_id FROM push_token WHERE token=?', 'tok-jp-1')).organization_id).toBe(jpOrg.id);
            const krCnt = (await request(app).get('/api/admin/push/status').query({ admin_key: ADMIN })).body.tokens;
            const jpCnt = (await request(app).get('/api/admin/push/status').set('Host', JP).query({ admin_key: ADMIN })).body.tokens;
            expect(jpCnt).toBeGreaterThanOrEqual(1); expect(krCnt).toBe(0);
        }
    });

    it('외부 API 키: 발급·목록·회수가 조직별, 다른 조직 대회는 거부', async () => {
        const mk = await request(app).post('/api/admin/external-keys').set('Host', JP).send({ admin_key: ADMIN, label: 'jp-key' });
        expect(mk.status).toBe(200);
        const jpKeys = (await request(app).get('/api/admin/external-keys').set('Host', JP).query({ admin_key: ADMIN })).body;
        const krKeys = (await request(app).get('/api/admin/external-keys').query({ admin_key: ADMIN })).body;
        const ids = jpKeys.items.map(k => k.id); const krIds = krKeys.items.map(k => k.id);
        expect(ids).toContain(mk.body.id); expect(krIds).not.toContain(mk.body.id);
        expect((await request(app).post(`/api/admin/external-keys/${mk.body.id}/revoke`).send({ admin_key: ADMIN })).status).toBe(404);
        // 키로 다른 조직 대회 조회 → 거부
        const plain = mk.body.api_key;
        if (plain) {
            const forbidden = await request(app).get(`/api/v1/competitions/${krComp.id}/events`).set('X-API-Key', plain);
            expect([403, 404]).toContain(forbidden.status);
        }
    });
});
