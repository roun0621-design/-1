/**
 * 상장·기록증 PDF — 워터마크 그리기 순서 (2026-11-05)
 *
 * 사용자 지적: "워터마크를 넣었는데도 가운데 기록 칸 때문에 뒤의 워터마크가 안 보인다."
 *   기록증(record) 레이아웃이 워터마크 → 기록 패널(기본 불투명) 순서로 그려 패널이 가운데 워터마크를 통째로 가렸다.
 *   이제 패널 바탕 → 워터마크 → 글자 순서다. 이 테스트는 PDF 콘텐츠 스트림의 연산자 순서로 그 순서를 못 박는다.
 *   (pdfkit 은 스트림을 FlateDecode 로 압축하므로 풀어서 본다. 패널 바탕 = fillAndStroke 의 'B', 이미지 = 'Do', 글자 = 'BT')
 */
const zlib = require('zlib');
const { generateCertificatePdf } = require('../../lib/certificatePdf');

// 양식의 이미지 경로는 웹 경로(/uploads/…, /brand/…) — resolveImagePath 가 public/ 아래로 푼다. 맥 절대경로는 통하지 않는다.
const WM = '/brand/pacerise-mark.png';
const DATA = { athlete_name: '홍길동', team: '소속명', bib_number: '1234', gender: 'M', division: '중등부', event_name: '100m', rank: 1, record_value: '10.32', wind: 1.2, competition_name: '제00회 대회' };

/** 페이지 콘텐츠 스트림(글자 연산자 BT 가 든 스트림)을 풀어서 돌려준다 */
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
const firstOp = (c, op) => { const m = c.match(new RegExp('(^|\\n)' + op + '\\n')); return m ? m.index : -1; };

describe('기록증(record) — 기록 패널 바탕 → 워터마크 → 글자 순서', () => {
    it('워터마크(Do)가 패널 바탕(B) 뒤, 첫 글자(BT) 앞에 그려진다 — 불투명 패널이 워터마크를 가리지 않는다', async () => {
        const tpl = { kind: 'record', watermark_image_path: WM, watermark_opacity: 0.07, watermark_scale: 0.5, panel_opacity: 1 };
        const c = pageContent(await generateCertificatePdf(tpl, DATA));
        const iPanel = firstOp(c, 'B'), iImg = c.indexOf(' Do\n'), iText = firstOp(c, 'BT');
        expect(iPanel).toBeGreaterThan(-1); expect(iImg).toBeGreaterThan(-1); expect(iText).toBeGreaterThan(-1);
        expect(iPanel).toBeLessThan(iImg);
        expect(iImg).toBeLessThan(iText);
    });
    it('워터마크가 없어도 기록증은 그대로 만들어진다 (이미지 없음, 패널·글자 있음)', async () => {
        const c = pageContent(await generateCertificatePdf({ kind: 'record', panel_opacity: 1 }, DATA));
        expect(c.indexOf(' Do\n')).toBe(-1);
        expect(firstOp(c, 'B')).toBeGreaterThan(-1);
        expect(firstOp(c, 'B')).toBeLessThan(firstOp(c, 'BT'));
    });
});

describe('상장(award) — 워터마크는 글자 아래', () => {
    it('워터마크(Do)가 첫 글자(BT) 앞에 그려진다', async () => {
        const tpl = { kind: 'award', watermark_image_path: WM, watermark_opacity: 0.07 };
        const c = pageContent(await generateCertificatePdf(tpl, DATA));
        const iImg = c.indexOf(' Do\n'), iText = firstOp(c, 'BT');
        expect(iImg).toBeGreaterThan(-1);
        expect(iImg).toBeLessThan(iText);
    });
});
