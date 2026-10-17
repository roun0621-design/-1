// 테이블 셀 안의 클릭요소를 텍스트로 찾아 클릭 → 모달 캡처
// 사용: node scripts/capture_cell.js <url> <out> <cellText> [w] [h]
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3];
const cellText = process.argv[4]; // 명단/결과/예선/결승
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
  const clicked = await page.evaluate((txt) => {
    // onclick 가진 span/a 중 텍스트가 정확히 일치하는 첫 요소 클릭
    const cands = Array.from(document.querySelectorAll('[onclick]'));
    const el = cands.find(e => (e.innerText||'').trim() === txt) || cands.find(e => (e.innerText||'').trim().includes(txt) && (e.innerText||'').trim().length < txt.length + 4);
    if (el) { el.click(); return el.getAttribute('onclick'); }
    return null;
  }, cellText);
  console.log('clicked onclick =', clicked);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log('saved', out);
})();
