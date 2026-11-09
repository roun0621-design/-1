'use strict';
/**
 * Code 128 (B세트) 바코드 — ID카드(AD카드)에 실제로 스캔되는 바코드를 그리기 위한 최소 구현. 외부 의존성 없음.
 *   encode(text)  → 막대/공백 폭 배열 [2,1,1,2,1,4, ...] (짝수 인덱스 = 막대, 홀수 = 공백), 단위 = 모듈
 *   drawPdf(doc, text, x, y, { width, height }) → pdfkit 문서에 그린다. 그렸으면 true, 표현 못 하는 값이면 false
 * B세트는 ASCII 32~126 만 표현한다. 한글 등 그 밖의 문자가 있으면 encode 가 null 을 돌려준다(호출부가 배번으로 대체).
 */
const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104, STOP = 106;

/** 코드값 배열(시작·체크섬·정지 포함). 표현 못 하면 null */
function codewords(text) {
    const s = String(text == null ? '' : text);
    if (!s || s.length > 40) return null;
    const vals = [];
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c < 32 || c > 126) return null;
        vals.push(c - 32);
    }
    let sum = START_B;
    vals.forEach((v, i) => { sum += v * (i + 1); });
    return [START_B, ...vals, sum % 103, STOP];
}

function encode(text) {
    const cw = codewords(text);
    if (!cw) return null;
    const widths = [];
    cw.forEach(c => { for (const d of PATTERNS[c]) widths.push(Number(d)); });
    return widths;
}

/** 조용한 영역(양쪽 10모듈)을 포함해 width 안에 맞춰 그린다. 모듈이 너무 가늘어지면(0.6pt 미만) 스캔이 안 되므로 그리지 않는다. */
function drawPdf(doc, text, x, y, opts = {}) {
    const widths = encode(text);
    if (!widths) return false;
    const QUIET = 10;
    const total = widths.reduce((a, b) => a + b, 0) + QUIET * 2;
    const boxW = opts.width || 200, h = opts.height || 28;
    const mod = Math.min(opts.maxModule || 1.4, boxW / total);
    if (mod < 0.6) return false;
    let cx = x + (boxW - total * mod) / 2 + QUIET * mod;
    doc.save();
    doc.rect(x + (boxW - total * mod) / 2, y - 2, total * mod, h + 4).fill('#ffffff');     // 띠·배경 위에서도 읽히게 흰 바탕
    widths.forEach((w, i) => {
        if (i % 2 === 0) doc.rect(cx, y, w * mod, h).fill('#000000');
        cx += w * mod;
    });
    doc.restore();
    return true;
}

module.exports = { encode, codewords, drawPdf, PATTERNS };
