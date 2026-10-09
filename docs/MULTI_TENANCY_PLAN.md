# 멀티테넌시(조직별 칸막이) 설계 — 2026-10-01

사용자 결정(2026-10-01): 해외 이벤트사·연맹을 받을 때 서버를 따로 두지 않고 **한 서버·한 코드에서 조직(organization)별로 칸막이**를 만든다("아파트" 방식). 리전 분리(EU 등)는 법적 요구가 생길 때 같은 이미지를 리전에 한 번 더 올리는 것으로 처리하고, 고객별 전용 서버는 하지 않는다.

## 1. 지금 구조에서 확인한 사실 (2026-10-01 조사)
- 대회에 딸린 데이터(종목·선수·조·결과·시간표·문서·로그)는 전부 `competition_id` 로 닿는다 → 대회에 조직만 붙이면 분리된다.
- **전역 테이블**: `event_record`(NR/DR/CR), `division_master`, `competition_series`, `federation_list`, `operation_key`, `system_config`(관리자 계정·운영키·`site_*` 설정), `sms_config`(단일 행), `home_popup`(competition_id NULL = 전체), `certificate_template`(NULL = 전체 기본), `award_docx_template`(`scope_key='global'`), `external_api_key`, `push_token/push_interest`, `joint_group`(competition_id 자체가 없음 — 버그), `app_user/session_refresh/login_audit`.
- `app_user.organization_id` 컬럼은 이미 있고 JWT 페이로드에도 실리지만(`lib/auth/jwt.js:57`) **어디서도 쓰지 않는다**. `organization` 테이블은 없다.
- 호스트(도메인)는 어디서도 보지 않는다(`req.headers.host` 는 CSRF 검사·WS 경로 파싱 2곳뿐). 쿠키에 `domain` 없음, CORS 없음.
- 공개 대회 목록은 `lib/routes/competitions.js` 의 `VISIBLE_SQL` 한 곳으로 모인다(`?include_hidden=1` 이면 우회).
- 레거시 키 라우트 ~300곳은 역할만 보고 조직은 모른다. JWT→레거시 브리지(`server.js:325-368`)가 역할만 넘긴다.
- NR 은 `(record_type, event_name, gender)` 로만 유일 → 두 나라 연맹이 같은 표를 쓰면 충돌.

## 2. 모델
```
organization
  id, slug(서브도메인·URL 식별자, 소문자 a-z0-9-), name, name_en,
  country(ISO 3166-1 alpha-2, 'KR'), default_tz('Asia/Seoul'), default_lang('ko'|'en'|'ja'),
  custom_domain(''), site_name(''), brand_logo_path(''), brand_color_point(''), brand_color_accent(''),
  settings_json('{}'),   -- site_* 류 설정(설치 안내 링크·매뉴얼 HTML 등)
  active(1), created_at, updated_at
```
- 기본 조직 **id=1, slug `pace-rise`, KR, Asia/Seoul, ko** 를 부팅 시 자동 생성하고, 기존 데이터는 전부 조직 1 소속으로 백필한다(운영 영향 없음).
- 조직 선택(요청마다 `req.org`): ① 호스트가 `organization.custom_domain` 과 같으면 그 조직 ② 호스트의 첫 라벨이 `slug` 와 같으면 그 조직(`jp.pace-rise-node.com`, `jp.localhost`) ③ 로컬·테스트용 `?org=<slug>` 또는 `x-org` 헤더 ④ 그 외(`pace-rise-node.com`, `www`, `localhost`)는 기본 조직. `ORG_DEFAULT_SLUG` 환경변수로 기본 조직을 바꿀 수 있다.
- 플랫폼 관리자 = 기본 조직(id 1)의 admin. 조직 생성·수정은 기본 조직 호스트에서만 가능.

