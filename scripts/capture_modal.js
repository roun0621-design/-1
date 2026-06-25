// 특정 행(nth)의 특정 버튼 클릭 → 모달 캡처
// 사용: node scripts/capture_modal.js <url> <out> <btnText> <nth> [w] [h]
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3];
const btnText = process.argv[4];
const nth = parseInt(process.argv[5] || '0', 10);
const width = parseInt(process.argv[6] || '1500', 10);
const height = parseInt(process.argv[7] || '1050', 10);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    try {
      const wk = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
      localStorage.setItem('pace_push_home_dismiss', wk);
      localStorage.setItem('pace_push_toggle_dismiss', wk);
    } catch (e) {}
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  try {
    const btns = page.locator(`button:has-text("${btnText}"), a:has-text("${btnText}"), span.round-btn:has-text("${btnText}"), .round-btn:has-text("${btnText}")`);
    const cnt = await btns.count();
    console.log('found', cnt, 'buttons for', btnText);
    const btn = btns.nth(Math.min(nth, cnt - 1));
    await btn.scrollIntoViewIfNeeded();
    await btn.click({ timeout: 8000 });
    await page.waitForTimeout(3500);
  } catch (e) { console.log('click err:', e.message); }
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log('saved', out);
})();
