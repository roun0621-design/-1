const { chromium } = require('playwright');
const url = process.argv[2];
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.addInitScript(() => {
    try { const wk = String(Date.now()+30*864e5); localStorage.setItem('pace_push_home_dismiss', wk); localStorage.setItem('pace_push_toggle_dismiss', wk); } catch(e){}
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  const info = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[onclick]')).slice(0, 12);
    return els.map(e => ({ tag: e.tagName, cls: e.className, txt: (e.innerText||'').trim().slice(0,12), onclick: (e.getAttribute('onclick')||'').slice(0,50) }));
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})();
