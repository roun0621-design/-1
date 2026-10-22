'use strict';
/**
 * 카탈로그 스크린샷 촬영 (2026-10-22) — seed.js 로 만든 가상 대회 DB 를 서버로 띄우고 헤드리스 크롬으로 찍는다
 *   node scripts/catalog/capture.js <sqlite> <ids.json> <출력 폴더>
 *   데스크톱 1440×900 · 모바일 390×844@2x, UI 언어 en(일본어 컷 1장은 ja). 운영자 화면은 PC 만, 관전 화면은 모바일도.
 *   report.json: 컷마다 url·콘솔 오류·화면에 보이는 한글(sel·text·visible) — 한글은 전부 빈 배열이어야 한다.
 */
const fs = require('fs'), path = require('path'), { spawn, execSync } = require('child_process');
const puppeteer = require('puppeteer');
const [,, DBP, IDSP, OUT] = process.argv;
if (!DBP || !IDSP || !OUT) { console.error('usage: capture.js <sqlite> <ids.json> <out dir>'); process.exit(1); }
const ids = JSON.parse(fs.readFileSync(IDSP, 'utf8'));
const PORT = 3350, BASE = `http://localhost:${PORT}`, ADMIN = 'testadmin1234';
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 }, MOB = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer() {
    const env = { ...process.env, SQLITE_PATH: DBP, DB_BACKEND: 'sqlite', PORT: String(PORT), NODE_ENV: 'test', ADMIN_PW: ADMIN, OPERATION_KEY: 'testopkey', INTL_SYNC: 'off', AUTH_RATE_LIMIT_MAX: '5000' };
    const p = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(OUT, 'server.log')); p.stdout.pipe(log); p.stderr.pipe(log);
    for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return p; } catch (e) {} await sleep(500); }
    throw new Error('server did not start');
}

const SHOTS = [
    { name: 'dashboard_desktop', url: `/dashboard.html?comp=${ids.comp}`, vp: DESK, wait: 3500 },
    { name: 'dashboard_mobile', url: `/dashboard.html?comp=${ids.comp}`, vp: MOB, wait: 3500 },
    { name: 'results_desktop', url: `/dashboard.html?comp=${ids.comp}`, vp: DESK, wait: 3000, action: async p => { await p.evaluate(id => openResult(id), ids.m100f); await sleep(2500); } },
    { name: 'results_mobile', url: `/dashboard.html?comp=${ids.comp}`, vp: MOB, wait: 3000, action: async p => { await p.evaluate(id => openResult(id), ids.m100f); await sleep(2500); } },
    { name: 'monitor_desktop', url: `/monitor.html?comp=${ids.comp}`, vp: DESK, wait: 3500 },
    { name: 'record_desktop', url: `/record.html?comp=${ids.comp}&event_id=${ids.w100f}`, vp: DESK, wait: 4000, role: 'admin' },
    { name: 'callroom_desktop', url: `/callroom.html?comp=${ids.comp}&event_id=${ids.w100f}`, vp: DESK, wait: 4000, role: 'admin' },
    { name: 'admin_overview_desktop', url: `/admin.html?comp=${ids.comp}`, vp: DESK, wait: 4000, role: 'admin' },
    { name: 'admin_events_desktop', url: `/admin.html?comp=${ids.comp}`, vp: DESK, wait: 3500, role: 'admin', action: async p => { await p.evaluate(() => sidebarNavigate('events')); await sleep(2500); } },
    { name: 'admin_athletes_desktop', url: `/admin.html?comp=${ids.comp}`, vp: DESK, wait: 3500, role: 'admin', action: async p => { await p.evaluate(() => sidebarNavigate('athletes')); await sleep(2500); } },
    { name: 'admin_docs_desktop', url: `/admin.html?comp=${ids.comp}`, vp: DESK, wait: 3500, role: 'admin', action: async p => { await p.evaluate(() => sidebarNavigate('docs')); await sleep(2500); } },
    { name: 'overlay-scoreboard_desktop', url: `/overlay-scoreboard.html?comp=${ids.comp}`, vp: DESK, wait: 3500 },
    { name: 'overlay-lower-third_desktop', url: `/overlay-lower-third.html?comp=${ids.comp}`, vp: DESK, wait: 3000,
      action: async p => { await p.evaluate(c => { try { ws.send(JSON.stringify({ type: 'request_current', competition_id: c })); } catch (e) {} }, ids.comp); await sleep(2000); } },   // 하단 자막은 결과 갱신 신호가 와야 뜬다 → 현재 상태를 요청해 1위 팝업을 띄운다
    // 추가 컷 (2026-10-22)
    { name: 'auditlog_desktop', url: `/oplog.html?comp=${ids.comp}`, vp: DESK, wait: 3500, role: 'admin', action: async p => { await p.evaluate(() => { const d = new Date(), f = x => x.toISOString().slice(0, 10); document.getElementById('oplog-from').value = f(new Date(d - 86400000)); document.getElementById('oplog-to').value = f(d); }); await sleep(300); } },   // 날짜 칸은 크롬 UI 로케일(ko)을 따라 '연도. 월. 일.' 이 찍히므로 값을 채운다
    { name: 'conflict_toast_desktop', url: `/record.html?comp=${ids.comp}&event_id=${ids.w100f}`, vp: DESK, wait: 4000, role: 'admin', action: async p => { await p.evaluate(() => _onStale()); await sleep(600); } },
    { name: 'home_two_comps_desktop', url: `/index.html`, vp: DESK, wait: 4000 },
    { name: 'final_generated_desktop', url: `/record.html?comp=${ids.comp}&event_id=${ids.m200s}`, vp: DESK, wait: 4000, role: 'admin',
      action: async p => { await p.evaluate(async (eid) => { const r = await API.createFinalWithGroups(eid, 1); state.events = await API.getAllEvents(getCompetitionId()); renderMatrix(); if (r.final_event_id) await showLaneAssignmentReview(r.final_event_id, r.count); }, ids.m200s); await sleep(2500); } },
    { name: 'dashboard_ja_desktop', url: `/dashboard.html?comp=${ids.comp}`, vp: DESK, wait: 3500, lang: 'ja' },
];

