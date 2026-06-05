/**
 * i18n.js — Pace Rise 런타임 다국어 엔진 + 언어 스위처 (빌드 도구 불필요)
 * ------------------------------------------------------------------
 * 사용법: 페이지 끝에 <script src="/i18n.js?v=1"></script> 한 줄만 추가.
 *   - 우측 상단에 🌐 KO/EN/JA 전환기가 자동으로 뜸
 *   - data-i18n="key" 가 붙은 요소를 번역 (텍스트)
 *   - data-i18n-ph="key" → placeholder, data-i18n-title="key" → title 속성
 *
 * 안전 설계(절대 안 깨짐):
 *   - 페이지의 "기존 한국어"를 ko 원본으로 자동 수집한다.
 *   - en/ja 사전에 키가 없으면 한국어 원본으로 폴백한다.
 *   - 따라서 태그를 달아도 최악의 경우 한국어 그대로 표시될 뿐.
 *
 * 확장: 아래 DICT 에 키를 추가하거나, window.PaceI18n.extend({en:{...},ja:{...}}) 호출.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'pace_lang';
    var LANGS = [
        { code: 'ko', label: '한국어', short: 'KO' },
        { code: 'en', label: 'English', short: 'EN' },
        { code: 'ja', label: '日本語', short: 'JA' },
    ];

    // 번역 사전 (ko 는 페이지에서 자동 수집되므로 en/ja 만 정의).
    // 키 네이밍: 도메인.용어 (예: nav.dashboard). 점진 확장 가능.
    var DICT = {
        en: {
            'app.name': 'Pace Rise',
            'nav.home': 'Home',
            'nav.dashboard': 'Dashboard',
            'nav.display-manage': 'Display',
            'nav.results': 'Results',
            'nav.callroom': 'Call Room',
            'nav.monitor': 'Monitor',
            'nav.admin': 'Admin',
            'nav.record': 'Record Entry',
            'nav.login': 'Login',
            'nav.logout': 'Logout',
            'common.male': 'Men', 'common.female': 'Women', 'common.mixed': 'Mixed',
            'common.all': 'All', 'common.search': 'Search', 'common.close': 'Close',
            'common.save': 'Save', 'common.cancel': 'Cancel', 'common.loading': 'Loading…',
            'round.prelim': 'Prelim', 'round.semifinal': 'Semifinal', 'round.final': 'Final',
            'status.upcoming': 'Upcoming', 'status.active': 'In progress', 'status.completed': 'Completed',
            'home.subtitle': 'Athletics Competition Operations',
            'home.competitions': 'Competitions',
            'about.title': 'About P-R : Node',
            'about.h1': 'Live competition results',
            'about.features': 'Key features',
            'about.favorites': 'Favorites',
            'home.about_btn': 'About P-R : Node',
            'home.install_btn': 'Install app',
            'home.manual_btn': 'Operations manual',
            'home.add_comp': '+ Add competition',
            'footer.privacy': 'Privacy policy',
        },
        ja: {
            'app.name': 'Pace Rise',
            'nav.home': 'ホーム',
            'nav.dashboard': 'ダッシュボード',
            'nav.display-manage': '表示管理',
            'nav.results': '結果',
            'nav.callroom': '招集所',
            'nav.monitor': 'モニター',
            'nav.admin': '管理',
            'nav.record': '記録入力',
            'nav.login': 'ログイン',
            'nav.logout': 'ログアウト',
            'common.male': '男子', 'common.female': '女子', 'common.mixed': '混合',
            'common.all': 'すべて', 'common.search': '検索', 'common.close': '閉じる',
            'common.save': '保存', 'common.cancel': 'キャンセル', 'common.loading': '読み込み中…',
            'round.prelim': '予選', 'round.semifinal': '準決勝', 'round.final': '決勝',
            'status.upcoming': '予定', 'status.active': '進行中', 'status.completed': '終了',
            'home.subtitle': '陸上競技 大会運営',
            'home.competitions': '大会一覧',
            'about.title': 'P-R : Node について',
            'about.h1': 'リアルタイム大会結果',
            'about.features': '主な機能',
            'about.favorites': 'お気に入り',
            'home.about_btn': 'P-R : Node について',
            'home.install_btn': 'アプリ設置案内',
            'home.manual_btn': '運営マニュアル',
            'home.add_comp': '+ 大会追加',
            'footer.privacy': 'プライバシー方針',
        },
    };

    var koOriginal = {}; // 페이지에서 자동 수집한 한국어 원본 (key → text)

    function getLang() {
        try { return localStorage.getItem(STORAGE_KEY) || 'ko'; } catch (e) { return 'ko'; }
    }
    function setLangPref(code) {
        try { localStorage.setItem(STORAGE_KEY, code); } catch (e) {}
    }

    function translate(key, lang) {
        if (lang === 'ko') return koOriginal[key];
        var d = DICT[lang];
        if (d && d[key] != null) return d[key];
        return koOriginal[key]; // 폴백: 한국어
    }

    function harvest() {
        // data-i18n 요소의 현재 한국어 텍스트를 1회 수집
        var nodes = document.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) {
            var k = nodes[i].getAttribute('data-i18n');
            if (k && koOriginal[k] == null) koOriginal[k] = nodes[i].textContent.trim();
        }
        // placeholder / title 도 수집
        collectAttr('[data-i18n-ph]', 'data-i18n-ph', 'placeholder');
        collectAttr('[data-i18n-title]', 'data-i18n-title', 'title');
    }
    function collectAttr(sel, dataAttr, domAttr) {
        var nodes = document.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) {
            var k = nodes[i].getAttribute(dataAttr);
            if (k && koOriginal[k] == null) koOriginal[k] = nodes[i].getAttribute(domAttr) || '';
        }
    }

    function apply(lang) {
        var nodes = document.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) {
            var k = nodes[i].getAttribute('data-i18n');
            var v = translate(k, lang);
            if (v != null) nodes[i].textContent = v;
        }
        applyAttr('[data-i18n-ph]', 'data-i18n-ph', 'placeholder', lang);
        applyAttr('[data-i18n-title]', 'data-i18n-title', 'title', lang);
        // 주의: documentElement 의 lang 을 바꾸면 크롬 자동번역이 우리 번역을
        // 다시 덮어써(이중 번역) 깨지므로 건드리지 않는다.
        updateSwitcherActive(lang);
        // 다른 스크립트가 반응할 수 있게 이벤트 발행
        try { window.dispatchEvent(new CustomEvent('pace:langchange', { detail: { lang: lang } })); } catch (e) {}
    }
    function applyAttr(sel, dataAttr, domAttr, lang) {
        var nodes = document.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) {
            var k = nodes[i].getAttribute(dataAttr);
            var v = translate(k, lang);
            if (v != null) nodes[i].setAttribute(domAttr, v);
        }
    }

    function setLang(code) {
        setLangPref(code);
        apply(code);
    }

    // ── 언어 스위처 UI ──
    // 우선 헤더(common.js)가 mountSwitcher(container)로 끼워넣음(자연스러운 배치).
    // 아무도 안 끼우면 잠시 후 우하단 플로팅으로 폴백(데모 등 단독 페이지용).
    var switcherEl = null;

    function createSwitcher(inline) {
        var box = document.createElement('div');
        box.id = 'pace-lang-switcher';
        box.setAttribute('aria-label', 'Language / 언어');
        if (inline) {
            // 헤더에 녹아드는 밝은 톤 인라인 스타일
            box.style.cssText = [
                'display:inline-flex', 'align-items:center', 'gap:1px', 'vertical-align:middle',
                'border:1px solid rgba(0,0,0,.12)', 'border-radius:999px',
                'padding:2px 5px', 'font-family:system-ui,sans-serif', 'user-select:none',
                'line-height:1'
            ].join(';');
        } else {
            box.style.cssText = [
                'position:fixed', 'bottom:14px', 'right:14px', 'z-index:99999',
                'display:inline-flex', 'align-items:center', 'gap:1px',
                'background:rgba(26,31,43,.9)', 'border:1px solid rgba(183,159,88,.5)',
                'border-radius:999px', 'padding:4px 8px', 'font-family:system-ui,sans-serif',
                'box-shadow:0 2px 10px rgba(0,0,0,.25)', 'user-select:none'
            ].join(';');
        }
        box._inline = inline;

        var globe = document.createElement('span');
        globe.textContent = '🌐';
        globe.style.cssText = 'font-size:11px;line-height:1;margin-right:2px;opacity:.7';
        box.appendChild(globe);

        LANGS.forEach(function (l) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = l.short;
            b.setAttribute('data-lang', l.code);
            b.setAttribute('title', l.label);
            b.style.cssText = [
                'border:0', 'background:transparent', 'cursor:pointer',
                'font-size:11px', 'font-weight:700', 'padding:2px 6px',
                'border-radius:999px', 'line-height:1.3', 'transition:all .15s',
                'color:' + (inline ? '#6b7280' : '#cdd3df')
            ].join(';');
            b.addEventListener('click', function () { setLang(l.code); });
            box.appendChild(b);
        });
        return box;
    }

    function mountSwitcher(container) {
        if (switcherEl || !container) return;
        try {
            switcherEl = createSwitcher(true);
            container.appendChild(switcherEl);
            updateSwitcherActive(getLang());
        } catch (e) { /* 무시 */ }
    }
    // refNode 바로 앞(같은 부모)에 인라인 스위처 삽입 (예: 로그인 버튼 왼쪽)
    function mountSwitcherBefore(refNode) {
        if (switcherEl || !refNode || !refNode.parentNode) return;
        try {
            switcherEl = createSwitcher(true);
            switcherEl.style.marginRight = '8px';
            refNode.parentNode.insertBefore(switcherEl, refNode);
            updateSwitcherActive(getLang());
        } catch (e) { /* 무시 */ }
    }
    function floatFallback() {
        if (switcherEl) return;
        switcherEl = createSwitcher(false);
        document.body.appendChild(switcherEl);
        updateSwitcherActive(getLang());
    }
    function updateSwitcherActive(lang) {
        if (!switcherEl) return;
        var inline = switcherEl._inline;
        var btns = switcherEl.querySelectorAll('button[data-lang]');
        for (var i = 0; i < btns.length; i++) {
            var on = btns[i].getAttribute('data-lang') === lang;
            btns[i].style.background = on ? '#b79f58' : 'transparent';
            btns[i].style.color = on ? '#1a1f2b' : (inline ? '#6b7280' : '#cdd3df');
        }
    }

    function init() {
        harvest();
        apply(getLang());
        // 헤더가 끼워넣지 않으면 플로팅 폴백
        setTimeout(function () { if (!switcherEl) floatFallback(); }, 400);
    }

    // 공개 API
    window.PaceI18n = {
        setLang: setLang,
        getLang: getLang,
        t: function (key) { return translate(key, getLang()); },
        apply: function () { harvest(); apply(getLang()); }, // 동적 콘텐츠 추가 후 재적용
        mountSwitcher: mountSwitcher,                         // 컨테이너에 append
        mountSwitcherBefore: mountSwitcherBefore,             // 특정 노드 앞에 삽입(로그인 버튼 등)
        extend: function (obj) {
            if (obj && obj.en) Object.assign(DICT.en, obj.en);
            if (obj && obj.ja) Object.assign(DICT.ja, obj.ja);
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
