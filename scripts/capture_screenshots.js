// Play Store 스크린샷 캡처 — 실제 앱 화면
// 휴대전화 / 7인치 태블릿 / 10인치 태블릿 3종 규격
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3999';
const ROOT = path.join(__dirname, '..', 'playstore_assets');

// 디바이스 프로필 (Play Store 권장)
// CSS 폭은 실제 기기처럼 좁게 두고 deviceScaleFactor 로 고해상도 픽셀을 만든다.
//   → 모바일/태블릿 반응형 레이아웃이 정상 적용됨
//   phone:    412 x 915  @2.62 ≈ 1080 x 2400 px
//   tablet7:  768 x 1024 @2.0  = 1536 x 2048 px (7~8인치 태블릿)
//   tablet10: 800 x 1280 @2.0  = 1600 x 2560 px (10인치 태블릿)
const DEVICES = {
  phone:    { dir: 'screenshots_phone',    width: 412, height: 915,  dsf: 2.62 },
  tablet7:  { dir: 'screenshots_tablet7',  width: 768, height: 1024, dsf: 2 },
  tablet10: { dir: 'screenshots_tablet10', width: 800, height: 1280, dsf: 2 },
};

// 캡처할 화면 시나리오
const SCENES = [
  { name: '01_competition_list', url: '/', wait: 3000 },
  { name: '02_live_dashboard',   url: '/dashboard.html?comp=1', wait: 3500 },
  { name: '03_callroom_monitor', url: '/monitor.html?comp=46', wait: 3500 },
  { name: '04_record_entry',     url: '/record.html?comp=1', wait: 3500 },
  {
    name: '05_event_result', url: '/dashboard.html?comp=1', wait: 3500,
    // 첫 번째 '결과' 버튼 클릭해서 결과 모달 띄우기
    action: async (page) => {
      try {
        const btn = page.locator('.round-btn-result').first();
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(2500);
      } catch (e) { /* 모달 없으면 그냥 대시보드 */ }
    }
  },
];

(async () => {
  const browser = await chromium.launch();
  for (const [devName, dev] of Object.entries(DEVICES)) {
    const outDir = path.join(ROOT, dev.dir);
    fs.mkdirSync(outDir, { recursive: true });
    const ctx = await browser.newContext({
      viewport: { width: dev.width, height: dev.height },
      deviceScaleFactor: dev.dsf,
    });
    for (const scene of SCENES) {
      try {
        const page = await ctx.newPage();
        await page.goto(BASE + scene.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(scene.wait);
        if (scene.action) await scene.action(page);
        // 뷰포트 고정 크기로 캡처 (fullPage 아님 — 규격 유지)
        await page.screenshot({ path: path.join(outDir, `${scene.name}.png`) });
        console.log(`OK [${devName}] ${scene.name}`);
        await page.close();
      } catch (e) {
        console.log(`ERR [${devName}] ${scene.name}: ${e.message.slice(0, 80)}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
  console.log('DONE');
})();
