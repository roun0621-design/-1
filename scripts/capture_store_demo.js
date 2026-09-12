// ============================================================
// 앱스토어 / PWA manifest 용 스크린샷 캡처 (가상 데이터 버전)
// ------------------------------------------------------------
// ※ 실제 운영 사이트(www.pace-rise-node.com)의 UI/CSS 를 그대로 사용하되,
//    화면에 표시되는 모든 대회명/선수명/소속/기록 등은 개인정보 보호를 위해
//    전부 허구(가상)로 치환합니다. 실제 존재하는 팀/선수/대회가 아닙니다.
// ※ Uses the live app UI/CSS, but ALL displayed competition / athlete / team /
//    record data is replaced with entirely fictional values (no real PII).
//
// 출력 크기:
//   - wide        1280x720   (PWA manifest, 데스크탑/태블릿)
//   - narrow       750x1334  (PWA manifest, 모바일)
//   - iPhone 6.5"  1284x2778 (App Store Connect)
//   - iPhone 5.5"  1242x2208 (App Store Connect)
//
// 캡처 화면: ① 메인(대회 목록) ② 대시보드+결승 결과 ③ 대시보드+참가선수 명단
// 사용: node scripts/capture_store_demo.js
// ============================================================
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const FAKE = require('./fake_data');

const OUT_DIR = path.join(__dirname, '..', 'evidence', '스토어스크린샷');
fs.mkdirSync(OUT_DIR, { recursive: true });
const BASE = 'https://www.pace-rise-node.com';

const SIZES = [
  { name: 'wide_1280x720',      w: 1280, h: 720,  mobile: false },
  { name: 'narrow_750x1334',    w: 750,  h: 1334, mobile: true  },
  { name: 'iphone65_1284x2778', w: 1284, h: 2778, mobile: true  },
  { name: 'iphone55_1242x2208', w: 1242, h: 2208, mobile: true  },
];

const DISMISS = () => {
  try {
    const wk = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
    localStorage.setItem('pace_push_home_dismiss', wk);
    localStorage.setItem('pace_push_toggle_dismiss', wk);
  } catch (e) {}
};

async function closePopups(page) {
  for (const sel of ['text=닫기', 'text=나중에', 'button:has-text("닫기")', '[aria-label="close"]', '.modal-close', '.close']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 })) { await el.click({ timeout: 1200 }); await page.waitForTimeout(500); }
    } catch (e) {}
  }
  try { await page.keyboard.press('Escape'); } catch (e) {}
}

function ctxOpts(size) {
  return {
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: 1,
    isMobile: size.mobile,
    hasTouch: size.mobile,
    userAgent: size.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      : undefined,
  };
}

// ── 브라우저 내부에서 실행될 주입 함수들 (page.evaluate 로 전달) ──

const FN_injectCompTitle = (comp) => {
  const cand = [...document.querySelectorAll('div, h1, h2, h3, span')].find(e =>
    /전국육상|코리아오픈|선수권/.test(e.textContent || '') &&
    (e.textContent || '').length < 140 && e.children.length <= 4);
  if (cand) {
    cand.innerHTML = `${comp.title} &nbsp;<span style="display:inline-block;background:#b79f58;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;vertical-align:middle;">${comp.badge}</span> &nbsp;|&nbsp; ${comp.dateRange} &nbsp;|&nbsp; ${comp.venue}`;
  }
};

const FN_showTrack = (R) => {
  const overlay = document.getElementById('result-overlay');
  const panel = document.getElementById('result-panel');
  if (!overlay || !panel) return false;
  const rows = R.rows.map(r => `<tr>
      <td>${r.sc ? `<span class="sc-badge sc-${r.sc}">${r.sc}</span>` : r.rank}</td>
      <td>${r.lane}</td><td>${r.bib}</td>
      <td style="text-align:left;">${r.name}</td>
      <td style="text-align:left;font-size:11px;">${r.team}</td>
      <td style="font-family:monospace;font-weight:600;">${r.sc ? `<span class="sc-badge sc-${r.sc}">${r.sc}</span>` : r.time}</td>
      <td style="font-size:11px;color:#666;">${r.remark || ''}</td>
    </tr>`).join('');
  const body = `<h4 style="margin:12px 0 6px;">결승 <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">풍속: ${R.wind} m/s</span></h4>
    <table class="data-table" style="font-size:13px;">
      <thead><tr><th>순위</th><th>레인</th><th>BIB</th><th style="text-align:left;">선수명</th><th style="text-align:left;">소속</th><th>기록</th><th>비고</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  panel.innerHTML = `<div class="result-panel-header"><h3>${R.eventTitle}</h3><button class="result-panel-close">&times;</button></div><div class="result-panel-body">${body}</div>`;
  overlay.classList.add('show');
  return true;
};

const FN_showRoster = (RO) => {
  const overlay = document.getElementById('result-overlay');
  const panel = document.getElementById('result-panel');
  if (!overlay || !panel) return false;
  const rows = RO.rows.map(a => `<tr style="border-bottom:1px solid #f0f0f0;">
      <td style="padding:8px 4px;text-align:center;font-weight:700;color:#b79f58;">${a.lane}</td>
      <td style="padding:8px 4px;text-align:center;font-weight:700;">${a.bib}</td>
      <td style="padding:8px 12px;font-weight:600;">${a.name}</td>
      <td style="padding:8px 12px;color:#555;">${a.team}</td>
    </tr>`).join('');
  const body = `<div style="margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;padding:6px 10px;background:#f5f5f5;border-radius:4px;margin-bottom:6px;">예선 — ${RO.rows.length}명</div>
      <div style="font-size:12px;font-weight:700;color:#b79f58;padding:5px 10px;margin-top:8px;margin-bottom:4px;background:#f8f4ea;border-radius:4px;display:flex;justify-content:space-between;"><span>${RO.heatLabel}</span><span style="color:#888;font-weight:500;">${RO.rows.length}명</span></div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <colgroup><col style="width:50px"><col style="width:60px"><col style="width:auto"><col style="width:40%"></colgroup>
        <thead><tr style="border-bottom:2px solid #e5e7eb;">
          <th style="padding:8px 4px;text-align:center;font-size:11px;color:#888;">레인</th>
          <th style="padding:8px 4px;text-align:center;font-size:11px;color:#888;">배번</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;">성명</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;">소속</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
  panel.innerHTML = `<div class="result-panel-header"><h3>${RO.eventTitle}</h3><button class="result-panel-close">&times;</button></div><div class="result-panel-body">${body}</div>`;
  overlay.classList.add('show');
  return true;
};

