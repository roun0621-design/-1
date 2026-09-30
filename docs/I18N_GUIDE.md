# 다국어(i18n) 가이드 — v2 (2026-09-30)

엔진: [`public/i18n.js`](../public/i18n.js). 빌드 도구 없음. **한국어 원문이 곧 키**다.

## 어떻게 동작하나
- 모든 페이지가 `<script src="/i18n.js?v=4">` 를 `common.js` 앞에 로드한다(오버레이·open·privacy 제외).
- 언어: `localStorage('pace_lang')` → 없으면 브라우저 언어(ko → 한국어, ja → 일본어, 그 밖엔 **영어**). 헤더의 KO/EN/JA 스위처로 바꾼다.
- 선택 언어가 ko 가 아니면 `/locales/<lang>.json`(`{ "한국어 원문": "번역" }`)을 받아(localStorage 캐시, `PACE_I18N_VERSION` 으로 무효화) **화면의 텍스트 노드·placeholder·title·aria-label·alt·버튼 value** 를 원문 그대로 찾아 바꾼다. `MutationObserver` 가 나중에 그려지는 DOM 도 계속 번역하므로 렌더 함수는 손대지 않아도 된다.
- 사전에 없는 문장은 한국어 그대로 남는다(절대 안 깨짐). 언어를 되돌리면 원문 복원.
- 자리표시자: 사전 키 `"{0}개 종목"` → 값 `"{0} events"`. 화면 문장 `"36개 종목"` 이 패턴으로 잡힌다.
- 낱말 조합: `"남자 100m 결승"` 처럼 공백·`·`·`/`·괄호로 나뉜 낱말이 모두 사전에 있으면 이어 붙인다(`Men 100m Final`). 종목명(`멀리뛰기`)·라운드·성별·부 라벨은 `lib/eventCatalog.js`·`lib/labels.js` 에서 자동으로 사전에 들어간다.
- `alert/confirm/prompt` 메시지도 번역된다(서버 오류 문구). `showToast` 는 DOM 이라 자동.
- JS 에서 직접: `t('저장했습니다')`, `t('{0}개 종목', n)`, `PaceI18n.getLang()`, `PaceI18n.setLang('en')`. 옛 방식(`data-i18n="nav.home"`)도 그대로 동작.
- 번역하면 안 되는 요소: `data-i18n-skip` 속성.

## 사전 만들기·고치기
```bash
node scripts/i18n/extract.js            # public/*.html·*.js 의 한국어 원문 → scripts/i18n/ko_strings.json
node scripts/i18n/extract.js --stats    # 파일별 원문 수·번역률
node scripts/i18n/extract.js --missing en dashboard.js   # 아직 en 사전에 없는 원문(파일 필터 선택)
node scripts/i18n/build.js              # parts/<lang>_*.json + 자동 항목 → public/locales/en.json, ja.json
```
- 번역 조각은 `scripts/i18n/parts/<lang>_<이름>.json` (`{ 원문: 번역 }`). 용어는 `scripts/i18n/GLOSSARY.md`.
- 손으로 고칠 땐 `public/locales/<lang>.overrides.json` 에 넣으면 빌드 때 가장 우선.
- 새 한국어 문장을 코드에 추가했으면 `extract → --missing → parts 에 번역 추가 → build` 순서. 사전 파일이 바뀌면 `public/i18n.js` 의 `DICT_VERSION`(또는 페이지의 `window.PACE_I18N_VERSION`)을 올려 캐시를 비운다.

## 서버 쪽
- `GET /api/labels?lang=en|ja|ko` — 라운드·상태·성별·종목군·상태코드·기록·부 라벨 + 종목 사전 + 부 마스터(`lib/labels.js`, `lib/eventCatalog.js`).
- `GET /api/events` 의 `code`·`name_en`. `division_master.label_en`.
- 문서(PDF/Excel)·오버레이·결과 이미지는 아직 한국어/영어 고정 — B5 에서.

## 남은 것
- 종목명에 부 접미가 붙은 이름(`100m 일반부`)은 낱말 조합으로 번역된다. 사전에 없는 자유 문자열 부(예: `U20(남)`)는 `parts` 에 추가.
- 국제대회 선수 이름: KO 는 한글 병기(`name_alt`), EN/JA 는 공식 영문명 우선 표시 — dashboard 에서 처리(진행 중).
