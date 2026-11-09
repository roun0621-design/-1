/**
 * 라벨 사전(lib/labels.js) + GET /api/labels + division_master.label_en (2026-09-30)
 */
const request = require('supertest');
const Labels = require('../../lib/labels');
let app, db; const ADMIN = 'testadmin1234';

describe('labels', () => {
    beforeAll(async () => { const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready; });
    it('label()/all()', () => {
        expect(Labels.label('round', 'semifinal', 'en')).toBe('Semifinal'); expect(Labels.label('round', 'semifinal', 'ko')).toBe('준결승');
        expect(Labels.label('round', 'weird', 'en')).toBe('weird'); expect(Labels.label('status_code', 'DQ', 'ko')).toBe('실격');
        expect(Labels.all('en').gender.F).toBe('Women'); expect(Labels.all('ko').gender.F).toBe('여자');
    });
    it('부 영문 라벨: 저장값 우선, 없으면 성별·학교급·학년으로', () => {
        expect(Labels.divisionLabelEn({ gender: 'M', school_level: 'HIGH', grade: 2 })).toBe('Men High school Grade 2');
        expect(Labels.divisionLabelEn({ gender: 'F', school_level: 'GEN' })).toBe('Women Senior');
        expect(Labels.divisionLabelEn({ gender: 'X', school_level: 'MIXED' })).toBe('Mixed');
        expect(Labels.divisionLabelEn({ gender: 'M', school_level: 'OPEN', label_en: 'Men Elite' })).toBe('Men Elite');
    });
    it('GET /api/labels?lang=en 은 사전·종목·부 를 준다, /api/divisions 에 label_en', async () => {
        const en = (await request(app).get('/api/labels').query({ lang: 'en' })).body;
        expect(en.lang).toBe('en'); expect(en.round.final).toBe('Final'); expect(en.events.LJ).toBe('Long Jump'); expect(en.divisions.M_HIGH).toBe('Men High school'); expect(en.division_by_ko['남자고등부']).toBe('Men High school');
        const ko = (await request(app).get('/api/labels')).body;
        expect(ko.round.final).toBe('결승'); expect(ko.events.LJ).toBe('멀리뛰기'); expect(ko.divisions.M_HIGH).toBe('남자고등부');
        const divs = (await request(app).get('/api/divisions')).body;
        expect(divs.find(d => d.code === 'F_GEN').label_en).toBe('Women Senior');
    });
    it('관리자가 부 label_en 을 넣고, 비우면 자동 라벨로 돌아간다', async () => {
        const c = await request(app).post('/api/admin/divisions').send({ admin_key: ADMIN, code: 'M_MASTERS40', label_ko: '남자마스터즈40', gender: 'M', school_level: 'OPEN', sort_order: 700, label_en: 'Men Masters 40+' });
        expect(c.status).toBe(200); expect(c.body.label_en).toBe('Men Masters 40+');
        const u = await request(app).put('/api/admin/divisions/M_MASTERS40').send({ admin_key: ADMIN, label_en: '' });
        expect(u.body.label_en).toBe('Men Open');
        expect((await request(app).get('/api/labels').query({ lang: 'en' })).body.divisions.M_MASTERS40).toBe('Men Open');
    });
});
