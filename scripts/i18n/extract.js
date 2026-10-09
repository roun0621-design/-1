#!/usr/bin/env node
'use strict';
/**
 * 한국어 원문 추출 — public/*.html·*.js 에서 화면에 나갈 수 있는 한국어 문장을 모아 사전 뼈대를 만든다 (2026-09-30, B3)
 *   node scripts/i18n/extract.js                → scripts/i18n/ko_strings.json  { "원문": { count, files:[…] } }
 *   node scripts/i18n/extract.js --missing en   → en.json 에 없는 원문만 stdout (JSON 배열)
 *   node scripts/i18n/extract.js --stats        → 파일별 원문 수·번역 완료율
 *
 * 추출 규칙
 *   - HTML: 태그 사이 텍스트(>…<), placeholder/title/aria-label/alt/value 속성값
 *   - JS(인라인 <script> 포함): '…' "…" 문자열 리터럴, `…` 템플릿 리터럴은 ${…} 을 {0},{1}… 로 바꿔 패턴 키로
 *   - 한글이 든 것만. HTML 조각(<…>)이 든 문자열은 태그를 기준으로 잘라 조각별로
 *   - 주석·console.log·opLog·API 경로·CSS 는 제외
 */
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', '..', 'public');
const OUT = path.join(__dirname, 'ko_strings.json');
const HANGUL = /[가-힣]/;
const SKIP_FILES = new Set(['i18n.js', 'sw.js', 'lib']);

function add(map, text, file) {
    let s = String(text).replace(/\s+/g, ' ').trim();
    if (!s || !HANGUL.test(s) || s.length > 160) return;
    if (!map[s]) map[s] = { count: 0, files: [] };
    map[s].count++;
    if (!map[s].files.includes(file)) map[s].files.push(file);
}
// HTML 조각이 든 문자열 → 태그 밖의 텍스트 조각 + 속성값
function splitHtml(str) {
    const out = [];
    const attrRe = /(?:placeholder|title|aria-label|alt|value)\s*=\s*"([^"]*)"/g; let m;
    while ((m = attrRe.exec(str))) out.push(m[1]);
    str.split(/<[^>]*>/).forEach(seg => out.push(seg));
    return out;
}
function extractJs(src, file, map) {
    // 주석 제거(대략): // … 줄 끝, /* … */
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
    // console.log / opLog / audit 호출 줄은 제외
    src = src.split('\n').filter(l => !/console\.(log|warn|error)|opLog\(|audit\(/.test(l)).join('\n');
    // 템플릿 리터럴 (중첩 ${`…`} 은 단순 처리)
    const tpl = /`((?:[^`\\]|\\.)*)`/g; let m;
    while ((m = tpl.exec(src))) {
        let i = 0;
        const body = m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`);
        for (const piece of splitHtml(body)) {
            // 자리표시자만 있거나 한글 없는 조각 제외; 조각 안의 {n} 번호는 0부터 다시
            if (!HANGUL.test(piece)) continue;
            let j = 0; const norm = piece.replace(/\{\d+\}/g, () => `{${j++}}`);
            add(map, norm, file);
        }
    }
    const lit = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
    while ((m = lit.exec(src))) {
        const s = (m[1] != null ? m[1] : m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"');
        if (!HANGUL.test(s)) continue;
        if (/^\/api\//.test(s)) continue;
        for (const piece of splitHtml(s)) add(map, piece, file);
    }
}
function extractHtml(src, file, map) {
    // 인라인 스크립트
    const scripts = []; src = src.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body) => { scripts.push(body); return ''; });
    scripts.forEach(b => extractJs(b, file, map));
    src = src.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const piece of splitHtml(src)) add(map, piece, file);
}
function run() {
    const map = {};
    for (const f of fs.readdirSync(PUB)) {
        if (SKIP_FILES.has(f)) continue;
        const p = path.join(PUB, f);
        if (fs.statSync(p).isDirectory()) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (f.endsWith('.html')) extractHtml(src, f, map);
        else if (f.endsWith('.js')) extractJs(src, f, map);
    }
    return map;
}
const args = process.argv.slice(2);
const map = run();
if (args[0] === '--missing') {
    const lang = args[1] || 'en';
    let dict = {}; try { dict = JSON.parse(fs.readFileSync(path.join(PUB, 'locales', lang + '.json'), 'utf8')); } catch (e) {}
    const filt = args[2] ? s => map[s].files.some(f => args.slice(2).includes(f)) : () => true;
    const missing = Object.keys(map).filter(s => dict[s] == null && filt(s)).sort((a, b) => map[b].count - map[a].count);
    process.stdout.write(JSON.stringify(missing, null, 1) + '\n');
} else if (args[0] === '--stats') {
    const langs = ['en', 'ja']; const dicts = {};
    for (const l of langs) { try { dicts[l] = JSON.parse(fs.readFileSync(path.join(PUB, 'locales', l + '.json'), 'utf8')); } catch (e) { dicts[l] = {}; } }
    const byFile = {};
    for (const [s, v] of Object.entries(map)) for (const f of v.files) { byFile[f] = byFile[f] || { total: 0, en: 0, ja: 0 }; byFile[f].total++; for (const l of langs) if (dicts[l][s] != null) byFile[f][l]++; }
    const rows = Object.entries(byFile).sort((a, b) => b[1].total - a[1].total);
    console.log('file'.padEnd(28), 'total', 'en%', 'ja%');
    for (const [f, c] of rows) console.log(f.padEnd(28), String(c.total).padStart(5), String(Math.round(100 * c.en / c.total)).padStart(3), String(Math.round(100 * c.ja / c.total)).padStart(3));
    console.log('TOTAL'.padEnd(28), String(Object.keys(map).length).padStart(5), String(Math.round(100 * Object.keys(map).filter(s => dicts.en[s] != null).length / Object.keys(map).length)).padStart(3), String(Math.round(100 * Object.keys(map).filter(s => dicts.ja[s] != null).length / Object.keys(map).length)).padStart(3));
} else {
    fs.writeFileSync(OUT, JSON.stringify(map, null, 1));
    console.log(`${Object.keys(map).length} strings → ${path.relative(process.cwd(), OUT)}`);
}
