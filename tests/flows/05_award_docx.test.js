/**
 * 상장 워드(.docx) 출력 — 경기 완료 후 기록입력 화면의 "상장 출력" 버튼 (POST /api/certificates/event-award)
 *   편집 가능한 파일: 워드·한글에서 열린다. 문구는 상장관리 양식(title_text·body_template·signer_*)을 쓴다.
 */
const request = require('supertest');
const JSZip = require('jszip');
let app, db; const fx = {}; const OP = 'testopkey';
const binary = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const docText = async (buf) => { const zip = await JSZip.loadAsync(buf); const xml = await zip.file('word/document.xml').async('string'); return { xml, text: xml.replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, ''), files: Object.keys(zip.files) }; };

beforeAll(async () => {
    const mod = require('../../server.js'); app = mod.app; db = mod.db;
    let r = await db.run("INSERT INTO competition (name, start_date, end_date, venue, status) VALUES (?,?,?,?, 'active')", '제37회 상장테스트대회', '2026-09-14', '2099-12-31', '예천'); fx.comp = r.lastInsertRowid;
    r = await db.run("INSERT INTO event (competition_id, name, category, gender, division, round_type, round_status) VALUES (?,?, 'track', 'M', '일반', 'final', 'completed')", fx.comp, '100m'); fx.ev = r.lastInsertRowid;
    r = await db.run("INSERT INTO heat (event_id, heat_number, wind) VALUES (?,1,'1.2 m/s')", fx.ev); const h = r.lastInsertRowid;
    for (const [n, t, team] of [['김일등', 10.31, '광주광역시청'], ['이공동', 10.45, '안양시청'], ['박공동', 10.45, '서천군청'], ['최사위', 10.60, '보은군청']]) {
        const a = (await db.run("INSERT INTO athlete (competition_id, name, bib_number, team, gender) VALUES (?,?,?,?, 'M')", fx.comp, n, String(Math.floor(t * 100)), team)).lastInsertRowid;
        const ee = (await db.run("INSERT INTO event_entry (event_id, athlete_id, status) VALUES (?,?, 'checked_in')", fx.ev, a)).lastInsertRowid;
        await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,4)', h, ee);
        await db.run('INSERT INTO result (heat_id, event_entry_id, time_seconds) VALUES (?,?,?)', h, ee, t);
    }
    r = await db.run(`INSERT INTO certificate_template (competition_id, name, kind, title_text, body_template, rank_label_style, signer_org, signer_title, signer_name, is_default)
        VALUES (?, '테스트 시상', 'award', '상  장', '위 선수는 {competition_name}\n{event_name} 종목에서 {rank_label}의 성적을 거두었기에\n이 상장을 수여합니다.', 'numeric', '한국실업육상연맹', '회장', '홍길동', 1)`, fx.comp);
    fx.tpl = r.lastInsertRowid;
});

describe('상장 워드 출력', () => {
    it('키가 없으면 403, 완료되지 않은 종목은 400', async () => {
        expect((await request(app).post('/api/certificates/event-award').send({ event_id: fx.ev })).status).toBe(403);
        const r = await db.run("INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?, 'track', 'M', 'final', 'in_progress')", fx.comp, '200m');
        const res = await request(app).post('/api/certificates/event-award').set('x-admin-key', OP).send({ event_id: r.lastInsertRowid });
        expect(res.status).toBe(400);
    });
    it('1~3위: 공동 2위 두 명 포함 3장, 4위는 제외 — 양식 문구·수여자·기록·풍속이 들어간다', async () => {
        const res = await request(app).post('/api/certificates/event-award').set('x-admin-key', OP).send({ event_id: fx.ev, rank_to: 3 }).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('wordprocessingml');
        const d = await docText(res.body);
        expect(d.files).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']));
        for (const n of ['김일등', '이공동', '박공동']) expect(d.text).toContain(n);
        expect(d.text).not.toContain('최사위');
        expect((d.xml.match(/<w:pageBreakBefore\/>/g) || []).length).toBe(2);           // 3장 → 쪽 나눔 2번
        expect(d.text).toContain('남자 일반부 100m');
        expect(d.text).toContain('제37회 상장테스트대회');
        expect((d.text.match(/2위/g) || []).length).toBeGreaterThanOrEqual(2);           // 공동 2위 두 명
        expect(d.text).toContain('10.31'); expect(d.text).toContain('풍속 +1.2');
        expect(d.text).toContain('한국실업육상연맹'); expect(d.text).toContain('홍길동');
        expect(d.text).toContain('2026년 9월 14일');                                      // 상장 날짜 = 대회 시작일
    });
    it('상장관리에서 문구를 바꾸면 그대로 반영된다', async () => {
        await db.run("UPDATE certificate_template SET title_text='표 창 장', body_template='{athlete_name} 선수의 {record_value} 기록을 기립니다.' WHERE id=?", fx.tpl);
        const res = await request(app).post('/api/certificates/event-award').set('x-admin-key', OP).send({ event_id: fx.ev, rank_to: 1 }).buffer(true).parse(binary);
        const d = await docText(res.body);
        expect(d.text).toContain('표 창 장');
        expect(d.text).toContain('김일등 선수의 10.31 기록을 기립니다.');
    });
    it('관리자 일괄 발급도 format=docx 지원', async () => {
        const res = await request(app).post('/api/admin/certificates/generate').send({ admin_key: 'testadmin1234', template_id: fx.tpl, competition_id: fx.comp, event_ids: [fx.ev], rank_from: 1, rank_to: 2, format: 'docx' }).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect((await docText(res.body)).text).toContain('이공동');
    });
    it('문단 속성 순서가 스키마를 지킨다 (spacing → ind → jc) — 어기면 워드가 손상 파일로 본다', async () => {
        const { generateCertificateDocx } = require('../../lib/certificateDocx');
        const d = await docText(await generateCertificateDocx({}, [{ athlete_name: 'A', event_name: '100m', rank: 1 }]));
        for (const pPr of d.xml.match(/<w:pPr>.*?<\/w:pPr>/g)) {
            const order = ['w:pageBreakBefore', 'w:tabs', 'w:wordWrap', 'w:spacing', 'w:ind', 'w:jc'].map(t => pPr.indexOf('<' + t)).filter(i => i >= 0);
            expect(order).toEqual([...order].sort((a, b) => a - b));
        }
    });
    it('특수문자가 들어가도 XML 이 깨지지 않는다', async () => {
        const { generateCertificateDocx } = require('../../lib/certificateDocx');
        const buf = await generateCertificateDocx({ title_text: '상 <장> & "증"', body_template: 'A&B <{athlete_name}>' }, [{ athlete_name: "O'Neil & Co", team: 'T<1>', event_name: '100m', rank: 1 }]);
        const d = await docText(buf);
        expect(d.xml).toContain('상 &lt;장&gt; &amp; &quot;증&quot;');
        expect(d.xml).toContain('T&lt;1&gt;');
        expect(d.xml).not.toContain('<장>'); expect(d.xml).not.toContain('T<1>');
        expect(d.text).toContain('A&amp;B &lt;O\'Neil &amp; Co&gt;');
    });
});
