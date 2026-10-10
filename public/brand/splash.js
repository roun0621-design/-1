/**
 * 시작 스플래시 (2026-10-10, 브랜드 필름의 '결승선 바가 갈라지며 심볼이 되는' 장면)
 *   홈·대시보드에 <body> 바로 아래에서 동기 실행 → 첫 그리기 전에 라인 화이트 막을 덮고, 바(트랙 블랙)가 올라온 뒤 55° 로 갈라져
 *   윗조각이 위로 미끄러지며 타탄 심볼이 되고 막이 걷힌다(약 1.4초). 세션당 한 번, 축소된 동작 선호(prefers-reduced-motion)·iframe·?nosplash=1 이면 건너뜀.
 *   기하는 /brand/symbol-tartan.svg 와 같은 좌표계(최종 모양이 심볼과 정확히 일치): 바 24×68 → 아래조각 38,92 62,92 62,36.86 38,71.14 / 윗조각 translate(6.31,-17.01)
 */
(function () {
    try {
        if (window.top !== window) return;
        if (/[?&]nosplash=1/.test(location.search)) return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        if (sessionStorage.getItem('pr_splash') === '1') return;
        if (document.getElementById('pr-splash')) return;
    } catch (e) { return; }
    // 세션 표시는 끝까지 보여 준 뒤에 남긴다 — 첫 화면이 중간에 다시 읽히면(언어 전환 등) 다음 로드에서 온전히 한 번 보여 주기 위해
    function markDone() { try { sessionStorage.setItem('pr_splash', '1'); } catch (e) {} }
    var css = '#pr-splash{position:fixed;inset:0;z-index:99999;background:#F4F3EF;display:flex;align-items:center;justify-content:center;pointer-events:none;' +
        'animation:prs-out .35s ease 1.15s both}' +
        '#pr-splash svg{width:64px;height:132px;overflow:visible}' +
        '#pr-splash .prs-bar{fill:#0E0E10;transform-box:fill-box;transform-origin:50% 100%;animation:prs-draw .32s cubic-bezier(.33,1,.68,1) both,prs-hide 0s .48s both}' +
        '#pr-splash .prs-lo,#pr-splash .prs-up{fill:#0E0E10;opacity:0;animation:prs-show 0s .48s both,prs-tartan .45s ease .5s both}' +
        '#pr-splash .prs-upg{animation:prs-slide .75s cubic-bezier(.22,1,.36,1) .48s both}' +
        '#pr-splash .prs-gap{fill:#C24A2E;opacity:0;animation:prs-glow .9s ease-out .48s both}' +
        '@keyframes prs-draw{from{transform:scaleY(0)}to{transform:scaleY(1)}}' +
        '@keyframes prs-hide{to{opacity:0}}@keyframes prs-show{to{opacity:1}}' +
        '@keyframes prs-tartan{to{fill:#C24A2E}}' +
        '@keyframes prs-slide{to{transform:translate(6.31px,-17.01px)}}' +
        '@keyframes prs-glow{0%{opacity:0}8%{opacity:.55}100%{opacity:0}}' +
        '@keyframes prs-out{to{opacity:0;visibility:hidden}}';
    var html = '<svg viewBox="26 -8 54 108" aria-hidden="true">' +
        '<polygon class="prs-gap" points="38,71.14 62,36.86 68.31,19.85 44.31,54.13"/>' +
        '<rect class="prs-bar" x="38" y="24" width="24" height="68"/>' +
        '<polygon class="prs-lo" points="38,92 62,92 62,36.86 38,71.14"/>' +
        '<g class="prs-upg"><polygon class="prs-up" points="38,71.14 62,36.86 62,24 38,24"/></g>' +
        '</svg>';
    var st = document.createElement('style'); st.textContent = css;
    var el = document.createElement('div'); el.id = 'pr-splash'; el.innerHTML = html;
    var root = document.body || document.documentElement;
    root.appendChild(st); root.appendChild(el);
    var gone = false;
    function remove() { if (gone) return; gone = true; markDone(); try { el.remove(); st.remove(); } catch (e) {} }
    el.addEventListener('animationend', function (ev) { if (ev.target === el) remove(); });
    setTimeout(markDone, 1200);   // 막이 걷히기 시작한 뒤면 본 것으로 친다
    setTimeout(remove, 2200);
})();
