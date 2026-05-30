#!/usr/bin/env node
/**
 * 프로그램 전체의 이모지를 Lucide 스타일 인라인 SVG 아이콘으로 치환합니다.
 *
 * 안전 규칙 (v2):
 *  - 정규식 character class [...] 안에 있는 이모지는 보존 (데이터 정규화용)
 *  - 식별자/locale 비교 등 코드 의미가 있는 위치는 사람이 보고 결정
 *  - 그 외 모든 UI/HTML/텍스트 출력 이모지 → SVG 치환
 *
 * 동작 모드:
 *  --dry  : 변경 없이 미리보기
 *  기본    : 적용 + 저장
 *
 * 제외:
 *  - public/lib/*  (외부 라이브러리)
 *  - public/sw.js
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const ROOT = path.join(__dirname, '..', 'public');

// ============================================================
// 1) Lucide 스타일 SVG path 매핑 (24x24, 1.7px stroke, currentColor)
// ============================================================
const SVG_PATHS = {
    check:      '<polyline points="20 6 9 17 4 12"/>',
    close:      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    skip:       '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
    pencil:     '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    warn:       '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    bolt:       '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    search:     '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    settings:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    wrench:     '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    shuffle:    '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
    broom:      '<path d="M19.4 2.6l2 2L9 17H7v-2L19.4 2.6z"/><path d="M9 17l-3 5 5-3"/><path d="M3 22l3-3"/>',
    folder:     '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    file:       '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    archive:    '<rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><line x1="10" y1="13" x2="14" y2="13"/>',
    calendar:   '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    chart:      '<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>',
    clipboard:  '<rect x="6" y="3" width="12" height="18" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/>',
    pin:        '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    lock:       '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    unlock:     '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    link:       '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    runner:     '<circle cx="13" cy="4" r="2"/><path d="M4 22l4-9 5 2 3-3 4 8"/><path d="M8 13l-2-5 4-2"/>',
    trophy:     '<path d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a2 2 0 0 0-2 2v1a3 3 0 0 0 3 3h2"/><path d="M17 6h3a2 2 0 0 1 2 2v1a3 3 0 0 1-3 3h-2"/><path d="M10 17h4v4h-4z"/><path d="M8 21h8"/>',
    bulb:       '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c1 .8 1 2 1 3.3h6c0-1.3 0-2.5 1-3.3A7 7 0 0 0 12 2z"/>',
    wind:       '<path d="M9.59 4.59A2 2 0 1 1 11 8H2"/><path d="M17.73 2.27A2.5 2.5 0 1 1 19.5 7H2"/><path d="M14.83 21.41A2 2 0 1 0 16.24 18H2"/>',
    printer:    '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    image:      '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    wifi:       '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    hourglass:  '<path d="M6 2h12"/><path d="M6 22h12"/><path d="M6 2v4a6 6 0 0 0 12 0V2"/><path d="M6 22v-4a6 6 0 0 1 12 0v4"/>',
    dotRed:     '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
    dotYellow:  '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
    starFill:   '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/>',
    starLine:   '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    flag:       '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    target:     '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    female:     '<circle cx="12" cy="9" r="6"/><line x1="12" y1="15" x2="12" y2="22"/><line x1="9" y1="19" x2="15" y2="19"/>',
    male:       '<circle cx="10" cy="14" r="6"/><line x1="14.5" y1="9.5" x2="21" y2="3"/><polyline points="15 3 21 3 21 9"/>',
    kbd:        '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10.01"/><line x1="10" y1="10" x2="10" y2="10.01"/><line x1="14" y1="10" x2="14" y2="10.01"/><line x1="18" y1="10" x2="18" y2="10.01"/><line x1="6" y1="14" x2="18" y2="14"/>',
    trash:      '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

const EMOJI_TO_ICON = {
    '✓':'check','✅':'check','✗':'close','✖':'close','✕':'close','❌':'close',
    '⏭':'skip','✏':'pencil','⚠':'warn','⚡':'bolt',
    '🔍':'search','⚙':'settings','🔧':'wrench','🔀':'shuffle','🧹':'broom',
    '📂':'folder','📄':'file','🗂':'archive','📅':'calendar','📊':'chart','📋':'clipboard','📍':'pin',
    '🔒':'lock','🔓':'unlock','🔗':'link',
    '🏃':'runner','🏆':'trophy',
    '💡':'bulb','💨':'wind',
    '🖨':'printer','🖼':'image',
    '📡':'wifi','⏳':'hourglass',
    '🔴':'dotRed','🟡':'dotYellow',
    '★':'starFill','☆':'starLine',
    '⚑':'flag','⌖':'target',
    '♀':'female','♂':'male',
    '⌘':'kbd','🗑':'trash',
};

const COLOR_HINT = {
    check:'#16a34a', close:'#dc2626', warn:'#d97706',
    dotRed:'#dc2626', dotYellow:'#eab308',
    starFill:'#eab308',
};

function makeIcon(key, size = 14) {
    const svgPath = SVG_PATHS[key];
    if (!svgPath) return null;
    const color = COLOR_HINT[key];
    const colorAttr = color ? ` style="color:${color};"` : '';
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${colorAttr} class="ui-emoji">${svgPath}</svg>`;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// 안전 영역 마스킹: 정규식 character class [...] 안의 이모지는 건드리지 않음
// 전략: 텍스트를 토큰화하여
//   (1) 정규식 리터럴 /.../ 안의 [..] 블록
//   (2) new RegExp("[...]") 안
//   (3) 'replace(/[...]/, ...)' 류
// 을 식별해서 마스킹.
//
// 더 단순하고 안전한 접근:
//   파일을 라인 단위로 보지 말고, 정규식 리터럴만 찾아서 그 내용을 placeholder로 치환 → 치환 후 복원
// ============================================================

function maskRegexLiterals(src) {
    // JS 정규식 리터럴: /pattern/flags
    // 단순 구현: 라인 안에서 '=', '(', ',', 'return ', ':' 직후 또는 줄 시작에서 시작하는 / 부터 escape되지 않은 / 까지
    // 그러나 HTML 안의 //comment, JSX 등 복잡 — 보수적으로 처리
    const tokens = [];
    let out = '';
    let i = 0;
    const n = src.length;

    // 간단한 상태 머신
    let mode = 'code'; // code | sgl | dbl | tpl | lineComment | blockComment | regex

    function pushToken(s) {
        const id = `\u0001RX${tokens.length}\u0002`;
        tokens.push(s);
        return id;
    }

    while (i < n) {
        const c = src[i];
        const c2 = src[i] + (src[i+1] || '');

        if (mode === 'code') {
            // 주석 시작
            if (c2 === '//') { out += c2; i += 2; mode = 'lineComment'; continue; }
            if (c2 === '/*') { out += c2; i += 2; mode = 'blockComment'; continue; }
            // 문자열 시작
            if (c === '"')  { out += c; i++; mode = 'dbl'; continue; }
            if (c === "'")  { out += c; i++; mode = 'sgl'; continue; }
            if (c === '`')  { out += c; i++; mode = 'tpl'; continue; }
            // 정규식 리터럴 후보: / 앞이 식별자/숫자/) 가 아니면 정규식으로 추정
            if (c === '/') {
                // 이전 비공백 토큰 확인 → 정규식인지 나누기인지 판단
                // 보수적: 이전 의미있는 문자 검사
                let k = out.length - 1;
                while (k >= 0 && /\s/.test(out[k])) k--;
                const prev = k >= 0 ? out[k] : '';
                const isRegex = prev === '' ||
                    /[=({[,!&|?:;+*%^~<>]/.test(prev) ||
                    // 'return /.../' 같은 키워드 뒤
                    (k >= 5 && /\b(return|typeof|in|of|instanceof|new|throw|delete|void|do|else|case|yield|await)\s*$/.test(out.slice(Math.max(0,k-15), k+1)));
                if (isRegex) {
                    // 정규식 리터럴 끝 찾기
                    let j = i + 1;
                    let inCharClass = false;
                    while (j < n) {
                        const ch = src[j];
                        if (ch === '\\') { j += 2; continue; }
                        if (ch === '[') inCharClass = true;
                        else if (ch === ']') inCharClass = false;
                        else if (ch === '/' && !inCharClass) break;
                        else if (ch === '\n') break; // 정규식은 한 줄
                        j++;
                    }
                    if (j < n && src[j] === '/') {
                        // flags
                        let k2 = j + 1;
                        while (k2 < n && /[gimsuy]/.test(src[k2])) k2++;
                        const literal = src.slice(i, k2);
                        out += pushToken(literal);
                        i = k2;
                        continue;
                    }
                }
                // 정규식 아니면 그냥 /
                out += c; i++; continue;
            }
            out += c; i++; continue;
        }
        if (mode === 'lineComment') {
            out += c; i++;
            if (c === '\n') mode = 'code';
            continue;
        }
        if (mode === 'blockComment') {
            out += c; i++;
            if (c === '*' && src[i] === '/') { out += '/'; i++; mode = 'code'; }
            continue;
        }
        if (mode === 'sgl') {
            out += c; i++;
            if (c === '\\') { if (i < n) { out += src[i]; i++; } continue; }
            if (c === "'") mode = 'code';
            continue;
        }
        if (mode === 'dbl') {
            out += c; i++;
            if (c === '\\') { if (i < n) { out += src[i]; i++; } continue; }
            if (c === '"') mode = 'code';
            continue;
        }
        if (mode === 'tpl') {
            out += c; i++;
            if (c === '\\') { if (i < n) { out += src[i]; i++; } continue; }
            if (c === '`') mode = 'code';
            continue;
        }
    }
    return { masked: out, tokens };
}

function unmaskRegexLiterals(masked, tokens) {
    return masked.replace(/\u0001RX(\d+)\u0002/g, (_, n) => tokens[Number(n)]);
}

// HTML 파일은 <script>...</script> 블록 내부만 마스킹 처리
function processHtml(src) {
    const scriptRe = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;
    return src.replace(scriptRe, (whole, open, body, close) => {
        if (/\bsrc\s*=/.test(open)) return whole; // 외부 src는 본문 없음
        const { masked, tokens } = maskRegexLiterals(body);
        // 1) HTML 텍스트 영역(즉 마스킹된 body 내) 의 이모지를 치환할 때 정규식 안은 보존
        const replaced = replaceEmojisInText(masked);
        return open + unmaskRegexLiterals(replaced, tokens) + close;
    }).replace(/(<\/script>|^)([\s\S]*?)(?=<script\b|$)/gi, (whole, lead, htmlPart) => {
        // 위 첫 replace에서 이미 script 블록 안은 처리됨
        // 여기서는 그 외 HTML 텍스트 영역의 이모지 치환을 시도
        // 그러나 .replace가 위와 중복돼서 정확한 슬라이싱이 복잡 → 다른 접근으로 변경 (아래)
        return whole;
    });
}

// 더 간단/안정적 접근: 전체 파일 단위로
//   1) 정규식 리터럴 마스킹
//   2) 전체 이모지 치환
//   3) 마스킹 복원
function processFile(src, ext) {
    if (ext === '.js') {
        const { masked, tokens } = maskRegexLiterals(src);
        const replaced = replaceEmojisInText(masked);
        return unmaskRegexLiterals(replaced, tokens);
    }
    if (ext === '.html') {
        // HTML 파일: <script> 블록 안만 마스킹, 외부 텍스트는 그대로 치환
        const scriptRe = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;
        // 1단계: script 블록을 placeholder로 치환
        const blocks = [];
        const placeheld = src.replace(scriptRe, (whole, open, body, close) => {
            if (/\bsrc\s*=/.test(open) || !body.trim()) {
                blocks.push(whole);
                return `\u0001SC${blocks.length-1}\u0002`;
            }
            const { masked, tokens } = maskRegexLiterals(body);
            const replacedBody = replaceEmojisInText(masked);
            const finalBody = unmaskRegexLiterals(replacedBody, tokens);
            blocks.push(open + finalBody + close);
            return `\u0001SC${blocks.length-1}\u0002`;
        });
        // 2단계: 남은 HTML 부분의 이모지 치환
        const replaced = replaceEmojisInText(placeheld);
        // 3단계: script 블록 복원
        return replaced.replace(/\u0001SC(\d+)\u0002/g, (_, n) => blocks[Number(n)]);
    }
    if (ext === '.css') {
        return replaceEmojisInText(src);
    }
    return src;
}

function replaceEmojisInText(text) {
    let out = text;
    for (const [emoji, iconKey] of Object.entries(EMOJI_TO_ICON)) {
        const svg = makeIcon(iconKey);
        if (!svg) continue;
        const pattern = new RegExp(escapeRegex(emoji) + '\\uFE0F?', 'g');
        out = out.replace(pattern, svg);
    }
    // 남은 외로운 variation selector 제거
    out = out.replace(/\uFE0F/g, '');
    return out;
}

// ============================================================
// 파일 순회
// ============================================================
const FILES = [
    'admin.html','callroom-monitor.html','callroom.html','dashboard.html','display-manage.html',
    'index.html','monitor.html','og-preview.html','open.html','oplog.html',
    'overlay-lower-third.html','overlay-scoreboard.html','record.html','results.html',
    'callroom.js','common.js','dashboard.js','record.js','results.js',
];

let grandTotal = 0;
const EMOJI_RE = new RegExp('[' + Object.keys(EMOJI_TO_ICON).map(escapeRegex).join('') + ']', 'g');

for (const fname of FILES) {
    const full = path.join(ROOT, fname);
    if (!fs.existsSync(full)) continue;
    const ext = path.extname(fname);
    const src = fs.readFileSync(full, 'utf8');

    const before = (src.match(EMOJI_RE) || []).length;
    const out = processFile(src, ext);
    const after = (out.match(EMOJI_RE) || []).length;
    const replaced = before - after;

    if (replaced > 0) {
        if (!DRY) fs.writeFileSync(full, out);
        grandTotal += replaced;
        console.log(`  ${replaced.toString().padStart(4)} ${fname}   ${after>0 ? `(보존 ${after}개 - 정규식 등)` : ''}`);
    }
}

console.log(`\n[${DRY?'DRY':'APPLIED'}] 총 ${grandTotal}개 이모지 치환`);
