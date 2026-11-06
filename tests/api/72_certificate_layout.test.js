/**
 * 상장·기록증 PDF — 배치 옵션 (2026-11-06, 경기도육상연맹 요청)
 *
 * 고객 요청 5건: 증명 문구 삭제 · '기록증' 제목을 대회명 자리까지 내리고 전체를 아래로 가운데 · 글씨 키우기 · 로고 키우기 · 발급자 한 줄.
 *   → 기록증은 내용 블록을 로고 줄 아래 ~ 카드 하단의 세로 가운데에 놓는다(기본 변경).
 *   → certificate_template.show_body / signer_inline / font_scale / logo_scale (양식 편집기 옵션, 기본값은 예전 출력과 같다).
 * 검증은 PDF 콘텐츠 스트림(글자 Tm 위치·Tf 크기, 이미지 cm 폭)과 pdf-parse 본문으로 한다.
 */
const zlib = require('zlib');
const request = require('supertest');
const pdfParse = require('pdf-parse');
const { generateCertificatePdf } = require('../../lib/certificatePdf');

const H = 841.89;
const WIDE = '/brand/wordmark.png', MARK = '/brand/pacerise-mark.png';
const DATA = { athlete_name: '서준', team: '한국초등학교', bib_number: '254', gender: 'M', division: '초3학년부', event_name: '600m 결승', record_value: '1:38.02', competition_name: '2026 유소년 기초종목 생활체육 육상 페스티벌' };
const SIGN = { signer_org: '경기도육상연맹', signer_title: '회장', signer_name: '이 윤 진', seal_image_path: MARK, logo_left_path: WIDE };

