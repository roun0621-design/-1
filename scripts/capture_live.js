// 실제 운영 사이트(production) 화면을 가로형으로 캡처
// 사용: node scripts/capture_live.js <url> <out.png> [width] [height] [fullPage:0|1] [waitSel]
const { chromium } = require('playwright');

const url = process.argv[2];
const out = process.argv[3];
const width = parseInt(process.argv[4] || '1600', 10);
const height = parseInt(process.argv[5] || '1000', 10);
const fullPage = (process.argv[6] || '0') === '1';
const waitSel = process.argv[7] || '';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setViewportSize({ width, height });
  // 팝업 dismiss 키를 미리 주입 (alarm 팝업 차단)
  const origin = new URL(url).origin;
  await page.addInitScript(() => {
    try {
      const wk = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
      localStorage.setItem('pace_push_home_dismiss', wk);
      localStorage.setItem('pace_push_toggle_dismiss', wk);
    } catch (e) {}
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (waitSel) {
    try { await page.waitForSelector(waitSel, { timeout: 20000 }); } catch (e) { console.log('waitSel timeout:', waitSel); }
  }
  await page.waitForTimeout(3500);
  // 팝업/모달 닫기 (경기 알림 받기 등)
  for (const sel of ['text=닫기', 'text=나중에', 'button:has-text("닫기")', '[aria-label="close"]', '.modal-close', '.close']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) { await el.click({ timeout: 1500 }); await page.waitForTimeout(800); }
    } catch (e) {}
  }
  // ESC 도 한번
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out, fullPage });
  await browser.close();
  console.log('saved', out, `${width}x${height}`, fullPage ? 'fullPage' : 'viewport');
})();
