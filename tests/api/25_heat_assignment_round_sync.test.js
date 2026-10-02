/**
 * 조편성 업로드 — 라운드 동기화 회귀
 *
 * 사전소집 후 예선이 폐지돼 결승 직행이 되면(1500m 36명 → 15명 1조) 조편성 파일은 "결승"인데
 * 종목은 1단계에서 만들어진 '예선' 그대로였다 → 대회 당일 수동으로 라운드를 바꿔야 했음.
 * 이제 기록이 없고 해당 라운드의 별도 종목이 없으면 종목 round_type 을 파일에 맞춘다.
 * (반대 방향: 릴레이 결승 → 예선 2조도 동일)
 *
 * DB 격리: tests/setup/global-setup.js 가 임시 SQLite 주입.
 */
const request = require('supertest');
const XLSX = require('xlsx');

let app;
const ADMIN_KEY = 'testadmin1234';

beforeAll(async () => { app = require('../../server.js').app; });

function xlsxBuffer(aoa, sheet) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function createComp() {
    const res = await request(app).post('/api/competitions')
        .send({ admin_key: ADMIN_KEY, name: 'HA_ROUND_SYNC_' + Date.now(), start_date: '2026-09-14', end_date: '2026-09-16', venue: '', federation: 'KTFL', mode: 'operation' })
        .set('Content-Type', 'application/json');
    return res.body.id;
}
const getEvents = async compId => (await request(app).get(`/api/events?competition_id=${compId}`)).body;
const HA_HDR = ['성별', '종목', '라운드', '조', '그룹', '순서', '배번', '성명', '소속'];

