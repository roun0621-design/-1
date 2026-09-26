const { chromium } = require('playwright');
const path = require('path');
const file = process.argv[2];
const out = process.argv[3];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setViewportSize({ width: 2000, height: 1200 });
  await page.goto('file://' + path.resolve(file), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log('saved', out);
})();
