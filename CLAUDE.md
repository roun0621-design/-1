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
- 상장 링크는 기한 없이 유지한다(문자에 '삭제됨' 안내 불필요). 대신 명단이 바뀌면 남의 상장이 아니라 안내 페이지가 뜬다 — 그 선수에게는 일괄 발송(중복 방지 끔)으로 다시 보낸다. 문자 문구는 대회마다 다를 수 있다(대회 문구 > 조직 기본).
- 종목 이름은 정식명(`100m`)만, 부(18세이하·대학·일반)는 `division` 칸 → 화면 알약/탭. 시간표는 **시작 시각만**. 전국체전 10종·7종 대학부는 대회에 없음(일반부에 포함) → 그대로 둔다.
- 전국체전 결과는 **연맹 result.kaaf.or.kr 우선**, 종목표가 비면 대한체육회 폴백. '순위처리'도 완료(종합 총점표는 '경기완료'만), 끝난 행도 3시간 동안 5분마다 재읽기(정정 반영). 데일리 PDF는 변환 없이 그대로 업로드, 배번은 연맹 번호.
- 대시보드 상단 'LIVE 묶음' 없음(배지·깜빡임·NEXT로 충분). Node에선 브랜드 색 규칙을 유연하게 — 무분별하지만 않으면 색 사용 OK(`docs/DESIGN_SYSTEM.md` §0).
- 멀티테넌시 C안(한 서버, 조직 칸막이). 과금·가입은 미정. 문자는 기록증만, 푸시는 FCM.
- WA-readiness 우선순위: 인프라 > 유지보수 > 국제화 > 공정성.

### 다음 할 일
1. **배포**: `./scripts/deploy.sh genspark_ai_developer` 뒤 ① 상장·기록증 › 미리보기 모달 확인(CSP) ② 경기도육상연맹 양식 워터마크 진하기 8~15% 로 ③ 알림 › 발송 이력 › **링크 진단**에 문제였던 옛 문자 링크를 붙여 넣어 원인 확인(서명 불일치=서버 키 변경 / changed=명단 재등록) ④ 새로 보낼 문자는 일괄 발송에서 '이 대회 문자 문구'와 **문자 링크 상장 양식 두 칸**(경기도육상연맹이면 둘 다 기록증 양식) 확인. 계측 에이전트 원클릭 내려받기는 GitHub 릴리스 호스팅 답 대기.
2. 전국체전 마무리(사용자): 관리자 › 대회 65 › 국제대회 동기화 › **지금 동기화** 한 번(빈 2조 정리). 클로드 계정 로그인(김로운/0621)은 운영에서 안 통함 — 운영키 점검이 필요하면 사용자가.
3. (결정 대기) 일반부 10종·7종에 대학생이 섞인 걸 알약 '대학·일반부'로 표시할지.
4. 카탈로그: 스크린샷은 됐고, 사용자 입력(가격·회사 정보·로고 허가) 받으면 `NODE_CATALOG_SOURCE.md`(미커밋) 완성.
5. 앱: iOS 1.2 심사 결과 확인, Play v4 콘솔 업로드(사용자).
6. 멀티테넌시 제품 결정(과금·가입 흐름), 옛 `pacerise-api`(/api/v1) 정리.
7. 남은 큰 것: C7 벤더 포맷(샘플 필요), cluster/Redis, 오버레이 커스터마이징.

## 디자인 틀 (반드시 따를 것)
화면·문구·아이콘·글자 크기·색·버튼·레이아웃을 새로 만들거나 고칠 때는 먼저 `docs/DESIGN_SYSTEM.md` 를 읽고 그 규칙대로 한다. 사용자가 디자인 수정을 요청하면 코드와 함께 그 문서(§0 요청 이력 + 해당 절)를 갱신한다. 동작 규칙은 `docs/UX_RULES.md`.
