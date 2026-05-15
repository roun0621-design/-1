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

### 🗑️ Tier 1 — 즉시 삭제 가능 (영향 없음)

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
