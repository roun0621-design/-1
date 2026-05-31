# PaceRise 코드 감사 보고서 (2026-05-19)

> 케이스 2 대회 도입 전 마지막 점검. `genspark_ai_developer` 브랜치 기준, 커밋 `cb956a4` 시점 분석.

---

## 📊 코드 규모 요약

| 항목 | 수치 | 비고 |
|---|---|---|
| **server.js** | 12,906 줄 / 215 라우트 / 78 함수 | 모놀리식 — 분할 시급 |
| **public/*.js (6개 메인)** | ~13,000 줄 / ~700KB | bib() 등 60+ 함수 중복 정의 |
| **DB 스키마 (SQLite/PG)** | 14 vs 28 테이블 | **스키마 동기화 불일치 13개** |
| **backups/** | 182MB / 425파일 | 7일치 일일 덤프 누적 |
| **tmp/** | 6.6MB | 일회성 debug 스크립트 |
| **db_import/** | 2.9MB | legacy recover_db.js 3종 + ktfl_source.db |
| **루트 잡파일** | ~3.5MB | 6 버전 gen_icons*.py + 14개 sample xlsx/lif/pdf |

---

# 🔴 CRITICAL (대회 도입 전 반드시 수정)

## C-1. `event_records` (복수) vs `event_record` (단수) — 동일 URL prefix, 다른 테이블
**위치**: `server.js:7191~9286` (6개 라우트), `db/schema.sql:191`, `db/schema.pg.sql:142, 159`

| 라우트 | 메서드 | 사용 테이블 | PK | 용도 |
|---|---|---|---|---|
| `/api/event-records/:eventId` | GET | `event_records` | event_id | 종목별 NR/DR/CR JSON |
| `/api/event-records` | POST | `event_records` | event_id | 종목별 NR/DR/CR JSON 저장 |
| `/api/event-records` | GET | `event_record` | (gender,event_name,record_type) | NR/DR/CR 마스터 조회 |
| `/api/event-records/:gender/:eventName` | GET | `event_record` | 동일 | 종목별 NR/DR/CR 마스터 |
| `/api/event-records` | PUT | `event_record` | 동일 | 마스터 갱신 |
| `/api/event-records/batch` | PUT | `event_record` | 동일 | 일괄 갱신 |

**문제**:
- 같은 prefix `/api/event-records`로 **두 개의 완전히 다른 테이블**(스키마/PK/용도 다름)을 조작.
- HTTP 메서드만으로 구분 (POST→복수, PUT→단수) — 새 개발자/관리 도구가 헷갈리기 100% 확실.
- 신뢰성 사고로 이어질 수 있음 (예: 외부 도구가 PUT 대신 POST로 NR 데이터 보내면 JSON column에 저장됨).

**권장 조치**:
- `/api/event-records-master` (단수 → 마스터) 와 `/api/event-records-by-event` (복수 → 종목별) 로 분리하고, 6개월 deprecation 헤더 유지.
- 또는 단순히 `event_records` 테이블을 사용하는 라우트만 남기고 단수 테이블을 별도 prefix(`/api/record-registry`)로 마이그.

## C-2. `setupExportButtons()` 실행 시 TypeError — UI 깨짐
**위치**: `public/app.js:1276~1303`, `public/app.js:152` (호출), 모든 `public/*.html`

**문제**:
- `setupExportButtons()`는 `export-excel-btn`, `export-png-btn`, `export-pdf-btn` 3개 버튼에 listener 부착.
- **그러나 `public/*.html` 어느 파일에도 위 ID를 가진 요소가 없음** (검색 결과 0건).
- `document.getElementById('export-excel-btn')`이 null 반환 → `.addEventListener` 호출 시 `TypeError: Cannot read properties of null`.
- 페이지 로드 직후 `init()` 흐름에서 즉시 던져지므로 그 뒤 함수들 실행 중단 가능.

**확인 필요**:
- 사용자가 말한 "**종합기록지 사진 업로드 회귀 테스트**"의 실제 의도가 "**결과 화면 → PNG로 저장 / PDF 인쇄**" 기능이라면 → **현재 완전히 깨져 있음**.
- (별도 결과지 PDF는 `/api/documents/result-sheet/:eventId`로 서버에서 정상 생성됨)

**권장 조치**:
1. results.html에 export 버튼 UI를 추가하거나
2. `setupExportButtons()`에 null-check 추가 (`if (!btn) return;`)
3. 회귀 테스트 항목으로 명시.

## C-3. SQLite schema 파일이 13개 테이블 누락 — production-quality risk
**위치**: `db/schema.sql` (14 테이블) vs `db/schema.pg.sql` (28 테이블)

**누락된 테이블** (server.js 안에서 inline `db.exec(CREATE TABLE IF NOT EXISTS ...)` 으로 동적 생성됨):
```
event_records, external_api_key, external_api_log, federation_list,
home_popup, home_popup_section, joint_group, joint_group_member,
display_roster, doc_template, event_link, system_config, timetable,
operation_key (server.js:156에 inline)
```

**문제**:
- 새 환경 부팅 시 `db/schema.sql` 만 보면 **테이블 절반이 없는 줄 알게 됨**.
- 이미 server.js boot 시 동적 생성이 동작 중이므로 런타임 버그는 아니지만, **schema parity test의 신뢰성을 떨어뜨림**.
- PG로 마이그 시 schema.pg.sql만 sync — 두 파일이 동치라는 가정이 깨짐.

**권장 조치**:
- `db/schema.sql`에 누락된 13개 테이블 CREATE 문 추가 (server.js의 inline 문구를 그대로 옮기기).
- 또는 server.js의 inline CREATE 블록을 모두 schema.sql import로 대체.

## C-4. SMS/카카오 알림톡 — **코드 0건** (신규 구현)
검색 결과: `sms|kakao|알림톡|aligo|coolsms|nhn.cloud|toast.sms` — **server.js 및 public/ 전체에서 매칭 0**.

대회 도입 전 필수가 아니라면 Phase 2로 분리. 필수라면:
- 외부 SMS API (Aligo/CoolSMS/NHN Cloud Toast SMS/카카오 알림톡) 계약 선결.
- `external_api_key` 테이블에 키 저장 → `/api/notifications/sms` POST 라우트 추가.
- 알림 전송 대상: athlete 테이블에 `phone` 컬럼 추가, 결과 입력 시 트리거.

---

# 🟠 HIGH (운영 안정성)

## H-1. Dead/외부전용 라우트 5개 (frontend 참조 0)
| 라우트 | 메서드 | 라인 | 판정 |
|---|---|---|---|
| `/api/barcode/:code` | GET | 2270 | **외부 스캐너용**으로 보이나 frontend 미사용. 유지/문서화 필요. |
| `/api/overlay/current` | GET | 12638 | **OBS overlay 외부 폴링용**일 가능성. docs/EXTERNAL_API.md에 추가. |
| `/api/staff/verify` | POST | 1362 | 사용처 0. `isOperationKey` 검증 — 삭제 후보. |
| `/api/heat-assignment/create-events` | POST | 5149 | 사용처 0. 삭제 후보. |
| `/api/display/events/bulk-result-url` | PUT | 12390 | 사용처 0. 삭제 후보. |

**권장**: 외부 API 라우트는 `docs/EXTERNAL_API.md`에 명시. 그 외 3개는 1주 모니터링 후 삭제.

## H-2. SQLite 스키마 외부 동적 생성 = 마이그레이션 리스크
- `db/schema.sql`을 단일 진실원으로 만들어야 production 안정성 보장.

## H-3. `record.js` 4,276줄 / 228KB — 단일 파일 한계
- Track + Field + Combined + Heat 모달 + Admin 인증까지 **모두 하나의 파일**.
- 기능 추가 시 충돌/IDE lag/test 어려움.
- 비교: dashboard.js 2,083줄, results.js 2,144줄.

**권장 분할**:
- `record-track.js` (트랙 인라인 입력/저장)
- `record-field.js` (필드 거리/높이 모달)
- `record-combined.js` (혼성)
- `record-heat.js` (조 관리)
- `record-common.js` (공용 — 인증 모달, 상수)

각 ~50KB로 분할 가능. lazy load도 가능.

---

# 🟡 MEDIUM (코드 다이어트)

## M-1. Frontend 유틸 함수 중복 (대규모)
대표 사례 `bib()` — 5개 파일에서 **완전 동일 본체로 중복 정의**:
```js
function bib(val) { return val != null && val !== '' ? val : '—'; }
```
정의된 파일: `record.js`, `dashboard.js`, `results.js`, `callroom.js`, `app.js`.

**중복 함수 통계** (2개 이상 파일에서 정의):
- 5중복: `bib`
- 3중복: `toggleCombinedSubs`, `renderMatrix`
- 2중복: `trackInlineKeydown`, `trackInlineInput`, `syncCombinedFromSubEvent`, `showBanner`, `setupHeightModal`, `setupGenderTabs`, `setupFieldModal`, `setEntryStatus`, `saveSingleTrackInline`, `saveAllTrackInline`, `renderTrackTable`, `renderTrackResults`, `renderFieldHeightResults`, `renderCombinedResults`, `renderAuditLog`, `processBarcodeOrBib`, `parseTimeInput`, `openTrackQualification`, `openHeightModal`, `markUnsaved`, `loadTrackHeatData`, `loadResultsData` 등 60개+

**권장**:
- `public/common.js`에 한 번만 정의, 다른 파일은 `<script src="common.js">` 하나만 import.
- `common.js`는 이미 1,822줄로 존재 — 여기에 통합 가능.
- 추정 절감: **frontend 30~40% 라인 감소** (200~280KB).

## M-2. Server.js 모놀리식 (12,906줄) 모듈 분할
| 제안 모듈 | 라우트 그룹 | 라우트 수 |
|---|---|---|
| `routes/admin.js` | `/api/admin/*` | 32 |
| `routes/display.js` | `/api/display/*` | 26 |
| `routes/events.js` | `/api/events/*` | 23 |
| `routes/timetable.js` | `/api/timetable/*` | 12 |
| `routes/joint-groups.js` | `/api/joint-groups/*` | 9 |
| `routes/documents.js` | `/api/documents/*` | 8 |
| `routes/heats.js` | `/api/heats/*` | ~15 |
| `routes/athletes.js` | `/api/athletes/*` | ~10 |
| `routes/event-records.js` | record + records | 6 |
| `routes/federation.js` | `/api/federation/*` | ~4 |
| `routes/scoreboard.js` | `/api/scoreboard/*` | 5 |
| `routes/popup.js` | `/api/popup*`, `home_popup*` | ~5 |
| `lib/auth.js` | isAdminKey/isOperationKey/getKeyRole | - |
| `lib/wa-rules.js` | WA seeding, wind eligibility | - |
| `lib/pdf-gen.js` | PDFKit 결과지/시작리스트/광고카드 | - |

남는 server.js: ~3,000줄 (boot + DB schema 동적 생성 + 글로벌 미들웨어).

**효과**:
- 새 개발자/세션 인덱싱 속도 5~10배
- 변경 충돌 감소
- 라우트 단위 단위 테스트 가능

## M-3. 디스크 정리 (총 ~195MB 회수)

### 🟢 즉시 삭제 안전
- **`pacerise.db`** (루트, 0 bytes 빈 파일) — 명백한 dead.
- **`gen_icons.py` ~ `gen_icons_final.py`** (5개 버전) — final 하나만 남기고 v1~v4 삭제.
- **`db/competition_backup_20260328_064912.db`** + **`db/competition_backup_before_fix_20260430_080158.db`** — 2MB, backups/에 일일 백업 있으니 중복.
- **`GENSPARK_NEWS_API_REQUEST.md`, `GENSPARK_NEWS_REQUEST.md`** — 4월 작성, 기능 외 요청서.

### 🟡 압축 후 보관 (AI Drive로 이동)
- **`backups/`** (182MB, 425 파일) — `tar -czf backups_2026-05-19.tar.gz backups/` → `/mnt/aidrive/`로 이동 → 본디렉토리는 최근 3일만 유지.
- **`tmp/`** (6.6MB, debug 스크립트) — 압축 후 삭제.
- **`db_import/`** (2.9MB, recover_db*.js + legacy ktfl_source.db) — 압축 후 삭제 (혹시 모를 복구용).

### 🟠 검토 후 처리 (루트 sample 파일)
| 파일 | 크기 | 처리 |
|---|---|---|
| `record_form.xlsx` | 2.8MB | sample 데이터, `samples/` 폴더로 이동 |
| `ktfl_sample.pdf` | 144KB | docs/에 참고용 첨부 |
| `test-100m-1.lif`, `test-wind-100m.lif` | <1KB | LynxScribe 테스트 파일, `tests/fixtures/`로 |
| `bib_test.xlsx`, `daily_schedule.xlsx`, `db_schema.xlsx`, `federation_sample.xlsx`, `heat_assignment.xlsx`, `timetable_day1~3.xlsx`, `2026_김해_실업부_조편성_내부용.xlsx` | ~150KB 합계 | `samples/` 폴더 신설 후 이동 |

### 🔵 업로드 양식 통일 — Critical
**현재 상태 (2개 양식 파일 공존)**:
- 루트: `PACERISE_upload_template.xlsx` (40,768 bytes, 4월 수정)
- uploads/: `PACERISE_업로드양식.xlsx` (10,347 bytes, 3월 수정) ← **outdated**

**문제**: 어느 것이 v4.1? 둘 다 다운로드 라우트(`app.get`) 존재하지 않음. **사용자가 다운로드할 곳이 없음**.

**권장**:
1. v4.1 양식을 하나만 유지: `samples/PACERISE_upload_template_v4.1.xlsx`
2. `app.get('/api/download/upload-template', (req, res) => res.download(...))` 라우트 추가
3. admin.html "엑셀 양식 다운로드" 섹션의 H4에 다운로드 링크 연결

---

# 🟢 FUTURE (사용자 요청 신기능)

## F-1. 랭킹 시스템 (종별 필터) — **0% 구현됨**
- 검색 결과: `ranking|랭킹|순위`는 result 화면 안 "현재 종목 8위 랭킹"만 존재 (server.js:9468).
- **종별 필터 (M/F/통합/U18/U20/학년부) 독립 랭킹 페이지 없음**.

**구현 제안**:
- 신규 라우트: `GET /api/rankings?event_name=100m&gender=M&category=U20&competition_id=N`
- 종합 랭킹 페이지: `public/rankings.html` (인덱스에서 진입)
- 동일 종목 다회 결과 → best 추출 → 정렬
- 카테고리는 `athlete.category` 컬럼 추가 (현재 schema에 미존재 확인 필요)

**Effort**: ~2일 (백엔드 + 프론트 + 카테고리 데이터 보강).

## F-2. 상장(공식 PDF) — **0% 구현됨**
- `/api/documents/*` 8개 라우트 매핑 후: start-list ✅, result-sheet ✅, ad-card ✅, comprehensive ✅, full-record ✅ — **diploma/certificate/award 라우트 없음**.

**구현 제안**:
- 신규 라우트: `GET /api/documents/certificate/:eventId?rank=1`
- PDFKit으로 A4 가로 1장 (선수명/소속/종목/순위/대회명/날짜/주최/도장).
- 배경 템플릿 이미지 업로드 가능 (`doc_template` 테이블에 `certificate` JSON 컬럼 추가).
- 종목별 1~3위만 자동 생성 일괄 다운로드 옵션.

**Effort**: ~1.5일.

## F-3. 결과지 PDF — **✅ 이미 구현됨** (확인 필요)
**기존 라우트**:
- `GET /api/documents/result-sheet/:eventId` (8241줄) → A4 PDF 직접 생성
- `GET /api/documents/result-sheet/:eventId/png` (9006줄) → PNG 변환
- `GET /api/documents/comprehensive/:compId/excel` (9316줄) → 종합기록지 Excel
- `GET /api/documents/full-record/:compId/excel|pdf` (9795/9820줄) → 연맹 종합기록지

사용자가 추가로 원하는 것이 있는지 확인 필요 (예: 모든 종목 일괄 PDF zip, 인쇄 미리보기 UI 등).

## F-4. SMS / 카카오톡 알림톡 — Phase 2 권장
- 외부 API 계약 + 비용 정책 결정 후 진입.
- `athlete.phone` 컬럼 + `notification_log` 테이블 + Worker queue 필요.
- **Effort**: ~5일 (API 통합 + 동의 관리 + 실패 재시도 + 로그).

## F-5. 모바일 앱 / PWA — **PWA 일부 구현됨** (확인 필요)
- `gen_icons*.py` 6개 존재 → 아이콘 자산 생성 흔적.
- `public/manifest.json`/`service-worker.js` 존재 여부 확인 안 함 — 다음 단계.

---

# 📋 권장 실행 순서

## Phase A — 대회 도입 전 (이번 주)
1. **C-2 export buttons null-check 추가** (5분) — TypeError 즉시 차단
2. **C-3 schema.sql 보강** (30분) — 13개 테이블 추가
3. **C-1 event_records 혼란 문서화** (15분) — 코드 변경 없이 주석/Swagger로 명시
4. **M-3 디스크 정리 (안전 항목만)** (30분) — pacerise.db, gen_icons v1~v4, GENSPARK_NEWS_*.md, db/backup.db
5. **M-3 업로드 양식 통일 + 다운로드 라우트** (1시간) — v4.1 단일 source of truth + admin.html 링크
6. **`cb956a4` production deploy** — Lightsail `git pull && pm2 restart` 필수
7. **Lightsail 백업 압축 → AI Drive 이동** (30분)

**Phase A 총 effort**: ~3시간

## Phase B — 대회 직후 1주 (코드 다이어트)
8. M-1 frontend 공용 함수 통합 (`common.js`로 집중) — 4시간
9. H-1 dead route 3개 삭제 + 외부 API 라우트 문서화 — 1시간
10. H-3 record.js 분할 — 1일

## Phase C — 다음 분기 (모듈화 + 신기능)
11. M-2 server.js 라우트 단위 모듈 분리 — 3~5일
12. F-1 랭킹 시스템 — 2일
13. F-2 상장 PDF — 1.5일
14. F-4 SMS/알림톡 — 5일 (외부 API 계약 후)

---

# 🧪 회귀 테스트 체크리스트 (사용자 요청 반영)

- [ ] `setupExportButtons()` null-check 후 페이지 로드 콘솔 에러 0건 확인
- [ ] 결과 화면 → "PNG로 저장" 버튼 (HTML 신규 추가 시) 클릭 → 다운로드 성공
- [ ] `/api/documents/result-sheet/:eventId` GET → PDF 정상 다운로드
- [ ] `/api/documents/comprehensive/:compId/excel` GET → 종합기록지 xlsx 다운로드
- [ ] `/api/event-records` POST (operation_key) + PUT (admin_key) — 각각 올바른 테이블에 저장 검증
- [ ] 업로드 양식 다운로드 라우트 신규 추가 후, 빈 DB에서 양식 → 업로드 → 선수+종목 등록 e2e
- [ ] PG 환경 `parity_test.js` 63/63 PASS 재확인
- [ ] SQLite 환경 `test_db_layer.js` 28/28 PASS 재확인

---

# 📎 부록 — 발견 사실 raw 데이터

## A. 라우트 그룹 분포
```
/api/admin/*       32  관리자 인증/시스템/키 관리
/api/display/*     26  전광판 관리 (compId 기반)
/api/events/*      23  종목 CRUD + WA seeding
/api/heats/*       ~15 조 관리, wind, 인라인 결과
/api/timetable/*   12  시간표 CRUD
/api/athletes/*    ~10 선수 CRUD/Excel/배번
/api/joint-groups/* 9  합동 그룹
/api/documents/*    8  PDF/Excel/PNG 문서 생성
/api/event-records*  6  ⚠️ 두 테이블 혼용 (C-1)
/api/scoreboard/*   5  외부 API (스코어보드)
```

## B. 빈 / outdated 파일 (총 ~195MB 회수 가능)
```
0    bytes    pacerise.db                            ← 즉시 삭제
3,333         gen_icons.py                           ← 삭제 (v1)
4,113         gen_icons_v3.py                        ← 삭제 (v3)
4,196         gen_icons_v4.py                        ← 삭제 (v4)
5,452         gen_icons_v2.py                        ← 삭제 (v2)
3,969         gen_icons_final.py                     ← 유지 (이름 단순화 권장: gen_icons.py로 rename)
2,603         GENSPARK_NEWS_API_REQUEST.md           ← 삭제 (외부 요청서)
1,913         GENSPARK_NEWS_REQUEST.md               ← 삭제 (외부 요청서)
1MB           db/competition_backup_20260328_*.db    ← 삭제 (backups/에 중복)
1MB           db/competition_backup_before_fix_*.db  ← 삭제 (backups/에 중복)
2.9MB         db_import/                             ← AI Drive 이동 후 삭제
6.6MB         tmp/                                   ← AI Drive 이동 후 삭제
182MB         backups/                               ← AI Drive 이동 후 최근 3일만 유지
~3.5MB        루트 .xlsx/.pdf/.lif 파일 14개         ← samples/ 폴더 이동
```

## C. 함수/스키마 중복 정밀 데이터
- **server.js 215 라우트** 중 frontend 미참조 12개 → 7개는 외부 API(barcode/overlay/scoreboard/event-links), 5개는 진짜 의심 dead.
- **frontend 6 파일 평균 줄수**: record.js 4,276 > dashboard.js 2,083 > results.js 2,144 > common.js 1,822 > callroom.js 1,348 > app.js 1,316.
- **schema.sql vs schema.pg.sql 테이블 차이**: 14 vs 28 — 13개 누락 (event_records 포함).

---

_Generated 2026-05-19 by codebase audit. Branch: `genspark_ai_developer` @ `cb956a4`._
