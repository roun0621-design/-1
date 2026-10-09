/**
 * 조직(organization) — 멀티테넌시 1단계 (2026-10-01, docs/MULTI_TENANCY_PLAN.md)
 *   호스트(서브도메인)로 조직을 고르고, 대회 목록·조회·생성·홈 팝업·사이트 설정이 조직별로 갈린다.
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234', OP = 'testopkey';
const JP = 'jp.localhost';

describe('조직(멀티테넌시 1단계)', () => {
    let jpOrg, krComp, jpComp;
    beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready; });

    it('기본 조직이 자동으로 있고 /api/org 가 요약을 준다', async () => {
        const r = await request(app).get('/api/org');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ id: 1, slug: 'pace-rise', country: 'KR', default_tz: 'Asia/Seoul', default_lang: 'ko', is_default: true });
        expect((await db.get('SELECT organization_id FROM app_user WHERE username=?', 'admin')).organization_id).toBe(1);
    });

    it('플랫폼 관리자가 조직을 만든다 (검증·중복·권한)', async () => {
        const bad = await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'WWW', name: 'x' });
        expect(bad.status).toBe(400);
        const noKey = await request(app).post('/api/admin/organizations').send({ slug: 'jp', name: 'x' });
        expect(noKey.status).toBe(403);
        const r = await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'jp', name: '일본 데모', name_en: 'JP Demo', country: 'jp', default_tz: 'Asia/Tokyo', default_lang: 'ja', site_name: 'PACE RISE Japan' });
        expect(r.status).toBe(200); jpOrg = r.body;
        expect(jpOrg).toMatchObject({ slug: 'jp', country: 'JP', default_tz: 'Asia/Tokyo', default_lang: 'ja' });
        const dup = await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'jp', name: 'again' });
        expect(dup.status).toBe(409);
        // 다른 조직 호스트에서는 조직 관리 불가
        const fromJp = await request(app).post('/api/admin/organizations').set('Host', JP).send({ admin_key: ADMIN, slug: 'us', name: 'US' });
        expect(fromJp.status).toBe(403);
        const list = await request(app).get('/api/admin/organizations').query({ key: ADMIN });
        expect(list.status).toBe(200); expect(list.body.map(o => o.slug)).toEqual(expect.arrayContaining(['pace-rise', 'jp']));
    });

    it('호스트·?org·x-org 로 조직이 정해진다', async () => {
        expect((await request(app).get('/api/org').set('Host', JP)).body.slug).toBe('jp');
        expect((await request(app).get('/api/org').set('Host', 'jp.pace-rise-node.com:3000')).body.slug).toBe('jp');
        expect((await request(app).get('/api/org').set('Host', 'www.pace-rise-node.com')).body.slug).toBe('pace-rise');
        expect((await request(app).get('/api/org').set('Host', 'pace-rise-node.com')).body.is_default).toBe(true);
        expect((await request(app).get('/api/org').set('Host', 'nope.localhost')).body.slug).toBe('pace-rise');   // 모르는 서브도메인 → 기본
        expect((await request(app).get('/api/org?org=jp')).body.slug).toBe('jp');
        expect((await request(app).get('/api/org').set('x-org', 'jp')).body.slug).toBe('jp');
    });

    it('대회는 만든 호스트의 조직 소속이고, 목록·조회가 조직별로 갈린다', async () => {
        krComp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'KR 대회', start_date: '2026-11-01', end_date: '2026-11-02' })).body;
        jpComp = (await request(app).post('/api/competitions').set('Host', JP).send({ admin_key: ADMIN, name: 'JP 大会', start_date: '2026-11-01', end_date: '2026-11-02' })).body;
        expect(krComp.organization_id).toBe(1);
        expect(jpComp.organization_id).toBe(jpOrg.id);
        expect(jpComp.timezone).toBe('Asia/Tokyo');   // 조직 기본 시간대
        const krList = (await request(app).get('/api/competitions')).body.map(c => c.id);
        const jpList = (await request(app).get('/api/competitions').set('Host', JP)).body.map(c => c.id);
        expect(krList).toContain(krComp.id); expect(krList).not.toContain(jpComp.id);
        expect(jpList).toContain(jpComp.id); expect(jpList).not.toContain(krComp.id);
        const krAll = (await request(app).get('/api/competitions?include_hidden=1')).body.map(c => c.id);
        expect(krAll).not.toContain(jpComp.id);
        const recent = (await request(app).get('/api/competitions/recent?window=all').set('Host', JP)).body.map(c => c.id);
        expect(recent).toContain(jpComp.id); expect(recent).not.toContain(krComp.id);
        expect((await request(app).get(`/api/competitions/${jpComp.id}`)).status).toBe(404);
        expect((await request(app).get(`/api/competitions/${jpComp.id}`).set('Host', JP)).status).toBe(200);
        // 복제도 같은 조직
        const cl = await request(app).post(`/api/competitions/${jpComp.id}/clone`).set('Host', JP).send({ admin_key: ADMIN, name: 'JP 2027', start_date: '2027-11-01', end_date: '2027-11-02' });
        expect(cl.status).toBe(200);
        expect((await db.get('SELECT organization_id FROM competition WHERE id=?', cl.body.competition.id)).organization_id).toBe(jpOrg.id);
        expect((await request(app).post(`/api/competitions/${jpComp.id}/clone`).send({ admin_key: ADMIN, name: 'X', start_date: '2027-11-01', end_date: '2027-11-02' })).status).toBe(404);
    });

    it('홈 팝업·사이트 설정이 조직별로 갈린다', async () => {
        const p = await request(app).post('/api/home-popups').set('Host', JP).send({ admin_key: ADMIN, title: 'JP 공지' });
        expect(p.status).toBe(200);
        const pid = p.body.id;
        expect((await request(app).get('/api/home-popups?competition_id=common')).body.map(x => x.id)).not.toContain(pid);
        expect((await request(app).get('/api/home-popups?competition_id=common').set('Host', JP)).body.map(x => x.id)).toContain(pid);
        expect((await request(app).delete(`/api/home-popups/${pid}`).send({ admin_key: ADMIN })).status).toBe(404);   // 다른 조직에서 삭제 불가
        const sc = await request(app).post('/api/admin/site-config').set('Host', JP).send({ admin_key: ADMIN, configs: { site_manual_html: '<p>JP manual</p>' } });
        expect(sc.status).toBe(200);
        const jpCfg = (await request(app).get('/api/site-config').set('Host', JP)).body;
        expect(jpCfg.site_manual_html).toBe('<p>JP manual</p>');
        expect(jpCfg.org).toMatchObject({ slug: 'jp', site_name: 'PACE RISE Japan', is_default: false });
        const krCfg = (await request(app).get('/api/site-config')).body;
        expect(krCfg.site_manual_html).not.toBe('<p>JP manual</p>');
        expect(krCfg.org.is_default).toBe(true);
    });

    it('조직 수정: slug 변경 반영, 기본 조직 slug 는 못 바꿈', async () => {
        const up = await request(app).put(`/api/admin/organizations/${jpOrg.id}`).send({ admin_key: ADMIN, slug: 'japan', country: 'JP' });
        expect(up.status).toBe(200); expect(up.body.slug).toBe('japan');
        expect((await request(app).get('/api/org').set('Host', 'japan.localhost')).body.slug).toBe('japan');
        expect((await request(app).get('/api/org').set('Host', JP)).body.slug).toBe('pace-rise');
        expect((await request(app).put('/api/admin/organizations/1').send({ admin_key: ADMIN, slug: 'other' })).status).toBe(400);
    });

    it('새 조직: 기본 상장 양식 시드, 로고 업로드, 조직별 manifest', async () => {
        const o = (await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'us', name: 'US Demo', country: 'US', default_lang: 'en', site_name: 'PACE RISE US' })).body;
        expect(o.id).toBeTruthy();
        const tpls = await db.all('SELECT kind, is_default FROM certificate_template WHERE organization_id=? ORDER BY sort_order', o.id);
        expect(tpls.length).toBe(3); expect(tpls[0].kind).toBe('award');
        // 로고: 기본 조직 호스트에서 플랫폼 관리자가 올림
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
        const up = await request(app).post(`/api/admin/organizations/${o.id}/logo`).field('admin_key', ADMIN).attach('image', png, 'logo.png');
        expect(up.status).toBe(200); expect(up.body.path).toBe(`/uploads/brand/org_${o.id}.png`);
        expect((await request(app).get('/api/org').set('Host', 'us.localhost')).body.brand.logo).toBe(`/uploads/brand/org_${o.id}.png`);
        // 다른 조직 호스트(jp)에서는 us 로고를 못 바꾼다
        expect((await request(app).post(`/api/admin/organizations/${o.id}/logo`).set('Host', 'japan.localhost').field('admin_key', ADMIN).attach('image', png, 'logo.png')).status).toBe(403);
        const m = await request(app).get('/manifest.json').set('Host', 'us.localhost');
        expect(m.status).toBe(200); expect(m.body.name).toBe('PACE RISE US'); expect(m.body.lang).toBe('en');
        expect((await request(app).get('/manifest.json')).body.name).toContain('PACE RISE');
        expect((await request(app).delete(`/api/admin/organizations/${o.id}/logo`).send({ admin_key: ADMIN })).status).toBe(200);
    });
});
