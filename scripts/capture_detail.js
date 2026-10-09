// 대시보드 진입 → 특정 버튼(명단/예선/결승 등) 클릭 → 상세 화면 캡처
// 사용: node scripts/capture_detail.js <url> <out.png> <buttonText> [width] [height]
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3];
const btnText = process.argv[4]; // 예: 결승, 명단, 예선
const width = parseInt(process.argv[5] || '1600', 10);
const height = parseInt(process.argv[6] || '1100', 10);

async function closePopups(page) {
  for (const sel of ['text=닫기', 'button:has-text("닫기")', '.modal-close', '.close']) {
    try { const el = page.locator(sel).first(); if (await el.isVisible({ timeout: 400 })) { await el.click({ timeout: 1200 }); await page.waitForTimeout(600); } } catch (e) {}
  }
  try { await page.keyboard.press('Escape'); } catch (e) {}
}

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
  await page.waitForTimeout(3500);
  await closePopups(page);
  await page.waitForTimeout(1000);
  // 첫번째 해당 텍스트 버튼 클릭
  try {
    const btn = page.locator(`button:has-text("${btnText}"), a:has-text("${btnText}")`).first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click({ timeout: 8000 });
    await page.waitForTimeout(3500);
    await closePopups(page);
    await page.waitForTimeout(1500);
  } catch (e) { console.log('btn click err:', e.message); }
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log('saved', out, 'btn=', btnText);
})();