function pageContent(buf) {
    const s = buf.toString('latin1'); const re = /stream\r?\n/g; let m; const chunks = [];
    while ((m = re.exec(s))) {
        const start = m.index + m[0].length; const end = s.indexOf('endstream', start); if (end < 0) break;
        const raw = Buffer.from(s.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
        let txt = ''; try { txt = zlib.inflateSync(raw).toString('latin1'); } catch (e) { txt = raw.toString('latin1'); }
        chunks.push(txt); re.lastIndex = end;
    }
    const page = chunks.find(c => c.includes('BT') && c.includes('ET'));
    if (!page) throw new Error('page content stream not found');
    return page;
}
/** 글자 묶음 — { base: 위에서 잰 기준선(pt), size } (pdfkit 은 페이지를 뒤집어 그리므로 H - y) */
function texts(c) { const out = []; const re = /BT\n1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\n\/F(\d+) ([\d.]+) Tf/g; let m; while ((m = re.exec(c))) out.push({ x: +m[1], base: H - +m[2], size: +m[4] }); return out; }
/** 이미지 — 그린 순서대로 { w } (기록증: 로고 → (워터마크) → 인장) */
function images(c) { const out = []; const re = /\n([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\n\/I(\d+) Do/g; let m; while ((m = re.exec(c))) out.push({ w: +m[1], h: Math.abs(+m[2]) }); return out; }
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
async function render(tpl, data = DATA) { const buf = await generateCertificatePdf(tpl, data); return { buf, c: pageContent(buf) }; }

describe('기록증(record) — 세로 가운데 배치', () => {
    it('제목이 예전 고정 위치(92pt)보다 아래로 내려오고 발급자도 카드 아래쪽까지 내려온다 (로고 있음)', async () => {
        const { c } = await render({ kind: 'record', ...SIGN });
        const t = texts(c);
        expect(t[0].size).toBe(38);                 // 첫 글자 = 제목
        expect(t[0].base).toBeGreaterThan(150);     // 예전: 92 + 올림폭 ≈ 125
        expect(t[t.length - 1].base).toBeGreaterThan(700);   // 예전 발급자 줄 ≈ 655
        expect(t[t.length - 1].base).toBeLessThan(786);      // 카드 하단 여백(maxBottom) 안
    });
    it('로고가 없어도 가운데(포인트 바 아래부터 잰다)', async () => {
        const { c } = await render({ kind: 'record', signer_org: '단체', signer_title: '회장', signer_name: '홍길동' });
        const t = texts(c);
        expect(t[0].base).toBeGreaterThan(140);
        expect(t[t.length - 1].base).toBeGreaterThan(680);
    });
    it('극단 설정(글자 1.3·로고 2·조/풍속 4행·두 줄 문구)도 카드 안에 들어간다', async () => {
        const { c } = await render({ kind: 'record', ...SIGN, font_scale: 1.3, logo_scale: 2, body_template: '위 선수는 {competition_name} 에 출전하여\n아래와 같은 기록을 수립하였음을 이에 증명합니다.' }, { ...DATA, wind: 1.2, heat_number: 3 });
        const t = texts(c);
        expect(t[0].base).toBeGreaterThan(120);          // minTop(92) 아래
        expect(t[t.length - 1].base).toBeLessThan(786);  // maxBottom 안
    });
});

describe('기록증 — 안 들어가면 배율을 줄여서라도 한 장에 넣는다', () => {
    it('긴 증명 문구 두 줄 + 두 줄 발급자 + 인장을 1.3 배로 하면 1.25 배로 줄어 카드 안에 들어간다', async () => {
        const { c } = await render({ kind: 'record', ...SIGN, font_scale: 1.3 });
        const t = texts(c);
        expect(t[0].size).toBeLessThan(49.4);
        expect(t[0].size).toBeGreaterThanOrEqual(38);
        expect(t[t.length - 1].base).toBeLessThan(786);
    });
});

describe('기록증 — show_body (증명 문구 삭제)', () => {
    it('기본은 증명 문구가 있고, show_body=0 이면 빠진다', async () => {
        const on = await render({ kind: 'record', ...SIGN });
        const off = await render({ kind: 'record', ...SIGN, show_body: 0 });
        // 문구가 줄바꿈으로 갈라져 나오므로 공백을 지우고 본다
        const flat = async b => (await pdfParse(b)).text.replace(/\s+/g, '');
        expect(await flat(on.buf)).toContain('증명합니다');
        expect(await flat(off.buf)).not.toContain('증명합니다');
        expect(texts(off.c).length).toBeLessThan(texts(on.c).length);
    });
    it('문구가 빠지면 그 자리가 접혀 제목이 더 아래로 내려온다 (블록이 짧아져 가운데가 내려감)', async () => {
        const on = texts((await render({ kind: 'record', ...SIGN })).c);
        const off = texts((await render({ kind: 'record', ...SIGN, show_body: 0 })).c);
        expect(off[0].base).toBeGreaterThan(on[0].base);
    });
});

describe('기록증 — signer_inline (발급자 한 줄)', () => {
    it('기본은 단체명 / 직책 이름 두 줄(18pt 2개), signer_inline=1 이면 한 줄(18pt 1개)에 이름이 다 들어간다', async () => {
        const two = await render({ kind: 'record', ...SIGN });
        const one = await render({ kind: 'record', ...SIGN, signer_inline: 1 });
        expect(texts(two.c).filter(t => t.size === 18).length).toBe(2);
        expect(texts(one.c).filter(t => t.size === 18).length).toBe(1);
        const txt = (await pdfParse(one.buf)).text.replace(/\s+/g, ' ');
        expect(txt).toContain('경기도육상연맹 회장 이 윤 진');
    });
});

describe('글자·로고 배율', () => {
    it('기록증 font_scale 1.25 → 제목 47.5 · 발급자 22.5pt, logo_scale 1.6 → 로고 80pt(기본 50), 인장은 글자를 따라 55pt(기본 44)', async () => {
        const base = await render({ kind: 'record', ...SIGN });
        const big = await render({ kind: 'record', ...SIGN, font_scale: 1.25, logo_scale: 1.6 });
        const bs = texts(big.c).map(t => t.size);
        expect(bs.some(s => near(s, 47.5))).toBe(true);
        expect(bs.some(s => near(s, 22.5))).toBe(true);
        const bi = images(base.c), gi = images(big.c);
        expect(near(bi[0].w, 50)).toBe(true); expect(near(gi[0].w, 80)).toBe(true);
        expect(near(bi[bi.length - 1].w, 44)).toBe(true); expect(near(gi[gi.length - 1].w, 55)).toBe(true);
    });
    it('범위 밖 값은 잘라낸다 — font_scale 5 → 1.3(제목 49.4), logo_scale 9 → 2(로고 100)', async () => {
        // 짧은 블록(문구 없음·발급자 한 줄)으로 — 긴 블록이면 '안 들어가면 배율 축소'가 먼저 걸린다
        const { c } = await render({ kind: 'record', ...SIGN, font_scale: 5, logo_scale: 9, show_body: 0, signer_inline: 1 });
        expect(texts(c)[0].size).toBeCloseTo(49.4, 1);
        expect(near(images(c)[0].w, 100)).toBe(true);
    });
    it('상장(award)도 같은 옵션 — font_scale 1.2 → 제목 64.8, logo_scale 2 → 로고 120(기본 60), signer_inline → 24pt 한 줄, show_body=0 → 본문 없음', async () => {
        const d = { ...DATA, rank: 1, record_value: '10.32' };
        const base = await render({ kind: 'award', ...SIGN }, d);
        const big = await render({ kind: 'award', ...SIGN, font_scale: 1.2, logo_scale: 2, signer_inline: 1, show_body: 0 }, d);
        expect(texts(base.c)[0].size).toBe(54);
        expect(texts(big.c)[0].size).toBeCloseTo(64.8, 1);
        expect(near(images(base.c)[0].w, 60)).toBe(true);
        expect(near(images(big.c)[0].w, 120)).toBe(true);
        // 발급자 영역(세로 640pt 아래)만 센다 — 종목·기록 줄도 같은 20pt(배율 뒤 24pt)라서
        expect(texts(base.c).filter(t => t.size === 20 && t.base > 640).length).toBe(2);   // 단체명 / 직책 이름
        expect(texts(big.c).filter(t => near(t.size, 24) && t.base > 640).length).toBe(1); // 한 줄
        expect((await pdfParse(base.buf)).text).toContain('수여합니다');
        expect((await pdfParse(big.buf)).text).not.toContain('수여합니다');
    });
});

describe('양식 API — 새 컬럼 저장·기본값·범위', () => {
    let app; const ADMIN = 'testadmin1234';
    beforeAll(async () => { app = require('../../server.js').app; });
    const post = body => request(app).post('/api/admin/certificate-templates').send({ admin_key: ADMIN, name: 'L72', kind: 'record', ...body });

    it('없이 만들면 show_body 1 · signer_inline 0 · font_scale 1 · logo_scale 1', async () => {
        const r = await post({});
        expect(r.status).toBe(200);
        const t = r.body.template;
        expect(Number(t.show_body)).toBe(1); expect(Number(t.signer_inline)).toBe(0);
        expect(Number(t.font_scale)).toBe(1); expect(Number(t.logo_scale)).toBe(1);
    });
    it('값을 주면 저장되고, PUT 은 준 것만 바꾸며 범위 밖은 잘라낸다', async () => {
        const r = await post({ show_body: 0, signer_inline: 1, font_scale: 1.25, logo_scale: 1.6 });
        expect(r.status).toBe(200);
        let t = r.body.template;
        expect(Number(t.show_body)).toBe(0); expect(Number(t.signer_inline)).toBe(1);
        expect(Number(t.font_scale)).toBeCloseTo(1.25, 5); expect(Number(t.logo_scale)).toBeCloseTo(1.6, 5);
        const u = await request(app).put(`/api/admin/certificate-templates/${t.id}`).send({ admin_key: ADMIN, font_scale: 9, logo_scale: 0.1 });
        expect(u.status).toBe(200);
        t = u.body.template;
        expect(Number(t.font_scale)).toBeCloseTo(1.3, 5); expect(Number(t.logo_scale)).toBeCloseTo(0.5, 5);
        expect(Number(t.show_body)).toBe(0); expect(Number(t.signer_inline)).toBe(1);   // 안 준 것은 그대로
        const g = await request(app).get(`/api/admin/certificate-templates/${t.id}`).query({ admin_key: ADMIN });
        expect(Number(g.body.template.font_scale)).toBeCloseTo(1.3, 5);
    });
    it('미리보기는 편집 중인 값(show_body 0 · font_scale 1.3)을 그대로 반영한다', async () => {
        const r = await request(app).post('/api/admin/certificates/preview').buffer(true).parse((res, cb) => { const b = []; res.on('data', d => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); })
            .send({ admin_key: ADMIN, template: { kind: 'record', ...SIGN, show_body: 0, font_scale: 1.3 } });
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain('application/pdf');
        expect(texts(pageContent(r.body))[0].size).toBeCloseTo(49.4, 1);
        expect((await pdfParse(r.body)).text.replace(/\s+/g, '')).not.toContain('증명합니다');
    });
});
