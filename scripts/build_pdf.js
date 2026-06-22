// 증빙 자료 통합 PDF 생성 (표지 + 6개 항목)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EV = path.join(__dirname, '..', 'evidence');
const OUT = path.join(EV, '증빙자료_PACE-RISE_2026-06-22.pdf');

// 각 증빙 이미지를 A4 페이지에 배치하는 HTML 생성
function imgPage(file, title) {
  return `
  <div class="page">
    <div class="ph">${title}</div>
    <div class="imgwrap"><img src="${file}"></div>
  </div>`;
}

const items = [
  ['01_app_build_guide.png',          '① 앱 프로젝트 · 빌드 가이드 및 로컬 구동 화면'],
  ['02_aws_architecture.png',         '② AWS 클라우드 구성도 및 콘솔 캡처 가이드'],
  ['03_migration_verification.png',   '③ SQLite → PostgreSQL 데이터 이관 검증'],
  ['04_https.png',                    '④ HTTPS(SSL/TLS) 적용 증빙'],
  ['05_web_before_after.png',         '⑤ 웹 개편 전 · 후 비교 화면'],
  ['05b_web_improvement_detail.png',  '⑥ 웹 시스템 고도화 — 작업 내역 및 개선 효과 상세'],
  ['07_source_delivery.png',          '⑦ 소스코드 일체 납품 · 소유권 인계 증빙'],
  ['08_per_concurrency.png',          '⑧ 다수 동시접속 성능 · 실 운영 근거 (PER-001)'],
  ['09_ter_ios_pwa.png',              '⑨ iOS 실기기 구동 증빙 (TER-001)'],
];

const body = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
  <link rel="stylesheet" href="fonts/audiowide_face.css"><style>
  @page { size: A4; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Noto Sans CJK KR','NanumSquare','Malgun Gothic',sans-serif; color:#111111; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .page { width:210mm; min-height:297mm; padding:10mm 8mm; page-break-after:always; display:flex; flex-direction:column; background:#ffffff; }
  .ph { font-size:12pt; font-weight:800; color:#000000; padding:4mm 5mm; border-left:5px solid #111111; border:1px solid #111111; border-left:5px solid #111111; background:#ffffff; border-radius:4px; margin-bottom:5mm; }
  .imgwrap { flex:1; display:flex; justify-content:center; align-items:flex-start; }
  .imgwrap img { max-width:100%; height:auto; border:1px solid #cccccc; border-radius:6px; }
</style></head><body>
  ${items.map(([f,t]) => imgPage(f, t)).join('')}
</body></html>`;

const TMP = path.join(EV, '_pdf_body.html');
fs.writeFileSync(TMP, body, 'utf-8');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 1) 표지+목차 PDF
  await page.goto('file://' + path.join(EV, 'cover.html'), { waitUntil:'networkidle' });
  await page.waitForTimeout(500);
  const coverPdf = path.join(EV, '_cover.pdf');
  await page.pdf({ path: coverPdf, format:'A4', printBackground:true });

  // 2) 본문 PDF
  await page.goto('file://' + TMP, { waitUntil:'networkidle' });
  await page.waitForTimeout(800);
  const bodyPdf = path.join(EV, '_body.pdf');
  await page.pdf({ path: bodyPdf, format:'A4', printBackground:true });

  await browser.close();
  console.log('cover.pdf + body.pdf 생성 완료');
})();
