/**
 * 전국체전 보조 (2026-10-17): 대한육상연맹 데일리 조편성 PDF(글자) → 동기화된 조에 레인/배번, 결과는 result.kaaf.or.kr 실시간 결과표
 */
const request = require('supertest');
const fs = require('fs'); const path = require('path');
let app, db; const ADMIN = 'testadmin1234';
const K = require('../../lib/intl/kaaf');
const D = require('../../lib/intl/nsf_daily');
const sync = require('../../lib/intl/sync');
const FX = path.join(__dirname, '..', 'fixtures', 'nsf');
const KX = path.join(__dirname, '..', 'fixtures', 'kaaf');
const entrants = JSON.parse(fs.readFileSync(path.join(FX, 'entrants.json'), 'utf8'));
const unfinished = fs.readFileSync(path.join(FX, 'detail_unfinished.html'), 'utf8');
const nsfFetch = async (source, kind, p) => {
    if (kind === 'dates') return p.cls === 'A1' ? ['20261018', '20261020'] : ['20261018'];
    if (kind === 'schedule') { const f = path.join(FX, `sched_${p.cls}_${p.date}.html`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '<html></html>'; }
    if (kind === 'entrants') return entrants[`${p.dc}/${p.rh}`] || { playerList: [] };
    if (kind === 'detail') return unfinished;
    throw new Error('unexpected fetch ' + kind);
};

// 연맹 PDF 글자 모양 그대로(칸이 붙고, 부 표시는 쪽 끝에) — 명단 픽스처의 선수로
const DAILY_TEXT = `
-31-
▣ 100m (4-2)
1조레인번호성명소속
2152김리한울산광역시
3360김시훈경상남도
4384최재혁경상남도
5
647이건호부산광역시
2조   레인  번호성명   소속
2   999
비웨사다니엘가사마
경기도
3   998홍길동   서울특별시
남자고등학교부
-32-
▣ 5000m (결승 A,B)
A순   번호성명   소속
1   14이영범   서울특별시
2   329우지민   경상북도
B순   번호성명   소속
3   386이은성   제주특별자치도
▣ 100m(10종)
레인번호성명소속
2370손동현경상남도
3258이우혁충청남도
▣ 멀리뛰기(10종)
순번호성명소속
1258이우혁충청남도
2370손동현경상남도
남자고등학교부
-33-
▣ 100m (3-2+2)
1조레인번호성명소속
384장수인울산광역시
4225황소혜경상남도
여자고등학교부
-34-
▣ 마라톤 (결승)
순   번호성명   소속
1   692강종필   충청남도
남자일반부
-35-
▣ 마라톤 (결승)
순   번호성명   소속
2   700유진서   충청남도
남자일반부
`;

describe('전국체전 데일리 조편성 + 연맹 실시간 결과', () => {
    const fx = {};
    beforeAll(async () => {
        const mod = require('../../server.js'); app = mod.app; db = mod.db; await mod.ready;
        fx.calc = { calcWAPoints: mod.calcWAPoints, waKeysFor: mod.waKeysFor };
        fx.comp = (await request(app).post('/api/competitions').send({ admin_key: ADMIN, name: '제107회 전국체육대회 육상 (데일리)', start_date: '2026-10-18', end_date: '2026-10-21', federation: 'KAAF', venue: '제주' })).body.id;
        const r = await request(app).put(`/api/admin/intl/${fx.comp}/source`).send({ admin_key: ADMIN, base: 'https://meet.sports.or.kr', champ: 'NSF2026', results_url: 'https://result.kaaf.or.kr/tourInfo/resultInfo.do?reg_year=2026&to_cd=E010031092&gubun=E&domestic=0&resultType=TRM&kind_cd=&tabs_id=toKor' });
        expect(r.body.source.results).toMatchObject({ provider: 'kaaf', to_cd: 'E010031092', year: '2026' });
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        await sync.setupStructure(db, comp, { fetch: nsfFetch, calc: fx.calc });
        await sync.syncEntries(db, comp, { fetch: nsfFetch, calc: fx.calc });
        fx.ev100 = await db.get("SELECT * FROM event WHERE competition_id=? AND external_key='A10301#preliminary'", fx.comp);
        expect(fx.ev100).toBeTruthy();
        // 사이트가 가린 이름 흉내: 김시훈 → '김**'
        await db.run("UPDATE athlete SET name='김**' WHERE competition_id=? AND name='김시훈'", fx.comp);
    });

    it('PDF 글자 해석: 붙은 칸 나누기(시도 이름·레인 이어짐), 빈 레인, 줄 바뀐 긴 이름, A/B 그룹, 종합 세부종목, 쪽 넘어간 종목 합치기', () => {
        const p = D.parseDailyText(DAILY_TEXT);
        expect(p.issues).toEqual([]);
        const s100 = p.sections[0];
        expect(s100).toMatchObject({ name: '100m', round: 'preliminary', code: '4-2', gender: 'M', division: '18세이하부' });
        expect(s100.heats.get(1).map(r => [r.lane, r.bib, r.name, r.sido])).toEqual([[2, '152', '김리한', '울산'], [3, '360', '김시훈', '경남'], [4, '384', '최재혁', '경남'], [6, '47', '이건호', '부산']]);
        expect(s100.heats.get(2).map(r => [r.lane, r.bib, r.name, r.sido])).toEqual([[2, '999', '비웨사다니엘가사마', '경기'], [3, '998', '홍길동', '서울']]);
        const s5k = p.sections.find(s => s.name === '5000m');
        expect(s5k.heats.get(1).map(r => [r.lane, r.group, r.name])).toEqual([[1, 'A', '이영범'], [2, 'A', '우지민'], [3, 'B', '이은성']]);
        const dec = p.sections.filter(s => s.combined === '10종'); expect(dec.map(s => s.name)).toEqual(['100m', '멀리뛰기']); expect(dec[0].heats.get(1)[0]).toMatchObject({ lane: 2, bib: '370', name: '손동현', sido: '경남' });
        expect(p.sections.find(s => s.gender === 'F')).toMatchObject({ name: '100m', division: '18세이하부', code: '3-2+2' });
        const mar = p.sections.filter(s => s.name === '마라톤'); expect(mar).toHaveLength(1); expect(mar[0].heats.get(1).map(r => r.lane)).toEqual([1, 2]); expect(mar[0].division).toBe('일반부');
        expect(D.sidoOf('전북특별자치도')).toBe('전북'); expect(D.splitNameTeam('송이창수광주광역시')).toEqual({ name: '송이창수', team: '광주광역시' });
    });

    it('미리보기는 DB 를 바꾸지 않고, 반영은 기존 조(external_key)에 레인·배번·가린 이름 복원·새 선수·세부종목', async () => {
        const heat1 = await db.get("SELECT * FROM heat WHERE event_id=? AND heat_number=1", fx.ev100.id);
        expect(heat1.external_key).toBe('A10301/A11001');
        const before = await db.get('SELECT COUNT(*) c FROM heat_entry WHERE heat_id=?', heat1.id);
        const pre = await request(app).post(`/api/admin/intl/${fx.comp}/daily-lanes`).field('admin_key', ADMIN).field('apply', '0').attach('file', Buffer.from(DAILY_TEXT), 'daily.txt');
        expect(pre.status).toBe(200); expect(pre.body.apply).toBe(false);
        expect(pre.body.stats.events).toBeGreaterThanOrEqual(5);
        expect(Number((await db.get('SELECT COUNT(*) c FROM heat_entry WHERE heat_id=?', heat1.id)).c)).toBe(Number(before.c));
        expect((await db.get("SELECT name FROM athlete WHERE competition_id=? AND barcode='NSF:MAT153100024'", fx.comp)).name).toBe('김**');   // 미리보기는 이름도 안 바꿈

        const ap = await request(app).post(`/api/admin/intl/${fx.comp}/daily-lanes`).field('admin_key', ADMIN).field('apply', '1').attach('file', Buffer.from(DAILY_TEXT), 'daily.txt');
        expect(ap.status).toBe(200); expect(ap.body.apply).toBe(true);
        const sec100 = ap.body.sections[0]; expect(sec100.status).toBe('반영'); expect(sec100.event.id).toBe(fx.ev100.id); expect(sec100.heats).toBe(2); expect(sec100.entries).toBe(6);
        const h1 = await db.all('SELECT he.lane_number, a.name, a.bib_number, a.team, a.barcode FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE he.heat_id=? ORDER BY he.lane_number', heat1.id);
        expect(h1.map(r => [r.lane_number, r.name, r.bib_number, r.team])).toEqual([[2, '김리한', '152', '울산'], [3, '김시훈', '360', '경남'], [4, '최재혁', '384', '경남'], [6, '이건호', '47', '부산']]);
        expect(h1[1].barcode).toBe('NSF:MAT153100024');                 // 가린 이름이 같은 종목·시도의 선수로 맞춰져 실명 복원
        expect((await db.get("SELECT external_key FROM heat WHERE id=?", heat1.id)).external_key).toBe('A10301/A11001');   // 조는 그대로
        const h2 = await db.get("SELECT h.*, (SELECT COUNT(*) FROM heat_entry WHERE heat_id=h.id) n FROM heat h WHERE event_id=? AND heat_number=2", fx.ev100.id);
        expect(h2.external_key).toBe('A10301/A11002'); expect(Number(h2.n)).toBe(2);
        const created = await db.get("SELECT * FROM athlete WHERE competition_id=? AND name='비웨사다니엘가사마'", fx.comp); expect(created).toMatchObject({ team: '경기', bib_number: '999', gender: 'M' });
        // 종합 세부종목: 부모 종목 출전 + 세부종목 조 레인
        const sub = await db.get("SELECT e.* FROM event e JOIN event p ON p.id=e.parent_event_id WHERE e.competition_id=? AND e.name='[10종] 100m' AND p.name='10종경기'", fx.comp);
        const subRows = await db.all('SELECT he.lane_number, a.name FROM heat_entry he JOIN heat h ON h.id=he.heat_id JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE h.event_id=? ORDER BY he.lane_number', sub.id);
        expect(subRows.map(r => [r.lane_number, r.name])).toEqual([[2, '손동현'], [3, '이우혁']]);
        expect(Number((await db.get('SELECT COUNT(*) c FROM event_entry WHERE event_id=?', sub.parent_event_id)).c)).toBeGreaterThanOrEqual(2);
        // A/B 그룹 → sub_group, 마라톤은 road(C10533 결승) 에 순서
        const s5k = ap.body.sections.find(x => x.label.includes('5000m')); expect(s5k.status).toBe('반영');
        const grp = await db.all('SELECT he.sub_group, he.lane_number FROM heat_entry he JOIN heat h ON h.id=he.heat_id WHERE h.event_id=? ORDER BY he.lane_number', s5k.event.id);
        expect(grp.map(g => g.sub_group + g.lane_number)).toEqual(['A1', 'A2', 'B3']);
        const mar = ap.body.sections.find(x => x.label.includes('마라톤')); expect(mar.status).toBe('반영'); expect(mar.entries).toBe(2);
        expect((await db.get('SELECT round_status FROM event WHERE id=?', fx.ev100.id)).round_status).toBe('heats_generated');
        // 다시 올려도 같은 결과(멱등)
        const again = await request(app).post(`/api/admin/intl/${fx.comp}/daily-lanes`).field('admin_key', ADMIN).field('apply', '1').attach('file', Buffer.from(DAILY_TEXT), 'daily.txt');
        expect(again.body.stats.created).toBe(0);
        expect(Number((await db.get('SELECT COUNT(*) c FROM heat_entry WHERE heat_id=?', heat1.id)).c)).toBe(4);
    });

    it('KAAF 파서: 종목표·트랙(풍속·통과)·높이(시기·점프오프)·거리(6시기)·종합(점수·기록)·계주(주자)·장거리(기권·불참)', () => {
        const tb = K.parseEventTable(fs.readFileSync(path.join(KX, 'event_table.html'), 'utf8'));
        expect(tb.length).toBe(33); expect(tb[0]).toMatchObject({ event: '100m', division: '남자고등학교부', round: '예선', state: '경기완료', kind_cd: '13', dc: '11', round_cd: '1', key: '13/11/1' });
        expect(K.divisionOfLabel('남자고등학교부')).toEqual({ gender: 'M', division: '18세이하부' }); expect(K.divisionOfLabel('일반부')).toEqual({ gender: 'X', division: '일반부' });
        expect(K.eventOfLabel('100m(10종)')).toEqual({ name: '100m', combined: '10종' }); expect(K.eventOfLabel('4x100mR')).toEqual({ name: '4X100mR', combined: null }); expect(K.eventOfLabel('포환던지기(6.0KG)').name).toBe('포환던지기');
        const tr = K.parseResultPage(fs.readFileSync(path.join(KX, 'result_track_prelim.html'), 'utf8'));
        expect(tr).toMatchObject({ event: '100m', division: '남자중학교부', date: '2026-07-04' }); expect(tr.heats).toHaveLength(7); expect(tr.heats[0].kind).toBe('track');
        expect(tr.heats[0].rows[0]).toMatchObject({ rank: 1, lane: 6, bib: '00132', name: '최한솔', team: '부천부곡중학교', mark: '11.41', wind: '1.9', remark: '통과' });
        const dsq = tr.heats[1].rows.find(r => r.remark === '실격'); expect(dsq).toMatchObject({ lane: 6, name: '최기영', mark: '' }); expect(K.statusOf(dsq.mark, dsq.remark)).toBe('DQ');
        const hj = K.parseResultPage(fs.readFileSync(path.join(KX, 'result_height.html'), 'utf8'));
        expect(hj.heats[0].kind).toBe('height'); expect(hj.heats[0].rows[0]).toMatchObject({ rank: 1, order: 3, bib: '00380', name: '하도훈', team: '대전체육고등학교', mark: '1.90' });
        expect(hj.heats[0].rows[0].heights.filter(h => !h.jumpoff).map(h => `${h.height}:${h.marks}`)).toEqual(['1.75:-', '1.8:O', '1.85:O', '1.9:XXO', '1.95:XXX']);
        const sp = K.parseResultPage(fs.readFileSync(path.join(KX, 'result_distance.html'), 'utf8'));
        expect(sp.heats[0].kind).toBe('distance'); expect(sp.heats[0].rows[1]).toMatchObject({ rank: 2, name: '이수환', attempts: ['16.44', '17.19', '16.92', '17.22', 'X', 'X'], mark: '17.22' });
        const dec = K.parseResultPage(fs.readFileSync(path.join(KX, 'result_combined.html'), 'utf8'));
        expect(dec.heats[0].kind).toBe('combined'); expect(dec.heats[0].rows[0]).toMatchObject({ bib: '00384', name: '윤태준', total: '5353', team: '충남고등학교' });
        expect(dec.heats[0].rows[0].subs.map(s => `${s.name}=${s.mark}/${s.points}`)).toEqual(['100m=11.80/691', '멀리뛰기=6.27/646', '포환던지기=10.43/512', '높이뛰기=1.82/644', '400m=54.01/639', '110mH=18.39/487', '원반던지기=26.77/401', '장대높이뛰기=3.20/406', '창던지기=39.71/438', '1500m=5:12.61/489']);
        expect(dec.heats[0].rows[1]).toMatchObject({ name: '손동현', total: '0', remark: '기권' });
        const rl = K.parseResultPage(fs.readFileSync(path.join(KX, 'result_relay.html'), 'utf8'));
        expect(rl.heats[0].rows[0]).toMatchObject({ rank: 1, lane: 6, name: '박인석', team: '전북체육고등학교', mark: '41.61' }); expect(rl.heats[0].rows[0].members.map(m => m.name)).toEqual(['최명진', '유호석', '이동관']);
        const lg = K.parseResultPage(fs.readFileSync(path.join(KX, 'result_5000.html'), 'utf8'));
        expect(lg.heats[0].rows).toHaveLength(30); expect(lg.heats[0].rows[0]).toMatchObject({ rank: 1, lane: 1, mark: '14:44.89' });
        expect(K.statusOf('', '기권')).toBe('DNF'); expect(K.statusOf('', '불참')).toBe('DNS');
    });

    // 연맹 결과 페이지 흉내 (실제 마크업과 같은 뼈대)
    const trackPage = (event, division, heats) => `<html><body><div class="Team_wrap" id='html_kor'><div class="team_result">
        <span class="info_box_title info_bg">종목명</span><input value="${event}" /><span class="info_box_title info_bg">종별</span><input value="${division}" /><span class="info_box_title info_bg">라운드</span><input value="예선" /><span class="info_box_title info_bg">일자</span><input value="2026-10-18" />
        ${heats.map((rows, i) => `<div class="tb_list"><table class="table table-hover team_table"><caption>종별 테이블</caption><thead><tr class="tb_title_top01"><th colspan="9" class="sm_th_title">${i + 1}조</th></tr>
        <tr class="tb_title_top"><th>순위</th><th>레인</th><th>배번</th><th>성명</th><th>소속</th><th>기록</th><th>풍속</th><th>비고</th><th>신기록</th></tr></thead><tbody>
        ${rows.map(r => `<tr class="border_bg"><td>${r.rank || ''}</td><td>${r.lane}</td><td>${r.bib}</td><td>${r.name}</td><td class="td_over">${r.team}</td><td>${r.mark || ''}</td><td>${r.wind || ''}</td><td>${r.remark || ''}</td><td>${r.record || ''}</td></tr>`).join('')}
        </tbody></table></div>`).join('')}</div></div><div class="Team_wrap" id='html_eng'></div></body></html>`;
    const distancePage = (event, division, rows) => `<html><body><div class="Team_wrap" id='html_kor'>
        <span class="info_box_title info_bg">종목명</span><input value="${event}" /><span class="info_box_title info_bg">종별</span><input value="${division}" />
        <table class="table table-hover team_table"><caption>종별 테이블</caption><thead><tr class="tb_title_top01"><th colspan="12">1조</th></tr><tr class="tb_title_top"><th>순위</th><th>순번</th><th>배번</th><th>성명</th><th>1차시기</th><th>2차시기</th><th>3차시기</th><th>4차시기</th><th>5차시기</th><th>6차시기</th><th>기록</th><th>비고</th></tr><tr><th>소속</th><th>신기록</th></tr></thead><tbody>
        ${rows.map(r => `<tr class="twolist_tr"><td colspan="12"><div><table class="table table-hover twotable"><tbody><tr><td>${r.rank || ''}</td><td>${r.order}</td><td>${r.bib}</td><td>${r.name}</td>${r.attempts.map(a => `<td>${a}</td>`).join('')}<td>${r.mark || ''}</td><td>${r.remark || ''}</td></tr><tr><td>${r.team}</td><td></td></tr></tbody></table></div></td></tr>`).join('')}
        </tbody></table></div><div class="Team_wrap" id='html_eng'></div></body></html>`;
    const combinedPage = (event, division, subs, rows) => `<html><body><div class="Team_wrap" id='html_kor'>
        <span class="info_box_title info_bg">종목명</span><input value="${event}" /><span class="info_box_title info_bg">종별</span><input value="${division}" />
        <table class="table table-hover team_table"><caption>종별 테이블</caption><thead><tr class="tb_title_top"><th>순위</th><th>배번</th><th>성명</th><th>총점</th><th>신기록</th>${subs.map(s => `<th>${s}</th>`).join('')}</tr><tr><th>소속</th></tr></thead><tbody>
        ${rows.map(r => `<tr class="twolist_tr"><td><div><table class="table table-hover twotable"><tbody><tr><td>${r.rank || ''}</td><td>${r.bib}</td><td>${r.name}</td><td>${r.total}</td><td>${r.remark || ''}</td>${r.points.map(p => `<td>${p}</td>`).join('')}</tr><tr><td>${r.team}</td>${r.marks.map(m => `<td>${m}</td>`).join('')}</tr><tr>${r.marks.map(() => '<td></td>').join('')}</tr></tbody></table></div></td></tr>`).join('')}
        </tbody></table></div><div class="Team_wrap" id='html_eng'></div></body></html>`;
    const tableRow = (event, division, round, state, kind, dc, rcd) => `<tr><td>${event}</td><td>${division}</td><td>${round}</td><td>${state}</td><td><a href="#" onclick="javascript:go_result('E010031092','2026','${kind}','${dc}','${rcd}','','TRM')">보기</a></td></tr>`;

    it('KAAF 동기화: 종목표의 완료 행만 읽어 레인·기록·풍속·상태, 거리 시기, 종합 총점·점수, 완료 처리 + 재실행 시 안 읽음', async () => {
        const comp = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const source = JSON.parse(comp.sync_source);
        const tableHtml = `<html><body><div class="Team_wrap" id='html_kor'><table><tbody>
            ${tableRow('100m', '남자고등학교부', '예선', '순위처리', '13', '11', '1')}
            ${tableRow('100m', '남자고등학교부', '결승', '경기전', '13', '11', '4')}
            ${tableRow('멀리뛰기', '남자일반부', '결승', '경기완료', '15', '23', '4')}
            ${tableRow('10종경기', '남자고등학교부', '결승', '경기완료', '13', '41', '4')}
            ${tableRow('100m', '남자초등부', '결승', '경기완료', '99', '11', '4')}
            </tbody></table></div><div class="Team_wrap" id='html_eng'></div></body></html>`;
        const calls = [];
        const kaafFetch = async (src, kind, row) => {
            calls.push(kind + (row ? ':' + row.key : ''));
            if (kind === 'table') return tableHtml;
            if (row.key === '13/11/1') return trackPage('100m', '남자고등학교부', [
                [{ rank: 1, lane: 2, bib: '00152', name: '김리한', team: '울산광역시', mark: '10.85', wind: '1.2', remark: '통과' }, { rank: 2, lane: 3, bib: '00360', name: '김시훈', team: '경상남도', mark: '10.99', wind: '1.2', remark: '통과', record: '대회신' }, { lane: 6, bib: '00047', name: '이건호', team: '부산광역시', mark: '', wind: '1.2', remark: '불참' }],
                [{ rank: 1, lane: 2, bib: '00999', name: '비웨사다니엘가사마', team: '경기도', mark: '11.01', wind: '-0.3', remark: '통과' }, { rank: 2, lane: 3, bib: '00998', name: '홍길동', team: '서울특별시', mark: '11.20', wind: '-0.3', remark: '탈락' }]]);
            if (row.key === '15/23/4') return distancePage('멀리뛰기', '남자일반부', [
                { rank: 1, order: 2, bib: '00590', name: '박시훈', team: '울산광역시', attempts: ['17.03', 'X', '17.95', '-', '', ''], mark: '17.95' },
                { order: 1, bib: '00795', name: '이상명', team: '경상남도', attempts: ['', '', '', '', '', ''], mark: '', remark: '기권' }]);
            if (row.key === '13/41/4') return combinedPage('10종경기', '남자고등학교부', ['100m', '멀리뛰기', '포환던지기', '높이뛰기', '400m', '110mH', '원반던지기', '장대높이뛰기', '창던지기', '1500m'], [
                { rank: 1, bib: '00258', name: '이우혁', team: '충청남도', total: '5353', remark: '기록경기', points: ['691', '646', '512', '644', '639', '487', '401', '406', '438', '489'], marks: ['11.80', '6.27', '10.43', '1.82', '54.01', '18.39', '26.77', '3.20', '39.71', '5:12.61'] },
                { bib: '00370', name: '손동현', team: '경상남도', total: '0', remark: '기권', points: ['584', '561', '', '', '', '', '', '', '', ''], marks: ['12.35', '5.88', '', '', '', '', '', '', '', ''] }]);
            throw new Error('unexpected ' + row.key);
        };
        const applied = [];
        const out = await sync.runOnce(db, comp, { source, fetch: nsfFetch, kaafFetch, calc: fx.calc, onApplied: a => applied.push(a) });
        const res = out.results;
        expect(res.table_rows).toBe(5); expect(res.checked).toBe(3); expect(res.updated).toBe(3); expect(res.completed).toBe(3);
        expect(res.unmatched).toEqual(['남자초등부 100m 결승']);
        expect(calls.filter(c => c.startsWith('result:')).sort()).toEqual(['result:13/11/1', 'result:13/41/4', 'result:15/23/4']);   // '경기전' 행은 안 읽음
        // 트랙: 기존 조(A10301/A11001)에 기록·레인·풍속·상태
        const h1 = await db.get("SELECT * FROM heat WHERE event_id=? AND heat_number=1", fx.ev100.id);
        expect(h1.wind).toBe(1.2);
        const rows = await db.all('SELECT a.name, a.bib_number, he.lane_number, r.time_seconds, r.status_code, r.remark, r.wind FROM heat_entry he JOIN event_entry ee ON ee.id=he.event_entry_id JOIN athlete a ON a.id=ee.athlete_id LEFT JOIN result r ON r.heat_id=he.heat_id AND r.event_entry_id=ee.id WHERE he.heat_id=? ORDER BY he.lane_number', h1.id);
        expect(rows.map(r => [r.name, r.lane_number, r.time_seconds, r.status_code, r.remark])).toEqual([['김리한', 2, 10.85, '', 'Q'], ['김시훈', 3, 10.99, '', '대회신 Q'], ['최재혁', 4, null, null, null], ['이건호', 6, null, 'DNS', '']]);
        expect((await db.get('SELECT round_status FROM event WHERE id=?', fx.ev100.id)).round_status).toBe('completed');
        // 거리: 시기별(파울 0, 패스 -1), 기권 상태
        const sp = await db.get("SELECT * FROM event WHERE competition_id=? AND name='멀리뛰기' AND gender='M' AND division='일반부'", fx.comp);
        const att = await db.all('SELECT a.name, r.attempt_number, r.distance_meters, r.status_code FROM result r JOIN heat h ON h.id=r.heat_id JOIN event_entry ee ON ee.id=r.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE h.event_id=? ORDER BY a.name, r.attempt_number', sp.id);
        expect(att.filter(x => x.name === '박시훈').map(x => [x.attempt_number, x.distance_meters])).toEqual([[1, 17.03], [2, 0], [3, 17.95], [4, -1]]);
        expect(att.filter(x => x.name === '이상명').map(x => [x.attempt_number, x.status_code])).toEqual([[null, 'DNF']]);
        expect((await db.get('SELECT bib_number FROM athlete WHERE competition_id=? AND name=?', fx.comp, '박시훈')).bib_number).toBe('590');
        // 종합: 부모 조에 총점, combined_score 는 사이트 점수(WA 순서)
        const dec = await db.get("SELECT * FROM event WHERE competition_id=? AND name='10종경기' AND gender='M'", fx.comp);
        const tot = await db.all('SELECT a.name, r.distance_meters, r.status_code, ee.manual_rank FROM result r JOIN heat h ON h.id=r.heat_id JOIN event_entry ee ON ee.id=r.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE h.event_id=? ORDER BY a.name', dec.id);
        expect(tot.map(t => [t.name, t.distance_meters, t.status_code, t.manual_rank])).toEqual([['손동현', null, 'DNF', null], ['이우혁', 5353, '', 1]]);
        const cs = await db.all('SELECT cs.sub_event_order o, cs.sub_event_name n, cs.raw_record v, cs.wa_points p FROM combined_score cs JOIN event_entry ee ON ee.id=cs.event_entry_id JOIN athlete a ON a.id=ee.athlete_id WHERE ee.event_id=? AND a.name=? ORDER BY cs.sub_event_order', dec.id, '이우혁');
        expect(cs.length).toBe(10); expect(cs[0]).toMatchObject({ o: 1, n: '100m', v: 11.8, p: 691 }); expect(cs[9]).toMatchObject({ o: 10, n: '1500m', v: 312.61, p: 489 });
        expect((await db.get('SELECT round_status FROM event WHERE id=?', dec.id)).round_status).toBe('completed');
        expect(applied.filter(a => a.official).length).toBe(3);
        // 두 번째 실행: 완료 행은 다시 읽지 않는다
        calls.length = 0;
        const comp2 = await db.get('SELECT * FROM competition WHERE id=?', fx.comp);
        const out2 = await sync.runOnce(db, comp2, { source, fetch: nsfFetch, kaafFetch, calc: fx.calc });
        expect(out2.results.checked).toBe(0); expect(calls).toEqual(['table']);
        const st = JSON.parse((await db.get('SELECT sync_state FROM competition WHERE id=?', fx.comp)).sync_state);
        expect(st.kaaf['13/11/1']).toMatchObject({ state: '순위처리', written: 5 }); expect(st.kaaf['13/11/1'].doneAt).toBeTruthy();   // 트랙 '순위처리' = 기록 다 들어옴 → 완료(정정은 5분마다 다시 읽음) expect(st.kaaf_stats.table_rows).toBe(5);   // 1조 3건 + 2조 2건
        // 결과가 생긴 종목에 데일리를 다시 올리면 건너뛴다 (force 없이)
        const again = await request(app).post(`/api/admin/intl/${fx.comp}/daily-lanes`).field('admin_key', ADMIN).field('apply', '1').attach('file', Buffer.from(DAILY_TEXT), 'daily.txt');
        expect(again.body.sections[0].status).toMatch(/결과가 있어 건너뜀/);
    });
});
