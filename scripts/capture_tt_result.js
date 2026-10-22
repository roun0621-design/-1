// 시간표 모달 열기 → '결과' 배지 클릭 → 결과 상세 캡처
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3];
const width = parseInt(process.argv[4] || '1500', 10);
const height = parseInt(process.argv[5] || '1050', 10);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    try { const wk = String(Date.now()+30*864e5); localStorage.setItem('pace_push_home_dismiss', wk); localStorage.setItem('pace_push_toggle_dismiss', wk); } catch(e){}
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  // 시간표 열기
  try { await page.evaluate(() => openTimetable()); } catch(e) { console.log('openTimetable err', e.message); }
  await page.waitForTimeout(2500);
  // '결과' 텍스트 배지 클릭 (시간표 내)
  const clicked = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('[onclick]'));
    // 결과 배지: 텍스트가 '결과' 로 시작하는 작은 요소
    const el = cands.find(e => { const t=(e.innerText||'').trim(); return t === '결과' || t.startsWith('결과'); });
    if (el) { el.click(); return el.getAttribute('onclick'); }
    return null;
  });
  console.log('result badge onclick =', clicked);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log('saved', out);
})();
