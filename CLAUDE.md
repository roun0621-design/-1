# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pace Rise Competition OS — a Korean track-and-field (athletics) competition operation system. Single Node.js/Express server backed by SQLite (or PostgreSQL), serving a set of static HTML/JS pages for judges, call-room staff, scoreboard operators, broadcast overlays, and admins. Multi-competition, real-time (WebSocket) scoreboard. Comments and docs are predominantly in Korean — match that when editing.

## Commands

```bash
npm start            # run server (node server.js) → http://localhost:3000
npm run dev          # same as start
npm test             # vitest run — full suite, runs serially
npm run test:watch   # vitest watch mode
npm run test:coverage

# 컨테이너 (멀티테넌시 4단계): docker build -t pacerise . / docker compose up -d app — docs/DEPLOY_DOCKER.md

# Run a single test file or pattern:
npx vitest run tests/api/02_competitions.test.js
npx vitest run -t "some test name substring"
TEST_VERBOSE=1 npx vitest run <file>   # un-mute server boot logs for debugging

# PostgreSQL path (same suite against a local PG): create a template DB with db/schema.pg.sql applied, then
#   TEST_DB_BACKEND=postgres TEST_DATABASE_URL=postgres://user@host:port/<template_db> npm test   (or: npm run test:pg)
# Each test file clones the template DB (CREATE DATABASE … TEMPLATE) via psql; SQLite-only tests (file backup) are skipped.
```

There is no lint/format/build step — it's plain CommonJS, run directly with `node`.

Deploy (production EC2, PM2 app named `pacerise`): `./scripts/deploy.sh [branch]`. It refuses a dirty tree, pulls, runs `npm ci --omit=dev` only if `package.json` changed, PM2-restarts, polls `/api/health`, and auto-rolls-back on failure.

## Tests are DB-isolated — never touch the production DB

`tests/setup/global-setup.js` injects `SQLITE_PATH` pointing at a fresh `mkdtemp` temp file and forces `DB_BACKEND=sqlite` per run, so tests never hit the operational `db/competition.db` (which holds real competition data). When adding tests, rely on this isolation; never hardcode a DB path. `vitest.config.js` forces a single fork / serial execution (`fileParallelism: false`) to avoid SQLite lock contention. server.js skips `listen()` under tests via a `require.main !== module` guard, exporting the Express `app` for supertest.

## Architecture

### server.js is the monolith (~755KB, ~13k lines)
It owns: boot self-check, all middleware, the DB handle, ~30 shared helper functions, the WebSocket server, and most routes. It is being **incrementally decomposed** into `lib/routes/*` — do not assume a route lives in a module; many are still inline in server.js. Check `docs/MODULARIZATION_PROGRESS.md` for status and the extraction conventions before moving routes.

### Route modules use a factory pattern with explicit dependency injection
Extracted route files export `module.exports = function mount<Domain>Routes(app, deps)` and are wired in server.js like:
```js
require('./lib/routes/results')(app, { db, isAdminKey, isOperationKey, opLog, broadcastSSE, calcWAPoints, requireAdminAfterCompEnd });
```
`deps` passes server.js's shared helpers and the db handle by reference so behavior is identical to the inline version. When extracting a route: keep registration order (prefix routes like `/api/x/foo` must register before `/api/x/:id`), preserve `db.transaction(async () => {...})()` call shapes, and don't change `opLog` message formats. Each extraction must keep `npm test` green.

### Database abstraction layer — `lib/db.js`
A single adapter exposes a unified interface over **two backends**, selected by `DB_BACKEND` (`sqlite` default, or `postgres`):
- SQLite (`better-sqlite3`) is **synchronous**; PostgreSQL (`pg`) is **asynchronous**.
- Unified API: `db.get / db.all / db.run / db.exec / db.transaction(fn) / db.prepare / db.pragma / db.close`, plus `db.isAsync` and `db.getBackendName()`.
- The PG adapter auto-translates SQL: `?` → `$1,$2,…`, `INSERT OR IGNORE/REPLACE` → `ON CONFLICT`, `datetime('now')` → `NOW()`, `strftime` → `TO_CHAR`, and adds `RETURNING id` when a `lastInsertRowid` is needed.

**Critical implication:** because the same code path must run under both a sync and an async backend, all query call sites are written with `await`, and code must avoid SQLite-only / PG-only SQL. When writing SQL that differs by backend, branch on `db.isAsync` (see `orderByBibSql()` in server.js for the canonical example — `CAST(... AS INTEGER)` on SQLite vs `regexp_replace + NUMERIC` on PG). Schemas: `db/schema.sql` (SQLite) and `db/schema.pg.sql` (PostgreSQL) must be kept in sync. A new SQLite DB is auto-initialized + seeded from `db/seed_clean.sql` on first run.

### Authentication — two coexisting systems
1. **Legacy access keys** (still primary for most routes): role is derived from a key string via helpers in server.js — `isAdminKey`, `isOperationKey`, `isRecordOfficerKey`, `isAdminOrManager`, `getKeyRole`, `getJudgeName`. Keys arrive via `?key=`, `body.admin_key/operation_key`, or `x-admin-key`. The admin key is bcrypt-hashed (`ACCESS_KEYS.adminHash`); operation keys are cached in `_opKeyCache`. Tiers: viewer / operation / record_officer / manager / admin.
2. **JWT** (`lib/auth/jwt.js`, `lib/auth/middleware.js`): `attachUser()` builds a unified `req.user` (JWT first, legacy key fallback). Being adopted gradually; not yet on every route.

