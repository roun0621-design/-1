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
            'nav.dashboard': 'Dashboard',
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
        },
        ja: {
            'app.name': 'Pace Rise',
            'nav.dashboard': 'ダッシュボード',
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
        try { document.documentElement.setAttribute('lang', lang); } catch (e) {}
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

    // ── 플로팅 언어 스위처 UI ──
    var switcherEl = null;
    function buildSwitcher() {
        if (switcherEl) return;
        var box = document.createElement('div');
        box.id = 'pace-lang-switcher';
        box.setAttribute('aria-label', 'Language / 언어');
        box.style.cssText = [
            'position:fixed', 'top:10px', 'right:10px', 'z-index:99999',
            'display:flex', 'align-items:center', 'gap:2px',
            'background:rgba(26,31,43,.82)', 'backdrop-filter:blur(6px)',
            'border:1px solid rgba(183,159,88,.45)', 'border-radius:999px',
            'padding:3px 6px', 'font-family:system-ui,sans-serif', 'font-size:12px',
            'box-shadow:0 2px 8px rgba(0,0,0,.25)', 'user-select:none'
        ].join(';');

        var globe = document.createElement('span');
        globe.textContent = '🌐';
        globe.style.cssText = 'margin-right:2px;font-size:12px;line-height:1';
        box.appendChild(globe);

        LANGS.forEach(function (l) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = l.short;
            b.setAttribute('data-lang', l.code);
            b.setAttribute('title', l.label);
            b.style.cssText = [
                'border:0', 'background:transparent', 'color:#cdd3df', 'cursor:pointer',
                'font-size:12px', 'font-weight:700', 'padding:2px 6px', 'border-radius:999px',
                'line-height:1.4', 'transition:all .15s'
            ].join(';');
            b.addEventListener('click', function () { setLang(l.code); });
            box.appendChild(b);
        });
        document.body.appendChild(box);
        switcherEl = box;
    }
    function updateSwitcherActive(lang) {
        if (!switcherEl) return;
        var btns = switcherEl.querySelectorAll('button[data-lang]');
        for (var i = 0; i < btns.length; i++) {
            var on = btns[i].getAttribute('data-lang') === lang;
            btns[i].style.background = on ? '#b79f58' : 'transparent';
            btns[i].style.color = on ? '#1a1f2b' : '#cdd3df';
        }
    }

    function init() {
        harvest();
        buildSwitcher();
        apply(getLang());
    }

    // 공개 API
    window.PaceI18n = {
        setLang: setLang,
        getLang: getLang,
        t: function (key) { return translate(key, getLang()); },
        apply: function () { harvest(); apply(getLang()); }, // 동적 콘텐츠 추가 후 재적용
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
