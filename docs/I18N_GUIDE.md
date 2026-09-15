# 다국어(i18n) 적용 가이드

빌드 도구 없는 런타임 i18n. 엔진: [`public/i18n.js`](../public/i18n.js). 데모: `/i18n-demo.html`.

## 페이지에 언어 스위처 추가 (1줄)

```html
<script src="/i18n.js?v=1"></script>   <!-- </body> 직전 -->
```

→ 우측 상단에 🌐 KO/EN/JA 전환기가 자동으로 뜬다. 선택은 `localStorage('pace_lang')`에 저장돼 페이지 간 유지된다.

## 요소 번역 (data 속성)

```html
<h4 data-i18n="about.features">주요 기능</h4>           <!-- 텍스트 -->
<input data-i18n-ph="common.search" placeholder="검색">  <!-- placeholder -->
<button data-i18n-title="nav.login" title="로그인">      <!-- title 속성 -->
```

**핵심 안전장치:** 페이지의 기존 한국어가 `ko` 원본으로 자동 수집된다. en/ja 사전에 키가 없으면 한국어로 폴백한다 → **태그를 달아도 절대 깨지지 않는다**(최악의 경우 한국어 유지).

## 번역어 추가

`public/i18n.js`의 `DICT.en` / `DICT.ja`에 `'키': '번역'`을 추가. 또는 런타임에:

```js
PaceI18n.extend({ en: { 'event.100m': '100m' }, ja: { 'event.100m': '100m' } });
```

## 동적 콘텐츠

SSE/fetch로 DOM을 새로 그린 뒤에는 `PaceI18n.apply()`를 호출하면 새 요소까지 재번역된다.
언어 변경 시 `window`에 `pace:langchange` 이벤트가 발행되므로, 직접 렌더링하는 스크립트는 이를 구독해 다시 그릴 수 있다.

```js
window.addEventListener('pace:langchange', (e) => renderList(e.detail.lang));
```

## 롤아웃 순서 (권장)

1. 공개·관전 페이지부터: `results.html`, `monitor.html`, `callroom-monitor.html` (해외 관중 노출 큼)
2. 방송 오버레이(`overlay-*.html`)는 이미 영어 위주 — 필요 시만
3. 운영자 페이지(`record/callroom/admin`)는 국내 심판용이라 후순위

키 네이밍: `도메인.용어` (예: `nav.dashboard`, `round.final`, `status.completed`). 공통 용어는 `common.*`.
