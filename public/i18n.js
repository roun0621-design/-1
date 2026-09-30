/**
 * i18n.js — Pace Rise 런타임 다국어 엔진 v2 (빌드 도구 불필요) — 2026-09-30, 해외 대회 대비 B3
 * ------------------------------------------------------------------
 * 원리: 화면의 한국어 문장을 "원문 그대로 키"로 삼아 사전(/locales/en.json, ja.json)에서 찾아 바꾼다.
 *   - 정적 HTML·동적으로 그려지는 DOM 모두: 텍스트 노드·placeholder·title·aria-label·value 를 MutationObserver 로 계속 번역
 *   - 사전 키에 {0} {1} 같은 자리표시자가 있으면 패턴(예: "{0}개 종목" → "{0} events")
 *   - 낱말 조합 폴백: "남자 100m 결승" 처럼 낱말마다 사전에 있으면 이어 붙인다
 *   - 사전에 없으면 한국어 그대로 (절대 안 깨짐). 언어를 되돌리면 원문 복원
 *   - 예전 방식(data-i18n="key" + 인라인 DICT)도 그대로 동작
 * JS 에서: PaceI18n.t('저장했습니다') / PaceI18n.t('{0}개 종목', n) / PaceI18n.getLang()
 * 사전 파일: public/locales/<lang>.json — { "한국어 원문": "translation", ... } (scripts/i18n/extract.js 로 원문 목록 생성)
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'pace_lang';
    var DICT_VERSION = (window.PACE_I18N_VERSION || '7');
    var LANGS = [
        { code: 'ko', label: '한국어', short: 'KO' },
        { code: 'en', label: 'English', short: 'EN' },
        { code: 'ja', label: '日本語', short: 'JA' },
    ];
    var HANGUL = /[가-힣]/;

    // ── 예전 키 기반 사전 (data-i18n="nav.home" 등) — 유지 ──
    var DICT = {
        en: {
            'app.name': 'Pace Rise', 'nav.home': 'Home', 'nav.dashboard': 'Dashboard', 'nav.display-manage': 'Display', 'nav.results': 'Results', 'nav.callroom': 'Call Room', 'nav.monitor': 'Monitor', 'nav.admin': 'Admin', 'nav.record': 'Record Entry', 'nav.login': 'Login', 'nav.logout': 'Logout',
            'common.male': 'Men', 'common.female': 'Women', 'common.mixed': 'Mixed', 'common.all': 'All', 'common.search': 'Search', 'common.close': 'Close',
            'filter.callroom_done': 'Call-in done', 'filter.progress': 'Calling in', 'filter.waiting': 'Waiting', 'filter.race_done': 'Finished',
            'common.save': 'Save', 'common.cancel': 'Cancel', 'common.loading': 'Loading…',
            'round.prelim': 'Heats', 'round.semifinal': 'Semifinal', 'round.final': 'Final',
            'status.upcoming': 'Upcoming', 'status.active': 'In progress', 'status.completed': 'Completed',
            'home.subtitle': 'Athletics Competition Operations', 'home.competitions': 'Competitions', 'about.title': 'About P-R : Node', 'about.h1': 'Live competition results', 'about.features': 'Key features', 'about.favorites': 'Favorites',
            'home.about_btn': 'About P-R : Node', 'home.install_btn': 'Install app', 'home.manual_btn': 'Operations manual', 'home.add_comp': '+ Add competition', 'footer.privacy': 'Privacy policy',
        },
        ja: {
            'app.name': 'Pace Rise', 'nav.home': 'ホーム', 'nav.dashboard': 'ダッシュボード', 'nav.display-manage': '表示管理', 'nav.results': '結果', 'nav.callroom': '招集所', 'nav.monitor': 'モニター', 'nav.admin': '管理', 'nav.record': '記録入力', 'nav.login': 'ログイン', 'nav.logout': 'ログアウト',
            'common.male': '男子', 'common.female': '女子', 'common.mixed': '混合', 'common.all': 'すべて', 'common.search': '検索', 'common.close': '閉じる',
            'filter.callroom_done': '招集完了', 'filter.progress': '招集中', 'filter.waiting': '待機', 'filter.race_done': '競技終了',
            'common.save': '保存', 'common.cancel': 'キャンセル', 'common.loading': '読み込み中…',
            'round.prelim': '予選', 'round.semifinal': '準決勝', 'round.final': '決勝',
            'status.upcoming': '予定', 'status.active': '進行中', 'status.completed': '終了',
            'home.subtitle': '陸上競技 大会運営', 'home.competitions': '大会一覧', 'about.title': 'P-R : Node について', 'about.h1': 'リアルタイム大会結果', 'about.features': '主な機能', 'about.favorites': 'お気に入り',
            'home.about_btn': 'P-R : Node について', 'home.install_btn': 'アプリ設置案内', 'home.manual_btn': '運営マニュアル', 'home.add_comp': '+ 大会追加', 'footer.privacy': 'プライバシー方針',
        },
    };
    var koOriginal = {};

    // ── 원문 사전 (언어별) ──
    var TEXT = { en: null, ja: null };          // { 원문: 번역 }
    var PATTERNS = { en: [], ja: [] };          // [{ re, tpl }] — 키에 {0} 이 든 항목
    var PHRASES = { en: [], ja: [] };           // 서버가 준 긴 원문(대회명 등) — 문장 안에 들어 있어도 바꾼다 (긴 것부터)
    var loading = {};

    function getLang() {
        try {
            var v = localStorage.getItem(STORAGE_KEY);
            if (v) return v;
            // 처음: 브라우저 언어로 (ko → 한국어, ja → 일본어, 그 밖엔 영어)
            var nl = String(navigator.language || navigator.userLanguage || 'ko').toLowerCase();
            return nl.indexOf('ko') === 0 ? 'ko' : nl.indexOf('ja') === 0 ? 'ja' : 'en';
        } catch (e) { return 'ko'; }
    }
    function setLangPref(code) { try { localStorage.setItem(STORAGE_KEY, code); } catch (e) {} }

    function compilePatterns(lang) {
        var d = TEXT[lang]; var out = [];
        if (!d) return out;
        for (var k in d) {
            if (k.indexOf('{') < 0) continue;
            var esc = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\d)(?::ord)?\}/g, '(.+?)');
            out.push({ re: new RegExp('^' + esc + '$'), tpl: d[k], key: k });
        }
        // 긴 키부터 (구체적인 패턴 우선)
        out.sort(function (a, b) { return b.key.length - a.key.length; });
        return out;
    }
    function ensureDict(lang, cb) {
        if (lang === 'ko' || TEXT[lang]) { if (cb) cb(); return; }
        if (loading[lang]) { loading[lang].push(cb); return; }
        loading[lang] = [cb];
        var cacheKey = 'pace_i18n_' + lang + '_' + DICT_VERSION;
        var base = null;
        try { var cached = localStorage.getItem(cacheKey); if (cached) base = JSON.parse(cached); } catch (e) {}
        var p = base ? Promise.resolve(base) : fetch('/locales/' + lang + '.json?v=' + DICT_VERSION).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) {
            try { localStorage.setItem(cacheKey, JSON.stringify(j || {})); } catch (e) {}
            return j || {};
        }).catch(function () { return {}; });
        p.then(function (dict) {
            // 서버가 가진 원문→번역(대회명 영문·일문 등)을 덧붙인다 — 캐시 경로에서도, 실패해도 사전은 그대로
            return fetch('/api/labels?lang=' + lang).then(function (r) { return r.ok ? r.json() : null; }).then(function (l) {
                if (l && l.text) { Object.assign(dict, l.text); PHRASES[lang] = Object.keys(l.text).filter(function (k) { return k.length >= 4; }).sort(function (a, b) { return b.length - a.length; }); }
                return dict;
            }).catch(function () { return dict; });
        }).then(function (dict) {
            TEXT[lang] = dict; PATTERNS[lang] = compilePatterns(lang);
            var cbs = loading[lang]; delete loading[lang];
            (cbs || []).forEach(function (f) { if (f) f(); });
        });
    }

    // 원문 → 번역 (없으면 null). 패턴·낱말 조합 폴백 포함
    function tText(src, lang) {
        if (lang === 'ko' || !src) return null;
        var d = TEXT[lang]; if (!d) return null;
        var s = src.replace(/\s+/g, ' ').trim(); if (!s || !HANGUL.test(s)) return null;   // 안쪽 줄바꿈·연속 공백은 한 칸으로 (추출기와 같은 정규화)
        if (d[s] != null) return d[s];
        var ps = PATTERNS[lang];
        for (var i = 0; i < ps.length; i++) {
            var m = s.match(ps[i].re);
            if (!m) continue;
            // 잡힌 조각에 한글이 있으면 그 조각도 번역돼야 한다 — '현대자동차' 가 '{0}차'(Attempt {0}) 에, '10종경기' 가 '{0}경기' 에 잡히는 오인 방지
            var vals = [], bad = false;
            for (var g = 1; g < m.length; g++) { var tv2 = HANGUL.test(m[g]) ? tText(m[g], lang) : m[g]; if (tv2 == null) { bad = true; break; } vals.push(tv2); }
            if (bad) continue;
            var out = ps[i].tpl; for (var g2 = 0; g2 < vals.length; g2++) out = fill(out, g2, vals[g2], lang); return out;
        }
        // 낱말 조합: "남자 100m 결승", "멀리뛰기 일반부" — 한글이 든 낱말이 모두 사전에 있어야 한다
        var parts = s.split(/(\s+|·|\/|\(|\)|,)/);
        if (parts.length > 1) {
            var ok = false, fail = false, res = [];
            for (var j = 0; j < parts.length; j++) {
                var p = parts[j];
                if (!HANGUL.test(p)) { res.push(p); continue; }
                var tv = d[p];
                if (tv == null) { fail = true; break; }     // 모르는 낱말 → 아래 긴 원문 치환으로
                ok = true; res.push(tv);
            }
            if (ok && !fail) return res.join('');
        }
        // 서버가 준 긴 원문(대회명)이 문장 안에 있으면 그 부분만 바꾼다: '2026 아이치 … 육상 (2026-09-23)' → '2026 Aichi … (2026-09-23)'
        var ph = PHRASES[lang]; if (ph && ph.length) {
            var changed = false, o = s;
            for (var q = 0; q < ph.length; q++) if (o.indexOf(ph[q]) >= 0) { o = o.split(ph[q]).join(d[ph[q]]); changed = true; }
            if (changed) return o;
        }
        return null;
    }
    // {0:ord} — 서수 (en: 1st 2nd 3rd, ja: 1位, ko: 1위)
    function ordinal(v, lang) {
        var n = parseInt(v, 10); if (isNaN(n)) return v;
        if (lang === 'ja') return n + '位';
        if (lang !== 'en') return n + '위';
        var s = ['th', 'st', 'nd', 'rd'], r = n % 100; return n + (s[(r - 20) % 10] || s[r] || s[0]);
    }
    function fill(tpl, idx, val, lang) {
        return String(tpl).replace(new RegExp('\\{' + idx + '(?::ord)?\\}', 'g'), function (m) { return m.indexOf(':ord') >= 0 ? ordinal(val, lang) : val; });
    }
    function t(src) {
        var lang = getLang();
        var v = tText(src, lang);
        if (v == null) v = src;
        for (var i = 1; i < arguments.length; i++) v = fill(v, i - 1, arguments[i], lang);
        return v;
    }

    // ── DOM 번역 ──
    var SKIP_TAG = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, NOSCRIPT: 1, SVG: 1, svg: 1 };
    var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-label'];   // data-label: CSS content:attr() 로 그리는 라벨(대시보드 폰 카드의 라운드명)
    var origText = new WeakMap();    // 텍스트 노드 → 한국어 원문
    var origAttr = new WeakMap();    // 요소 → { attr: 원문 }
    var lastSet = new WeakMap();     // 우리가 마지막으로 써 넣은 값 — 관찰자가 우리 변경을 남의 변경으로 오해하지 않게
    var applying = false;

    function translateTextNode(node, lang) {
        var cur = node.nodeValue; if (!cur) return;
        var orig = origText.get(node);
        if (orig == null) { if (!HANGUL.test(cur)) return; orig = cur; origText.set(node, orig); }
        var target;
        if (lang === 'ko') target = orig;
        else {
            var lead = orig.match(/^\s*/)[0], trail = orig.match(/\s*$/)[0];
            var v = tText(orig, lang);
            target = v == null ? orig : lead + v + trail;
        }
        if (cur !== target) { lastSet.set(node, target); node.nodeValue = target; }
    }
    function translateElementAttrs(el, lang) {
        var store = origAttr.get(el);
        for (var i = 0; i < ATTRS.length; i++) {
            var a = ATTRS[i];
            if (!el.hasAttribute(a)) continue;
            var cur = el.getAttribute(a);
            if (!store) { store = {}; origAttr.set(el, store); }
            if (store[a] == null) { if (!HANGUL.test(cur)) continue; store[a] = cur; }
            var target = lang === 'ko' ? store[a] : (tText(store[a], lang) || store[a]);
            if (cur !== target) { lastSet.set(el, (lastSet.get(el) || {})); lastSet.get(el)[a] = target; el.setAttribute(a, target); }
        }
        // input[type=button|submit] value
        if ((el.tagName === 'INPUT') && /^(button|submit|reset)$/i.test(el.type || '')) {
            if (!store) { store = {}; origAttr.set(el, store); }
            if (store.value == null) { if (!HANGUL.test(el.value || '')) return; store.value = el.value; }
            var tv = lang === 'ko' ? store.value : (tText(store.value, lang) || store.value);
            if (el.value !== tv) el.value = tv;
        }
    }
    function translateTree(root, lang) {
        if (!root) return;
        if (root.nodeType === 3) { translateTextNode(root, lang); return; }
        if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
        if (root.nodeType === 1) { if (SKIP_TAG[root.tagName] || root.hasAttribute('data-i18n-skip') || root.hasAttribute('data-i18n')) { if (root.hasAttribute('data-i18n')) translateElementAttrs(root, lang); return; } translateElementAttrs(root, lang); }
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                if (n.nodeType === 1) { if (SKIP_TAG[n.tagName] || n.hasAttribute('data-i18n-skip') || n.hasAttribute('data-i18n')) return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        var n;
        while ((n = walker.nextNode())) { if (n.nodeType === 3) translateTextNode(n, lang); else translateElementAttrs(n, lang); }
    }
    var origTitle = null;
    function translateAll(lang) {
        applying = true;
        try {
            translateTree(document.body, lang);
            if (origTitle == null && HANGUL.test(document.title)) origTitle = document.title;
            if (origTitle != null) { var tt = lang === 'ko' ? origTitle : (tText(origTitle, lang) || origTitle); if (document.title !== tt) document.title = tt; }
        } finally { applying = false; }
    }

    var observer = null, pending = [], flushTimer = null;
    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(function () {
            flushTimer = null; var lang = getLang(); if (lang === 'ko' || !TEXT[lang]) { pending = []; return; }
            var batch = pending; pending = []; applying = true;
            try { for (var i = 0; i < batch.length; i++) translateTree(batch[i], lang); } finally { applying = false; }
        }, 0);
    }
    function startObserver() {
        if (observer || !window.MutationObserver) return;
        observer = new MutationObserver(function (muts) {
            if (applying) return;
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === 'characterData') {
                    if (lastSet.get(m.target) === m.target.nodeValue) continue;           // 우리가 쓴 값 → 무시
                    origText.delete(m.target); pending.push(m.target);
                } else if (m.type === 'attributes') {
                    var ls = lastSet.get(m.target); if (ls && ls[m.attributeName] === m.target.getAttribute(m.attributeName)) continue;
                    var st = origAttr.get(m.target); if (st) delete st[m.attributeName]; pending.push(m.target);
                }
                else for (var j = 0; j < m.addedNodes.length; j++) pending.push(m.addedNodes[j]);
            }
            if (pending.length) scheduleFlush();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }

    // ── 예전 키 방식 ──
    function translateKey(key, lang) {
        if (lang === 'ko') return koOriginal[key];
        var d = DICT[lang];
        if (d && d[key] != null) return d[key];
        return koOriginal[key];
    }
    function harvest() {
        var nodes = document.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) { var k = nodes[i].getAttribute('data-i18n'); if (k && koOriginal[k] == null) koOriginal[k] = nodes[i].textContent.trim(); }
        collectAttr('[data-i18n-ph]', 'data-i18n-ph', 'placeholder'); collectAttr('[data-i18n-title]', 'data-i18n-title', 'title');
    }
    function collectAttr(sel, dataAttr, domAttr) {
        var nodes = document.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) { var k = nodes[i].getAttribute(dataAttr); if (k && koOriginal[k] == null) koOriginal[k] = nodes[i].getAttribute(domAttr) || ''; }
    }
    function applyKeys(lang) {
        var nodes = document.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) { var v = translateKey(nodes[i].getAttribute('data-i18n'), lang); if (v != null) nodes[i].textContent = v; }
        applyAttr('[data-i18n-ph]', 'data-i18n-ph', 'placeholder', lang); applyAttr('[data-i18n-title]', 'data-i18n-title', 'title', lang);
    }
    function applyAttr(sel, dataAttr, domAttr, lang) {
        var nodes = document.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) { var v = translateKey(nodes[i].getAttribute(dataAttr), lang); if (v != null) nodes[i].setAttribute(domAttr, v); }
    }

    function apply(lang) {
        harvest(); applyKeys(lang);
        ensureDict(lang, function () {
            translateAll(lang);
            try { document.documentElement.lang = lang; document.documentElement.setAttribute('data-lang', lang); } catch (e) {}
            updateSwitcherActive(lang);
            try { window.dispatchEvent(new CustomEvent('pace:langchange', { detail: { lang: lang } })); } catch (e) {}
        });
    }
    function setLang(code) { setLangPref(code); apply(code); }

    // ── 언어 스위처 UI ──
    var switcherEl = null;
    function createSwitcher(inline) {
        var box = document.createElement('div');
        box.id = 'pace-lang-switcher'; box.setAttribute('aria-label', 'Language'); box.setAttribute('data-i18n-skip', '');
        box.style.cssText = inline
            ? 'display:inline-flex;align-items:center;gap:1px;vertical-align:middle;border:1px solid rgba(0,0,0,.12);border-radius:999px;padding:2px 5px;font-family:system-ui,sans-serif;user-select:none;line-height:1'
            : 'position:fixed;bottom:14px;right:14px;z-index:99999;display:inline-flex;align-items:center;gap:1px;background:rgba(26,31,43,.9);border:1px solid rgba(183,159,88,.5);border-radius:999px;padding:4px 8px;font-family:system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);user-select:none';
        box._inline = inline;
        var globe = document.createElement('span');
        if (window.PaceIcons) globe.innerHTML = PaceIcons.svg('globe', { size: 16 }); else globe.textContent = 'A';
        globe.style.cssText = 'font-size:11px;line-height:1;margin-right:2px;opacity:.7';
        box.appendChild(globe);
        LANGS.forEach(function (l) {
            var b = document.createElement('button');
            b.type = 'button'; b.textContent = l.short; b.setAttribute('data-lang', l.code); b.setAttribute('title', l.label);
            b.style.cssText = 'border:0;background:transparent;cursor:pointer;font-size:11px;font-weight:700;padding:2px 6px;border-radius:999px;line-height:1.3;transition:all .15s;color:' + (inline ? '#6b7280' : '#cdd3df');
            b.addEventListener('click', function () { setLang(l.code); });
            box.appendChild(b);
        });
        return box;
    }
    function mountSwitcher(container) {
        if (switcherEl || !container) return;
        try { switcherEl = createSwitcher(true); container.appendChild(switcherEl); updateSwitcherActive(getLang()); } catch (e) {}
    }
    function mountSwitcherBefore(refNode) {
        if (switcherEl || !refNode || !refNode.parentNode) return;
        try { switcherEl = createSwitcher(true); switcherEl.style.marginRight = '8px'; refNode.parentNode.insertBefore(switcherEl, refNode); updateSwitcherActive(getLang()); } catch (e) {}
    }
    function floatFallback() {
        if (switcherEl) return;
        switcherEl = createSwitcher(false); document.body.appendChild(switcherEl); updateSwitcherActive(getLang());
    }
    function updateSwitcherActive(lang) {
        if (!switcherEl) return;
        var inline = switcherEl._inline, btns = switcherEl.querySelectorAll('button[data-lang]');
        for (var i = 0; i < btns.length; i++) { var on = btns[i].getAttribute('data-lang') === lang; btns[i].style.background = on ? '#b79f58' : 'transparent'; btns[i].style.color = on ? '#1a1f2b' : (inline ? '#6b7280' : '#cdd3df'); }
    }

    function init() {
        apply(getLang());
        startObserver();
        setTimeout(function () { if (!switcherEl) floatFallback(); }, 400);
    }

    window.PaceI18n = {
        setLang: setLang, getLang: getLang,
        t: t,                                                  // PaceI18n.t('원문') / t('{0}개', n)
        tKey: function (key) { return translateKey(key, getLang()); },
        apply: function () { apply(getLang()); },              // 동적 콘텐츠 뒤 강제 재적용 (관찰자가 있어 보통 불필요)
        mountSwitcher: mountSwitcher, mountSwitcherBefore: mountSwitcherBefore,
        extend: function (obj) { if (obj && obj.en) Object.assign(DICT.en, obj.en); if (obj && obj.ja) Object.assign(DICT.ja, obj.ja); },
        extendText: function (lang, obj) { if (!TEXT[lang]) TEXT[lang] = {}; Object.assign(TEXT[lang], obj || {}); PATTERNS[lang] = compilePatterns(lang); },
        LANGS: LANGS,
    };
    // 전역 단축: t('원문') — 페이지 스크립트가 편하게 쓰도록 (이미 t 가 있으면 건드리지 않는다)
    if (typeof window.t !== 'function') window.t = t;
    // 브라우저 기본 대화상자(alert/confirm/prompt)의 한국어 메시지도 번역 — 서버 오류 문구가 여기로 많이 나온다
    ['alert', 'confirm', 'prompt'].forEach(function (name) {
        var orig = window[name]; if (typeof orig !== 'function') return;
        window[name] = function (msg) { var args = Array.prototype.slice.call(arguments); if (typeof msg === 'string') args[0] = t(msg); return orig.apply(window, args); };
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
