#!/usr/bin/env node
'use strict';
/**
 * WaveLight 연동 문서 2종 → PDF (2026-11-21)
 *   docs/wavelight/protocol.html  →  WaveLight_프로토콜_분석서.pdf
 *   docs/wavelight/design.html    →  WaveLight_연동_구조_설계서.pdf
 *   본문은 HTML 조각(제목·표·그림), 여기서 표지·글꼴·쪽 번호를 입혀 A4 세로 PDF 로 낸다(헤드리스 크롬).
 *   node scripts/wavelight-docs/build.js [출력 폴더]      (기본: ~/Desktop/WaveLight_증빙_2026-11-21/문서)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..', '..');
const OUT = process.argv[2] || path.join(os.homedir(), 'Desktop', 'WaveLight_증빙_2026-11-21', '문서');
const FONT = f => pathToFileURL(path.join(ROOT, 'scripts', 'catalog', 'fonts', f)).href;

const DOCS = [
    { src: 'protocol.html', out: 'WaveLight_프로토콜_분석서.pdf', title: 'WaveLight 컨트롤러 프로토콜 분석서', sub: '페이싱 라이트 연동을 위한 컨트롤러 통신 방식 분석' },
    { src: 'design.html', out: 'WaveLight_연동_구조_설계서.pdf', title: 'WaveLight 연동 구조 설계서', sub: '페이싱 시나리오 자동 생성·전송 모듈과 실시간 동기화 제어·통합 운영 콘솔' },
];

const CSS = `
@font-face{font-family:'Pretendard Std';font-weight:400;src:url('${FONT('PretendardStd-Regular.woff2')}') format('woff2')}
@font-face{font-family:'Pretendard Std';font-weight:600;src:url('${FONT('PretendardStd-SemiBold.woff2')}') format('woff2')}
@font-face{font-family:'Pretendard Std';font-weight:700;src:url('${FONT('PretendardStd-Bold.woff2')}') format('woff2')}
@page { size: A4; margin: 20mm 18mm 20mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { background:#fff; }
body { margin:0; font: 10.5pt/1.65 'Pretendard Std', 'Apple SD Gothic Neo', sans-serif; color:#0E0E10; }
.cover { height: 250mm; display:flex; flex-direction:column; justify-content:center; page-break-after: always; }
.cover .brand { font-weight:700; font-size:11pt; letter-spacing:.08em; color:#C24A2E; margin-bottom:28mm; }
.cover h1 { font-size:26pt; line-height:1.25; margin:0 0 6mm; }
.cover .sub { font-size:12pt; color:#6D6A64; margin:0 0 28mm; }
.cover table { width:auto; font-size:10.5pt; border:0; } .cover td { border:0; padding:1.2mm 8mm 1.2mm 0; } .cover td:first-child { color:#6D6A64; }
h2 { font-size:14pt; margin: 9mm 0 3mm; padding-bottom:1.5mm; border-bottom:1.5px solid #0E0E10; break-after: avoid; }
h2:first-of-type { margin-top:0; }
h3 { font-size:11.5pt; margin: 6mm 0 2mm; break-after: avoid; }
p { margin: 0 0 2.5mm; } ul, ol { margin: 0 0 3mm; padding-left: 5.5mm; } li { margin-bottom: 1mm; }
table { width:100%; border-collapse:collapse; margin: 2mm 0 4mm; font-size:9.5pt; break-inside: avoid; }
th { background:#F4F3EF; text-align:left; font-weight:600; padding:1.8mm 2.5mm; border:1px solid #D6D3CB; }
td { padding:1.8mm 2.5mm; border:1px solid #D6D3CB; vertical-align:top; }
code, pre { font-family: Menlo, Consolas, monospace; font-size:8.8pt; }
code { background:#F4F3EF; padding:0 1.2mm; border-radius:2px; }
pre { background:#F4F3EF; border:1px solid #D6D3CB; border-radius:4px; padding:3mm; margin:2mm 0 4mm; white-space:pre-wrap; word-break:break-all; line-height:1.5; break-inside: avoid; }
.note { border-left:3px solid #C24A2E; padding:1.5mm 0 1.5mm 4mm; margin:3mm 0; color:#3a3936; }
figure { margin: 3mm 0 5mm; break-inside: avoid; } figcaption { font-size:9pt; color:#6D6A64; margin-top:1.5mm; }
svg { width:100%; height:auto; display:block; }
svg text { font-family:'Pretendard Std', sans-serif; }
.small { font-size:9pt; color:#6D6A64; }
`;

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await puppeteer.launch({ headless: 'new' });
    for (const d of DOCS) {
        const body = fs.readFileSync(path.join(ROOT, 'docs', 'wavelight', d.src), 'utf8');
        const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${d.title}</title><style>${CSS}</style></head><body>
<section class="cover"><div class="brand">PACE RISE : Node</div><h1>${d.title}</h1><p class="sub">${d.sub}</p>
<table><tr><td>문서 버전</td><td>1.0</td></tr><tr><td>작성일</td><td>2026년 11월 21일</td></tr><tr><td>대상 장비</td><td>Wavelight event tool 5.0 (하드웨어 5.00, 한 바퀴 조명 400개)</td></tr><tr><td>작성</td><td>PACE RISE</td></tr></table></section>
${body}</body></html>`;
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready);
        const out = path.join(OUT, d.out);
        await page.pdf({
            path: out, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: `<div style="width:100%;font-size:8px;color:#8A867E;padding:0 18mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>${d.title}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
        });
        const pages = (fs.readFileSync(out).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
        console.log('→', out, `(${pages}쪽)`);
        if (process.argv.includes('--png')) {
            await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1.5 });
            await page.emulateMediaType('print');
            await page.screenshot({ path: out.replace(/\.pdf$/, '_미리보기.png'), fullPage: true });
        }
        await page.close();
    }
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