When adding protected routes, follow the pattern of the surrounding routes in that domain rather than mixing the two schemes arbitrarily.

### Organizations (multi-tenancy, 1단계 적용 2026-10-01)
`organization` 테이블 + `competition.organization_id`. `lib/org.js` 미들웨어가 요청 호스트(서브도메인·전용 도메인·`?org=`)로 `req.org` 를 정한다. 대회 목록·조회·생성·홈 팝업·site-config 는 `req.org.id` 로 걸러진다. **새로 만드는 전역 데이터(마스터·설정·키)는 `organization_id` 를 두고 `req.org` 로 거른다**; 다른 조직의 대회는 404 로 "없는 것처럼" 답한다(조직 가드 미들웨어가 대회를 가리키는 모든 `/api` 요청에 적용). 키 검사 함수는 `lib/reqContext.js`(AsyncLocalStorage)로 요청 조직을 안다 — 운영키·계정은 자기 조직 호스트에서만 통하고, 기본 조직의 admin 만 플랫폼 관리자로 어디서나 통한다. 단계·메모는 `docs/MULTI_TENANCY_PLAN.md`.

### Post-competition lock
Many write routes are gated by `requireAdminAfterCompEnd()` / `isCompetitionEnded()`: once a competition's `status='completed'` (or `end_date` passed with no explicit status), non-admins are blocked from mutations. Preserve this when touching write paths.

### Real-time & side effects
- WebSocket server at `/ws/scoreboard` pushes live scoreboard/overlay updates; `broadcastSSE` / WS broadcasts fire after result writes. The critical hot path is **judge record entry** (`record.html` → `POST /api/results`) which has concurrent-write risk — SQLite uses `busy_timeout` as mitigation; this flow is the priority target for the async/PG migration.
- `opLog(message, category, performedBy, compId)` writes to the operation log (surfaced in `oplog.html`). Treat its message format as a stable contract.

### Document generation
PDF/Excel output lives in `lib/` (not routes): `fullRecordExcel.js`, `fullRecordPdf.js`, `certificatePdf.js`, `comprehensiveByDivision.js`, plus `smsSender.js` for SMS. These use `exceljs`/`pdfkit`/`canvas` and contain large layout functions.

### Frontend
Static pages in `public/` (no framework, no bundler) — `record.html`+`record.js` (judge entry, core), `callroom.*`, `dashboard.*`, `monitor.html` / `overlay-*.html` (scoreboard & broadcast), `admin.html`, `results.*`. A service worker (`sw.js`) + `manifest.json` make it a PWA.

## Reference docs
- `docs/SYSTEM_MAP.md` — full system diagram, route groups, critical data flows.
- `docs/MODULARIZATION_PROGRESS.md` — server.js decomposition plan & safety rules.
- `docs/EXTERNAL_API.md`, `SCOREBOARD_API_GUIDE.md`, `FIELD_EVENT_GUIDE.md` — API/feature references.
- `db/schema.sql` / `db/schema.pg.sql` — table definitions (30+ tables).

## 작업 현황 — 맥미니·맥북 공용 인계 (단계 끝날 때마다 갱신하고 커밋)
사용자는 두 대의 맥을 번갈아 쓴다. 로컬 메모리(`~/.claude/projects/…/memory/`)는 기기마다 따로라 믿지 말고, **사실은 이 절**에 둔다.
- **새 세션은 항상 `git pull` 먼저, 그 다음 이 절을 읽고 시작한다.** "우리 어디까지 작업했어?" 류 질문엔 이 절(+ `git log -15 --oneline`)만 보고 바로 이어서 답한다.
- 한 단계(기능·수정 묶음)가 끝날 때마다 **완료·주요 결정·다음 할 일**을 여기 갱신해 코드와 같은 커밋(또는 바로 다음 커밋)으로 **커밋하고 push까지** 한다. 날짜는 절대 날짜로.
- 긴 역사는 각 문서(`docs/INTL_SYNC.md`, `docs/MULTI_TENANCY_PLAN.md`, `docs/DESIGN_SYSTEM.md` §0, `docs/HANDOFF_AG2026.md`)에 있고, 여기는 요약만.

### 개요
Pace Rise **Node** — 대한육상연맹·시도연맹·학교 대회용 육상 대회 운영 OS. 운영 서버 `https://pace-rise-node.com`(EC2 52.79.132.6, PostgreSQL, PM2 `pacerise`), 배포는 **사용자가** `./scripts/deploy.sh genspark_ai_developer`. 작업 브랜치 `genspark_ai_developer`. 조직(멀티테넌시) › 대회 › 종목·라운드·조 › 기록 → 대시보드·오버레이·문서(PDF/엑셀)·푸시·앱(iOS/Android PWA). 외부 동기화: 국제대회(Bornan)·전국체전(대한체육회 + 대한육상연맹). 클로드가 못 하는 것: 앱스토어 제출/업로드, 운영 DB 직접 접근, 서버 로그 읽기 — 사용자가 한다.

