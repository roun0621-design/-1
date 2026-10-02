// 실제 운영 도메인 HTTPS 화면 캡처 (본인 소유 도메인)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'evidence', 'https');
fs.mkdirSync(OUT, { recursive: true });

const SITES = [
  { key: 'pace-rise',      url: 'https://pace-rise.com/' },
  { key: 'pace-rise-node', url: 'https://pace-rise-node.com/' },
];

(async () => {
  const browser = await chromium.launch({ args:['--ignore-certificate-errors=false'] });
  for (const s of SITES) {
    const ctx = await browser.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2 });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(s.url, { waitUntil:'networkidle', timeout:25000 });
      console.log(`${s.key}: HTTP ${resp ? resp.status() : '?'} | secure=${s.url.startsWith('https')}`);
    } catch(e){
      try { await page.goto(s.url,{waitUntil:'domcontentloaded',timeout:15000}); } catch(_){}
      console.log(`${s.key}: (networkidle timeout, domcontentloaded fallback)`);
    }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `${s.key}.png`), fullPage:false });
    console.log(`✓ ${s.key}.png`);
    await ctx.close();
  }
  await browser.close();
})();