## 3. 단계
| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | `organization` 테이블·기본 조직·`competition.organization_id`·`app_user` 백필, `req.org` 미들웨어, 공개 목록·대회 조회·생성·복제·recent·슬러그·홈 팝업·site-config 를 조직으로 스코프, 새 대회 기본 시간대 = 조직, 조직별 `/api/site-config` 에 `org{slug,name,country,default_tz,default_lang,brand}` 포함, `/manifest.json` 조직별, 관리자 › 시스템 › **조직** 화면(플랫폼 관리자), 테스트 | **구현 완료(2026-10-01)** — `tests/api/53_organization.test.js` 6건, 전체 590 통과. `/manifest.json` 조직별은 보류(정적 그대로) |
| 2 | 전역 테이블에 `organization_id`: `event_record`(NR/DR/CR, 조회·갱신·승인·감지·문서·엑셀·국제동기화 전부 조직 조건), `competition_series`, `federation_list`, `division_master`(0 = 공용 기본 부, 조직이 추가한 부만 자기 것; 공용은 기본 조직만 수정), `certificate_template`(목록·조회·수정·삭제·발급·공개 링크 선택), `award_docx_template`(전체 기본 키: 기본 조직 `global`, 다른 조직 `o<id>`), `sms_config`(조직마다 한 행 — CHECK(id=1) 제거 마이그레이션, `lib/smsConfig.js`), `push_token/push_interest`, `external_api_key`(키는 발급 조직의 대회에만 통함), `joint_group.competition_id` 추가(버그 수정). `record_breaking_log` 목록·승인은 대회의 조직으로 | **완료(2026-10-02)** — `tests/api/54_org_scope_masters.test.js`·`55_org_scope_settings.test.js` 10건. `event_record` UNIQUE 는 NULL 때문에 원래 느슨해서 그대로 두고 조회 조건으로 분리 |
| 3 | 계정·키 조직 소속: 로그인 시 계정 조직 ≠ 호스트 조직이면 403(기본 조직의 admin = 플랫폼 관리자는 어디서나), JWT 브리지도 같은 규칙(다른 조직 토큰은 권한 없음), 계정 목록·생성·수정·삭제·잠금 해제·로그인 이력은 호스트 조직만, `operation_key.organization_id` + `_opKeyLookup` 이 요청 조직(`lib/reqContext.js`, AsyncLocalStorage)으로 거름, 기본 운영키·기록위원 키는 기본 조직에서만, **조직 가드 미들웨어**(요청이 가리키는 대회가 다른 조직이면 404 — 종료 가드의 대회 추출기 재사용), 되돌리기도 조직 검사 | **완료(2026-10-09)** — `tests/api/56_org_auth.test.js` 4건 |
| 4 | 운영: 쿠키 `domain` 옵션·CORS(필요 시), Docker 이미지·리전 배포 옵션, 과금·셀프 가입(고객 생긴 뒤) | 나중 |

각 단계는 기존 한국 운영에 영향 없이 배포 가능해야 하고, `npm test` 가 통과해야 한다.

## 4. 1단계 상세
- 마이그레이션(4곳 규칙: `db/schema.sql`, `db/schema.pg.sql`, server.js SQLite ALTER 블록, PG `pgIdempotentAddCol`) + `organization` CREATE(5곳).
- `lib/org.js`: `resolveOrgMiddleware(db)` — 호스트 파싱, 조직 캐시(60초), `req.org` 설정; `orgDefaults()`.
- `lib/routes/organizations.js`: `GET /api/org`(공개, 현재 조직 요약), `GET/POST/PUT /api/admin/organizations`(기본 조직 admin 만).
- `lib/routes/competitions.js`: 모든 목록 쿼리에 `organization_id=?`; `POST` 생성·복제 시 `organization_id=req.org.id`, 시간대 기본값 `req.org.default_tz`; `GET /:id`·`/api/event/:slug` 는 다른 조직이면 404.
- `lib/routes/home_popups.js`, `admin_keys.js(site-config)`: 조직 스코프.
- 프런트: 홈이 `/api/site-config` 의 `org` 를 받아 `window.PACE_ORG` 설정, 기본 조직이 아니면 헤더·문서 제목·og:site_name 을 조직 사이트 이름으로. `API.getOrg()` 추가. i18n 기본 언어는 지금처럼 브라우저 언어(ko/ja/그 외 en) — 조직 기본 언어 반영은 보류(브라우저 언어가 이미 세 언어를 가른다).
- 관리자: 시스템 › 조직 화면(디자인 틀 준수 — 표 + 드로어 아님, 소규모라 카드 + 폼), 플랫폼 관리자만 사이드바에 보임.
- 테스트 `tests/api/53_organization.test.js`.

## 5. 2단계 메모 (2026-10-02)
- 연맹 `code`·시리즈 `name`·부 `code` 의 UNIQUE 는 서버 전체 유일 그대로다(두 조직이 같은 코드를 못 씀). 해외 조직은 자기 코드(JAAF 등)를 쓰므로 실무 충돌은 없고, 필요해지면 `(organization_id, code)` 로 바꾼다.
- 새 조직에는 상장 양식 시드가 없다 → 그 조직 관리자가 상장·기록증 › 양식에서 만들어야 한다(없으면 발급 시 "양식이 없습니다").
- 아직 전역: 관리자 계정·운영키·`login_audit`·`undo_snapshot`·백업 폴더(3단계).

## 6. 3단계 메모 (2026-10-09)
- 레거시 관리자 비밀번호(`system_config.admin_pw`)는 플랫폼 운영자의 것 → 모든 호스트에서 관리자. 해외 조직 관리자는 JWT 계정(role admin, organization_id = 그 조직)으로만.
- 호스트가 곧 조직이다 — 관리자 화면에 조직 전환은 없다. 플랫폼 관리자가 다른 조직을 손보려면 그 조직 주소로 들어가 같은 계정으로 로그인한다.
- 남은 틈: WebSocket 구독은 대회 id 만 보고 조직을 보지 않는다(실시간 결과 push 가 다른 호스트로 새어 나갈 수 있음 — 공개 데이터라 낮은 위험, 4단계에서 호스트 검사 추가). 백업 ZIP·`audit_log`·`operation_log`(대회 없는 행)는 플랫폼 관리자만 본다.
- 운영 전제: DNS 와일드카드(`*.pace-rise-node.com`) + nginx `server_name` 에 와일드카드 추가. 쿠키는 호스트별이라 조직마다 따로 로그인한다(정상).
