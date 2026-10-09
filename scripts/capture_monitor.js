// 모니터/대시보드 화면 단독 캡처 (before 4200 / after 3999)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'evidence', 'web_before_after');
fs.mkdirSync(OUT, { recursive: true });

const JOBS = [
  { key: 'monitor', path: '/monitor.html', tag: 'before', port: 4200, vw: 1440, vh: 900 },
  { key: 'monitor', path: '/monitor.html', tag: 'after',  port: 3999, vw: 1440, vh: 900 },
];

(async () => {
  const browser = await chromium.launch();
  for (const j of JOBS) {
    const ctx = await browser.newContext({ viewport: { width: j.vw, height: j.vh }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const url = `http://localhost:${j.port}${j.path}`;
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }); }
    catch (e) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }); } catch (_) {} }
    await page.waitForTimeout(2500);
    const file = path.join(OUT, `${j.key}_desktop_${j.tag}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`✓ ${j.key} ${j.tag} -> ${path.basename(file)}`);
    await ctx.close();
  }
  await browser.close();
})();
