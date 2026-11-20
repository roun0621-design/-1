/**
 * 페이싱 라이트 → WaveLight 시스템 파일(.pc2) 내려받기 (2026-11-20) — lib/pacingExport.js · /api/pacing/:id/wavelight · /api/pacing/wavelight.zip
 *   색 한 줄 = 파일 하나, 구간 = {"step-distance": "거리", "step-pace": 초}. 파일 이름은 영문 <종목>_<성별>[_<부>]_<기록>_<색>.pc2
 */
const request = require('supertest');
const AdmZip = require('adm-zip');
const P = require('../../lib/pacingExport');

let app, db; const ADMIN = 'testadmin1234';
// 운영사가 준 예시 파일(steeple_11-30.pc2 · steeple_11-40.pc2) 그대로 — 글자 단위로 같아야 한다
const SAMPLE_1130 = '[{"step-distance": "250", "step-pace": 57.5}, {"step-distance": "100", "step-pace": 27.93}, {"step-distance": "300", "step-pace": 69.0}, {"step-distance": "100", "step-pace": 27.93}, {"step-distance": "300", "step-pace": 69.0}, {"step-distance": "100", "step-pace": 27.93}, {"step-distance": "300", "step-pace": 69.0}, {"step-distance": "100", "step-pace": 27.93}, {"step-distance": "300", "step-pace": 69.0}, {"step-distance": "100", "step-pace": 27.93}, {"step-distance": "300", "step-pace": 69.0}, {"step-distance": "100", "step-pace": 27.93}, {"step-distance": "300", "step-pace": 69.0}, {"step-distance": "100", "step-pace": 27.93}, {"step-distance": "100", "step-pace": 23.0}]';
const SAMPLE_1140 = '[{"step-distance": "250", "step-pace": 58.34}, {"step-distance": "100", "step-pace": 28.33}, {"step-distance": "300", "step-pace": 70.0}, {"step-distance": "100", "step-pace": 28.33}, {"step-distance": "300", "step-pace": 70.0}, {"step-distance": "100", "step-pace": 28.33}, {"step-distance": "300", "step-pace": 70.0}, {"step-distance": "100", "step-pace": 28.33}, {"step-distance": "300", "step-pace": 70.0}, {"step-distance": "100", "step-pace": 28.33}, {"step-distance": "300", "step-pace": 70.0}, {"step-distance": "100", "step-pace": 28.33}, {"step-distance": "300", "step-pace": 70.0}, {"step-distance": "100", "step-pace": 28.33}, {"step-distance": "100", "step-pace": 23.34}]';
const segs = list => list.map(([d, t], i) => ({ segment_order: i, distance_meters: d, lap_seconds: t }));
const one = (key, list, opts) => P.buildFiles({ event_name: key, colors: [{ color_key: 'green', segments: segs(list) }] }, opts);
const binary = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

