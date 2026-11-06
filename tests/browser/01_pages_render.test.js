/**
 * 브라우저 렌더 테스트 (puppeteer) — 화면이 실제로 뜨는지, 폰·태블릿·PC 폭에서 가로로 넘치지 않는지 (2026-09 Phase 4)
 *   실행: BROWSER_TESTS=1 npx vitest run tests/browser      (npm run test:browser)
 *   기본 `npm test` 에서는 건너뛴다 — 크롬을 띄우는 데 시간이 걸리고 CI 에 크롬이 없을 수 있어서.
 *
 *   검사(페이지 × 폭 360/768/1024):
 *     - 자바스크립트 예외 없음 (pageerror)
 *     - CSP 거부 없음 (console 'Refused to …')
 *     - 가로 넘침 없음 (scrollWidth ≤ innerWidth+1) — 표·코드는 자기 상자 안에서만 스크롤
 *     - 핵심 요소가 보임 (종목 카드, 대회 카드 …)
 *   스크린샷은 tests/browser/shots/ 에 남긴다(git 무시) — 눈으로 볼 때.
 */
const path = require('path');
const fs = require('fs');
const RUN = process.env.BROWSER_TESTS === '1';
const WIDTHS = [360, 768, 1024];
const OP = 'testopkey';

let mod, db, server, base, browser, comp;
const SHOTS = path.join(__dirname, 'shots');

describe.skipIf(!RUN)('브라우저 렌더 — 페이지 × 폭', () => {
    beforeAll(async () => {
        mod = require('../../server.js'); db = mod.db; server = mod.server;
        await mod.ready;
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
        // 대회 하나: 종목 4개(트랙·필드·계주·종합) + 시간표 2행 + 선수 2명
        comp = (await db.run("INSERT INTO competition (name, start_date, end_date, venue, status, mode) VALUES ('브라우저 테스트 대회', '2026-10-01', '2026-10-02', '테스트경기장', 'active', 'operation')")).lastInsertRowid;
        const ev = async (name, cat, g, rt, st) => (await db.run('INSERT INTO event (competition_id, name, category, gender, round_type, round_status) VALUES (?,?,?,?,?,?)', comp, name, cat, g, rt, st)).lastInsertRowid;
        const e100 = await ev('100m', 'track', 'M', 'final', 'heats_generated');
        await ev('멀리뛰기', 'field_distance', 'F', 'final', 'created');
        await ev('4X100mR', 'relay', 'M', 'final', 'created');
        await ev('10,000m', 'track', 'F', 'final', 'completed');
        for (let i = 1; i <= 2; i++) {
            const a = (await db.run("INSERT INTO athlete (competition_id, name, team, gender, bib_number) VALUES (?,?,?,?,?)", comp, '선수' + i, '팀' + i, 'M', String(100 + i))).lastInsertRowid;
            const ee = (await db.run('INSERT INTO event_entry (event_id, athlete_id) VALUES (?,?)', e100, a)).lastInsertRowid;
            const h = await db.get('SELECT id FROM heat WHERE event_id=? AND heat_number=1', e100);
            const hid = h ? h.id : (await db.run('INSERT INTO heat (event_id, heat_number) VALUES (?,1)', e100)).lastInsertRowid;
            await db.run('INSERT INTO heat_entry (heat_id, event_entry_id, lane_number) VALUES (?,?,?)', hid, ee, i + 2);
        }
        await db.run("INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, event_id, scheduled_date) VALUES (?,1,'track','10:00','100m','남자','결승',?, '2026-10-01')", comp, e100);
        await db.run("INSERT INTO timetable (competition_id, day, section, time, event_name, category, round, scheduled_date) VALUES (?,1,'field','10:30','멀리뛰기','여자','결승','2026-10-01')", comp);
        const puppeteer = require('puppeteer');
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        fs.mkdirSync(SHOTS, { recursive: true });
    }, 90000);
    afterAll(async () => { try { if (browser) await browser.close(); } catch (e) {} try { server && server.close(); } catch (e) {} });

    const PAGES = [
        { name: 'index', url: () => '/', expect: 'body' },
        { name: 'dashboard', url: () => `/dashboard.html?comp=${comp}`, expect: '#events-container .matrix-section, #events-container .ui-state' },
        { name: 'results', url: () => `/results.html?comp=${comp}`, expect: 'body' },
        { name: 'callroom', url: () => `/callroom.html?comp=${comp}&key=${OP}`, expect: 'body' },
        { name: 'record', url: () => `/record.html?comp=${comp}&key=${OP}`, expect: 'body' },
    ];

    async function visit(page, url, w) {
        const errors = [], refused = [];
        page.removeAllListeners('pageerror'); page.removeAllListeners('console');
        page.on('pageerror', e => errors.push(String(e && e.message || e)));
        page.on('console', m => { const t = m.text(); if (m.type() === 'error' && /Refused to/.test(t)) refused.push(t); });
        await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1, isMobile: w < 700, hasTouch: w < 700 });
        await page.goto(base + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));
        const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, textLen: (document.body.innerText || '').trim().length }));
        return { errors, refused, metrics };
    }

    for (const pg of PAGES) {
        for (const w of WIDTHS) {
            it(`${pg.name} @${w}px — 예외·CSP 거부·가로 넘침 없음`, async () => {
                const page = await browser.newPage();
                try {
                    const r = await visit(page, pg.url(), w);
                    await page.screenshot({ path: path.join(SHOTS, `${pg.name}-${w}.png`) });
                    // 웹소켓/SSE 연결 실패는 테스트 서버에 WS 가 없어서 나는 것 — 예외로 치지 않는다
                    const realErrors = r.errors.filter(e => !/WebSocket|EventSource|Failed to fetch|NetworkError/i.test(e));
                    expect(realErrors, '자바스크립트 예외').toEqual([]);
                    expect(r.refused, 'CSP 거부').toEqual([]);
                    expect(r.metrics.scrollWidth, '가로 넘침').toBeLessThanOrEqual(r.metrics.innerWidth + 1);
                    expect(r.metrics.textLen).toBeGreaterThan(20);
                    expect(await page.$(pg.expect), '핵심 요소').not.toBeNull();
                } finally { await page.close(); }
            }, 60000);
        }
    }

    it('대시보드: 종목 카드 4개가 보이고, 종목을 누르면 명단 창이 뜬다 (360px)', async () => {
        const page = await browser.newPage();
        try {
            await visit(page, `/dashboard.html?comp=${comp}`, 360);
            const names = await page.$$eval('#events-container .event-name', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
            expect(names.join(' ')).toMatch(/100m/); expect(names.join(' ')).toMatch(/멀리뛰기/); expect(names.join(' ')).toMatch(/4X100mR/);
            await page.evaluate(() => { const e = allEvents.find(x => x.name === '100m'); openEventDetail(e.id); });
            await new Promise(r => setTimeout(r, 1500));
            const modalText = await page.$eval('#roster-modal-overlay', el => el.innerText);
            expect(modalText).toMatch(/선수1/);
            // 관심 국가(KOR) 설정이 없는 일반 대회: 히어로 오른쪽 반쪽(대표팀 명단)은 보이면 안 된다 — hidden 속성을 CSS display 가 덮던 버그
            const rosterVisible = await page.$eval('#hero-roster', el => { const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).display !== 'none'; });
            expect(rosterVisible, '일반 대회에 대표팀 명단 반쪽').toBe(false);
            await page.screenshot({ path: path.join(SHOTS, 'dashboard-roster-360.png') });
        } finally { await page.close(); }
    }, 60000);
});
