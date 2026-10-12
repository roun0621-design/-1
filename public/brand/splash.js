/**
 * 시작 스플래시 (2026-10-10, 2026-10-12 재구성 — "흰 바탕, 검은 막대가 점점 타탄으로 채워지고 마지막에 금이 가면서 0.7초쯤 보여 주고 들어간다")
 *   홈·대시보드에 <body> 바로 아래에서 동기 실행 → 첫 그리기 전에 라인 화이트 막을 덮는다.
 *   순서: 트랙 블랙 바가 올라옴(0.25초) → 아래서부터 타탄으로 차오름(0.8초) → 55° 로 금이 가며 윗조각이 미끄러짐(0.4초) → 심볼 + 워드마크 0.7초 → 막이 걷힘(0.3초). 총 ≈2.3초.
 *   세션당 한 번(끝까지 본 뒤 표시), 축소된 동작 선호(prefers-reduced-motion)·iframe·?nosplash=1 이면 건너뜀. 클릭은 통과.
 *   기하는 /brand/symbol-tartan.svg 와 같은 좌표계(끝 모양이 심볼과 정확히 일치): 바 24×68 → 아래조각 38,92 62,92 62,36.86 38,71.14 / 윗조각 translate(6.31,-17.01)
 */
(function () {
    try {
        if (window.top !== window) return;
        if (/[?&]nosplash=1/.test(location.search)) return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        if (sessionStorage.getItem('pr_splash') === '1') return;
        if (document.getElementById('pr-splash')) return;
    } catch (e) { return; }
    function markDone() { try { sessionStorage.setItem('pr_splash', '1'); } catch (e) {} }
    var T_FILL = 0.25, T_SPLIT = 1.05, T_OUT = 2.0;   // 초: 채우기 시작 / 금 가는 시점 / 막 걷기 시작
    var css = '#pr-splash{position:fixed;inset:0;z-index:99999;background:#F4F3EF;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;pointer-events:none;' +
        'animation:prs-out .3s ease ' + T_OUT + 's both}' +
        '#pr-splash svg{width:64px;height:132px;overflow:visible}' +
        '#pr-splash .prs-bar{fill:#0E0E10;transform-box:fill-box;transform-origin:50% 100%;animation:prs-draw .25s cubic-bezier(.33,1,.68,1) both,prs-hide 0s ' + T_SPLIT + 's both}' +
        '#pr-splash .prs-fill{fill:#C24A2E;transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(0);animation:prs-draw .8s cubic-bezier(.4,0,.2,1) ' + T_FILL + 's both,prs-hide 0s ' + T_SPLIT + 's both}' +
        '#pr-splash .prs-lo,#pr-splash .prs-up{fill:#C24A2E;opacity:0;animation:prs-show 0s ' + T_SPLIT + 's both}' +
        '#pr-splash .prs-upg{animation:prs-slide .4s cubic-bezier(.22,1,.36,1) ' + T_SPLIT + 's both}' +
        '#pr-splash .prs-gap{fill:#F4F3EF;opacity:0;animation:prs-glow .6s ease-out ' + T_SPLIT + 's both}' +
        '#pr-splash .prs-wm{height:18px;width:auto;opacity:0;animation:prs-rise .4s ease-out ' + (T_SPLIT + 0.15) + 's both}' +
        '@keyframes prs-draw{from{transform:scaleY(0)}to{transform:scaleY(1)}}' +
        '@keyframes prs-hide{to{opacity:0}}@keyframes prs-show{to{opacity:1}}' +
        '@keyframes prs-slide{to{transform:translate(6.31px,-17.01px)}}' +
        '@keyframes prs-glow{0%{opacity:0}15%{opacity:.9}100%{opacity:0}}' +
        '@keyframes prs-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
        '@keyframes prs-out{to{opacity:0;visibility:hidden}}';
    var html = '<svg viewBox="26 -8 54 108" aria-hidden="true">' +
        '<rect class="prs-bar" x="38" y="24" width="24" height="68"/>' +
        '<rect class="prs-fill" x="38" y="24" width="24" height="68"/>' +
        '<polygon class="prs-gap" points="38,71.14 62,36.86 68.31,19.85 44.31,54.13"/>' +
        '<polygon class="prs-lo" points="38,92 62,92 62,36.86 38,71.14"/>' +
        '<g class="prs-upg"><polygon class="prs-up" points="38,71.14 62,36.86 62,24 38,24"/></g>' +
        '</svg>' +
        '<img class="prs-wm" src="/brand/wordmark.svg" alt="PACE RISE">';
    var st = document.createElement('style'); st.textContent = css;
    var el = document.createElement('div'); el.id = 'pr-splash'; el.innerHTML = html;
    var root = document.body || document.documentElement;
    root.appendChild(st); root.appendChild(el);
    var gone = false;
    function remove() { if (gone) return; gone = true; markDone(); try { el.remove(); st.remove(); } catch (e) {} }
    el.addEventListener('animationend', function (ev) { if (ev.target === el) remove(); });
    setTimeout(markDone, T_OUT * 1000);   // 막이 걷히기 시작한 뒤면 본 것으로 친다
    setTimeout(remove, T_OUT * 1000 + 900);
})();
