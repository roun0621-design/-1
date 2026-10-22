'use strict';
/**
 * PDF 라틴 확장 글리프 폴백 (2026-10-22) — 문서 글꼴(나눔스퀘어)에 é·ü·ñ 같은 라틴 확장 글자가 없어 영문 문서에서 깨지던 것.
 *   installLatinFallback(doc) 를 PDFDocument 를 만든 직후 한 번 부르면, 이후 doc.text()/widthOfString()/heightOfString() 이
 *   한글 없이 라틴 확장 글자가 든 문자열을 만날 때만 Noto Sans(Regular/Bold)로 바꿔 그리고 원래 글꼴로 되돌린다.
 *   굵기는 마지막 doc.font() 이름에 'B'/'Bold' 가 있는지로 본다(나눔스퀘어 acB · NotoB · 경로 끝 acB.ttf).
 */
const path = require('path');
const fs = require('fs');
const NOTO_R = path.join(__dirname, '..', 'public', 'fonts', 'NotoSans-Regular.ttf');
const NOTO_B = path.join(__dirname, '..', 'public', 'fonts', 'NotoSans-Bold.ttf');
const NEEDS = /[À-ɏḀ-ỿͰ-ϿЀ-ӿ]/;   // 라틴-1 보충·확장 A/B·추가, 그리스, 키릴
const HANGUL = /[ㄱ-ㆎ가-힣]/;

function installLatinFallback(doc) {
    if (!doc || doc.__latinFallback || !fs.existsSync(NOTO_R)) return doc;
    doc.__latinFallback = true;
    doc.registerFont('PR_NotoR', NOTO_R);
    if (fs.existsSync(NOTO_B)) doc.registerFont('PR_NotoB', NOTO_B);
    const origFont = doc.font.bind(doc);
    doc.__curFont = null;
    doc.font = function (src, ...rest) { if (typeof src === 'string' && !/^PR_Noto/.test(src)) doc.__curFont = src; return origFont(src, ...rest); };
    const wrap = (m) => {
        const orig = doc[m].bind(doc);
        doc[m] = function (text, ...rest) {
            // text() 안에서 widthOfString() 이 다시 불린다 — 안쪽 호출이 글꼴을 되돌리면 정작 그릴 때 원래 글꼴이라 깨진다 → 바깥 호출만 바꾼다
            if (doc.__inFallback || typeof text !== 'string' || !NEEDS.test(text) || HANGUL.test(text)) return orig(text, ...rest);
            const cur = doc.__curFont, size = doc._fontSize;
            const bold = /(acB|Bold|B)(\.ttf|\.otf)?$/i.test(String(cur || '')) && !/acR|Regular/i.test(String(cur || ''));
            origFont(bold && fs.existsSync(NOTO_B) ? 'PR_NotoB' : 'PR_NotoR');
            doc.__inFallback = true;
            try { return orig(text, ...rest); }
            finally { doc.__inFallback = false; if (cur) origFont(cur); if (size) doc.fontSize(size); }
        };
    };
    ['text', 'widthOfString', 'heightOfString'].forEach(wrap);
    return doc;
}
module.exports = { installLatinFallback, NEEDS };