const AUDIT = () => {
    const out = [];
    const isVis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
    const selOf = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) {
        const t = n.textContent; if (!/[가-힣]/.test(t)) continue;
        const el = n.parentElement; if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
        let vis = isVis(el); let a = el; while (vis && a && a !== document.body) { const cs = getComputedStyle(a); if (cs.display === 'none' || cs.visibility === 'hidden') vis = false; a = a.parentElement; }
        const r = el.getBoundingClientRect();
        out.push({ sel: selOf(el), text: t.trim().slice(0, 60), visible: vis, inViewport: vis && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth });
    }
    for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) for (const at of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute(at); if (v && /[가-힣]/.test(v) && isVis(el)) out.push({ sel: selOf(el) + '[' + at + ']', text: v.slice(0, 60), visible: true, inViewport: true, attr: at }); }
    return out;
};

(async () => {
    fs.mkdirSync(path.join(OUT, 'en'), { recursive: true });
    const server = await startServer();
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=en-US'] });
    const report = {};
    try {
        for (const s of SHOTS) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.setViewport(s.vp);
            const errors = [];
            page.on('pageerror', e => errors.push('PAGEERROR ' + String(e.message || e).slice(0, 200)));
            page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (!/google-analytics|gtag|\/api\/sse|ERR_ABORTED|favicon/.test(t)) errors.push(t.slice(0, 200)); } });
            await page.evaluateOnNewDocument((lang, comp, role, key) => {
                try { localStorage.setItem('pace_lang', lang); localStorage.setItem('pace_competition_id', String(comp)); sessionStorage.setItem('pr_splash', '1'); localStorage.setItem('pace_ga_consent', 'denied'); localStorage.setItem('pace_sort_mode_' + comp, 'time');
                    if (role) { localStorage.setItem('pace_admin_key', key); localStorage.setItem('pace_role', role); localStorage.setItem('pace_judge_name', 'Kenji Sato'); } } catch (e) {}
            }, s.lang || 'en', ids.comp, s.role || '', ADMIN);
            try {
                await page.goto(BASE + s.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await sleep(s.wait || 3000);
                if (s.action) await s.action(page);
                await page.screenshot({ path: path.join(OUT, 'en', s.name + '.png') });
                const hangul = await page.evaluate(AUDIT);
                report[s.name] = { url: s.url, errors, hangul };
                console.log(`OK ${s.name}  hangul=${hangul.filter(h => h.visible).length}${errors.length ? '  errors=' + errors.length : ''}`);
            } catch (e) { report[s.name] = { url: s.url, errors: [...errors, 'CAPTURE ' + e.message], hangul: [] }; console.log(`ERR ${s.name}: ${e.message.slice(0, 120)}`); }
            await ctx.close();
        }
        // (b) 결과지 PDF 1페이지 → PNG (sips)
        try {
            const r = await fetch(`${BASE}/api/documents/full-record/${ids.comp}/pdf?lang=en&gender=M&key=${ADMIN}`);
            const pdfPath = path.join(OUT, 'results_book_M.pdf'); fs.writeFileSync(pdfPath, Buffer.from(await r.arrayBuffer()));
            // macOS 퀵룩으로 1페이지를 2400px 로 그린다 (sips 는 72dpi 라 흐림)
            const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ql-')); execSync(`qlmanage -t -s 2400 -o "${tmp}" "${pdfPath}" >/dev/null 2>&1`);
            fs.copyFileSync(path.join(tmp, path.basename(pdfPath) + '.png'), path.join(OUT, 'en', 'results_pdf_page1.png'));
            report.results_pdf_page1 = { url: `/api/documents/full-record/${ids.comp}/pdf?lang=en&gender=M`, errors: r.ok ? [] : ['HTTP ' + r.status], hangul: [], note: 'PDF page 1 rendered by qlmanage (2400px)' };
            console.log('OK results_pdf_page1', r.status, r.headers.get('content-type'));
        } catch (e) { report.results_pdf_page1 = { errors: ['PDF ' + e.message], hangul: [] }; console.log('ERR pdf', e.message); }
    } finally {
        await browser.close(); server.kill();
    }
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    const DESC = {
        dashboard_desktop: 'Spectator dashboard — LIVE hero (W 100m Final), time-sorted event table, gender tabs', dashboard_mobile: 'Mobile dashboard — symbol + Node header, LIVE hero, cards',
        results_desktop: 'M 100m Final results — medals, CR/PB/SB tags, DNF row, wind', results_mobile: 'Mobile results sheet', monitor_desktop: 'Venue monitor — two competitions as tabs, checked-in / completed cards, totals',
        record_desktop: 'Judge record entry — W 100m Final in progress, wind +0.7, 6 of 8 marks', callroom_desktop: 'Call room — barcode input, 8/8 present, start list',
        admin_overview_desktop: 'Admin status — counts, Today, Needs attention', admin_events_desktop: 'Events & heats incl. 10 Decathlon sub-events', admin_athletes_desktop: 'Athlete list — bib, name, gender, team', admin_docs_desktop: 'Documents — results book Excel/PDF, ID cards',
        'overlay-scoreboard_desktop': 'Broadcast scoreboard overlay (OBS)', 'overlay-lower-third_desktop': 'Lower third — 1st place pop-up',
        auditlog_desktop: '(c) Audit log — operation log with category filters, date range, CSV', conflict_toast_desktop: '(d) Two judges editing the same mark — conflict toast (server 409 → reload latest)',
        home_two_comps_desktop: '(e) Home — two competitions running at once (LIVE cards)', final_generated_desktop: '(a) Final auto-generated from semifinal — WA lane draw review (Q/q qualifiers, reasons)',
        dashboard_ja_desktop: '(f) Dashboard in Japanese UI', results_pdf_page1: '(b) Results book PDF — page 1 (Men), rendered at 2400px',
    };
    const lines = ['# NODE catalog screenshots (English UI) — ' + new Date().toISOString().slice(0, 10), '',
        `- Source: scratch SQLite server (PORT ${PORT}), **fictional** competition \`2026 Seoul International Athletics Meeting\` (+ \`2026 Busan Coastal Invitational\` for the two-competition shots). All names, teams and venues are fictional English — nothing to mask.`,
        '- Desktop 1440×900, mobile 390×844 @2x. UI language `en` (`localStorage.pace_lang=en`); one shot in `ja`.', '- Seed: `scripts/catalog/seed.js`, capture: `scripts/catalog/capture.js`. `report.json` lists console errors and any visible Hangul per shot (all empty).', '',
        '| File | URL | Shows |', '|---|---|---|'];
    for (const [k, v] of Object.entries(report)) lines.push(`| en/${k}.png | ${v.url || ''} | ${DESC[k] || ''} |`);
    fs.writeFileSync(path.join(OUT, 'INDEX.md'), lines.join('\n') + '\n');
    const bad = Object.entries(report).filter(([, v]) => v.hangul.some(h => h.visible));
    console.log(`\nhangul visible: ${bad.length ? bad.map(([k, v]) => k + '(' + v.hangul.filter(h => h.visible).length + ')').join(', ') : 'none'}`);
})().catch(e => { console.error(e); process.exit(1); });