### 완료 (최신순)
- **2026-11-21 WaveLight 프로그램 분석 · 파일 보정 · 에이전트**: 사용자가 장비를 연결해 줌(`http://192.168.1.240:5001/wavelight`, 'Wavelight event tool' 5.0, 조명 400개, 로그인 없음). 화면 코드를 **읽기만** 해서 분석(`docs/WAVELIGHT.md`) — ① 파일을 두는 폴더는 없다(Complex 창에서 브라우저가 읽고 끝) ② 대신 컨트롤러에 바로 올리는 HTTP 명령이 있다(`/command06` 줄 시작 · `/command08` 취소 · `/command09` 상태 · `/command12` Fire) ③ 이 장비는 '구간 전체 초' 방식 → **평지 종목 파일 형식 확정** ④ Complex 창이 **19.2초 미만 구간**(남자 3000m 장애물의 마지막 100m, 1500m 첫 100m)과 **너무 긴 구간**(10,000m 한 구간)을 거부 → `lib/pacingExport.js` `fitForProgram` 이 합치거나 나눠서 낸다(전체 기록 그대로, 예시 7개는 그대로, 관리자 카드에 안내 한 줄, 사전 v22). `GET /api/pacing/wavelight.json`(파일 + 컨트롤러 값) + **`scripts/wavelight-agent/`**(폴더의 `.pc2` 를 최신으로 맞춤 + `http://localhost:5010` 보내기 화면에서 '올리기' → 색마다 빈 줄에 **출발 신호 대기**로 올림, Fire·전원은 안 건드림, 취소는 자기가 올린 줄만; `build-agent.sh` → `dist/wavelight-agent/`). 검증은 제조사 화면 코드를 그대로 쓴 **로컬 가짜 컨트롤러**에서(파일 7가지 Confirm 통과, 에이전트가 올린 줄이 제조사 화면에 빨간 줄 + Fire 켜짐). 이어서 **실제 장비 시험 통과**(사용자 승인, 조명 전원 켜진 상태): 에이전트 코드로 줄 1 에 1000m 180초를 대기로 올림 → 컨트롤러 응답 200(ACK) · 상태가 2(출발 신호 대기)로 → 취소 → 비워짐. Fire 는 보내지 않음. 테스트 74(+7) · 73 수정. DESIGN_SYSTEM §0, SYSTEM_MAP. **배포는 사용자**.
- **2026-11-20 페이싱 라이트 → WaveLight 시스템 파일(.pc2) 내려받기**: 사용자가 준 예시(`steeple_11-30.pc2` 등 7개, JSON 배열 `{"step-distance": "거리", "step-pace": 초}`) 형식 그대로. `lib/pacingExport.js` + `GET /api/pacing/:id/wavelight`(`?list=1` · `?color=` · 종목 zip) · `GET /api/pacing/wavelight.zip?competition_id=`. 색 한 줄 = 파일 하나, 구간 그대로(1000m 3분 = `{1000, 180.0}`). **3000m 장애물만** 조명 거리로 변환(물웅덩이 구간 조명 100m = 달리는 121.41m, 15구간, 0.01초 올림 — 예시 7개와 글자 단위로 일치). 파일 이름 영문 `<종목>_<성별>[_<부>]_<기록>_<색>.pc2`(`3000mSC_Women_Senior_11-30_Green.pc2`). **부별 설정** 추가: 관리자 › 페이싱 라이트에 '부 선택'(공통 / 대학부 …), 설정 키 `10,000m (남) [대학부]`(스키마 변경 없음), 대시보드 Target 은 부별 → 공통 순. 편집기 아래 'WaveLight 파일' 카드(파일 이름 목록 · 받기 · ZIP), 설정 목록 아래 '대회 전체 WaveLight 파일 (ZIP)'. 조직·종료 가드에 빠져 있던 `pacing` id 조회문 추가. 번역 사전 v21(조각 `scripts/i18n/parts/*_pacing_wl.json`). 헤드리스 크롬으로 실제 화면(한·영·일) 확인, 테스트 73. DESIGN_SYSTEM §0·§5·§9, SYSTEM_MAP. **배포는 사용자**.
- **2026-11-19 해외용 카탈로그 원본 복구 · 일문판 · 8쪽 컷**: 10-23 에 만든 영문 14쪽 PDF(`PACE_RISE_Node_Catalogue_EN_2026.pdf`)는 원본 HTML 이 어디에도 없어 고칠 수 없었다 → 문안 `scripts/catalog/copy.js`(en · ja) + 조판 `scripts/catalog/build.js`(헤드리스 크롬, A4 가로) + 글꼴 `scripts/catalog/fonts/`(Pretendard Std 3종, OFL)로 다시 만들어 커밋. `node scripts/catalog/build.js` 한 번에 **영문·일문 × 14쪽(연맹용)·8쪽(이벤트사용: 1·2·3·4·5·8·9·14쪽)** PDF 4개(`PACE_RISE_Node_Catalogue_2026_<EN|JA>[_8p].pdf`). 옛 판에서 고친 것: ① 화면 그림자가 맥·아이폰 기본 뷰어에서 **회색/검은 상자**로 찍혀 제목과 화면을 가리던 것(그림자를 아예 안 쓴다 — PDFKit 으로 다시 그려 확인) ② P4 글과 화면 겹침 ③ P5·P12 상자 높이 어긋남 ④ P9 '10 competitions'인데 표는 9줄 — 빠져 있던 **정선 중장거리 챌린지(마스터즈, KAAF, 248)** 를 넣고 `2,900+` → **`3,100+`**(운영 10개 대회 선수 행 합계 3,190, 운영 공개 API 로 재집계) ⑤ 글이 쪽을 넘치거나 그림·글꼴이 안 실리면 빌드가 경고. `capture.js` 에 언어 인자(`… <출력 폴더> ja` → `ja/` 에 일본어 UI 20컷, 한글 0). 문서(결과지·종합기록지)는 일문판에도 영문 그대로(docLabels: ja → en) — 캡션에 밝힘. 산출물·스크린샷은 **이 맥**의 `~/Desktop/NODE_카탈로그_스크린샷_2026-10-22/`(`en/` · `ja/` · `catalogue/`), 다른 맥에선 seed → capture(en, ja) → build 로 다시 만든다(build.js 머리말).
- **2026-11-09 유소년 페스티벌 주최 파일 도착 · 점검 · 리허설**: `유소년_공인기록증_발급명단1109.xlsx`(시트 1개, 1행 제목 · 2행 머리글 `순·소속·학년·선수명·선수성별·종목·기록·연락처·비고`, 338행 = 259명, **순위·라운드·조 칸 없음**) → 파서 보강: ① `선수성별` 머리글 인식(안 되면 전 행 '성별을 알 수 없음' + 남녀가 한 종목으로 묶임) ② 010 은 11자리만 — 한 자리 빠진 번호·유선 번호를 미리보기 '확인 필요'와 `stats.bad_phone`('문자 못 가는 번호 N')으로, `SMS.isValidMobile` 도 같은 규칙(일괄 발송이 그런 번호를 그대로 시도하던 것 → `invalid_phone` 으로) ③ 기록의 2진 소수 찌꺼기 반올림(동률 보호) ④ **번호를 고쳐 다시 올리면 같은 선수의 전화만 갱신**(예전엔 '이름 (소속)' 둘째 선수 행이 생겨 기록증 이름이 그렇게 찍혔을 것) ⑤ 일괄 발송 **발송 모드 '완주자 전원'이 실제로 전원에게**(서버가 `mode` 를 안 봐서 '순위 외 완주자도'를 따로 체크하지 않으면 1~3위에게만 나가던 것) ⑥ '결과표 가져오기' 카드를 **알림 (푸시 · 문자) › 문자 발송 탭**의 일괄 발송 카드 바로 위에 묶음(`ADMIN_SCREENS` 하위 탭 목록에 빠져 있었음 — 헤드리스 크롬으로 실제 화면에서 수정본 올리기·미리보기·반영까지 확인). 로컬 리허설(임시 SQLite · 시뮬레이션, 실제 파일): 27종목(학년×성별×종목, 전부 결승 1조) · 기록 338건 · 재반영 멱등 · 문자 331통(전부 LMS 148~155바이트, 받는 번호 199개 — 형제·코치 번호 공유는 선수마다 따로 나감) · 못 가는 7행 = 3가구(순46, 순116·117 = 010 한 자리 빠짐 / 순153·154·318·319 = 유선 031) · 기록증 PDF 는 긴 소속명·1/1000초 기록(순9 `11.009`, 순96 `12.752`, 순125 `12.759` — 적힌 그대로 찍힘) 모두 한 장에 정상, 순위는 기록증 양식이면 안 찍힘. 테스트 70(+1)·43.
- **2026-11-08 결과표 가져오기(문자 발송용)**: 2026 유소년 기초종목 생활체육 육상 페스티벌은 경기 운영이 아니라 **결과 문자 발송만 계약** — 주최가 '이름·전화번호·소속·(부별)·종목·기록' 엑셀을 주면 관리자 › 알림 › 문자 › **결과표 가져오기** 카드에 올려 미리보기 → 반영(선수는 이름+전화로 동일인, 종목은 성별·부별·라운드로 찾고 없으면 생성, 1조, 기록은 트랙 시간/거리/높이/DNS·DNF·DQ, 멱등) → 기존 **일괄 발송**으로 종목마다 한 통. `lib/resultSheetImport.js`(파서, 머리글 이름으로 열 인식, 종목 칸에 '남초6 100m 예선'처럼 부별·라운드가 섞여도 됨) + `lib/routes/result_sheet_import.js`(`/api/admin/result-sheet/preview|import`), 테스트 `tests/api/70_result_sheet_import.test.js`. 양식은 주최가 정해 오므로 열 이름이 다르면 `HEADER_RULES` 에 추가.
- **2026-11-06 워터마크 위치 + 발급자·인장 묶음 가운데**: 사용자 지적(기록 칸과 가운데 워터마크가 어긋남 / 발급자 글자와 직인을 한 묶음으로 가운데) → `certificate_template.watermark_anchor`(panel 기본 · fit · page, SQLite/PG 마이그레이션 + schema.pg.sql), 기록증 워터마크 기준점을 **기록 칸 가운데**로(11-06 세로 가운데 배치로 생긴 어긋남 복구), 양식 편집기 '워터마크 위치' 셀렉트(기록증만). 발급자 줄은 글자+인장('(인)') 묶음 가운데(기록증·상장, 기본). '여러 디자인 중 고르기'는 양식 여러 개 + 미리보기 PDF 로(기존 기능), 디자인 프리셋은 보류. 테스트 72(+7). DESIGN_SYSTEM §0·§5·§11, SYSTEM_MAP. **배포는 사용자**.
- **2026-11-06 기록증 양식 배치(경기도육상연맹 요청 6건)**: 증명 문구 삭제 · 배번 삭제 · 제목을 대회명 자리까지 내리고 전체 가운데 · 글씨 키우기 · 로고 키우기 · '경기도육상연맹 회장 이윤진' 한 줄 → 기록증 PDF 는 내용 블록을 **로고 줄 아래 ~ 카드 하단 세로 가운데**에 놓고(기본 변경, `lib/certificatePdf.js` renderRecordCard 가 블록 높이를 먼저 잼, 안 들어가면 배율 자동 축소), `certificate_template` 에 `show_body`(본문/증명 문구 표시) · `show_bib`(기록증 배번 표시) · `signer_inline`(발급자 한 줄) · `font_scale`(1~1.3) · `logo_scale`(0.5~2) 추가(SQLite/PG 마이그레이션 + schema.pg.sql). 양식 편집기: 글자 크기 N%·로고 크기 N% 슬라이더, 표시 옵션 '본문'·'배번', 발급자 배치 셀렉트. 상장(시상장·완주증·단체상)에도 같은 옵션(로고 키우면 머리 부분이 그만큼 내려감). 기본값은 예전 출력과 동일. 테스트 72. DESIGN_SYSTEM §0·§5·§11, SYSTEM_MAP. **배포는 사용자**.
- **2026-11-05 상장 링크 내구성 + 대회별 문자 문구 + 초등 1·2학년 부**: 운영 문의(옛 문자의 링크가 안 열림 / 다른 사람이 뜸) → 문자·이메일 링크를 `cert_link` 발급 기록(난수 토큰 + 선수 이름·배번 스냅샷) 기반으로 바꾸고, 공개 라우트 `/c/:token` 은 지금 선수와 다르면 410 으로 닫음(옛 HMAC 토큰은 계속 받되 `sms_log` 발송 시각 < 선수 행 생성 시각이면 닫음), 안내 문구에서 '만료' 삭제. 관리자 › 알림 › 발송 이력에 **링크 진단**(붙여 넣으면 누구 것인지·지금 열리는지·발송 이력). `competition.sms_template` + 일괄 발송 카드의 '이 대회 문자 문구'(요청 > 대회 > 조직 기본). **문자 링크 상장 양식도 대회별 선택**(입상 1~3위 / 그 외 완주자 두 칸, `competition.cert_tpl_award_id/other_id`, 비우면 자동=★기본 시상장·완주증) — 전원 기록증이면 두 칸 모두 기록증 양식. 부 마스터 학년 부 24행(초1~6), '남자초등부 1학년 (5~7세 포함)' 괄호 허용. 기본 상장 양식 시드를 마이그레이션 뒤로 옮겨 새 DB 첫 부팅부터 시드됨. 테스트 71. **배포는 사용자**.
- **2026-11-05 기록증 워터마크가 기록 칸에 가려지던 것**: 기록증 PDF 가 워터마크 → 기록 패널(기본 불투명) 순서로 그려 가운데 워터마크가 통째로 가려짐 → 패널 바탕 → 워터마크 → 글자 순서로(`lib/certificatePdf.js` renderRecordCard, 증명 문구 높이를 먼저 재서 패널 위치 확정). 양식 편집 슬라이더 '기록 패널 투명도'·'워터마크 투명도'는 값이 불투명도라 말과 반대 → **'진하기 N%'**(저장값 그대로, 표시만 ×100). 테스트 70(콘텐츠 스트림 연산자 순서). DESIGN_SYSTEM §0·§5·§11. **배포는 사용자** — 운영 양식(경기도육상연맹)은 워터마크 진하기가 2%라 배포 뒤 8~15%로 올려야 보인다. 계측 에이전트 '클릭 → 다운로드 → 실행' 요청은 GitHub 릴리스 호스팅 여부 답 대기.
- **2026-11-05 상장 미리보기 모달 수정**: 관리자 › 상장·기록증 › PDF 양식 '미리보기'가 운영 크롬에서 빈 회색 화면(찡그린 문서 아이콘)이던 것 — 모달이 blob PDF 를 iframe 에 넣는데 CSP frame-src 에 `blob:` 이 없어 크롬이 프레임을 막았다(2026-09-21 CSP 도입, 10-01 모달 추가 → 운영에선 처음부터 안 열림). frame-src 에 `blob:` 추가 + 06_health CSP 테스트. object-src 'none' 유지. '새 창' 버튼·문자 링크 /c/:token 은 원래 정상. **배포는 사용자**. 같은 날 상장 문자 발송 문의 대응 중(고객에게 로고·직인 요청문 전달, 실물 상장 샘플로 갈래 판정 예정).
- **2026-10-22 카탈로그 스크린샷 재촬영**: 영문 가상 시드(`scripts/catalog/seed.js`) + 촬영·한글 검사(`capture.js`) → `~/Desktop/NODE_카탈로그_스크린샷_2026-10-22/`(19컷, hangul 전부 빈 배열). 그 김에 영문 UI 누락 번역(뒤로/앞으로·글씨·메달 툴팁, 감사 로그 배지, 레인 배정 사유, 관리자 라운드 툴팁, `LIVE 진행중`, 10종 시간표 줄), 영문 부제 중복 숨김(`.page-sub`), 운영 로그 시각 로케일. 사전 v20. 10/22 보강: 시간표 09:00~17:30 고정 + 촬영 시계 12:14, PDF 라틴 확장 글리프 Noto Sans 폴백(`lib/pdfLatinFallback.js`), 영문 결과지 높이 2.14 표기, 종목별 공식 결과지에 시각·풍속·심판장 서명(`results_sheet_W100mF.png`), 모니터 완료 종목 전원 소집.
- **2026-10-17~20 전국체전**(10/18~21 제주, 운영 대회 id 65): 대한체육회 구조·엔트리 동기화(`lib/intl/nsf*.js`) + 연맹 데일리 조편성 PDF 가져오기(`nsf_daily.js`, 관리자 수동 종목 매칭 10/20) + 연맹 실시간 결과(`kaaf*.js`, 10/20 장대높이뛰기 둘째 줄 파서) + 대시보드 보정(로딩 멈춤 `_catTxt`, 상단 LIVE 묶음 삭제, 10종이 다음 날 칸에 가던 것, 히어로 부 알약). 테스트 68·69. 2026-10-22 사후 점검 완료: 연맹 187행·우리 153종목 전부 완료, 매칭 누락 0, 기록 1,735건; 혼성계주 빈 2조만 남아 '완료 종목의 빈 조 자동 정리' 추가(운영 65 는 관리자 › 지금 동기화 한 번이면 정리됨).
- 2026-10-13 멀티테넌시 운영 개통: Gabia 와일드카드 DNS, 서버 `pacerise-add-domain`(LE 인증서/nginx), `demo.pace-rise-node.com` + 조직 demo.
- 2026-10-12 밀린 작업 일괄: 공개 API v1(`lib/routes/public_v1.js`), 이메일(`lib/mailer.js`)+Twilio, 5종 점수, GDPR 익명화, 오버레이 브랜드/4K/세로, 관측(`lib/observe.js`), GA 동의, 타이밍 PC 에이전트 폴더(`scripts/timing-watcher/`), 브랜드 마무리(헤더 B안·스플래시·심볼 워터마크·푸터 워드마크), 모바일 결과 행 overflow. 카탈로그 초안 `NODE_CATALOG_SOURCE.md`(**미커밋 유지**).
- 2026-10-09~10 새 브랜드(타탄 #C24A2E·브레이크 심볼, 골드 폐기), 관리자 재설계, C1~C6(계측 워처·자동 조편성 등), 국제 양식 가져오기, 문서 영문판.
- 2026-10-01~09 멀티테넌시 코드 1~4단계(조직·대회·마스터·설정·계정·운영키·조직 가드·WS·Docker).
- 2026-09-23~29 나고야 아시안게임 동기화(Bornan, 대회 63, 완료) — `docs/HANDOFF_AG2026.md`.
- 2026-09-21 중고연맹 도입 Phase 7. 앱: iOS 1.1 판매 중, 1.2(빌드5, 새 아이콘) 10/12 심사 제출, Play v4 aab 빌드됨(콘솔 업로드는 사용자).

### 주요 결정 (사용자)
- WaveLight 연동 범위(2026-11-20): **실시간 동기화·통합 운영 콘솔은 필요 없음**(만들지 않는다). 컨트롤러 전송은 **에이전트처럼**(계측 PC 에이전트와 같은 꼴 — 저장하면 WaveLight PC 에 파일이 알아서 들어오는 것) 되면 좋고, 안 되면 **자동화 느낌 정도**면 충분. 프로토콜·프로그램 분석은 **사용자가 이 맥에 장비를 연결해 준 뒤에** 한다(11-21 연결됨 → 분석·에이전트 완료, 실제 장비에 올리는 시험은 사용자 승인 뒤).
- WaveLight 파일(2026-11-20): 운동장은 **400m 기준 고정**(경기장별 설정 없음). 구간은 **입력한 그대로**(1000m 3분이면 1000m 180초, 구간이 나뉘어 있으면 구간별). 파일 이름은 **영문 + 색 포함**. 5초 간격으로 여러 개 뽑는 기능은 **필요 없음**. 평지 종목 예시 파일은 없음(장애물 예시의 형식을 그대로 씀 — 11-21 프로그램 화면 코드로 맞다고 확인).
- 유소년 페스티벌 기록 표기·번호(2026-11-09): 1/1000초까지 적힌 기록(순96 `12.752` · 순125 `12.759`)은 **적힌 그대로** 기록증에 찍는다. 순9 `11.009` 는 `11.09` 의 오타로 본다. 문자 못 가는 7행(3가구, 선수 4명)은 주최에 번호를 다시 묻지 않고 **사용자가 준 대표 번호 하나로** 보낸다(그 번호는 명단의 순95·316·317 도 이미 쓰는 번호라 모두 10통이 간다). 두 가지를 반영한 **수정본** `~/Downloads/유소년_공인기록증_발급명단1109_수정.xlsx` 를 올린다(원본은 그대로 둠, 파일은 만든 맥에만 있음 — 다른 맥에서 하면 원본에서 순9 기록 칸과 그 7행 연락처 칸을 다시 고친다).
- 유소년 페스티벌 문자(2026-11-08): 예선 파일·결승 파일 **둘 다 대비**(예선 결과 먼저 보내고 결승 파일이 오면 결승 진출자에게 한 통 더 — 라운드가 다른 종목이라 중복 방지에 안 걸림). **종목마다 따로 한 통**(두 종목이면 두 통). 문구는 **선수 본인에게 말하는 투**(대회별 문자 문구에 넣는다).
- 상장 링크는 기한 없이 유지한다(문자에 '삭제됨' 안내 불필요). 대신 명단이 바뀌면 남의 상장이 아니라 안내 페이지가 뜬다 — 그 선수에게는 일괄 발송(중복 방지 끔)으로 다시 보낸다. 문자 문구는 대회마다 다를 수 있다(대회 문구 > 조직 기본).
- 종목 이름은 정식명(`100m`)만, 부(18세이하·대학·일반)는 `division` 칸 → 화면 알약/탭. 시간표는 **시작 시각만**. 전국체전 10종·7종 대학부는 대회에 없음(일반부에 포함) → 그대로 둔다.
- 전국체전 결과는 **연맹 result.kaaf.or.kr 우선**, 종목표가 비면 대한체육회 폴백. '순위처리'도 완료(종합 총점표는 '경기완료'만), 끝난 행도 3시간 동안 5분마다 재읽기(정정 반영). 데일리 PDF는 변환 없이 그대로 업로드, 배번은 연맹 번호.
- 대시보드 상단 'LIVE 묶음' 없음(배지·깜빡임·NEXT로 충분). Node에선 브랜드 색 규칙을 유연하게 — 무분별하지만 않으면 색 사용 OK(`docs/DESIGN_SYSTEM.md` §0).
- 멀티테넌시 C안(한 서버, 조직 칸막이). 과금·가입은 미정. 문자는 기록증만, 푸시는 FCM.
- WA-readiness 우선순위: 인프라 > 유지보수 > 국제화 > 공정성.

### 다음 할 일
1. **유소년 페스티벌 문자(계약)** — 주최 파일 받음, 수정본 준비됨(11-09, 수정본으로 리허설 통과). 남은 순서: ① **배포**(11-09 파서 보강이 들어가야 `선수성별` 을 읽는다) ② 주최에 알릴 것(사용자, 선택): 순9 를 `11.09` 로 발급한다는 것 · 순위 없이 기록만 안내한다는 것(파일에 순위가 없음 — 우리가 기록으로 매긴 순위는 명단에 있는 사람끼리의 순위일 뿐) ③ 운영: 대회 만들기(대회명·시작일이 기록증에 찍힘) → 관리 › 알림 (푸시 · 문자) › **문자 발송** 탭 › 결과표 가져오기에 **수정본**을 올려 **미리보기**(기대값: 행 338 · 종목 27 · 선수 259 · 보낼 수 있는 338 · 확인 필요 0 — '문자 못 가는 번호 7'이 보이면 원본을 올린 것) → 반영 ④ 일괄 발송 카드: **문자 링크 상장 양식 두 칸 모두 기록증 양식**(비워 두면 우리가 매긴 1~3위에게 '우승' 시상장이 열린다) · '이 대회 문자 문구'는 선수에게 말하는 투로, `{rank_label}` 없이(조직 기본 문구에는 들어 있음) · 발송 모드 '완주자 전원' · 월 한도(0 = 없음)에 338통 여유 ⑤ '먼저 미리보기'로 통수 확인(338통 · 운영 문자 설정이 시뮬레이션이 아니면 그 버튼도 실제로 보낸다 — 확인 창이 뜬다) → 실제 발송. 나중에 번호나 기록을 고칠 일이 생기면 엑셀의 그 칸만 고쳐 다시 올리고(전화만 갱신) 일괄 발송을 한 번 더 — 이미 보낸 사람은 건너뛴다(같은 사람에게 다시 보내려면 '이미 보낸 사람 제외'를 끈다). 이 파일은 라운드 칸이 없어 전부 '결승'으로 들어가므로, 주최가 예선·결승 파일을 따로 또 보내면 같은 종목에 덮어쓰이지 않는지 먼저 본다. 파일 열 이름이 또 다르면 `lib/resultSheetImport.js` HEADER_RULES 보강.
2. **배포**: `./scripts/deploy.sh genspark_ai_developer` 뒤 ⓪ **WaveLight 파일**: 관리 › 페이싱 라이트에서 종목을 저장하고 'WaveLight 파일' 카드의 파일을 받아 **WaveLight 프로그램에 실제로 넣어 본다**(평지 형식은 11-21 프로그램 화면 코드로 확정, 19초 미만·너무 긴 구간은 서버가 맞춰서 낸다 — Complex › Load file › Confirm 이 닫히는지만 보면 된다). 부별로 목표가 다르면 '부 선택'에서 부를 고르고 입력 ① 상장·기록증 › 미리보기 모달 확인(CSP) ② 경기도육상연맹 기록증 양식 편집: 워터마크 진하기 8~15%, **글자 크기 120~130% · 로고 크기 150~200% · 표시 옵션 '본문'·'배번' 해제 · 발급자 배치 '한 줄'** → 미리보기 PDF 를 고객에게 보내 확인(로고·직인 실물 파일 받으면 교체) — 워터마크 위치는 기본 '기록 칸 가운데'라 그대로 두고, 배포 뒤 워터마크가 기록 칸 안에 오는지·발급자 줄과 직인이 한 묶음으로 가운데인지 확인 ③ 알림 › 발송 이력 › **링크 진단**에 문제였던 옛 문자 링크를 붙여 넣어 원인 확인(서명 불일치=서버 키 변경 / changed=명단 재등록) ④ 새로 보낼 문자는 일괄 발송에서 '이 대회 문자 문구'와 **문자 링크 상장 양식 두 칸**(경기도육상연맹이면 둘 다 기록증 양식) 확인. 계측 에이전트 원클릭 내려받기는 GitHub 릴리스 호스팅 답 대기.
2-1. **WaveLight 에이전트 현장 확인(사용자)**: 에이전트는 만들었고, 실제 컨트롤러에 대기로 올리기·취소까지 통과했다(11-21). 남은 순서 — ① **배포**(운영 서버에 `/api/pacing/wavelight.json` 이 있어야 에이전트가 운영 대회를 받는다; 그 전에는 로컬 서버로만) ② 배포 뒤 에이전트를 띄워 보내기 화면에서 실제 종목을 올리고 **WaveLight 화면의 Fire 로 조명이 달리는지** — 기록대로 가는지, 대기 중인 줄이 조명에 어떻게 보이는지, 출발선(평지 계산값 · 장애물 351)이 트랙과 맞는지 ③ 어긋나면 그 종목·출발선 숫자를 알려 주면 맞춘다 ④ 이 맥에서 쓸 묶음: `bash scripts/wavelight-agent/build-agent.sh mac` → `dist/wavelight-agent/mac/PaceRise-WaveLightAgent/`, `config.json` 에 대회 번호와 `controller: http://192.168.1.240:5001`. 다른 경기장 장비에 붙일 때는 `static/js/wavelight.js` 의 시간 단위(구간 전체 초인지)를 먼저 본다. 실시간 콘솔은 범위 밖(결정).
3. 전국체전 마무리(사용자): 관리자 › 대회 65 › 국제대회 동기화 › **지금 동기화** 한 번(빈 2조 정리). 클로드 계정 로그인(김로운/0621)은 운영에서 안 통함 — 운영키 점검이 필요하면 사용자가.
4. (결정 대기) 일반부 10종·7종에 대학생이 섞인 걸 알약 '대학·일반부'로 표시할지.
5. 카탈로그: 영문·일문 PDF 4종 나옴(11-19, 가격은 'Pricing on request' 로 확정 · 회사 정보는 뒤표지에 있음). 사용자 확인 대기 — ① 실적 표에 **KAAF 주최 정선 마스터즈를 싣는 것**(싫으면 `copy.js` ROWS 에서 그 줄만 지운다 → 자동으로 9개 · 2,900+) ② 일문 문안 원어민 검수(클로드 번역) ③ KTFL·KUAF 로고·명칭 사용 허가, 대회 공식 영문명(P9 는 임시 번역) ④ 있으면 좋은 것: 현장 사진 · 연맹 추천사 · 업타임/GA4 수치. 문안을 고치면 `copy.js` 만 고치고 `build.js --png` 로 눈으로 본다. 사실 정리 `NODE_CATALOG_SOURCE.md` 는 계속 미커밋(§10 내부 보안 메모).
6. 앱: iOS 1.2 심사 결과 확인, Play v4 콘솔 업로드(사용자).
7. 멀티테넌시 제품 결정(과금·가입 흐름), 옛 `pacerise-api`(/api/v1) 정리.
8. 남은 큰 것: C7 벤더 포맷(샘플 필요), cluster/Redis, 오버레이 커스터마이징.

## 디자인 틀 (반드시 따를 것)
화면·문구·아이콘·글자 크기·색·버튼·레이아웃을 새로 만들거나 고칠 때는 먼저 `docs/DESIGN_SYSTEM.md` 를 읽고 그 규칙대로 한다. 사용자가 디자인 수정을 요청하면 코드와 함께 그 문서(§0 요청 이력 + 해당 절)를 갱신한다. 동작 규칙은 `docs/UX_RULES.md`.
