# PACE RISE — 시스템 연동 맵 (Phase 2-pre)

> 작성일: 2026-05-15
> 목적: PostgreSQL 마이그레이션 전, 시스템 전체 구조 파악 + 죽은 코드 식별
> 후속: 이 문서를 기반으로 Phase 2-A (PostgreSQL 어댑터) 들어감

---

## 1. 시스템 전체 그림

```
┌─────────────────────────────────────────────────────────────┐
│  브라우저 (사용자)                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ HTML 페이지 (15개)                                    │   │
│  │   ├─ index.html         (홈 대시보드)                  │   │
│  │   ├─ admin.html         (관리자)                       │   │
│  │   ├─ dashboard.html     (모니터링)                     │   │
│  │   ├─ callroom.html      (콜룸 = 출전 체크인)           │   │
│  │   ├─ record.html        (심판 기록 입력) ★ 핵심        │   │
│  │   ├─ results.html       (결과 조회)                    │   │
│  │   ├─ display-manage.html (전광판 관리)                 │   │
│  │   ├─ monitor.html       (전광판 화면)                  │   │
│  │   ├─ callroom-monitor.html (콜룸 모니터)               │   │
│  │   ├─ overlay-scoreboard.html (방송 오버레이)           │   │
│  │   ├─ overlay-lower-third.html (방송 자막)              │   │
│  │   ├─ oplog.html         (운영 로그)                    │   │
│  │   ├─ open.html          (카카오톡 인앱브라우저 우회)    │   │
│  │   ├─ og-preview.html    (Open Graph 미리보기)          │   │
│  │   └─ icons/icon-render.html (아이콘 생성용)            │   │
│  └─────────────────────────────────────────────────────┘   │
│              ↕ HTTP REST    ↕ WebSocket                     │
└─────────────────────────────────────────────────────────────┘
                                ↕
┌─────────────────────────────────────────────────────────────┐
│  server.js (12,760줄)                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Express 라우트 (221개)                                │   │
│  │   ├─ /api/admin/* (33개) 관리자 전용                   │   │
│  │   ├─ /api/display/* (26개) 전광판/디스플레이           │   │
│  │   ├─ /api/events/* (24개) 종목                         │   │
│  │   ├─ /api/timetable/* (12개) 시간표                    │   │
│  │   ├─ /api/joint-groups/* (9개) 통합 그룹               │   │
│  │   ├─ /api/documents/* (8개) PDF/Excel 생성             │   │
│  │   ├─ /api/competitions/* (7개) 대회                    │   │
│  │   ├─ /api/heats/* (6개) 조                             │   │
│  │   ├─ /api/event-records/* (6개) 한국기록/대회기록      │   │
│  │   ├─ /api/scoreboard/* (5개) 전광판                    │   │
│  │   └─ ... (나머지 라우트들)                              │   │
│  │                                                       │   │
│  │ WebSocket 서버 (ws://...)                              │   │
│  │   └─ /ws/scoreboard — 전광판 실시간 연동                │   │
│  └─────────────────────────────────────────────────────┘   │
│              ↕ lib/db.js (어댑터)                            │
└─────────────────────────────────────────────────────────────┘
                                ↕
┌─────────────────────────────────────────────────────────────┐
│  SQLite (db/competition.db, 1.1MB)                           │
│  → Phase 2 후 PostgreSQL로 교체                              │
│  테이블 30+ 개:                                              │
│    competition, event, athlete, event_entry,                 │
│    heat, heat_entry, result, height_attempt,                 │
│    combined_score, qualification_selection,                  │
│    audit_log, operation_log, relay_member,                   │
│    pacing_*, event_record, operation_key,                    │
│    timetable, display_roster, federation_list,               │
│    home_popup, doc_template, doc_logo, ...                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 핵심 연동 흐름 (Critical Path)

### 흐름 ①: 심판 기록 입력 (가장 빈번 + 동시 충돌 위험)
```
심판 (record.html + record.js)
    ↓ POST /api/results
server.js
    ↓ db.run(INSERT INTO result ...)
SQLite
    ↓ WebSocket broadcast
전광판 (monitor.html / overlay-scoreboard.html)
관리자 (admin.html)
결과 페이지 (results.html)
```
**위험점:** 다중 심판 동시 입력 시 SQLite 잠금 → busy_timeout 응급조치 적용됨
**Phase 2 핵심 대상:** 이 흐름의 모든 라우트를 비동기로 변환

### 흐름 ②: 콜룸 체크인
```
콜룸 직원 (callroom.html + callroom.js)
    ↓ POST /api/callroom/checkin
    ↓ db.run(UPDATE event_entry SET status='checked_in')
    ↓ WebSocket broadcast
