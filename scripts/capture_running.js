// 로컬 앱 구동 화면 캡처 (현재 동작 중인 서버 3999)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'evidence', 'app_running');
fs.mkdirSync(OUT, { recursive: true });

const JOBS = [
  { key: 'home',     path: '/',             vw: 1440, vh: 900,  label: '메인 홈' },
  { key: 'monitor',  path: '/monitor.html', vw: 1440, vh: 900,  label: '경기 모니터' },
  { key: 'login',    path: '/login.html',   vw: 1440, vh: 900,  label: '로그인' },
  { key: 'home_mob', path: '/',             vw: 390,  vh: 844,  label: '메인(모바일)', mobile:true },
];

(async () => {
  const browser = await chromium.launch();
  for (const j of JOBS) {
    const ctx = await browser.newContext({ viewport:{width:j.vw,height:j.vh}, deviceScaleFactor:2, isMobile:!!j.mobile });
    const page = await ctx.newPage();
    const url = `http://localhost:3999${j.path}`;
    try { await page.goto(url, { waitUntil:'networkidle', timeout:20000 }); }
    catch(e){ try { await page.goto(url, { waitUntil:'domcontentloaded', timeout:12000 }); } catch(_){} }
    await page.waitForTimeout(2200);
    const file = path.join(OUT, `${j.key}.png`);
    await page.screenshot({ path:file, fullPage:false });
    console.log(`✓ ${j.label} -> ${path.basename(file)}`);
    await ctx.close();
  }
  await browser.close();
})();
