'use strict';
/**
 * 해외용 카탈로그 조판 (2026-11-19) — 문안(copy.js) + 스크린샷(capture.js 산출물) → A4 가로 PDF
 *
 *   node scripts/catalog/build.js --shots <스크린샷 폴더> [--out <출력 폴더>] [--lang en|ja|all] [--cut full|event|all] [--png]
 *
 *   --shots  capture.js 의 출력 폴더(안에 en/ · ja/). 안 주면 ~/Desktop/NODE_카탈로그_스크린샷_* 중 가장 최근 것.
 *   --out    기본 = <shots>/catalogue. PACE_RISE_Node_Catalogue_2026_<EN|JA>[_8p].pdf 와 같은 이름의 .html 을 쓴다.
 *   --cut    full = 14쪽(연맹용), event = 8쪽(이벤트사용: 1·2·3·4·5·8·9·14쪽, 쪽 번호는 다시 매김). 기본 all.
 *   --png    쪽마다 미리보기 PNG 도 쓴다(<out>/preview/<lang>_<cut>_NN.png) — 눈으로 검수할 때.
 *
 *   스크린샷부터 다시 찍으려면:
 *     node scripts/catalog/seed.js /tmp/shots.db /tmp/ids.json
 *     node scripts/catalog/capture.js /tmp/shots.db /tmp/ids.json <스크린샷 폴더>        # en
 *     node scripts/catalog/seed.js /tmp/shots2.db /tmp/ids2.json                          # 촬영이 DB 를 바꾸므로 언어마다 새로 시드
 *     node scripts/catalog/capture.js /tmp/shots2.db /tmp/ids2.json <스크린샷 폴더> ja   # ja
 *
 *   조판 규칙
 *   - 색·로고는 docs/DESIGN_SYSTEM.md §2·§3 (트랙 블랙 / 라인 화이트 / 타탄, 로고는 public/brand 이미지만).
 *   - box-shadow · filter · opacity 겹침을 쓰지 않는다 — 크롬이 만든 PDF 의 부드러운 그림자가 맥·아이폰 기본 뷰어(PDFKit)에서
 *     불투명한 회색 상자로 찍혀 제목과 화면을 가렸다(2026-10-23 판). 화면 테두리는 1px 선만.
 *   - 글이 쪽을 넘치면 빌드가 경고를 낸다(overflow …). 문안을 고친 뒤엔 --png 로 눈으로도 본다.
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const COPY = require('./copy');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const ROOT = path.join(__dirname, '..', '..');
function latestShots() {
    const desk = path.join(os.homedir(), 'Desktop');
    const c = fs.existsSync(desk) ? fs.readdirSync(desk).filter(n => /^NODE_카탈로그_스크린샷_\d{4}-\d{2}-\d{2}$/.test(n.normalize('NFC')) && fs.existsSync(path.join(desk, n, 'en'))).sort() : [];
    return c.length ? path.join(desk, c[c.length - 1]) : null;
}
const SHOTS = arg('shots') || latestShots();
if (!SHOTS || !fs.existsSync(SHOTS)) { console.error('usage: build.js --shots <dir with en/ (and ja/)> [--out dir] [--lang en|ja|all] [--cut full|event|all] [--png]'); process.exit(1); }
const OUT = arg('out') || path.join(SHOTS, 'catalogue');
const LANGS = (l => l === 'all' ? ['en', 'ja'] : [l])(arg('lang', 'all'));
const CUTS = (c => c === 'all' ? ['full', 'event'] : [c])(arg('cut', 'all'));
const PNG = !!arg('png', false);
const EVENT_CUT = ['cover', 'p2', 'p3', 'p4', 'p5', 'p8', 'p9', 'p14'];

const url = p => pathToFileURL(p).href;
const BRAND = n => url(path.join(ROOT, 'public', 'brand', n));
const FONT = n => url(path.join(__dirname, 'fonts', n));

// ── 조각 ────────────────────────────────────────────────────────────────
const esc = s => String(s);   // 문안은 우리가 쓴 HTML 조각 — 그대로 넣는다
const cap = c => `<p class="cap"><b>${c[0]}</b>${c[1]}</p>`;
const dash = (items, cls = '') => `<ul class="dash ${cls}">${items.map(t => `<li>${t}</li>`).join('')}</ul>`;
const head = c => `<p class="eyebrow">${c.eyebrow}</p><h1>${c.title}</h1>`;

function makeShot(lang) {
    const file = name => { for (const l of [lang, 'en']) { const p = path.join(SHOTS, l, name + '.png'); if (fs.existsSync(p)) return p; } throw new Error(`스크린샷 없음: ${name}.png (${lang}/ · en/) — capture.js 를 먼저 돌린다`); };
    const shot = (name, cls = '') => `<div class="shot ${cls}"><img src="${url(file(name))}"></div>`;
    // 원본 이미지(natW×natH)에서 (x,y,w,h) 만 잘라 보여 준다 — 컨테이너 너비에 맞춰 늘어난다
    const crop = (name, natW, natH, x, y, w, h, cls = '') => `<div class="shot crop ${cls}" style="aspect-ratio:${w}/${h}"><img src="${url(file(name))}" style="width:${(natW / w * 100).toFixed(3)}%;left:${(-x / w * 100).toFixed(3)}%;top:${(-y / h * 100).toFixed(3)}%"></div>`;
    return { shot, crop };
}

// ── 쪽 ──────────────────────────────────────────────────────────────────
function pages(lang) {
    const t = COPY[lang], { shot, crop } = makeShot(lang);
    const P = {};

    P.cover = () => ({ dark: true, bare: true, body: `
        <header class="hd"><img class="wm" src="${BRAND('wordmark-white.svg')}"><div class="pn">${t.cover.tag}</div></header>
        <div class="cv-main">
            <div class="cv-lock"><img src="${BRAND('symbol-tartan.svg')}"><span>Node</span></div>
            <h1 class="cv-line">${t.cover.line}</h1>
            <p class="cv-sub">${t.cover.sub}</p>
        </div>
        <div class="cv-stats">${t.cover.stats.map(s => `<div><p class="big ${s[2] || ''}">${s[0]}</p><p class="sm-t">${s[1]}</p></div>`).join('')}</div>` });

    P.p2 = () => ({ dark: true, foot: t.p2.foot, body: `${head(t.p2)}
        <div class="tl">
            <div class="tl-nums">${t.p2.steps.map((s, i) => `<span>${String(i + 1).padStart(2, '0')}</span>`).join('')}</div>
            <div class="tl-line">${t.p2.steps.map(() => '<i></i>').join('')}</div>
            <div class="tl-cols">${t.p2.steps.map(s => `<div><p class="tl-time">${s[0]}</p><h3>${s[1]}</h3><p>${s[2]}</p></div>`).join('')}</div>
        </div>` });

    P.p3 = () => ({ foot: t.p3.foot, body: `<div class="g g-3">
        <div>${head(t.p3)}${dash(t.p3.bullets)}</div>
        <div class="collage">
            ${shot('dashboard_desktop', 'c-desk')}
            ${shot('dashboard_mobile', 'phone c-ph1')}
            ${shot('results_mobile', 'phone c-ph2')}
            <div class="c-cap">${cap(t.p3.cap)}</div>
        </div></div>` });

    const col4 = (c, name) => `<div class="col4"><h2>${c.h}</h2>${dash(c.bullets, 'tight')}${shot(name)}<p class="note">${c.note}</p></div>`;
    P.p4 = () => ({ foot: t.p4.foot, body: `${head(t.p4)}<div class="g g-2 p4">${col4(t.p4.call, 'callroom_desktop')}${col4(t.p4.rec, 'record_desktop')}</div>` });

    const flow = (boxes, arrows, darkIdx) => boxes.map((b, i) => `<div class="fbox ${i === darkIdx ? 'on' : ''}"><p class="tag">${b[0]}</p><h3>${b[1]}</h3><p>${b[2]}</p></div>` + (arrows[i] ? `<div class="farrow"><span>${arrows[i]}</span><i></i></div>` : '')).join('');
    P.p5 = () => ({ foot: t.p5.foot, spread: true, body: `<div><p class="eyebrow">${t.p5.eyebrow}</p><h1 class="display">${t.p5.title}</h1></div>
        <div class="flow f4">${flow(t.p5.boxes, t.p5.arrows, 2)}</div>
        <div class="g g-33 notes">${t.p5.notes.map(n => `<p>${n}</p>`).join('')}</div>` });

    P.p6 = () => ({ foot: t.p6.foot, body: `<div class="g g-6">
        <div>${head(t.p6)}${dash(t.p6.bullets, 'p6')}</div>
        <div>${shot('final_generated_desktop')}${cap(t.p6.cap)}</div></div>` });

    P.p7 = () => ({ foot: t.p7.foot, body: `<div class="g g-7">
        <div>${head(t.p7)}${dash(t.p7.bullets)}</div>
        <div>
            ${crop('results_pdf_page1', 2400, 1696, 0, 0, 2400, 700)}${cap(t.p7.caps.book)}
            <div class="g g-7b"><div>${shot('results_sheet_W100mF')}${cap(t.p7.caps.sheet)}</div><div>${shot('admin_docs_desktop')}${cap(t.p7.caps.docs)}</div></div>
        </div></div>` });

    P.p8 = () => ({ foot: t.p8.foot, body: `<div class="g g-8">
        <div>${head(t.p8)}${dash(t.p8.bullets)}</div>
        <div>
            ${crop('overlay-scoreboard_desktop', 1440, 900, 200, 360, 1040, 525)}${cap(t.p8.caps.score)}
            <div class="g g-2 p8b"><div>${crop('overlay-lower-third_desktop', 1440, 900, 30, 705, 480, 160)}${cap(t.p8.caps.lower)}</div><div>${shot('monitor_desktop')}${cap(t.p8.caps.monitor)}</div></div>
        </div></div>` });

    P.p9 = () => ({ foot: t.p9.foot, body: `<div class="g g-9">
        <div>${head(t.p9)}<p class="lead">${t.p9.lead}</p>
            <div class="nums">${t.p9.nums.map(n => `<div><p class="big">${n[0]}</p><p class="sm-t">${n[1]}</p></div>`).join('')}</div>
            <p class="fine">${t.p9.note}</p></div>
        <table class="tr"><thead><tr>${t.p9.th.map((h, i) => `<th class="c${i}">${h}</th>`).join('')}</tr></thead>
            <tbody>${t.p9.rows.map(r => `<tr>${r.map((c, i) => `<td class="c${i}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` });

    P.p10 = () => ({ dark: true, foot: t.p10.foot, body: `${head(t.p10)}
        <div class="g g-33 p10s">${['conflict_toast_desktop', 'auditlog_desktop', 'home_two_comps_desktop'].map((n, i) => `<div>${shot(n)}${cap(t.p10.caps[i])}</div>`).join('')}</div>
        <div class="g g-33 cards">${t.p10.cards.map(c => `<div class="card"><h3>${c[0]}</h3><p>${c[1]}</p></div>`).join('')}</div>` });

    P.p11 = () => ({ foot: t.p11.foot, body: `<div class="g g-6">
        <div>${head(t.p11)}${dash(t.p11.bullets)}
            <h2 class="hostH">${t.p11.hostH}</h2>
            <div class="g g-33 host">${t.p11.host.map((h, i) => `<div class="card"><p class="tag">0${i + 1}</p><h3>${h[0]}</h3><p>${h[1]}</p></div>`).join('')}</div></div>
        <div>${shot(t.p11.shot)}${cap(t.p11.cap)}</div></div>` });

    P.p12 = () => ({ foot: t.p12.foot, spread: true, body: `<div>${head(t.p12)}</div>
        <div class="flow f3">${flow(t.p12.boxes, t.p12.arrows, 1)}</div>
        <div class="g g-2 notes">${t.p12.notes.map(n => `<p>${n}</p>`).join('')}</div>` });

    P.p13 = () => ({ foot: t.p13.foot, spread: true, body: `<div>${head(t.p13)}</div>
        <div class="steps">${t.p13.steps.map((s, i) => `<div class="card"><p class="tag">0${i + 1}<u>·</u><span>${s[0]}</span></p><h3>${s[1]}</h3><p>${s[2]}</p></div>`).join('')}</div>
        <div class="g g-13">
            <div><h2>${t.p13.modelsH}</h2><div class="chips">${t.p13.chips.map(c => `<span>${c}</span>`).join('')}</div><p class="note">${t.p13.pricing}</p></div>
            <p class="who">${t.p13.who}</p></div>` });

    P.p14 = () => ({ dark: true, bare: true, body: `
        <div class="bk-main">
            <div>
                <img class="bk-wm" src="${BRAND('wordmark-white.svg')}">
                <p class="bk-co">${t.p14.company}</p><p class="bk-per">${t.p14.person}</p>
                <div class="bk-lines">${t.p14.lines.map(l => `<p>${l}</p>`).join('')}</div>
                <p class="bk-addr">${t.p14.addr}</p>
            </div>
            <img class="bk-sym" src="${BRAND('symbol-tartan.svg')}">
        </div>
        <div class="bk-foot"><p class="bk-tag">${t.p14.tagline}</p><p class="bk-note">${t.p14.note}</p></div>` });

    return P;
}

function html(lang, cut) {
    const P = pages(lang), t = COPY[lang];
    const keys = cut === 'event' ? EVENT_CUT : ['cover', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13', 'p14'];
    const secs = keys.map((k, i) => {
        const p = P[k](), n = String(i + 1).padStart(2, '0');
        if (p.bare) return `<section class="page ${k} ${p.dark ? 'dark' : ''}" data-key="${k}"><div class="body">${p.body}</div></section>`;
        return `<section class="page ${k} ${p.dark ? 'dark' : ''}" data-key="${k}">
            <header class="hd"><img class="wm" src="${BRAND(p.dark ? 'wordmark-white.svg' : 'wordmark.svg')}"><div class="pn">Node<b>${n}</b></div></header>
            <div class="body ${p.spread ? 'spread' : ''}">${p.body}</div>
            <footer class="ft"><span>${esc(p.foot || '')}</span><span class="aw">PACE RISE : NODE</span></footer></section>`;
    });
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${t.title}</title><style>${css(lang)}</style></head><body>${secs.join('\n')}</body></html>`;
}

function css(lang) {
    const sans = lang === 'ja' ? `'Pretendard Std','Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif` : `'Pretendard Std','Helvetica Neue',Arial,sans-serif`;
    const aw = lang === 'ja' ? `'Audiowide','Hiragino Sans','Hiragino Kaku Gothic ProN',sans-serif` : `'Audiowide','Pretendard Std',sans-serif`;
    return `
@font-face{font-family:'Pretendard Std';font-weight:400;src:url('${FONT('PretendardStd-Regular.woff2')}') format('woff2')}
@font-face{font-family:'Pretendard Std';font-weight:600;src:url('${FONT('PretendardStd-SemiBold.woff2')}') format('woff2')}
@font-face{font-family:'Pretendard Std';font-weight:700;src:url('${FONT('PretendardStd-Bold.woff2')}') format('woff2')}
@font-face{font-family:'Audiowide';font-weight:400;src:url('${url(path.join(ROOT, 'public', 'fonts', 'Audiowide-Regular.ttf'))}') format('truetype')}
:root{--black:#0E0E10;--white:#F4F3EF;--tartan:#C24A2E;--cinder:#1B1B1E;--grey:#8A867E;--line:#D3D1CB;--soft:#5E5B55;--sans:${sans};--aw:${aw}}
@page{size:297mm 210mm;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff}
body{font-family:var(--sans);color:var(--black);font-size:14px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-font-smoothing:antialiased}
b{font-weight:600} i,em,u{font-style:normal;text-decoration:none}
p,li{text-wrap:pretty}
.page{width:297mm;height:210mm;position:relative;overflow:hidden;background:var(--white);padding:40px 60px 32px;display:flex;flex-direction:column;break-after:page}
.page:last-child{break-after:auto}
.page.dark{background:var(--black);color:var(--white);--line:#34343A;--soft:#B9B6AE}
.hd{flex:none;display:flex;justify-content:space-between;align-items:center;height:18px}
.wm{height:15px;display:block}
.pn{font-family:var(--aw);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--grey)} .pn b{font-weight:400;color:var(--tartan);margin-left:14px}
.body{flex:1;min-height:0;display:flex;flex-direction:column;padding-top:32px}
.body.spread{justify-content:space-between;padding-bottom:40px}
.ft{flex:none;display:flex;justify-content:space-between;align-items:flex-end;font-size:9.5px;line-height:1.3;color:var(--grey);padding-top:10px}
.ft .aw{font-family:var(--aw);font-size:8.5px;letter-spacing:.16em}
.eyebrow{font-family:var(--aw);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--tartan);margin-bottom:12px;line-height:1.3}
h1{font-weight:600;font-size:34px;line-height:1.16;letter-spacing:-.02em;text-wrap:balance}
h2{font-weight:600;font-size:18px;line-height:1.3;letter-spacing:-.01em}
h3{font-weight:600;font-size:15px;line-height:1.3;letter-spacing:-.005em}
ul.dash{list-style:none;margin-top:22px} ul.dash li{position:relative;padding-left:20px;margin-top:11px;font-size:14px;line-height:1.55}
ul.dash li:first-child{margin-top:0}
ul.dash li::before{content:'';position:absolute;left:0;top:.72em;width:10px;height:2px;background:var(--tartan)}
ul.dash.tight{margin-top:10px} ul.dash.tight li{font-size:12.5px;margin-top:7px;line-height:1.5}
ul.dash.p6 li{font-size:13px;margin-top:9px}
.cap{font-size:10.5px;line-height:1.5;color:var(--grey);margin-top:8px}
.cap b{font-family:var(--aw);font-weight:400;font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:var(--tartan);margin-right:9px}
.shot{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:6px;background:#fff}
.shot img{display:block;width:100%}
.shot.crop img{position:absolute;max-width:none}
.shot.phone{border:3px solid var(--black);border-radius:17px}
.note{font-size:12.5px;line-height:1.6;color:var(--black)}
.g{display:grid;gap:40px;min-height:0}
.g-2{grid-template-columns:1fr 1fr} .g-33{grid-template-columns:repeat(3,1fr);gap:20px}
.g-3{grid-template-columns:372px 1fr;gap:44px;flex:1}
.g-6{grid-template-columns:430px 1fr;flex:1;align-items:start}
.g-7{grid-template-columns:318px 1fr;flex:1;align-items:start}
.g-8{grid-template-columns:392px 1fr;flex:1;align-items:start}
.g-9{grid-template-columns:392px 1fr;gap:46px;flex:1;align-items:start}
.tag{font-family:var(--aw);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--tartan);line-height:1.3}
.card{border:1px solid var(--line);border-radius:6px;padding:16px 18px}
.card p:not(.tag){font-size:12.5px;line-height:1.55;margin-top:6px;color:var(--soft)}
.big{font-family:var(--aw);font-size:38px;line-height:1;letter-spacing:.01em} .big i{color:var(--tartan)}
.sm-t{font-size:10.5px;line-height:1.45;color:var(--grey);margin-top:9px}

/* 표지 */
.cover .body,.p14 .body{padding-top:0}
.cv-main{flex:1;display:flex;flex-direction:column;justify-content:center;padding-top:10px}
.cv-lock{display:flex;align-items:flex-end;gap:22px} .cv-lock img{height:118px;display:block} .cv-lock span{font-family:'Audiowide',sans-serif;font-size:104px;line-height:.82;letter-spacing:-.01em;color:var(--white)}
.cv-line{font-size:36px;line-height:1.18;margin-top:44px}
.cv-sub{font-size:13.5px;line-height:1.6;color:var(--soft);margin-top:16px;max-width:560px}
.cv-stats{flex:none;display:grid;grid-template-columns:repeat(5,1fr);border-top:1px solid var(--line);padding-top:26px;padding-bottom:10px}
.cv-stats>div{padding:0 18px;border-left:1px solid var(--line);min-height:92px} .cv-stats>div:first-child{padding-left:0;border-left:0}
.cv-stats .big{font-size:26px;min-height:40px} .cv-stats .big.sm{font-size:15px;line-height:1.35;letter-spacing:.02em}
.cv-stats .sm-t{margin-top:6px}

