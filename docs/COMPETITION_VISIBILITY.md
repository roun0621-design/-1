# 대회·연맹 숨기기 (Competition / Federation Visibility)

> 홈과 운영 화면의 대회 목록에서 특정 대회나 연맹 전체를 감추는 기능. 관리자 페이지에서는 계속 보이고, 직접 링크(대시보드 `?comp=ID` 등)는 그대로 열린다.

## 규칙

| 대상 | 저장 위치 | 값 |
|------|-----------|----|
| 대회 하나 | `competition.home_visibility` | `auto`(기본) / `pinned`(홈 상단 고정) / `hidden`(숨김) |
| 연맹 전체 | `federation_list.hidden` | `0` / `1` — 1이면 그 연맹 코드를 가진 대회 전부 숨김 (`pinned` 이어도 숨김) |

숨김 대상은 다음 목록에서 빠진다.

- 홈 상단 최근 대회 띠 (`GET /api/competitions/recent?window=active`)와 전체 펼침 (`window=all`)
- 홈 연도별·연맹별 목록, 운영 화면(대시보드 상단 대회 선택, 소집실 등)의 대회 선택 목록 (`GET /api/competitions`)
- 연맹별 목록 (`GET /api/competitions/by-federation/:code`)

전부 봐야 하는 곳은 `?include_hidden=1` 로 조회한다 (관리자 페이지, 이름 표시용 조회). `GET /api/competitions/:id` 는 숨겨도 응답한다.

## 어디서 바꾸나

- **홈 화면(관리자 로그인 상태)**: 연맹 헤더의 "연맹 숨기기 / 숨김 해제", 대회 카드의 "숨기기 / 숨김 해제". 숨긴 항목은 관리자에게 흐리게 "숨김" 배지와 함께 보이고, 일반 방문자에게는 안 보인다.
- **관리자 페이지**: 연맹 관리 목록의 "연맹 숨기기" 토글, 대회 수정 폼의 "홈 노출" 선택. 대회 선택 드롭다운에는 숨긴 대회가 `[숨김]` 표시로 남는다.

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| PUT | `/api/competitions/:id/home-visibility` | `{ admin_key, home_visibility }` — 관리자 키 전용, opLog `대회 숨김: {이름}` |
| PUT | `/api/federations/:id/hidden` | `{ admin_key, hidden: 0|1 }` — 관리자 키 전용, opLog `연맹 숨김: {코드}` |
| PUT | `/api/federations/:id` | 기존 수정 API. `hidden` 을 함께 보내면 반영, 안 보내면 유지 |

코드: `lib/routes/competitions.js` (VISIBLE_SQL), `lib/routes/federations.js`, `public/index.html`, `public/admin.html`, `public/common.js`.
테스트: `tests/api/34_hidden_competitions.test.js`, `tests/api/02_competitions.test.js`.
