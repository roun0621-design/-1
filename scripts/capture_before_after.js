// 웹 개편 전·후 화면 캡처 스크립트
// before = 포트 4200 (git ca3d736, 2026-02 초기 노출 시스템)
// after  = 포트 3999 (현재 main, 2026-06 개편 후)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'evidence', 'web_before_after');
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  { key: 'home',    path: '/',              label: '메인 홈' },
  { key: 'monitor', path: '/monitor.html',  label: '경기 모니터' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile',  width: 390,  height: 844 },
];

const SERVERS = [
  { tag: 'before', port: 4200 },
  { tag: 'after',  port: 3999 },
];

async function shoot(browser, server, target, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.name === 'mobile',
  });
  const page = await ctx.newPage();
  const url = `http://localhost:${server.port}${target.path}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
  } catch (e) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (_) {}
  }
  await page.waitForTimeout(2500); // 데이터 로드/렌더 대기
  const file = path.join(OUT, `${target.key}_${vp.name}_${server.tag}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`✓ ${target.label} [${vp.name}] ${server.tag} -> ${path.basename(file)}`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  for (const target of TARGETS) {
    for (const vp of VIEWPORTS) {
      for (const server of SERVERS) {
        await shoot(browser, server, target, vp);
      }
    }
  }
  await browser.close();
  console.log('\n캡처 완료 ->', OUT);
})();