/* 2 하루의 흐름 */
.tl{flex:1;display:flex;flex-direction:column;justify-content:center;padding-bottom:70px}
.tl-nums,.tl-line,.tl-cols{display:grid;grid-template-columns:repeat(7,1fr)}
.tl-nums span{font-family:'Audiowide',sans-serif;font-size:54px;line-height:1;color:#26262B;letter-spacing:-.02em}
.tl-line{margin:22px 0 20px;height:12px;background:linear-gradient(var(--line),var(--line)) left center/100% 2px no-repeat}
.tl-line i{display:block;width:12px;height:12px;border-radius:50%;background:var(--tartan)}
.tl-cols>div{padding-right:18px}
.tl-time{font-family:'Audiowide',sans-serif;font-size:12px;letter-spacing:.08em;color:var(--tartan)}
.tl-cols h3{font-size:17px;margin-top:8px} .tl-cols p:not(.tl-time){font-size:12px;line-height:1.6;color:var(--soft);margin-top:8px}

/* 3 관중 */
.collage{position:relative}
.c-desk{position:absolute;left:0;top:0;width:100%}
.c-ph1,.c-ph2{position:absolute;top:262px;width:162px} .c-ph1{right:184px} .c-ph2{right:0}
.c-cap{position:absolute;left:0;top:372px;width:190px} .c-cap .cap b{display:block;margin-bottom:4px}

/* 4 심판·소집실 */
.p4{margin-top:22px;grid-template-rows:repeat(4,auto);grid-auto-flow:column;row-gap:0;align-content:start}   /* 두 단의 제목·글머리·화면·설명이 줄마다 같은 높이에서 시작 */
.col4{display:contents} .col4 .shot{margin-top:14px} .col4 .note{margin-top:12px}

/* 5·12 흐름도 */
h1.display{font-family:var(--aw);font-weight:400;font-size:44px;line-height:1.18;letter-spacing:0} h1.display em{color:var(--tartan)}
.flow{display:grid;align-items:stretch}
.flow.f4{grid-template-columns:1fr 84px 1fr 84px 1fr 84px 1fr} .flow.f3{grid-template-columns:1fr 104px 1.3fr 104px 1fr}
.fbox{border:1.5px solid var(--black);border-radius:6px;padding:20px 20px 22px}
.fbox h3{font-size:17px;margin-top:10px} .fbox p:not(.tag){font-size:12.5px;line-height:1.6;margin-top:8px}
.fbox.on{background:var(--black);color:var(--white)}
.farrow{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:0 10px}
.farrow span{font-size:10.5px;line-height:1.4;color:var(--grey);text-align:center}
.farrow i{display:block;position:relative;width:100%;height:1.5px;background:var(--black)}
.farrow i::after{content:'';position:absolute;right:-1px;top:-4px;border-left:8px solid var(--black);border-top:4.75px solid transparent;border-bottom:4.75px solid transparent}
.notes p{font-size:14px;line-height:1.6}
.notes.g-2{gap:50px}

/* 6·11 */
ul.dash+.hostH{margin-top:26px} .host{margin-top:12px;gap:12px} .host .card{padding:14px 14px 16px} .host h3{margin-top:8px}

/* 7 문서 */
.g-7b{grid-template-columns:250px 1fr;gap:20px;margin-top:16px;align-items:start}
/* 8 방송 */
.p8b{gap:20px;margin-top:16px;align-items:start}

/* 9 실적 */
.lead{font-size:14px;line-height:1.6;margin-top:22px}
.nums{display:flex;gap:56px;margin-top:30px} .nums .big{font-size:46px}
.fine{font-size:10.5px;line-height:1.55;color:var(--grey);margin-top:28px}
table.tr{width:100%;border-collapse:collapse;margin-top:2px}
table.tr th{vertical-align:bottom;font-family:var(--aw);font-weight:400;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--grey);text-align:left;padding:0 0 10px;border-bottom:1.5px solid var(--black)}
table.tr td{font-size:13.5px;line-height:1.3;padding:13.5px 0;border-bottom:1px solid var(--line);vertical-align:middle}
table.tr .c1{font-family:var(--aw);font-size:10px;letter-spacing:.04em;padding-left:14px;white-space:nowrap} table.tr th.c1{font-size:9px;letter-spacing:.14em}
table.tr .c2{padding-left:16px;white-space:nowrap} table.tr .c3{text-align:right;padding-left:14px;font-variant-numeric:tabular-nums}

