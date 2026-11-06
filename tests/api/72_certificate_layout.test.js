/**
 * 상장·기록증 PDF — 배치 옵션 (2026-11-06, 경기도육상연맹 요청)
 *
 * 고객 요청: 증명 문구 삭제 · 배번 삭제 · '기록증' 제목을 대회명 자리까지 내리고 전체를 아래로 가운데 · 글씨 키우기 · 로고 키우기 · 발급자 한 줄.
 *   → 기록증은 내용 블록을 로고 줄 아래 ~ 카드 하단의 세로 가운데에 놓는다(기본 변경).
 *   → certificate_template.show_body / show_bib / signer_inline / font_scale / logo_scale (양식 편집기 옵션, 기본값은 예전 출력과 같다).
 * 같은 날 사용자 지적 2건: "기록 칸(네모)이 가운데 워터마크와 언발란스" → watermark_anchor(panel 기본 = 기록 칸 가운데 / fit / page),
 *   "발급자 글자와 직인을 한 묶음으로 가운데" → 인장(또는 '(인)')이 붙는 발급자 줄은 글자+인장 묶음을 가운데(기록증·상장, 옵션 없음).
 * 검증은 PDF 콘텐츠 스트림(글자 Tm 위치·Tf 크기, 이미지 cm 폭)과 pdf-parse 본문으로 한다.
 */
const zlib = require('zlib');
const request = require('supertest');
const pdfParse = require('pdf-parse');
const path = require('path');
const PDFDocument = require('pdfkit');
const { generateCertificatePdf } = require('../../lib/certificatePdf');

const H = 841.89, W = 595.28;
const FONT_R = path.join(__dirname, '..', '..', 'public', 'fonts', 'NanumSquare_acR.ttf');
const FONT_B = path.join(__dirname, '..', '..', 'public', 'fonts', 'NanumSquare_acB.ttf');
/** 렌더러와 같은 폰트로 글자 폭을 잰다 (발급자 묶음 가운데 검증용) */
function textWidth(fontPath, size, text) { const d = new PDFDocument({ autoFirstPage: false }); d.registerFont('X', fontPath); d.font('X').fontSize(size); return d.widthOfString(text); }
const WIDE = '/brand/wordmark.png', MARK = '/brand/pacerise-mark.png';
const DATA = { athlete_name: '서준', team: '한국초등학교', bib_number: '254', gender: 'M', division: '초3학년부', event_name: '600m 결승', record_value: '1:38.02', competition_name: '2026 유소년 기초종목 생활체육 육상 페스티벌' };
const SIGN = { signer_org: '경기도육상연맹', signer_title: '회장', signer_name: '이 윤 진', seal_image_path: MARK, logo_left_path: WIDE };

