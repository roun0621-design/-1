// 사이트 내부 링크/라우트 탐색
const { chromium } = require('playwright');
const url = process.argv[2] || 'https://pace-rise-node.com/';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // 모든 anchor + 클릭가능 데이터속성 수집
  const links = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => out.push({t: (a.innerText||'').trim().slice(0,40), href: a.href}));
    return out;
  });
  console.log('=== ANCHORS ===');
  [...new Set(links.map(l => l.href))].forEach(h => console.log(h));
  console.log('=== current url ===', page.url());
  await browser.close();
})();
