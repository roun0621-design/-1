const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('https://pace-rise-node.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  // 카드 컨테이너 클릭 (force)
  try {
    const card = page.locator('.comp-card-name').first();
    await card.scrollIntoViewIfNeeded();
    await card.click({ force: true, timeout: 8000 });
    await page.waitForTimeout(4500);
    console.log('URL after card =', page.url());
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 600));
    console.log('--- body text ---\n', txt);
  } catch (e) { console.log('err1', e.message); }
  await browser.close();
})();