콜룸 모니터 (callroom-monitor.html)
```

### 흐름 ③: 전광판 표시
```
전광판 관리자 (display-manage.html)
    ↓ POST /api/display/...
    ↓ db.run(UPDATE display_roster ...)
    ↓ WebSocket /ws/scoreboard
전광판 화면 (monitor.html, overlay-*.html)
```

### 흐름 ④: 결과지/상장 PDF 생성
```
관리자 (admin.html)
    ↓ GET /api/documents/result-sheet/:eventId
server.js
    ↓ lib/fullRecordExcel.js / lib/fullRecordPdf.js
    ↓ (DB에서 데이터 조회)
PDF/Excel 파일 응답

GET /api/documents/kjaf-record/:compId/excel  → lib/kjafRecordSheet.js  (한국중·고육상연맹 종합기록지, 2026-09 Phase 7-①)
    시트 묶음(남중/여중/N학년부/믹스릴레이/신기록현황)은 종목의 division 으로 결정 (planSheets). 결승 라운드만, 순위 8칸, 승인된 신기록만 CR/DR/KR.
```

---

## 3. 라우트 그룹 → 위험도 분류 (Phase 2 비동기 변환 순서 결정용)

| 그룹 | 라우트 수 | 위험도 | 변환 우선순위 | 비고 |
|---|---|---|---|---|
| `/api/admin/*` | 33 | 🟡 중 | 2차 | 관리자만 호출, 동시 충돌 적음 |
| `/api/display/*` | 26 | 🔴 높 | 3차 | WebSocket 연동 많음, 신중 |
| `/api/events/*` | 24 | 🟡 중 | 2차 | 종목 CRUD |
| `/api/timetable/*` | 12 | 🟢 낮 | 1차 | 일정 조회 위주 |
| `/api/joint-groups/*` | 9 | 🟢 낮 | 1차 | |
| `/api/documents/*` | 8 | 🟡 중 | 2차 | PDF/Excel 생성 — lib/도 같이 |
| `/api/competitions/*` | 7 | 🟢 낮 | 1차 | 단순 CRUD |
| `/api/heats/*` | 6 | 🔴 높 | 3차 | 핵심 운영 데이터 |
| `/api/event-records/*` | 6 | 🟢 낮 | 1차 | 기록 관리 |
| `/api/scoreboard/*` | 5 | 🔴 높 | 3차 | WebSocket 직결 |
| `/api/results` | 4 | 🔴 최고 | 3차 | 가장 핵심 |
| `/api/height-attempts` | 3 | 🔴 높 | 3차 | 필드 종목 핵심 |
| `/api/combined-scores` | 3 | 🟡 중 | 2차 | 혼성 종목 |
| 기타 (나머지) | 75 | 🟢 낮 | 1차 | 대부분 단순 조회 |

---

## 4. WebSocket 연동 지점

server.js 안에서 broadcast 호출 **62회**.

주요 이벤트:
- 기록 입력 시 → 모든 전광판에 broadcast
- 콜룸 체크인 시 → 콜룸 모니터에 broadcast
- 종목 상태 변경 시 → 관리자/대시보드에 broadcast

**Phase 2 주의점:** WebSocket broadcast가 DB 트랜잭션 안에 있으면 잠금 시간 길어짐. 변환 시 트랜잭션 외부로 빼야 함.

---

## 5. 외부 라이브러리 의존성

### 백엔드 (package.json)
```
better-sqlite3      ← 교체 대상 (PostgreSQL은 pg로)
pg                  ← Phase 2에서 추가됨
express             ← 그대로
ws                  ← WebSocket
xlsx                ← Excel 생성
pdfkit              ← PDF 생성
puppeteer           ← PDF 렌더링 (Chromium)
multer              ← 파일 업로드
helmet              ← 보안 헤더
compression         ← gzip
bcryptjs            ← 비밀번호 해싱
node-cron           ← 자동 백업 스케줄
canvas              ← (devDep) 아이콘 생성
playwright          ← 테스트용? (devDep 누락)
```

### 프론트엔드 (public/)
```
xlsx.full.min.js (881KB)    → public/xlsx.min.js와 중복 ⚠️
html2canvas-pro.min.js      → 결과지 스크린샷
```

---

## 6. 죽은 코드 / 정리 대상 식별

### 🗑️ Tier 1 — 즉시 삭제 가능 (영향 없음) — 2026-09-18 정리 완료(`_convert.js`, `download_server.py`, `db_import/`, `public/test-*.lif`, `i18n-demo.html` 포함)

| 항목 | 위치 | 이유 |
|---|---|---|
| `public/app.js` (1,316줄) | public/ | 어떤 HTML에서도 참조 안됨. 서비스 워커만 캐싱 (제거 시 sw.js도 한 줄 수정) |
| `public/xlsx.min.js` (881KB) | public/ | `public/lib/xlsx.full.min.js`와 100% 동일 파일 (바이트 단위 일치) |
| 빈 DB 파일 4개 | `competition.db`, `pacerise.db`, `db/pace.db`, `db/pacerise.db` | 모두 0바이트, 실제 운영 DB는 `db/competition.db` |
| `gen_icons*.py` (5개 버전) | 루트 | 아이콘 생성기 v1~v4 + final = 5개 중복. final만 남기면 됨 |
| 루트의 테스트 xlsx 17개 | 루트 | `test_*`, `temp_*`, `upload_test*`, `bib_test*` 등 개발 잔재 |
| 루트의 테스트 png 6개 | 루트 | `test_*.png`, `scoreboard_demo.png` 등 개발 잔재 |
| `tmp/` 폴더 전체 | tmp/ | PDF→Excel 변환 스크립트 + 임시 PDF. gitignore에는 들어있지만 sandbox에 누적 중 |

**예상 정리 효과:** 디스크 1MB+ 절약, 프로젝트 가시성 ↑

### 🗑️ Tier 2 — 사장님 확인 후 삭제 (확실치 않음)

| 항목 | 위치 | 의심 사유 |
|---|---|---|
| `/api/sse` | server.js:3177 | Server-Sent Events. WebSocket 있는데 이것도 있음. 사용 중인지 확인 필요 |
| `/api/wa-validate`, `/api/wa-correct` | server.js:6887, 6891 | WA = ? (World Athletics? WhatsApp?). 어디서 호출되는지 추적 필요 |
| `og-preview.html` | public/ | OG 미리보기. 한 번 만들고 안 쓰는 페이지일 수 있음 |
| `pre_demo_*.db` 백업 | backups/ | 데모용 백업. 운영 백업과 섞여있음 |
| `download_server.py` | 루트 | Python 파일. Node.js 프로젝트에 왜 있는지 불명 |

### 🗑️ Tier 3 — 정리 권장 (코드 가독성)

| 항목 | 위치 | 비고 |
|---|---|---|
| console.log 87회 | server.js | 운영 로그와 디버그 로그 섞임. 카테고리별 정리 권장 (Phase 4 UI 개선 때) |
| backups/ 194MB, 535개 | backups/ | 7일 보존 정책인데 누적되어있음. cleanOldBackups() 작동 점검 필요 |

---

## 7. 핵심 데이터베이스 통계 (참고)

| 테이블 | row 수 | 비고 |
|---|---|---|
| display_roster | 918 | 전광판 출전자 목록 (가장 많음) |
| result | 459 | 기록 — Phase 2 핵심 |
| timetable | 335 | 일정 |
| event | 299 | 종목 |
| event_entry | 269 | 종목 출전 신청 |
| heat_entry | 261 | 조별 배정 |
| height_attempt | 215 | 높이뛰기/장대 시도 |
| athlete | 187 | 선수 |
| combined_score | 68 | 혼성 종목 |
| heat | 65 | 조 |
| relay_member | 64 | 릴레이 |

활성 대회: 2개 (둘 다 completed 상태 — 새 대회 입력 대기)

---

## 8. Phase 2 변환 작업 범위 (확정)

### 변환 대상 코드
| 위치 | DB 호출 수 |
|---|---|
| server.js | 1,067 |
| lib/fullRecordExcel.js | ~20 |
| lib/fullRecordPdf.js | (점검 예정) |
| scripts/seed_demo.js | ~10 (운영 무관, 후순위) |
| db/init.js | ~3 (어댑터 안으로 통합 가능) |

### 변환 안 할 것
- `scripts/concurrent_write_test.js` — 테스트용, 직접 SQLite 사용해도 OK
- `scripts/check-scoreboard-keys.js` — 점검 스크립트, SQLite 직접 OK
- `tmp/` 폴더 전체 — 개발용

---

## 9. Phase 2 진행 순서 (확정)

1. **2-pre** (지금) — 시스템 맵 + 죽은 코드 식별 ← 본 문서
2. **2-pre-cleanup** — Tier 1 죽은 코드 삭제 (사장님 승인 후)
3. **2-A** — PostgreSQL 어댑터 (lib/db.js에 async 백엔드 추가)
4. **2-B** — 스키마 자동 변환기 (SQLite DDL → PostgreSQL DDL)
5. **2-C** — 데이터 마이그레이션 스크립트
6. **2-D~G** — 비동기 변환 (라우트 그룹별, 1~3차 우선순위 적용)
7. **2-H** — 자동화 통합 테스트
8. **2-I** — 동시 입력 부하 테스트 (PostgreSQL 환경)
9. **2-J** — AWS PostgreSQL 설치 + 환경변수 전환 + 실전 검증
10. **2-post** — 사진 업로드 회귀 테스트

---

## 10. Phase 2 진행 현황 (2026-05-15 갱신)

### ✅ 완료된 단계

| 단계 | 산출물 | 검증 결과 | 커밋 |
|---|---|---|---|
| 2-A | `lib/db.js` PostgreSQL 비동기 어댑터 | 단위 28/28, 동시쓰기 250/250 | `a0404a1` |
| 2-B | `scripts/sqlite_to_postgres_schema.js` + `db/schema.pg.sql` | PG15에 적용 OK, 통합 16/16 (500 concurrent INSERT 292ms) | `59aae8c` |
| 2-C | `scripts/migrate_sqlite_to_postgres.js` | 31/31 테이블, 3,236행 100% 이관 | `72fb8b0`, `03e3cdc` |
| 2-D | server.js 1차 라우트 17개 async 변환 | 174건 변환 / smoke OK | `67df5d2` |
| 2-E,F | server.js 2차+3차 라우트 28개 async 변환 | 593건 변환 / smoke OK / 동시쓰기 250/250 | `8c6f23e` |

**누적 변환량:** `db.prepare(...)` → `await db.*(...)` **757건 / 924건 = 82.0% 완료**

### 🚧 잔존 167건 분포 (Phase 2-G 작업 대상)

`server.js` 안에 남은 `db.prepare` 167건의 패턴 분류 (자동 분석):

| 카테고리 | 건수 | 위치 특성 | 처리 전략 |
|---|---:|---|---|
| `stmt = db.prepare(SQL)` 변수 저장 | 37 | 라우트 내부, 재사용 stmt | 인라인화 후 변환 |
| `db.transaction(()=>{...})` 콜백 내부 | 30 | 트랜잭션 블록 | Phase 2-G 통째로 async 트랜잭션 패턴으로 재작성 |
| 인라인 메서드 호출 (변환 가능했어야 함) | 54 | helper/getter 안 + codemod 누락 | 수동 또는 codemod v2 |
| 기타 (체이닝 변형 등) | 45 | 라우트 깊은 곳, ternary, async helper 등 | 케이스별 수동 |
| top-level/주석 | 1 | line 144 (주석) | 무시 |

**라인 분포:**
- `0000~0599` (init/helpers): 22건 — `getConfigKey`/`setConfigKey` 캐스케이드 영역
- `0600~1999`: 29건
- `2000~4999`: 45건
- `5000~7999`: 21건
- `8000~10999`: 14건
- `11000~`: 36건

**보조 통계:**
- `db.transaction(...)` 사이트: 51건 (Phase 2-G 메인 대상)
- `db.exec(...)` 잔존: 89건 (대부분 top-level 스키마 init — CommonJS 보호상 sync 유지)
- `await db.*` 호출 (변환 완료): 758건

### 🚫 자동 변환 중단 이유 (전체 변환 시도 시 발견된 두 가지 부작용)

**부작용 1: Top-level await → ESM 강제 전환**
- server.js의 라인 150 부근 top-level `db.exec("CREATE TABLE IF NOT EXISTS ...")` 등을 `await db.exec(...)`로 일괄 변환 시
- Node가 파일을 ESM으로 판정 → `Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph with top-level await`
- **해결책:** `scripts/async_codemod.js`에 top-level skip 로직 추가 (이 커밋)

**부작용 2: 헬퍼 함수 async 캐스케이드**
```js
// getConfigKey가 async가 되면…
async function getConfigKey(k, def) { ... }

// 이 줄들이 전부 깨짐:
const ADMIN_ID = () => getConfigKey('admin_id', 'admin');   // Promise 반환
get adminHash() { return getConfigKey('admin_pw', ''); }    // getter는 sync 강제
const existingPw = getConfigKey('admin_pw', '');             // existingPw.startsWith → TypeError
```
- **재현 에러:** `TypeError: existingPw.startsWith is not a function at server.js:530:35`
- **해결책:** Phase 2-G에서 헬퍼 → 호출자 → 호출자의 호출자 순으로 재귀적 수동 변환 필요
  - `getConfigKey`/`setConfigKey` 자체를 sync 유지 + DB 캐시 도입 (캐시는 boot 시 1회 비동기 로딩)
  - 또는 전부 async로 만들고 getter/closure를 method로 리팩토링
  - 결정은 Phase 2-G 시작 시점에 사장님 검토 후 진행

### 📋 Phase 2-G 작업 계획 (예정)

1. **G-1** — `db.transaction()` 30~51건을 async 트랜잭션 패턴으로 일괄 변환
   - `lib/db.js`의 `AsyncLocalStorage` 기반 트랜잭션 컨텍스트 이미 준비됨
   - 패턴: `db.transaction(()=>{...})` → `await db.transactionAsync(async()=>{...})`
2. **G-2** — `stmt = db.prepare(SQL)` 변수 저장 37건 인라인화
3. **G-3** — `getConfigKey`/`setConfigKey` 캐스케이드 처리
   - 전략 결정 후 헬퍼 → 호출자 트리 따라 재귀 변환
4. **G-4** — 남은 인라인 케이스 54건 + 기타 45건 케이스별 수동 정리
5. **G-5** — `db.prepare` 0건 도달 검증 + 풀 부팅 회귀

**예상 작업량:** 약 200건 수동 검토 + 50건 자동 변환

### 🔬 다음 검증 단계 (Phase 2-G 완료 후)

| 단계 | 내용 | 합격 기준 |
|---|---|---|
| 2-H | SQLite ↔ PostgreSQL 결과 동등성 자동 테스트 | 모든 라우트 GET 응답이 byte-identical |
| 2-I | PostgreSQL 부하 테스트 (10,000+ 동시 쓰기) | 0건 손실, p99 < 200ms |
| 2-J | AWS RDS PostgreSQL 환경 전환 + 실전 검증 | 사장님 입회하 라이브 대회 시뮬레이션 |

### 🛡️ 안전 장치 (현재 가동 중)

- `lib/db.js`: PG 백엔드에서 `db.prepare()` 호출 시 명시적 에러 throw — 100% 변환 검증용 그물망
- SQLite 환경(`DB_BACKEND=sqlite`)은 100% 호환 유지 — 운영 무중단
- pm2 daemon `pacerise` — 부팅 실패 시 즉시 인지

---

## 11. Phase 2-G 진행 현황 (2026-05-15 추가)

### ✅ G-1 완료 — db.transaction 시그니처 통일 + 38건 자동 변환 (`32f873d`)

**핵심 발견**: better-sqlite3는 async 콜백을 받으면
`TypeError: Transaction function cannot return a promise`로 거부함.
Phase 2-E/F에서 자동 변환된 `db.transaction(async () => {...})` 25건이
**SQLite 환경의 잠재 500 에러 폭탄**이었음 (해당 라우트 호출 시점에 터짐).

**해결**:
- `lib/db.js` SQLite 어댑터의 `transaction(fn)`을 PG와 시그니처 동일하게 재작성:
  - 콜백을 sync든 async든 받음
  - 내부에서 `raw.exec('BEGIN')` → `await fn(...)` → `raw.exec('COMMIT')`
  - 에러 시 `raw.exec('ROLLBACK')`
- 양쪽 PoC (`scripts/poc/sqlite_async_tx_poc.js`, `postgres_async_tx_poc.js`) 각 8/8 PASS
- AST 기반 codemod `scripts/tx_codemod.js` 작성 → 자동 38건 변환:
  - 25 async-iife: `db.transaction(async () => {...})()` → `await db.transaction(async () => {...})()`
  - 5 async-stored-call: stored 변수 호출에 `await` 추가
  - 8 mark-async: 호출자 함수에 `async` 키워드 자동 부착

### 🚧 G-2 진행 중 — sync 트랜잭션 22건 인라인화

`stmt = db.prepare(SQL)` 변수 의존이라 자동 변환 어려운 22건 → 수동 인라인.

**진행률: 2 / 22**

| Line | 라우트 | 상태 |
|---:|---|---|
| 1508 | `/api/federations/reorder` | ✅ 변환 완료 (handler sync→async) |
| 1541 | `/api/home-popups/reorder` | ✅ 변환 완료 (handler sync→async) |
| 190 | top-level wind 마이그레이션 | ⏳ 잔여 |
| 314 | top-level joint_group 마이그레이션 | ⏳ 잔여 |
| 1186 | (자동 조 재배정) | ⏳ 잔여 |
| 2078 | combined 점수 sync (forEach+async 버그도 존재) | ⏳ 잔여 — 추가 버그 |
| 2368 | qualification save | ⏳ 잔여 |
| 2885 | sub-events reorder | ⏳ 잔여 |
| 2934 | heat lane assignment | ⏳ 잔여 |
| 2951 / 2961 | lane updates × 2 | ⏳ 잔여 |
| 3289 / 3612 / 4488 / 7230 / 9086 / 10150 / 11084 / 11731 / 11868 / 12163 / 12308 | 기타 | ⏳ 잔여 |

**패턴**: 모두 동일 — 다음 형태로 일관 변환:
```js
// Before
const stmt = db.prepare('UPDATE ... WHERE id=?');
db.transaction(() => { for (const x of arr) stmt.run(x.v, x.id); })();

// After
await db.transaction(async () => {
    for (const x of arr) await db.run('UPDATE ... WHERE id=?', x.v, x.id);
})();
```

### 🚧 G-3,4,5 미착수 — 다음 세션 작업 대상

- **G-3** — `getConfigKey`/`setConfigKey` 헬퍼 async 캐스케이드 (전략 확정 필요)
- **G-4** — `stmt = db.prepare()` 변수 저장 패턴 143건 중 트랜잭션과 무관한 것들 인라인화
- **G-5** — `db.prepare` 0건 도달 검증 + 풀 부팅 회귀

### 📊 현재 상태 (G-1 + G-2 partial 적용 후)

| 항목 | 변경 전 | 변경 후 |
|---|---:|---:|
| `db.prepare` 호출 | 167 | **165** |
| `db.transaction` 호출 | 51 | 51 (유지) |
| `await db.transaction` (= 트랜잭션 정상 await) | 0 | **27** |
| `await db.*` 호출 (Phase 2-D~G 누적) | 758 | **760** |

**검증 (G-1 + G-2 partial 적용 후 모두 통과)**:
- `node --check server.js` ✅
- pm2 부팅 ✅ (pid 800482, online)
- HTTP smoke: `/api/competitions` `/api/events` `/api/federations` 200 ✅
- 단위 테스트 28/28 ✅
- 동시쓰기 250/250 ✅
- 에러 로그 0건 ✅

## 대회 시간대 (2026-09-30)
- `competition.timezone`(IANA, 기본 `Asia/Seoul`) — 관리자 대회 설정·홈 '대회 추가'에서 지정. 검증 `lib/tz.js isValidTz`.
- 서버: '오늘' 판정은 전부 `TZ.todayIn(TZ.compTz(comp))` — 자동 상태 전환(`competitions.js autoUpdateCompetitionStatus`, 대회마다 따로), 종료 잠금(`isCompetitionEnded`), 대회 재개, 운영 체크리스트, 시간표 `is_today`·`/today`·업로드의 '지난 날' 보존, 국제대회 동기화 기간 판정. 날짜 더하기는 `TZ.shiftYmd`(서버 시간대 무관).
- 로그·백업 파일명의 `kstNow()` 는 서버 기본 시간대(`APP_TZ`, 기본 Asia/Seoul) — 대회와 무관.
- 화면: `API.getCompetition` 이 `window.PACE_TZ` 를 채우고, `paceNow()`(common.js)가 대회 시간대의 오늘·현재 분을 준다 — 소집 시간창(−10/+5분), 대시보드 '지금'·NEXT·히어로 일차 전환, 시간표 창 일차 자동 선택, 종료 대회 진입 차단.

## 종목 코드 (2026-09-30, 해외 대회 대비 B2)
- `event.code`(NULL 허용) — `lib/eventCatalog.js` 사전의 코드(`100`·`110H`·`3000SC`·`5000W`·`LJ`·`SP`·`DEC`·`4X100`·`4X400X`(혼성 계주)·`HM`·`MAR`·`20KW` …). `event.name`(한글 정식명 + 부 접미)은 그대로 두고 코드를 옆에 채운다.
- 채우는 곳: 관리자 종목 생성·종목 xlsx 업로드·연맹 통합 업로드·국제 동기화·준결승/결승 생성(부모 코드 복사)·혼성 세부종목 생성. 그 밖의 경로(노출용 대회·조편성 업로드·복제)는 부팅 `backfillEventCodes()` 와 `GET /api/events` 의 lazy 채움이 잡는다. 사전에 없는 이름은 NULL.
- 이름 → 코드 매핑 `codeOf()`: `recordKey` 정규화(라운드·성별·부 접미·콤마·단위) → 사전(한글·영문·약어·연맹·Bornan 표기 별칭) → 낱말 단위 부분 일치(글자 단위 아님 — '4x400m' 안의 '400m' 오인 방지).
- 쓰는 곳: `GET /api/events` 의 `code`·`name_en`(영문 표시명, B3 영문 UI 의 기준), 풍속 규제 판정(`recordCompare.isWindAffectedEvent` 가 코드도 본다). 정렬(`sortIndex`)·문서·오버레이는 아직 이름 기준 — B3/B5 에서 코드로 옮긴다.
- 라벨 사전 `lib/labels.js`(라운드·라운드 상태·대회 상태·성별·종목군·엔트리 상태·상태코드·진출 표기·기록 종류·학교급, ko/en) + `division_master.label_en`(비우면 성별·학교급·학년으로 자동). `GET /api/labels?lang=en|ko` 가 사전 + 종목 사전(`events`) + 부(`divisions`, `division_by_ko`)를 한 번에 준다(5분 캐시) — B3 영문 UI 가 여기서 표기를 고른다.

## 다국어 (2026-09-30, B3)
- `public/i18n.js` v2: 한국어 원문이 키인 사전(`public/locales/en.json`·`ja.json`, 각 ≈3,680항목)으로 전 페이지(오버레이·open·privacy 제외)의 DOM 텍스트·속성·문서 제목을 실시간 번역(MutationObserver). 언어는 `localStorage.pace_lang` → 없으면 브라우저 언어(ko/ja/그 밖엔 en). 대회명은 `competition.name_en/name_ja`(관리자 대회 설정) 를 `/api/labels` 의 `text` 로 받아 사전에 합친다. 선수명은 EN/JA 에서 라틴 이름 우선(`dashboard.js _dispName`).
- 도구 `scripts/i18n/`: `extract.js`(원문 추출·통계·누락), `parts/<lang>_*.json`(번역 조각), `build.js`(자동 항목 + 조각 + `locales/<lang>.overrides.json` → 사전), `GLOSSARY.md`. 새 한국어 문장을 넣었으면 extract → 번역 → build, 사전이 바뀌면 `i18n.js` 의 `DICT_VERSION` 올리기. 자세한 건 `docs/I18N_GUIDE.md`.

## 조직 — 멀티테넌시 1단계 (2026-10-01, docs/MULTI_TENANCY_PLAN.md)
- `organization` 테이블(slug·국가·기본 시간대·기본 언어·전용 도메인·사이트 이름·브랜드·settings_json). 기본 조직 id 1 (`ORG_DEFAULT_SLUG`, 기본 `pace-rise`)은 부팅 때 자동 생성, 기존 대회·계정은 전부 조직 1.
- `lib/org.js` `createResolver(() => db)` → `app.use(ORG.middleware())` 가 요청마다 `req.org` 를 둔다: `?org=`/`x-org` → 전용 도메인 → 서브도메인 첫 라벨 == slug → 기본 조직. 60초 캐시, 조직 변경 시 `invalidate()`.
- 조직 스코프가 들어간 곳: `lib/routes/competitions.js`(목록·recent·by-federation·조회·생성·복제·`/api/event/:slug` — 다른 조직 대회는 404, 새 대회 시간대 기본값 = 조직), `lib/routes/home_popups.js`(`home_popup.organization_id`), `lib/routes/admin_keys.js` `/api/site-config`(기본 조직은 `system_config site_*`, 다른 조직은 `organization.settings_json`; 응답에 `org` 요약 포함).
- `lib/routes/organizations.js`: `GET /api/org`(공개), `GET/POST/PUT /api/admin/organizations`(기본 조직의 관리자 키만). 관리자 › 시스템 › 조직 화면(`card-organizations`, 플랫폼 관리자만 보임), 홈은 기본 조직이 아니면 사이트 이름을 조직 이름으로.
- 2단계(2026-10-02): `event_record`·`competition_series`·`federation_list`·`division_master`(0=공용)·`certificate_template`·`award_docx_template`·`sms_config`(조직별 행, `lib/smsConfig.js`)·`push_*`·`external_api_key` 에 `organization_id`; `joint_group.competition_id`. 기록 감지(`lib/recordCompare.js` `findEventRecord(..., orgId)`)·문서(`fullRecordExcel`·`pdf_documents`)·국제 동기화는 대회의 `organization_id` 로 기록표를 본다.
- 3단계(2026-10-09): `lib/reqContext.js`(AsyncLocalStorage 로 요청 조직 전달) → `_opKeyLookup`·기본 운영키·기록위원 키가 조직을 본다; 로그인·JWT 브리지·계정 관리(`admin_users.js`)·운영키 관리(`admin_keys.js`)·되돌리기 조직 검사; **조직 가드 미들웨어**(server.js, 쓰기 가드 뒤) — 요청이 가리키는 대회가 다른 조직이면 404.
- 4단계(2026-10-09): WebSocket 업그레이드 때 호스트로 조직을 정해 `ws._orgId` — 다른 조직 대회 구독·조회는 `{type:'error'}`, 대회 메시지는 구독한 소켓에만(`_wsForward`·`broadcastToScoreboard`). `COOKIE_DOMAIN` 옵션. `Dockerfile`·`docker-compose.yml`·`docs/DEPLOY_DOCKER.md`.
- 아직 전역(플랫폼 관리자만): 백업 ZIP, 대회 없는 `audit_log`/`operation_log` 행.

## 국제 양식 엔트리 가져오기 (2026-10-09, B4)
- `lib/routes/entry_import_intl.js`: `GET /api/entries/intl/template.xlsx`, `POST /api/entries/intl/preview|import`(multer `file`, `competition_id`, `name_order=given-family|family-given`, `skip_errors`). 머리글 별칭 표 `H`, 성별·생년월일 파서, CSV 는 UTF-8 로 읽음(`XLSX.read(type:'string')`).
- 종목은 `EventCatalog.codeOf()` → 사전 한글 정식명 + `code` 로 저장(결승 1조), 선수는 배번 → 이름|소속|성별 순으로 기존 매칭, 기존 행은 빈 칸만 채움. `athlete.family_name/given_name` 컬럼 추가.
- 관리자 › 가져오기 › 1단계 세그먼트 '국제 양식 (영문 CSV·엑셀)' — `previewIntl()/importIntl()`.

## 문서 영문판 (2026-10-09, B5)
- `lib/docLabels.js`: `docLabels(lang)` 라벨 묶음 + `compName/eventName/genderLabel/roundLabel/fontName/normLang`. `generateFullRecordExcel(db, comp, gender, getDocTemplate, lang)`, `generateFullRecordPdf(db, comp, gender, lang)`, `generateComprehensiveByDivision(db, comp, lang)`, `lib/routes/pdf_documents.js` 의 start-list·result-sheet·png·ad-card 는 `reqLang(req)`.
- 라우트의 `lang` 은 `?lang=` → 없으면 `req.org.default_lang`(ja 는 en) → ko. ko 출력은 바이트 동일(검증됨). 종목 매칭·정렬에 쓰는 한글 이름 표는 그대로.

## 계측 워처·자동 조편성 (2026-10-09, C1·C2)
- `scripts/timing-watcher/watch.js`: 계측 PC 에서 돌리는 폴더 워처(`npm run timing-watch -- --dir … --server … --key … --comp …`). `/api/scoreboard/preview` 로 판정(`judge()`) 후 `/api/scoreboard/import` 또는 `/api/timing-txt/import` 적용; done/review/failed 폴더. 테스트 `tests/api/61_timing_watcher.test.js`(실제 포트로 서버 띄워 processFile 호출). 문서 `docs/TIMING_WATCHER.md`.
- `lib/routes/auto_seed.js`: `POST /api/events/:id/auto-seed` — 엔트리 SB/PB(`parseRecordValue`) 순위 → `serpentine()` 지그재그 + 같은 소속 교환 → `waAssignLanesBulk` 레인 → 기존 조 삭제 후 재생성(`generateScoreboardKey`), 기록 있으면 `force`. 관리자 종목 드로어 조 탭 옆 '자동 조편성'(`emAutoSeedOpen/Preview/Apply`). 테스트 `tests/api/60_auto_seed.test.js`.

## PB/SB 자동 누적 (2026-10-09, C4)
- `lib/pbsb.js`: `updateEntryMarks(db, event)` — 종목 완료(`POST /api/events/:id/complete`, `lib/routes/callroom.js`) 때 자동 호출. 트랙·도로 MIN(time), 필드 거리 MAX, 높이 MAX(O); 상태 코드 있는 결과·풍속 +2.0 초과(`EventCatalog.isWindAffected`) 제외; `event_entry.personal_best/season_best` 가 더 좋을 때만 갱신(SB 는 대회 연도 기준), 선수가 한 종목만 뛰면 `athlete` 행도. `carryOverMarks(db, comp)` — 같은 조직·이전 대회·같은 선수(이름+성별+생년월일, 생년월일 없으면 소속)·같은 종목 코드의 PB/SB 를 빈 엔트리에.
- 라우트 `lib/routes/pbsb.js`: `POST /api/events/:id/marks/update`, `POST /api/competitions/:id/marks/carry-over`. 관리자 선수 화면 '이전 대회 기록 불러오기'. 테스트 `tests/api/62_pbsb.test.js`.

## 참가기준기록·승상 높이표·건타임·동시 편집 보호 (2026-10-09, C5·C6)
- `event.entry_standard / target_time / height_progression`(관리자 종목 드로어, `PUT /api/admin/events/:id`). 대시보드 소집 명단(`loadRosterModalData`)에 기준·타깃 줄 + 엔트리 기록(SB→PB)이 기준을 넘으면 '기준' 배지; PDF 스타트리스트에도 한 줄. 기록 입력(`record.js`)은 `height_progression` 으로 바 높이 목록을 미리 채운다.
- `result.gun_time`(도로 종목 건타임; `time_seconds` 는 넷타임) — 기록 입력 도로 표에 건타임 열(`saveGunTime`), `/api/results/upsert` 가 `gun_time` 을 받는다.
- 낙관적 락: `/api/results/upsert` 에 `expected_updated_at` 을 보내면 서버 `updated_at` 과 다를 때 409 `CONFLICT_STALE`(server_value 포함). `record.js` 는 트랙·필드 저장에 `_expUpd()` 로 붙이고 409 면 최신으로 새로 고침(`_onStale`). 보내지 않으면 예전처럼 마지막 저장이 이긴다(가져오기·동기화 경로).