const FN_injectMain = (list) => {
  const labels = ['대한육상연맹', '한국실업육상연맹', '한국대학육상연맹', '대한장애인'];
  let idx = 0;
  document.querySelectorAll('*').forEach(el => {
    if (el.children.length > 3) return;
    const t = (el.textContent || '').trim();
    for (const lb of labels) {
      if (t === lb || (t.includes(lb) && t.length < lb.length + 6)) {
        if (list[idx]) { el.textContent = list[idx].name; idx++; }
      }
    }
  });
  // RECENT 진행중 대회 카드 제목 (.comp-card-name) 치환
  document.querySelectorAll('.comp-card-name, .comp-name').forEach(el => {
    el.textContent = '제1회 페이스라이즈 오픈 육상경기대회';
  });
  // 카드 메타의 지역명(예천군 등) → 가상 장소로 치환
  document.querySelectorAll('.comp-card-info *, .comp-card *').forEach(el => {
    if (el.children.length === 0) {
      const t = (el.textContent || '').trim();
      if (t === '예천군' || t === '정선' || t === '정선군') el.textContent = '서울 가상스타디움';
    }
  });
};

// ── 캡처 헬퍼 ──
async function shot(page, size, key) {
  const file = path.join(OUT_DIR, `${size.name}__${key}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: size.w, height: size.h } });
  console.log('saved', path.basename(file), `${size.w}x${size.h}`);
}

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const size of SIZES) {
    // ① 메인(대회 목록)
    {
      const ctx = await browser.newContext(ctxOpts(size));
      await ctx.addInitScript(DISMISS);
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // RECENT 카드가 비동기로 로드되므로 .comp-card-name 등장까지 대기
        try { await page.waitForSelector('.comp-card-name', { timeout: 15000 }); } catch (e) {}
        await page.waitForTimeout(4500);
        await closePopups(page);
        await page.waitForTimeout(700);
        // 가상 데이터 주입 → 늦은 re-render 대비 한 번 더 주입
        await page.evaluate(FN_injectMain, FAKE.competitionList);
        await page.waitForTimeout(1200);
        await page.evaluate(FN_injectMain, FAKE.competitionList);
        await page.waitForTimeout(500);
        await shot(page, size, 'main');
      } catch (e) { console.log('ERR main', size.name, e.message); }
      finally { await ctx.close(); }
    }
    // ② 대시보드 + 결승 결과
    {
      const ctx = await browser.newContext(ctxOpts(size));
      await ctx.addInitScript(DISMISS);
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}/dashboard.html?comp=50`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForSelector('.matrix-table', { timeout: 25000 }); } catch (e) {}
        await page.waitForTimeout(2500);
        await closePopups(page);
        await page.evaluate(FN_injectCompTitle, FAKE.competition);
        await page.waitForTimeout(300);
        const ok = await page.evaluate(FN_showTrack, FAKE.trackResult);
        if (!ok) console.log('  track inject failed', size.name);
        await page.waitForTimeout(900);
        await shot(page, size, 'result');
      } catch (e) { console.log('ERR result', size.name, e.message); }
      finally { await ctx.close(); }
    }
    // ③ 대시보드 + 참가선수 명단
    {
      const ctx = await browser.newContext(ctxOpts(size));
      await ctx.addInitScript(DISMISS);
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}/dashboard.html?comp=50`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForSelector('.matrix-table', { timeout: 25000 }); } catch (e) {}
        await page.waitForTimeout(2500);
        await closePopups(page);
        await page.evaluate(FN_injectCompTitle, FAKE.competition);
        await page.waitForTimeout(300);
        const ok = await page.evaluate(FN_showRoster, FAKE.roster);
        if (!ok) console.log('  roster inject failed', size.name);
        await page.waitForTimeout(900);
        await shot(page, size, 'roster');
      } catch (e) { console.log('ERR roster', size.name, e.message); }
      finally { await ctx.close(); }
    }
  }
  await browser.close();
  console.log('DONE ->', OUT_DIR);
}

run().catch(e => { console.error(e); process.exit(1); });
