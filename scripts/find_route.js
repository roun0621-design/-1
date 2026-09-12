// 진행중 대회 카드 클릭 → 이동 URL 확인
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('https://pace-rise-node.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // 진행중 대회 카드(RECENT 안의 대회명) 클릭
  try {
    const card = await page.locator('text=KAAF배 제54회').first();
    await card.click({ timeout: 8000 });
    await page.waitForTimeout(4000);
    console.log('after card click url =', page.url());
    // 내부 메뉴/탭 텍스트 수집
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('button, a, [role=tab], .tab, nav *')).map(e => (e.innerText||'').trim()).filter(t => t && t.length < 20));
    console.log('TABS/BUTTONS:', [...new Set(tabs)].slice(0, 40).join(' | '));
  } catch (e) { console.log('click err', e.message); }
  await browser.close();
})();