function pageContent(buf) {
    const s = buf.toString('latin1'); const re = /(?<!end)stream\r?\n/g; let m; const chunks = [];
    while ((m = re.exec(s))) {
        const start = m.index + m[0].length; const end = s.indexOf('endstream', start); if (end < 0) break;
        const raw = Buffer.from(s.slice(start, end).replace(/\n$/, ''), 'latin1');
        let txt = ''; try { txt = zlib.inflateSync(raw).toString('latin1'); } catch (e) { txt = raw.toString('latin1'); }
        chunks.push(txt); re.lastIndex = end;
    }
    const page = chunks.find(c => c.includes('BT') && c.includes('ET'));
    if (!page) throw new Error('page content stream not found');
    return page;
}
/** 글자 묶음 — { base: 위에서 잰 기준선(pt), size } (pdfkit 은 페이지를 뒤집어 그리므로 H - y) */
function texts(c) { const out = []; const re = /BT\n1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\n\/F(\d+) ([\d.]+) Tf/g; let m; while ((m = re.exec(c))) out.push({ x: +m[1], base: H - +m[2], size: +m[4] }); return out; }
/** 이미지 — 그린 순서대로 { w, h, x, cx, cy } (기록증: 로고 → (워터마크) → 인장). pdfkit 은 'w 0 0 -h x (y+h) cm' 로 그리므로 위에서 잰 세로 가운데 = f + d/2 */
function images(c) { const out = []; const re = /\n([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\n\/I(\d+) Do/g; let m; while ((m = re.exec(c))) out.push({ w: +m[1], h: Math.abs(+m[2]), x: +m[3], cx: +m[3] + +m[1] / 2, cy: +m[4] + +m[2] / 2 }); return out; }
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

describe('기록증 — show_bib (배번 삭제)', () => {
    it('기본은 메타 줄에 "배번 254"가 있고, show_bib=0 이면 빠진다 (나머지 메타는 그대로)', async () => {
        const flat = async b => (await pdfParse(b)).text.replace(/\s+/g, '');
        const on = await flat((await render({ kind: 'record', ...SIGN })).buf);
        const off = await flat((await render({ kind: 'record', ...SIGN, show_bib: 0 })).buf);
        expect(on).toContain('배번254');
        expect(off).not.toContain('배번');
        expect(off).toContain('남자·초3학년부·한국초등학교');
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

describe('기록증 — 워터마크 위치 (watermark_anchor)', () => {
    const WM = { kind: 'record', ...SIGN, watermark_image_path: WIDE };   // 워드마크 3000×364 → fit 상자에서 폭이 꽉 찬다
    /** 기록 칸 가운데 — 패널 둥근 사각형의 첫 점(px+12 = 119.64, panelTop) 에서 잰다 (2행: 높이 96) */
    const panelCenter = (c) => { const m = c.match(/\n119\.64 ([\d.]+) m\n/); expect(m).toBeTruthy(); return +m[1] + 48; };
    const wmOf = (c, w) => images(c).find(i => near(i.w, w, 0.1));
    it('기본(panel): 워터마크 가운데 = 기록 칸 가운데 (예전처럼 종이 가운데 420.9 에 두면 내려간 기록 칸의 윗변에 걸친다)', async () => {
        const { c } = await render(WM);
        const wm = wmOf(c, W * 0.45); expect(wm).toBeTruthy();
        expect(near(wm.cy, panelCenter(c))).toBe(true);
        expect(near(wm.cx, W / 2)).toBe(true);
        expect(wm.cy).toBeGreaterThan(H / 2 + 40);
    });
    it('page: 종이 가운데(예전 위치) · fit: 칸 폭 −40(340) 안에 맞춰 줄이고 칸 가운데', async () => {
        const p = await render({ ...WM, watermark_anchor: 'page' });
        expect(near(wmOf(p.c, W * 0.45).cy, H / 2)).toBe(true);
        const f = await render({ ...WM, watermark_anchor: 'fit' });
        const wm = wmOf(f.c, 340); expect(wm).toBeTruthy();
        expect(wm.h).toBeLessThanOrEqual(88);                    // panelH 96 − 8
        expect(near(wm.cy, panelCenter(f.c))).toBe(true);
        expect(near(wm.cx, W / 2)).toBe(true);
    });
    it('모르는 값은 panel 로, 상장(award)은 값과 무관하게 종이 가운데', async () => {
        const { c } = await render({ ...WM, watermark_anchor: 'nope' });
        expect(near(wmOf(c, W * 0.45).cy, panelCenter(c))).toBe(true);
        const a = await render({ kind: 'award', ...SIGN, watermark_image_path: WIDE, watermark_anchor: 'panel' }, { ...DATA, rank: 1 });
        expect(near(wmOf(a.c, W * 0.45).cy, H / 2)).toBe(true);
    });
});

describe('발급자 글자 + 인장 묶음 가운데', () => {
    const SEAL = '/icons/icon-192.png';   // 정사각 → fit 44·50 그대로 그려진다
    const ONE = '경기도육상연맹  회장  이 윤 진';   // signer_inline=1 의 한 줄 글자
    it('기록증 한 줄 발급자 + 인장: 글자 왼쪽 끝 ~ 인장 오른쪽 끝의 가운데가 종이 가운데 (예전엔 글자만 가운데, 인장은 오른쪽에 덧붙음)', async () => {
        const { c } = await render({ kind: 'record', ...SIGN, seal_image_path: SEAL, signer_inline: 1 });
        const line = texts(c).filter(t => t.size === 18); expect(line.length).toBe(1);
        const seal = images(c).find(i => near(i.w, 44, 0.1) && near(i.h, 44, 0.1)); expect(seal).toBeTruthy();
        expect(near(seal.x, line[0].x + textWidth(FONT_B, 18, ONE) + 8)).toBe(true);   // 글자 바로 오른쪽 8pt
        expect(near((line[0].x + seal.x + 44) / 2, W / 2)).toBe(true);
        expect(line[0].x).toBeLessThan(191);   // 예전(글자만 가운데) x ≈ 191.3 보다 왼쪽
    });
    it('인장이 없으면 글자만 가운데 (예전 그대로)', async () => {
        const { c } = await render({ kind: 'record', ...SIGN, seal_image_path: '', signer_inline: 1 });
        const line = texts(c).filter(t => t.size === 18)[0];
        expect(near(line.x + textWidth(FONT_B, 18, ONE) / 2, W / 2)).toBe(true);
    });
    it('상장 두 줄: 이름 줄은 글자+인장(50) 묶음 가운데, 단체명 줄은 글자만 가운데', async () => {
        const { c } = await render({ kind: 'award', ...SIGN, seal_image_path: SEAL }, { ...DATA, rank: 1 });
        const ls = texts(c).filter(t => t.size === 20 && t.base > 640); expect(ls.length).toBe(2);
        const seal = images(c).find(i => near(i.w, 50, 0.1)); expect(seal).toBeTruthy();
        expect(near(ls[0].x + textWidth(FONT_B, 20, '경기도육상연맹') / 2, W / 2)).toBe(true);
        expect(near(seal.x, ls[1].x + textWidth(FONT_B, 20, '회장  이 윤 진') + 8)).toBe(true);
        expect(near((ls[1].x + seal.x + 50) / 2, W / 2)).toBe(true);
    });
    it("상장 인장 없음: 글자 + '(인)' 묶음 가운데", async () => {
        const { c } = await render({ kind: 'award', ...SIGN, seal_image_path: '', signer_inline: 1 }, { ...DATA, rank: 1 });
        const t = texts(c);
        const name = t.find(x => x.size === 20 && x.base > 640), inz = t.find(x => x.size === 14 && x.base > 640);
        expect(name && inz).toBeTruthy();
        expect(near(inz.x, name.x + textWidth(FONT_B, 20, ONE) + 10)).toBe(true);
        expect(near((name.x + inz.x + textWidth(FONT_R, 14, '(인)')) / 2, W / 2)).toBe(true);
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
        expect(Number(t.show_body)).toBe(1); expect(Number(t.show_bib)).toBe(1); expect(Number(t.signer_inline)).toBe(0);
        expect(Number(t.font_scale)).toBe(1); expect(Number(t.logo_scale)).toBe(1);
        expect(t.watermark_anchor).toBe('panel');
        expect((await post({ watermark_anchor: 'weird' })).body.template.watermark_anchor).toBe('panel');   // 모르는 값은 기본
    });
    it('값을 주면 저장되고, PUT 은 준 것만 바꾸며 범위 밖은 잘라낸다', async () => {
        const r = await post({ show_body: 0, show_bib: 0, signer_inline: 1, font_scale: 1.25, logo_scale: 1.6, watermark_anchor: 'fit' });
        expect(r.status).toBe(200);
        let t = r.body.template;
        expect(t.watermark_anchor).toBe('fit');
        expect(Number(t.show_body)).toBe(0); expect(Number(t.show_bib)).toBe(0); expect(Number(t.signer_inline)).toBe(1);
        expect(Number(t.font_scale)).toBeCloseTo(1.25, 5); expect(Number(t.logo_scale)).toBeCloseTo(1.6, 5);
        const u = await request(app).put(`/api/admin/certificate-templates/${t.id}`).send({ admin_key: ADMIN, font_scale: 9, logo_scale: 0.1 });
        expect(u.status).toBe(200);
        t = u.body.template;
        expect(Number(t.font_scale)).toBeCloseTo(1.3, 5); expect(Number(t.logo_scale)).toBeCloseTo(0.5, 5);
        expect(Number(t.show_body)).toBe(0); expect(Number(t.show_bib)).toBe(0); expect(Number(t.signer_inline)).toBe(1);   // 안 준 것은 그대로
        expect(t.watermark_anchor).toBe('fit');
        const bad = await request(app).put(`/api/admin/certificate-templates/${t.id}`).send({ admin_key: ADMIN, watermark_anchor: 'weird' });
        expect(bad.body.template.watermark_anchor).toBe('fit');     // 모르는 값은 그대로 둔다
        const pg = await request(app).put(`/api/admin/certificate-templates/${t.id}`).send({ admin_key: ADMIN, watermark_anchor: 'page' });
        expect(pg.body.template.watermark_anchor).toBe('page');
        const g = await request(app).get(`/api/admin/certificate-templates/${t.id}`).query({ admin_key: ADMIN });
        expect(Number(g.body.template.font_scale)).toBeCloseTo(1.3, 5);
        expect(g.body.template.watermark_anchor).toBe('page');
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
