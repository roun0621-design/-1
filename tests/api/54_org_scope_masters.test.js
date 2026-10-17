/**
 * 멀티테넌시 2단계-A (2026-10-02): 기록표(NR/DR/CR)·시리즈·연맹·부 마스터가 조직별로 갈린다.
 *   기본 조직(localhost) 과 jp 조직(jp.localhost) 에서 같은 API 를 불러 서로 안 보이는지 확인.
 */
const request = require('supertest');
let app, db; const ADMIN = 'testadmin1234';
const JP = 'jp.localhost';

describe('조직 스코프 — 기록표·시리즈·연맹·부', () => {
    let jpOrg;
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        const r = await request(app).post('/api/admin/organizations').send({ admin_key: ADMIN, slug: 'jp', name: 'JP', country: 'JP', default_tz: 'Asia/Tokyo', default_lang: 'ja' });
        jpOrg = r.body; expect(r.status).toBe(200);
    });

    it('기록표(NR): 조직마다 따로 — 같은 종목·성별이라도 서로 안 보이고 덮어쓰지 않는다', async () => {
        const kr = await request(app).put('/api/records').send({ admin_key: ADMIN, record_type: 'national', event_name: '100m', gender: 'M', record_value: '10.07', holder_name: '김국영' });
        expect(kr.status).toBe(200); expect(kr.body.mode).toBe('inserted');
        const jp = await request(app).put('/api/records').set('Host', JP).send({ admin_key: ADMIN, record_type: 'national', event_name: '100m', gender: 'M', record_value: '9.95', holder_name: '山縣' });
        expect(jp.status).toBe(200); expect(jp.body.mode).toBe('inserted');   // 덮어쓰기(updated)가 아니라 새 행
        const krList = (await request(app).get('/api/records?record_type=national&event_name=100m&gender=M')).body;
        const jpList = (await request(app).get('/api/records?record_type=national&event_name=100m&gender=M').set('Host', JP)).body;
        expect(krList.map(r => r.record_value)).toEqual(['10.07']);
        expect(jpList.map(r => r.record_value)).toEqual(['9.95']);
        // 구 API 도 같은 스코프
        expect((await request(app).get('/api/event-records/M/100m').set('Host', JP)).body.national.record_value).toBe('9.95');
        expect((await request(app).get('/api/event-records/M/100m')).body.national.record_value).toBe('10.07');
        // 매트릭스
        expect((await request(app).get('/api/records/matrix?event_name=100m&gender=M').set('Host', JP)).body.national.record_value).toBe('9.95');
        // 다른 조직 기록은 지울 수 없다
        const del = await request(app).delete(`/api/records/${jp.body.id}`).send({ admin_key: ADMIN });
        expect(del.status).toBe(404);
        expect((await request(app).delete(`/api/records/${jp.body.id}`).set('Host', JP).send({ admin_key: ADMIN })).status).toBe(200);
    });

    it('시리즈: 조직별 목록·수정', async () => {
        const kr = await request(app).post('/api/competition-series').send({ admin_key: ADMIN, name: '전국실업대항', federation: 'KTFL' });
        const jp = await request(app).post('/api/competition-series').set('Host', JP).send({ admin_key: ADMIN, name: '日本選手権', federation: 'JAAF' });
        expect(kr.status).toBe(200); expect(jp.status).toBe(200);
        expect(jp.body.organization_id).toBe(jpOrg.id);
        const krIds = (await request(app).get('/api/competition-series')).body.map(s => s.id);
        const jpIds = (await request(app).get('/api/competition-series').set('Host', JP)).body.map(s => s.id);
        expect(krIds).toContain(kr.body.id); expect(krIds).not.toContain(jp.body.id);
        expect(jpIds).toContain(jp.body.id); expect(jpIds).not.toContain(kr.body.id);
        expect((await request(app).put(`/api/competition-series/${jp.body.id}`).send({ admin_key: ADMIN, name: 'x' })).status).toBe(404);
        expect((await request(app).delete(`/api/competition-series/${jp.body.id}`).send({ admin_key: ADMIN })).status).toBe(404);
    });

    it('연맹: 조직별 목록, 기본 연맹(KTFL 등)은 기본 조직에만', async () => {
        const krCodes = (await request(app).get('/api/federations')).body.map(f => f.code);
        expect(krCodes).toEqual(expect.arrayContaining(['KTFL', 'KUAF', 'KJAF']));
        expect((await request(app).get('/api/federations').set('Host', JP)).body).toEqual([]);
        const add = await request(app).post('/api/federations').set('Host', JP).send({ admin_key: ADMIN, code: 'JAAF', name: '日本陸上競技連盟' });
        expect(add.status).toBe(200);
        expect((await request(app).get('/api/federations').set('Host', JP)).body.map(f => f.code)).toEqual(['JAAF']);
        expect((await request(app).get('/api/federations')).body.map(f => f.code)).not.toContain('JAAF');
        expect((await request(app).put(`/api/federations/${add.body.id}`).send({ admin_key: ADMIN, name: 'x' })).status).toBe(404);
        expect((await request(app).delete(`/api/federations/${add.body.id}`).send({ admin_key: ADMIN })).status).toBe(404);
    });

    it('부 마스터: 기본 13부는 공용, 조직이 추가한 부는 자기 조직만', async () => {
        const base = (await request(app).get('/api/divisions')).body.map(d => d.code);
        const jpBase = (await request(app).get('/api/divisions').set('Host', JP)).body.map(d => d.code);
        expect(jpBase).toEqual(base);   // 공용 부는 같이 보인다
        const add = await request(app).post('/api/admin/divisions').set('Host', JP).send({ admin_key: ADMIN, code: 'JP_U18', label_ko: 'U18', gender: 'M', school_level: 'HIGH' });
        expect(add.status).toBe(200);
        expect((await request(app).get('/api/divisions').set('Host', JP)).body.map(d => d.code)).toContain('JP_U18');
        expect((await request(app).get('/api/divisions')).body.map(d => d.code)).not.toContain('JP_U18');
        expect((await request(app).delete('/api/admin/divisions/JP_U18').send({ admin_key: ADMIN })).status).toBe(404);   // 다른 조직에서 못 지움
        // 공용 부는 기본 조직만 고친다
        expect((await request(app).put(`/api/admin/divisions/${base[0]}`).set('Host', JP).send({ admin_key: ADMIN, label_ko: 'x' })).status).toBe(404);
    });

    it('신기록 승인 대기 목록은 대회의 조직으로 갈린다', async () => {
        const kr = (await request(app).get('/api/record-breaks?status=all')).body;
        const jp = (await request(app).get('/api/record-breaks?status=all').set('Host', JP)).body;
        expect(Array.isArray(kr.rows)).toBe(true); expect(jp.rows).toEqual([]);
    });
});
