// JS 함수 직접 호출 후 모달 캡처
// 사용: node scripts/capture_fn.js <url> <out> <jsExpr> [w] [h]
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3];
const jsExpr = process.argv[4]; // 예: "openTimetable()"
const width = parseInt(process.argv[5] || '1500', 10);
const height = parseInt(process.argv[6] || '1050', 10);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    try { const wk = String(Date.now()+30*864e5); localStorage.setItem('pace_push_home_dismiss', wk); localStorage.setItem('pace_push_toggle_dismiss', wk); } catch(e){}
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  try {
    await page.evaluate((expr) => { eval(expr); }, jsExpr);
    await page.waitForTimeout(3500);
  } catch (e) { console.log('fn err:', e.message); }
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log('saved', out, jsExpr);
})();