describe('페이싱 라이트 → WaveLight 파일', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: 'WaveLight 대회', start_date: '2026-11-25', end_date: '2026-11-26', venue: '예천' })).body.id;
        expect(fx.comp).toBeTruthy();
        const ev = (name, gender, division) => db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status, sort_order) VALUES (?,?, 'track', ?, ?, 'final', 'created', 1)", fx.comp, name, gender, division);
        await ev('1500m', 'M', '대학부'); await ev('1500m', 'M', '일반부');     // 부가 둘 → 공통 설정의 파일 이름에는 부가 없다
        await ev('5000m', 'F', '일반부');                                       // 부가 하나 → 파일 이름에 그 부
        await ev('3000mSC', 'F', '일반부');
        const save = async (event_name, colors) => {
            const r = await request(app).post('/api/pacing').send({ admin_key: ADMIN, competition_id: fx.comp, event_name, notice: '', colors });
            expect(r.status).toBe(200); return r.body.id;
        };
        fx.c1500 = await save('1500m (남) [대학부]', [
            { color_key: 'green', segments: segs([[300, 46], [400, 62], [400, 62], [400, 62]]) },
            { color_key: 'red', segments: segs([[300, 47], [400, 0], [400, 63], [400, 63]]) },      // 빈 랩타임 → 파일을 만들지 않는다
        ]);
        fx.c5000 = await save('5000m (여)', [{ color_key: 'white', segments: segs([[5000, 1000]]) }, { color_key: 'blue', segments: segs([[5000, 1020.5]]) }]);
        fx.cSC = await save('3000mSC (여)', [{ color_key: 'green', segments: segs([[3000, 690]]) }]);
    });

    it('평지 종목: 구간 그대로 — 1000m 3분은 한 칸 {1000, 180.0}, 구간이 나뉘어 있으면 구간마다 한 칸', () => {
        const a = one('1000m (남)', [[1000, 180]]);
        expect(a.files[0].content).toBe('[{"step-distance": "1000", "step-pace": 180.0}]');
        expect(a.files[0].filename).toBe('1000m_Men_3-00_Green.pc2');
        const b = one('800m (남) [대학부]', [[200, 27], [200, 28], [400, 57.5]]);
        expect(b.files[0].content).toBe('[{"step-distance": "200", "step-pace": 27.0}, {"step-distance": "200", "step-pace": 28.0}, {"step-distance": "400", "step-pace": 57.5}]');
        expect(b.files[0].filename).toBe('800m_Men_Univ_1-52.50_Green.pc2');
        expect(JSON.parse(b.files[0].content)).toHaveLength(3);
    });

    it('3000m 장애물: 예시 파일과 글자 단위로 같다(조명 거리 2850m · 15구간 · 0.01초 올림), 구간이 나뉘어도 15구간', () => {
        expect(one('3000mSC (여)', [[3000, 690]]).files[0].content).toBe(SAMPLE_1130);
        expect(one('3000m 장애물 (여)', [[3000, 700]]).files[0].content).toBe(SAMPLE_1140);
        const split = one('3000mSC (남)', [[1000, 190], [1000, 185], [1000, 180]]).files[0];
        const steps = JSON.parse(split.content);
        expect(steps).toHaveLength(15); expect(split.converted).toBe('steeple');
        expect(steps.reduce((a, s) => a + Number(s['step-distance']), 0)).toBe(2850);
        expect(Math.abs(steps.reduce((a, s) => a + s['step-pace'], 0) - 555)).toBeLessThan(0.2);
        expect(split.filename).toBe('3000mSC_Men_9-15_Green.pc2');
    });

    it('파일 이름은 영문만: 종목·성별·부·기록·색', () => {
        expect(P.fileName({ name: '10,000m', gender: 'F', division: '일반부', totalSeconds: 2130, colorKey: 'red' })).toBe('10000m_Women_Senior_35-30_Red.pc2');
        expect(P.fileName({ name: '10,000mW', gender: 'M', division: '', totalSeconds: 2520, colorKey: 'white' })).toBe('10000mW_Men_42-00_White.pc2');
        expect(P.fileName({ name: '10종경기', gender: 'M', division: '', totalSeconds: 270, colorKey: 'blue' })).toBe('Decathlon_Men_4-30_Blue.pc2');
        expect(P.divisionToken('고2학년부')).toBe('High2'); expect(P.divisionToken('U20(남)')).toBe('U20'); expect(P.divisionToken('18세이하부')).toBe('U18');
        expect(P.divisionToken('실업부')).toBe('Senior'); expect(P.divisionToken('중등부')).toBe('Middle');
        for (const f of [...one('5000m (남) [선수권(남)]', [[5000, 875.25]]).files, ...one('한글종목 (여) [어떤부]', [[800, 130]]).files]) expect(f.filename).toMatch(/^[A-Za-z0-9._-]+\.pc2$/);
        expect(P.parsePacingKey('10,000m (남) [대학부]')).toEqual({ name: '10,000m', gender: 'M', division: '대학부' });
        expect(P.parsePacingKey('800m')).toEqual({ name: '800m', gender: null, division: '' });
        expect(P.pacingKey('800m', 'F', '대학부')).toBe('800m (여) [대학부]');
    });

    it('목록: 색마다 파일 하나, 빈 랩타임이 있는 색은 빼고 알려 준다', async () => {
        const r = await request(app).get(`/api/pacing/${fx.c1500}/wavelight?list=1`);
        expect(r.status).toBe(200);
        expect(r.body.files.map(f => f.filename)).toEqual(['1500m_Men_Univ_3-52_Green.pc2']);
        expect(r.body.files[0].steps).toBe(4);
        expect(r.body.skipped).toEqual([{ color_key: 'red', reason: 'empty_lap' }]);
    });

    it('색 하나 내려받기: 내용·파일 이름, 부가 하나뿐인 종목은 공통 설정에도 부가 붙는다', async () => {
        const r = await request(app).get(`/api/pacing/${fx.c5000}/wavelight?color=blue`).buffer(true).parse(binary);
        expect(r.status).toBe(200);
        expect(r.headers['content-disposition']).toBe('attachment; filename="5000m_Women_Senior_17-00.50_Blue.pc2"');
        expect(r.body.toString('utf8')).toBe('[{"step-distance": "5000", "step-pace": 1020.5}]');
        expect((await request(app).get(`/api/pacing/${fx.c1500}/wavelight?color=red`)).status).toBe(404);     // 파일을 못 만든 색
        expect((await request(app).get('/api/pacing/999999/wavelight?list=1')).status).toBe(404);
    });

    it('종목 묶음 · 대회 전체 묶음(zip)', async () => {
        const one = await request(app).get(`/api/pacing/${fx.c5000}/wavelight`).buffer(true).parse(binary);
        expect(one.status).toBe(200); expect(one.headers['content-disposition']).toContain('WaveLight_5000m_Women.zip');
        expect(new AdmZip(one.body).getEntries().map(e => e.entryName).sort()).toEqual(['5000m_Women_Senior_16-40_White.pc2', '5000m_Women_Senior_17-00.50_Blue.pc2']);

        const all = await request(app).get(`/api/pacing/wavelight.zip?competition_id=${fx.comp}`).buffer(true).parse(binary);
        expect(all.status).toBe(200);
        const zip = new AdmZip(all.body);
        expect(zip.getEntries().map(e => e.entryName).sort()).toEqual([
            '1500m_Men_Univ_3-52_Green.pc2', '3000mSC_Women_Senior_11-30_Green.pc2', '5000m_Women_Senior_16-40_White.pc2', '5000m_Women_Senior_17-00.50_Blue.pc2',
        ]);
        expect(zip.readAsText('3000mSC_Women_Senior_11-30_Green.pc2')).toBe(SAMPLE_1130);
        expect((await request(app).get('/api/pacing/wavelight.zip')).status).toBe(400);
        // 기존 단일 조회는 그대로
        const cfg = await request(app).get(`/api/pacing/${fx.c1500}`);
        expect(cfg.status).toBe(200); expect(cfg.body.event_name).toBe('1500m (남) [대학부]');
    });
});
