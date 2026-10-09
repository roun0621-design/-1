#!/usr/bin/env node
'use strict';
/**
 * 다국어 넘침 검출 — 페이지를 EN/JA 로 열어 글자가 상자를 넘치거나 잘리는 요소를 목록으로 (2026-10-01, docs/DESIGN_SYSTEM.md §8)
 *   BASE=http://localhost:3321 ADMIN_PW=testadmin1234 node scripts/i18n/overflow_check.js [en|ja|both] [comp=2]
 *   출력: 페이지/언어별 { selector, text, scrollWidth, clientWidth } — 0건이 목표
 *   판정: 요소 자신의 scrollWidth > clientWidth+2 (overflow 가 visible 이 아닌 것) 또는 text-overflow:ellipsis 로 실제 잘린 것. 표·코드 블록의 가로 스크롤 상자는 제외
 */
const puppeteer = require('puppeteer');
const BASE = process.env.BASE || 'http://localhost:3000';
const COMP = process.env.COMP || '2';
const langs = (process.argv[2] === 'both' || !process.argv[2]) ? ['en', 'ja'] : [process.argv[2]];
const PAGES = [
    { url: `/dashboard.html?comp=${COMP}`, name: 'dashboard' },
    { url: `/record.html?comp=${COMP}`, name: 'record' },
    { url: `/callroom.html?comp=${COMP}`, name: 'callroom' },
    { url: `/monitor.html?comp=${COMP}`, name: 'monitor' },
    { url: `/index.html`, name: 'home' },
    { url: `/admin.html?comp=${COMP}`, name: 'admin', screens: ['overview', 'comp', 'import', 'athletes', 'events', 'records', 'timing', 'docs', 'certs', 'notify', 'access', 'backup'] },
];
const DETECT = () => {
    const out = []; const seen = new Set();
    const skipScroll = el => { const cs = getComputedStyle(el); return ['auto', 'scroll'].includes(cs.overflowX) && (el.tagName === 'TABLE' || el.closest('table, pre, code') || cs.overflowX === 'scroll'); };
    for (const el of document.querySelectorAll('body *')) {
        if (!el.offsetParent || el.closest('script, style, svg, .mobile-menu, .mm-panel, #mobile-menu')) continue;
        if (el.classList.contains('mm-action')) continue;   // 폰 메뉴의 세로 목록 버튼은 일부러 크다
        const cs = getComputedStyle(el); const text = (el.textContent || '').trim(); if (!text || text.length > 80) continue;
        const tooWide = el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && !skipScroll(el);
        const clipped = cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 2;
        const button = /^(BUTTON|A)$/.test(el.tagName) && el.scrollHeight > el.clientHeight + 6 && cs.whiteSpace !== 'normal' ? false : (/^(BUTTON)$/.test(el.tagName) && el.clientHeight > 44);
        if (tooWide || clipped || button) {
            const key = (el.id || el.className || el.tagName) + '|' + text.slice(0, 40); if (seen.has(key)) continue; seen.add(key);
            out.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''), text: text.slice(0, 40), sw: el.scrollWidth, cw: el.clientWidth, h: el.clientHeight, why: clipped ? 'ellipsis' : button ? 'tall-button' : 'overflow' });
        }
    }
    return out.slice(0, 60);
};
(async () => {
    const b = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 }); const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await p.evaluate(async (pw) => { try { await fetch('/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pw }) }); } catch (e) {} localStorage.setItem('pace_admin_key', 'jwt-session'); localStorage.setItem('pace_role', 'admin'); localStorage.setItem('pr_auth_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin' })); }, process.env.ADMIN_PW || 'testadmin1234');
    let total = 0;
    // 폰 폭에서도 대시보드는 본다 (스크린샷 규칙: 모바일은 대시보드·결과만)
    const MOBILE = [{ url: `/dashboard.html?comp=${COMP}`, name: 'dashboard@390' }];
    for (const lang of langs) {
        await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
        await p.evaluate(l => localStorage.setItem('pace_lang', l), lang);
        for (const pg of MOBILE) {
            await p.goto(BASE + pg.url, { waitUntil: 'domcontentloaded' }); await new Promise(r => setTimeout(r, 2500));
            const found = await p.evaluate(DETECT); total += found.length;
            console.log(`[${lang}] ${pg.name}: ${found.length}`); found.forEach(f => console.log('   ', f.why.padEnd(11), f.sel.slice(0, 50).padEnd(50), `${f.sw}/${f.cw}`, JSON.stringify(f.text)));
        }
        await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        await p.evaluate(l => localStorage.setItem('pace_lang', l), lang);
        for (const pg of PAGES) {
            await p.goto(BASE + pg.url, { waitUntil: 'domcontentloaded' }); await new Promise(r => setTimeout(r, 2500));
            const views = pg.screens ? pg.screens : [null];
            for (const sc of views) {
                if (sc) { await p.evaluate(id => sidebarNavigate(id), sc); await new Promise(r => setTimeout(r, 900)); }
                const found = await p.evaluate(DETECT);
                total += found.length;
                console.log(`[${lang}] ${pg.name}${sc ? '/' + sc : ''}: ${found.length}`);
                found.forEach(f => console.log('   ', f.why.padEnd(11), f.sel.slice(0, 50).padEnd(50), `${f.sw}/${f.cw}`, JSON.stringify(f.text)));
            }
        }
    }
    console.log('TOTAL', total);
    await b.close();
})();
