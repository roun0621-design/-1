/**
 * PaceIcons — 인라인 SVG 아이콘 (2026-09)
 *  이모지 대신 쓰는 얇은 선 아이콘. 색은 currentColor 를 따르므로 글자색·버튼색과 같이 움직인다.
 *  태극기(flagKR)만 실제 태극 색(빨강·남색)을 고정으로 쓴다 — 남색 버튼 위에서도 보이도록 깃면은 흰색.
 *
 *  사용: PaceIcons.svg('bell')                → 1em 크기
 *        PaceIcons.svg('flagKR', { size: 18 })  → px 크기
 *        PaceIcons.svg('warn', { cls: 'x', style: 'color:#b3261e' })
 *  스타일: .ui-icon { display:inline-block; vertical-align:-.15em }  (styles.css)
 */
(function (root) {
    'use strict';
    const A = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    // 태극: 반지름 7, 중심 0,0 — 실제 태극기 방향(빨강 위, 왼쪽 위→오른쪽 아래 사선)
    const TAEGEUK = '<g stroke="none" transform="rotate(33)"><circle r="7" fill="#1a2a5e"/><path d="M-7 0A7 7 0 0 1 7 0A3.5 3.5 0 0 0 0 0A3.5 3.5 0 0 1 -7 0Z" fill="#c8102e"/></g>';
    const PATHS = {
        // 태극기 — 사각 깃면 + 태극 (깃면 흰색 고정)
        flagKR:  `<rect x="3" y="9" width="42" height="30" rx="5" fill="#fff"/><g transform="translate(24 24) scale(1.45)">${TAEGEUK}</g>`,
        // 태극 문양만 (동그란 배지)
        taegeuk: `<g transform="translate(24 24) scale(2.6)">${TAEGEUK}</g>`,
        bell:    '<path d="M12 32V21a12 12 0 0 1 24 0v11l4 5H8z"/><path d="M19 40a5 5 0 0 0 10 0"/>',
        bellOff: '<path d="M12 32V21a12 12 0 0 1 24 0v11l4 5H8z"/><path d="M19 40a5 5 0 0 0 10 0"/><path d="M8 8l32 32"/>',
        calendar:'<rect x="6" y="9" width="36" height="32" rx="6"/><path d="M6 18h36M15 5v8M33 5v8"/>',
        list:    '<rect x="8" y="6" width="32" height="36" rx="5"/><circle cx="17" cy="16" r="2.4" fill="currentColor" stroke="none"/><path d="M23 16h10M17 26h16M17 34h16"/>',
        stopwatch:'<circle cx="24" cy="27" r="15"/><path d="M24 27l7-7M19 5h10M24 5v7M38 13l3-3"/>',
        download:'<rect x="8" y="8" width="32" height="32" rx="9"/><path d="M24 17v14M18 25l6 6 6-6"/>',
        pin:     '<path d="M30 6l12 12-6 2-8 8v10l-4 2-6-6-10 10-2-2 10-10-6-6 2-4h10l8-8z"/>',
        globe:   '<circle cx="24" cy="24" r="18"/><path d="M6 24h36M24 6c6 6 6 30 0 36M24 6c-6 6-6 30 0 36"/>',
        speaker: '<path d="M6 19v10h8l10 8V11l-10 8z"/><path d="M31 18a8 8 0 0 1 0 12M36 13a15 15 0 0 1 0 22"/>',
        camera:  '<rect x="5" y="13" width="38" height="28" rx="5"/><path d="M17 13l3-5h8l3 5"/><circle cx="24" cy="27" r="7"/>',
        warn:    '<path d="M24 6L44 42H4z"/><path d="M24 19v11"/><circle cx="24" cy="36" r="1.6" fill="currentColor" stroke="none"/>',
        check:   '<circle cx="24" cy="24" r="18"/><path d="M15 25l6 6 12-13"/>',
        info:    '<circle cx="24" cy="24" r="18"/><path d="M24 22v12"/><circle cx="24" cy="15" r="1.6" fill="currentColor" stroke="none"/>',
        key:     '<circle cx="17" cy="31" r="9"/><path d="M23 25L41 7M35 13l5 5M30 18l5 5"/>',
        pause:   '<rect x="12" y="9" width="8" height="30" rx="2"/><rect x="28" y="9" width="8" height="30" rx="2"/>',
        play:    '<path d="M14 8l26 16-26 16z"/>',
        doc:     '<path d="M12 4h18l10 10v30H12z"/><path d="M30 4v10h10M18 26h12M18 34h12"/>',
        phone:   '<rect x="13" y="4" width="22" height="40" rx="5"/><path d="M21 38h6"/>',
        ticket:  '<path d="M6 16a4 4 0 0 0 4-4V10h28v2a4 4 0 0 0 4 4v16a4 4 0 0 0-4 4v2H10v-2a4 4 0 0 0-4-4z"/><path d="M19 10v28" stroke-dasharray="3 3"/>',
        eyeOff:  '<path d="M6 24s7-12 18-12 18 12 18 12-7 12-18 12S6 24 6 24z"/><path d="M8 8l32 32"/>',
        wrench:  '<path d="M38 10a10 10 0 0 1-13 12L11 36a3 3 0 0 1-4-4l14-14A10 10 0 0 1 33 5l-5 5 4 4z"/>',
        undo:    '<path d="M18 12H8v10"/><path d="M8 22a16 16 0 1 1 5 16"/>',
        refresh: '<path d="M40 24a16 16 0 1 1-4.7-11.3"/><path d="M40 8v9h-9"/>',
        menu:    '<path d="M9 14h30M9 24h30M9 34h30"/>',
        external:'<path d="M20 8H8v32h32V28"/><path d="M28 8h12v12M40 8L22 26"/>',
        trophy:  '<path d="M14 6h20v12a10 10 0 0 1-20 0z"/><path d="M14 10H6v4a8 8 0 0 0 8 6M34 10h8v4a8 8 0 0 1-8 6M24 28v8M16 42h16M18 36h12"/>',
        search:  '<circle cx="21" cy="21" r="12"/><path d="M30 30l10 10"/>',
        close:   '<path d="M12 12l24 24M36 12L12 36"/>',
        chevronDown:'<path d="M12 18l12 12 12-12"/>',
        chevronRight:'<path d="M18 12l12 12-12 12"/>',
    };
    function esc(s) { return String(s).replace(/"/g, '&quot;'); }
    function svg(name, opts) {
        const p = PATHS[name]; if (!p) return '';
        const o = opts || {};
        const size = o.size ? (typeof o.size === 'number' ? o.size + 'px' : o.size) : '1em';
        const style = (o.style ? esc(o.style) + ';' : '');
        const title = o.title ? `<title>${esc(o.title)}</title>` : '';
        return `<svg class="ui-icon${o.cls ? ' ' + esc(o.cls) : ''}" width="${size}" height="${size}" viewBox="0 0 48 48" ${A} aria-hidden="${o.title ? 'false' : 'true'}"${style ? ` style="${style}"` : ''}>${title}${p}</svg>`;
    }
    const api = { svg, names: Object.keys(PATHS) };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.PaceIcons = api;
})(typeof window !== 'undefined' ? window : globalThis);
