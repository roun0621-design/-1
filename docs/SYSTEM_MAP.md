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
