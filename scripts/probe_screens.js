// 주요 화면을 모바일 뷰로 빠르게 캡처해 어떤 화면이 스크린샷에 적합한지 점검
const { chromium } = require('playwright');
const path = require('path');

const BASE = 'http://localhost:3999';
const OUT = path.join(__dirname, '..', 'playstore_assets', 'probe');
require('fs').mkdirSync(OUT, { recursive: true });

const targets = [
  ['index', '/'],
  ['dashboard', '/dashboard.html?comp=1'],
  ['results', '/results.html?comp=1'],
  ['open', '/open'],
  ['monitor', '/monitor.html?comp=1'],
  ['record', '/record.html?comp=1'],
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
  });
  for (const [name, url] of targets) {
    try {
      const page = await ctx.newPage();
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      console.log('OK', name, url);
      await page.close();
    } catch (e) {
      console.log('ERR', name, url, e.message.slice(0, 80));
    }
  }
  await browser.close();
})();
