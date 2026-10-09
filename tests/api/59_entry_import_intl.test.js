/**
 * 국제 양식 엔트리 가져오기 (B4, 2026-10-09) — 영문 CSV 한 장으로 선수(성·이름 분리)·종목(사전 코드)·출전 등록
 */
const request = require('supertest');
const fs = require('fs'); const os = require('os'); const path = require('path');
let app, db; const ADMIN = 'testadmin1234';

describe('국제 양식 엔트리 가져오기', () => {
    let comp, csvPath;
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'Intl Meet', name_en: 'Intl Meet', start_date: '2026-11-01', end_date: '2026-11-02' })).body;
        csvPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intl-')), 'entries.csv');
        fs.writeFileSync(csvPath, [
            'Bib,Last name,First name,Nation/Club,Gender,DOB,Event 1,Event 2,PB,SB,Local name',
            '101,KIM,Guk-young,KOR,M,1991-04-19,100m,200m,10.07,10.21,김국영',
            '205,YAMADA,Hanako,JPN,Women,02.08.2001,Long Jump,,6.45,6.30,山田花子',
            '301,SMITH,John,USA,M,1999-01-05,Shot Put;Discus,Hammer Throw,,,',
            '302,DOE,Jane,USA,F,2000-02-02,Flying Saucer,4x100m Relay,,,',
            ',NOGENDER,X,KOR,,2000-01-01,100m,,,,',
        ].join('\n'));
    });

    it('양식 내려받기', async () => {
        const r = await request(app).get('/api/entries/intl/template.xlsx').buffer(true).parse((res, cb) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
        expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('spreadsheetml'); expect(r.body.length).toBeGreaterThan(2000);
    });

    it('미리보기: 행별 판정·모르는 종목·계주 경고·오류 행', async () => {
        const r = await request(app).post('/api/entries/intl/preview').field('admin_key', ADMIN).field('competition_id', String(comp.id)).attach('file', csvPath);
        expect(r.status).toBe(200);
        const s = r.body.summary;
        expect(s.rows).toBe(5); expect(s.error).toBe(1); expect(s.new).toBe(4);
        expect(s.unknown_events).toEqual(['Flying Saucer']); expect(s.relay_events).toEqual(['4x100m Relay']);
        const kim = r.body.rows[0];
        expect(kim.athlete.name).toBe('Guk-young KIM'); expect(kim.athlete.family_name).toBe('KIM'); expect(kim.athlete.name_alt).toBe('김국영');
        expect(kim.events.map(e => e.code)).toEqual(['100', '200']);
        const yamada = r.body.rows[1];
        expect(yamada.athlete.gender).toBe('F'); expect(yamada.athlete.date_of_birth).toBe('2001-08-02'); expect(yamada.events[0]).toMatchObject({ code: 'LJ', name: '멀리뛰기', name_en: 'Long Jump', category: 'field_distance' });
        expect(r.body.rows[2].events.map(e => e.code)).toEqual(['SP', 'DT', 'HT']);
        expect(r.body.rows[4].status).toBe('error');
        // 성 이름 순서
        const r2 = await request(app).post('/api/entries/intl/preview').field('admin_key', ADMIN).field('name_order', 'family-given').attach('file', csvPath);
        expect(r2.body.rows[0].athlete.name).toBe('KIM Guk-young');
    });

    it('가져오기: 오류 행이 있으면 거부, 건너뛰기면 적용 — 선수·종목·출전이 만들어진다', async () => {
        const bad = await request(app).post('/api/entries/intl/import').field('admin_key', ADMIN).field('competition_id', String(comp.id)).attach('file', csvPath);
        expect(bad.status).toBe(400);
        const ok = await request(app).post('/api/entries/intl/import').field('admin_key', ADMIN).field('competition_id', String(comp.id)).field('skip_errors', '1').attach('file', csvPath);
        expect(ok.status).toBe(200);
        expect(ok.body.stats).toMatchObject({ athletes_new: 4, athletes_updated: 0, entries: 6, skipped: 1 });   // 100·200·LJ·SP·DT·HT
        expect(ok.body.stats.events_new).toBe(6);
        const kim = await db.get('SELECT * FROM athlete WHERE competition_id=? AND bib_number=?', comp.id, '101');
        expect(kim).toMatchObject({ name: 'Guk-young KIM', family_name: 'KIM', given_name: 'Guk-young', team: 'KOR', gender: 'M', date_of_birth: '1991-04-19', personal_best: '10.07', season_best: '10.21', name_alt: '김국영' });
        const lj = await db.get("SELECT * FROM event WHERE competition_id=? AND code='LJ'", comp.id);
        expect(lj).toMatchObject({ name: '멀리뛰기', category: 'field_distance', gender: 'F', round_type: 'final' });
        expect((await db.get('SELECT COUNT(*) c FROM heat WHERE event_id=?', lj.id)).c).toBe(1);
        expect((await db.get('SELECT COUNT(*) c FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE e.competition_id=?', comp.id)).c).toBe(6);
        // 같은 파일을 다시 올리면 중복 없이 '기존' 으로
        const again = await request(app).post('/api/entries/intl/import').field('admin_key', ADMIN).field('competition_id', String(comp.id)).field('skip_errors', '1').attach('file', csvPath);
        expect(again.body.stats).toMatchObject({ athletes_new: 0, athletes_updated: 4, entries: 0, events_new: 0 });
        expect((await db.get('SELECT COUNT(*) c FROM athlete WHERE competition_id=?', comp.id)).c).toBe(4);
    });
});