describe('조편성 업로드 — 라운드 동기화', () => {
    it('예선 종목에 결승 조편성 → round_type=final, 시간표 결승 행 자동 연결', async () => {
        const compId = await createComp();
        // 1단계: 1500m 남 12명 (heat_size 8 → 예선), 4x100mR 여 3팀(릴레이 → 결승)
        const fedHdr = ['팀명', '선수명', '성별', '생년월일', '종목1', '종목2', '4x100mR', '바코드', '배번'];
        const rows = [];
        for (let i = 0; i < 12; i++) rows.push([`T${i % 3}`, `주자${i}`, '남', '20000101', '1500m', '', '', '', String(i + 1)]);
        for (let i = 0; i < 12; i++) rows.push([`W${i % 3}`, `여주자${i}`, '여', '20000101', '', '', 'O', '', String(100 + i)]);
        let res = await request(app).post('/api/federation/import')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).field('heat_size', '8')
            .attach('file', xlsxBuffer([fedHdr, ...rows], '선수명단'), 'fed.xlsx');
        expect(res.status).toBe(200);
        let evs = await getEvents(compId);
        const e1500 = evs.find(e => e.name === '1500m' && e.gender === 'M');
        const eRelay = evs.find(e => /4X100mR/i.test(e.name) && e.gender === 'F');
        expect(e1500.round_type).toBe('preliminary');
        expect(eRelay.round_type).toBe('final');

        // 시간표: 1500m 결승 행 (예선 종목뿐이라 처음엔 미연결)
        res = await request(app).post('/api/timetable/upload')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).field('overwrite_mode', 'force')
            .attach('file', xlsxBuffer([['구분', '시간', '종목', '부별', '라운드', '비고'], ['트랙', '16:00', '1500m', '실업(남)', '결승', '']], '1일차'), 'tt.xlsx');
        expect(res.status).toBe(200);
        let tt = (await request(app).get(`/api/timetable/${compId}`)).body.days['1'].track;
        expect(tt[0].event_id).toBeNull();

        // 2단계(당일): 1500m 결승 1조 7명, 4x100mR 예선 2조
        const ha = [HA_HDR];
        for (let i = 0; i < 7; i++) ha.push(['남', '1500m', '결승', 1, '', i + 1, String(i + 1), `주자${i}`, `T${i % 3}`]);
        ha.push(['여', '4x100mR', '예선', 1, '', 3, '', 'W0', 'W0']);
        ha.push(['여', '4x100mR', '예선', 1, '', 4, '', 'W1', 'W1']);
        ha.push(['여', '4x100mR', '예선', 2, '', 3, '', 'W2', 'W2']);
        const haBuf = xlsxBuffer(ha, '조편성');

        res = await request(app).post('/api/heat-assignment/preview')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).attach('file', haBuf, 'ha.xlsx');
        expect(res.status).toBe(200);
        const p1500 = res.body.preview.find(p => p.eventId === e1500.id);
        expect(p1500.roundChange).toEqual({ from: 'preliminary', to: 'final' });
        expect(p1500.status).toBe('changed');
        const pRelay = res.body.preview.find(p => p.eventId === eRelay.id);
        expect(pRelay.roundChange).toEqual({ from: 'final', to: 'preliminary' });

        res = await request(app).post('/api/heat-assignment/apply')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).attach('file', haBuf, 'ha.xlsx');
        expect(res.status).toBe(200);
        expect(res.body.stats.roundChanged).toBe(2);

        evs = await getEvents(compId);
        expect(evs.find(e => e.id === e1500.id).round_type).toBe('final');
        expect(evs.find(e => e.id === eRelay.id).round_type).toBe('preliminary');
        // 새 종목이 생기지 않았는지 (같은 이름·성별 1개)
        expect(evs.filter(e => e.name === '1500m' && e.gender === 'M').length).toBe(1);
        const heats = (await request(app).get(`/api/heats?event_id=${e1500.id}`)).body;
        expect(heats.length).toBe(1);

        // 시간표 결승 행이 라운드 변경 후 자동 연결
        tt = (await request(app).get(`/api/timetable/${compId}`)).body.days['1'].track;
        expect(tt[0].event_id).toBe(e1500.id);
    });

    it('기록이 있는 종목은 라운드를 바꾸지 않는다', async () => {
        const compId = await createComp();
        const fedHdr = ['팀명', '선수명', '성별', '생년월일', '종목1', '종목2', '바코드', '배번'];
        const rows = [];
        for (let i = 0; i < 10; i++) rows.push([`T${i % 2}`, `러너${i}`, '남', '20000101', '800m', '', '', String(i + 1)]);
        await request(app).post('/api/federation/import')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).field('heat_size', '8')
            .attach('file', xlsxBuffer([fedHdr, ...rows], '선수명단'), 'fed.xlsx');
        const ev = (await getEvents(compId)).find(e => e.name === '800m' && e.gender === 'M');
        expect(ev.round_type).toBe('preliminary');
        // 결과 1건 입력 (DB 직접 — 기록 존재 상태만 만들면 됨)
        const { db } = require('../../server.js');
        const heat = await db.get('SELECT id FROM heat WHERE event_id=? ORDER BY heat_number LIMIT 1', ev.id);
        const he = await db.get('SELECT event_entry_id FROM heat_entry WHERE heat_id=? LIMIT 1', heat.id);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', heat.id, he.event_entry_id, 110.5);

        const ha = [HA_HDR];
        for (let i = 0; i < 6; i++) ha.push(['남', '800m', '결승', 1, '', i + 1, String(i + 1), `러너${i}`, `T${i % 2}`]);
        const res = await request(app).post('/api/heat-assignment/preview')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).attach('file', xlsxBuffer(ha, '조편성'), 'ha.xlsx');
        const p = res.body.preview.find(x => x.eventId === ev.id);
        expect(p.roundChange).toBeNull();
        expect(p.status).toBe('has_results');
        await request(app).post('/api/heat-assignment/apply')
            .field('admin_key', ADMIN_KEY).field('competition_id', String(compId)).attach('file', xlsxBuffer(ha, '조편성'), 'ha.xlsx');
        expect((await getEvents(compId)).find(e => e.id === ev.id).round_type).toBe('preliminary');
    });
});
