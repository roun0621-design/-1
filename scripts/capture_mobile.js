// 모바일(PWA) 뷰 캡처 — iPhone 형태 뷰포트
// 사용: node scripts/capture_mobile.js <url> <out> [waitSel]
const { chromium, devices } = require('playwright');
const url = process.argv[2];
const out = process.argv[3];
const waitSel = process.argv[4] || '';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const iphone = devices['iPhone 13 Pro'];
  const context = await browser.newContext({ ...iphone });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try { const wk = String(Date.now()+30*864e5); localStorage.setItem('pace_push_home_dismiss', wk); localStorage.setItem('pace_push_toggle_dismiss', wk); } catch(e){}
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (waitSel) { try { await page.waitForSelector(waitSel, { timeout: 15000 }); } catch(e){} }
  await page.waitForTimeout(4500);
  // 팝업 닫기
  for (const sel of ['text=닫기', 'button:has-text("닫기")', '.pr-push-ghost']) {
    try { const el = page.locator(sel).first(); if (await el.isVisible({timeout:400})) { await el.click({timeout:1200}); await page.waitForTimeout(600); } } catch(e){}
  }
  await page.waitForTimeout(3500);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log('saved', out, '(mobile)');
})();