/* 10 신뢰 */
.p10s{margin-top:24px} .cards{margin-top:20px;gap:16px 20px}
.dark .card{background:var(--cinder)} .dark .card h3{font-size:16px}

/* 13 도입 */
.steps{display:grid;grid-template-columns:repeat(5,1fr);gap:16px}
.steps .card{padding:18px 18px 22px} .steps .tag u{margin:0 7px;color:var(--tartan)} .steps .tag span{text-transform:none;letter-spacing:.06em;font-size:10.5px}
.steps h3{font-size:16px;margin-top:10px}
.g-13{grid-template-columns:430px 1fr;gap:60px;align-items:start}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 14px} .chips span{font-family:var(--aw);font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:var(--tartan);border:1.2px solid var(--tartan);border-radius:4px;padding:6px 9px;line-height:1.2}
.g-13 .note{font-size:14px}
.who{font-size:15px;line-height:1.65}

/* 14 뒤표지 */
.p14{padding-top:60px;padding-bottom:50px}
.bk-main{flex:1;display:flex;justify-content:space-between;align-items:flex-start;padding-top:86px}
.bk-wm{height:42px;display:block;margin-left:4px}
.bk-co{font-weight:600;font-size:17px;margin-top:62px} .bk-per{font-size:14.5px;margin-top:6px}
.bk-lines{margin-top:20px} .bk-lines p{font-size:14.5px;line-height:1.95;color:#DAD7D0}
.bk-addr{font-size:11.5px;color:var(--grey);margin-top:18px}
.bk-sym{height:226px;display:block;margin-top:4px}
.bk-foot{flex:none;display:flex;justify-content:space-between;align-items:flex-end}
.bk-tag{font-family:'Audiowide',sans-serif;font-size:27px;line-height:1;letter-spacing:.02em}
.bk-note{font-size:9.5px;line-height:1.6;color:var(--grey);text-align:right}

${lang === 'ja' ? `
/* 일문 — 가나·한자는 글줄이 높고 자간이 넓다 */
body{line-height:1.7;line-break:strict;overflow-wrap:anywhere}
h1{font-size:30px;line-height:1.3;letter-spacing:0;font-weight:700} h2{font-size:17px} h3{font-size:14.5px}
ul.dash li{font-size:13px;line-height:1.7;margin-top:9px} ul.dash li::before{top:.82em}
ul.dash.tight li{font-size:11.8px;line-height:1.65} ul.dash.p6 li{font-size:12.2px;line-height:1.65;margin-top:7px}
.cap{font-size:10px;line-height:1.6} .note{font-size:11.8px;line-height:1.7} .notes p{font-size:13px;line-height:1.75}
.card p:not(.tag){font-size:11.8px;line-height:1.65} .fbox p:not(.tag){font-size:12px;line-height:1.7} .fbox h3{font-size:16px}
.cv-line{font-size:34px;line-height:1.3} .cv-sub{font-size:13px;line-height:1.75}
.tl-cols h3{font-size:16px} .tl-cols p:not(.tl-time){font-size:11.5px;line-height:1.7}
h1.display{font-family:var(--sans);font-weight:700;font-size:36px;line-height:1.35}
.lead{font-size:13.5px;line-height:1.75} .who{font-size:14px;line-height:1.8} .g-13 .note{font-size:13px}
table.tr td{font-size:12.5px;padding:13px 0} table.tr th{font-family:var(--sans);font-size:10px;letter-spacing:.06em;font-weight:600}
.chips span{font-family:var(--sans);font-size:10.5px;letter-spacing:.02em;font-weight:600} .steps .tag span{font-family:var(--sans);font-size:11px;letter-spacing:.02em;font-weight:600}
.farrow span{font-size:10px} .sm-t{font-size:10px;line-height:1.55}
table.tr th.c1{font-family:var(--sans);font-size:10px;letter-spacing:.06em}
/* 호스팅 카드는 세로 세 줄로 — 좁은 카드에선 가나가 두세 글자씩 끊긴다 */
.host{grid-template-columns:1fr;gap:8px} .host .card{display:grid;grid-template-columns:30px 150px 1fr;align-items:baseline;padding:11px 16px} .host h3{margin-top:0} .host .card p:not(.tag){margin-top:0}
` : ''}`;
}

// ── 빌드 ────────────────────────────────────────────────────────────────
(async () => {
    fs.mkdirSync(OUT, { recursive: true }); if (PNG) fs.mkdirSync(path.join(OUT, 'preview'), { recursive: true });
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    let warn = 0;
    try {
        for (const lang of LANGS) for (const cut of CUTS) {
            const base = `PACE_RISE_Node_Catalogue_2026_${lang.toUpperCase()}${cut === 'event' ? '_8p' : ''}`;
            const htmlPath = path.join(OUT, base + '.html');
            fs.writeFileSync(htmlPath, html(lang, cut));
            const page = await browser.newPage();
            await page.setViewport({ width: 1123, height: 794, deviceScaleFactor: 2 });
            await page.goto(url(htmlPath), { waitUntil: 'networkidle0' });
            await page.evaluate(() => document.fonts.ready);
            // 검사: 깨진 이미지 · 안 실린 글꼴 · 쪽을 넘친 글
            const issues = await page.evaluate(() => {
                const out = [];
                for (const im of document.images) if (!im.complete || !im.naturalWidth) out.push('image not loaded: ' + im.src.split('/').slice(-2).join('/'));
                for (const f of ['400 12px "Pretendard Std"', '600 12px "Pretendard Std"', '12px Audiowide']) if (!document.fonts.check(f)) out.push('font not loaded: ' + f);
                document.querySelectorAll('.page').forEach((pg, i) => {
                    const body = pg.querySelector('.body'), lim = body.getBoundingClientRect(), pr = pg.getBoundingClientRect();
                    let maxB = 0, maxR = 0;
                    body.querySelectorAll('*').forEach(el => { if (el.closest('.crop') && el.tagName === 'IMG') return; const r = el.getBoundingClientRect(); if (r.width && r.height) { maxB = Math.max(maxB, r.bottom); maxR = Math.max(maxR, r.right); } });
                    if (maxB > lim.bottom + 1) out.push(`overflow p${i + 1} (${pg.dataset.key}): ${Math.round(maxB - lim.bottom)}px below the body`);
                    if (maxR > pr.right - 59) out.push(`overflow p${i + 1} (${pg.dataset.key}): ${Math.round(maxR - (pr.right - 60))}px past the right margin`);
                });
                return out;
            });
            for (const m of issues) { warn++; console.log(`  ! ${base}: ${m}`); }
            if (PNG) { const els = await page.$$('.page'); for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: path.join(OUT, 'preview', `${lang}_${cut}_${String(i + 1).padStart(2, '0')}.png`) }); }
            await page.pdf({ path: path.join(OUT, base + '.pdf'), width: '297mm', height: '210mm', printBackground: true, preferCSSPageSize: true });
            const n = await page.$$eval('.page', a => a.length);
            console.log(`OK ${base}.pdf  ${n} pages  ${(fs.statSync(path.join(OUT, base + '.pdf')).size / 1048576).toFixed(1)} MB`);
            await page.close();
        }
    } finally { await browser.close(); }
    console.log(warn ? `\n${warn} warning(s) — 위 항목을 고친 뒤 다시 빌드한다` : '\nno warnings');
    console.log('out: ' + OUT);
})().catch(e => { console.error(e); process.exit(1); });
