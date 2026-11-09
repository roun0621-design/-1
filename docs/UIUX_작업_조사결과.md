# P-R:Node UI/UX 작업 — 사전 조사 결과 (인계 노트)

> 작성: 2026-08-15 · 목적: NODE_UIUX_WORK_ORDER.md 작업을 새 세션에서 이어갈 때
> 조사를 반복하지 않도록 현황을 정리해 둠. **이 문서를 먼저 읽고 진행할 것.**
> 조사만 완료된 상태이며 **코드는 아직 아무것도 수정하지 않았다.**

---

## Phase 1 — 모바일 대시보드 조사 결과

### ★ 핵심 제약: "카드"는 실제로 테이블이다
대시보드 종목 목록은 카드가 아니라 **`<table class="matrix-table">` 표를 640px 이하에서 CSS로 카드처럼 재배치**하는 구조.
"카드 재구성"은 표 HTML(`renderCategoryTable`)과 모바일 CSS(dashboard.html `@media`)를 함께 고쳐야 함.

### ★ SSE 안전 경계 (무단 변경 금지 — 지시서 철칙)
- **SSE 자동반영은 `#events-container` 전체를 통째로 다시 그린다** (개별 셀 셀렉터 없음).
  경로: `result_update`(common.js SSE) → `loadData()`(dashboard.js:194) → `renderMatrix()`(dashboard.js:570) → `container.innerHTML`(dashboard.js:707).
  → **표 내부 구조는 바꿔도 SSE 안전.** 유지할 것은 `#events-container` id + 함수 체계뿐.
- 유지 id: `#events-container` `#result-panel` `#result-overlay` `#hero-schedule`(+`#hero-title/#hero-sub/#hero-icon`) `#comp-info-bar` `#gender-tabs` `#division-tabs` `#modal-video-embed`
- 유지 함수: `renderMatrix` / `renderCategoryTable` / `renderViewerBtn` / `renderDisplayBtn`
- 유지 클래스: `.matrix-table(.matrix-display)` `.event-name` `.fav-cell/.fav-toggle/.fav-knob` `.round-btn(.btn-disabled/.btn-live/.round-btn-result)` `.gender-badge` `.live-pin` `.ico-callroom`
- 유지 전역상태: `_liveEventId _liveHeatId _rosterModalEventId _isDisplayMode _currentDivision callroomCompletedIds _colRounds _pacingMap _scheduleMap`
- SSE 이벤트(common.js:661): result_update, entry_status, event_completed, callroom_complete, height_update, combined_update, event_reverted, operation_log, event_status_changed, wind_update, pacing_update, record_break_detected

### before 측정 (390px)
- 고정영역 = 헤더 61 + comp-info 54 + 성별탭 48 = **163px / 844 = 19%** (comp1 시드, hero·division 데이터 없음)
- **히어로 있는 실운영 대회: +hero ~76 +division ~30 ≈ 269px = ~32%** ← 지시서가 말한 "27%" 문제
- hero 카드가 최대 비중. 목표 15%(~127px) 달성하려면 hero 압축이 핵심.

### 항목별 현황
- **1.1 헤더 압축**: 헤더(styles.css:112-116, 모바일 subtitle/nav 숨김 styles.css:1614) / #comp-info-bar(dashboard.html:24) / hero(dashboard.html:29-45, 데이터 없으면 display:none) / #gender-tabs(dashboard.html:264) / #division-tabs(`renderDivisionTabs` dashboard.js:494, #gender-tabs 뒤 .after() 삽입). 성별탭+부탭을 가로스크롤 칩 한 줄로 통합 필요.
- **1.2 종목 탐색**: 검색 인풋·"진행 중 N" 배지 둘 다 **현재 없음 → 신규 추가**. 진행중 판정 = `round_status==='in_progress'` 또는 `callroomCompletedIds.has(id)`.
- **1.3 카드 재구성**:
  - 상태 판정: 진행중=`round_status==='in_progress'`(dashboard.js:688,850) / 종료=`'completed'`(843) / 예정=heat_count>0면 "명단"(861) 아니면 "대기"(867). 카드레벨 상태배지는 신규.
  - 알림 토글: `toggleFavorite(name,gender)` dashboard.js:31, `.fav-toggle`(dashboard.html:107). 저장 이중=localStorage `pace_favorites_${compId}` + `PaceRisePush.syncFavorites()`(push.js:78). → 종아이콘+"알림"라벨+44×44px로 교체.
  - 비활성 라운드: 현재 `<span class="round-btn btn-disabled">—</span>`(dashboard.js:833). → 메타라인 텍스트로 통일.
  - 카드 전체 터치: 현재 라운드 칩만 클릭. 카드 탭→상세 추가 필요(칩/토글은 stopPropagation).
- **1.4 운영/노출 칩 분기**:
  - **운영용 ↗ 이미 없음** (`renderViewerBtn`에 external-link 없음) → 이 조건 이미 충족.
  - 노출용 외부이동: `renderDisplayBtn`(dashboard.js:882) `result_url` 있으면 `<a target="_blank">`인데 **↗ 아이콘 없음 → ↗ 추가가 실제 작업.**
  - `.matrix-table` 유일한 `↗`는 dashboard.html:310 SNS카드 표시용(무관).
- **W/L 버튼**: `wlCell` dashboard.js:736, `_pacingMap`에 항목 있을 때만. `openPacingPopup(key)`.

---

## Phase 2 — 관리자 필드 중복 조사 결과 (2.0, 보고만)

### 같은 의미 필드가 몇 벌 저장되나
| 의미 | DB 저장 슬롯 수 | 실사용 | 죽은/미저장 | UI 입력창 수 |
|---|---|---|---|---|
| 대회장(경기장) | **1** (`competition.venue`) | 1 | 0 | 1 | ← 중복 없음
| 심판장 이름 | 2 (result_sheet.chief_judge, comprehensive.chief_judge) | 1 | 1 | 3 |
| 기록주임 이름 | 2 (result_sheet.chief_recorder_name, comprehensive.chief_recorder) | 1 | 1 | 3 |
| 기록자 이름 | 1 (result_sheet.recorder_name) | 1 | 0 | 1 |
| 좌/우 로고 | 각 4 (start_list/result_sheet/comprehensive/competition.brand_logo_path) +상장N +ad_card자동 | 3(파일공유) | 1 | 5 |
| 워터마크 | 2 (competition.brand_watermark_path, certificate_template.watermark_image_path×N) | 전부 | 0 | 2 |

- `doc_template` 테이블 = 대회당 1행, JSON 컬럼 `ad_card` / `start_list` / `result_sheet` (db/schema.pg.sql:101-106).

### ★ 발견한 실제 버그 (마이그레이션 전 반드시 확인 — 운영 영향 있음)
UI 저장(`getDocTemplateFromUI` admin.html:7929)은 `{comprehensive, start_list, result_sheet}`를 보내지만, 서버 저장(server.js:8347)은 `ad_card/start_list/result_sheet` 컬럼만 기록.
→ **종합기록지(comprehensive) UI에서 입력한 심판장·기록주임·로고가 어느 컬럼에도 저장되지 않고 버려짐.** 읽기 코드는 `tpl.comprehensive.chief_judge`를 1순위 조회(server.js:11202)하지만 항상 undefined → 실제론 result_sheet 값만 동작. "중복"의 절반은 죽은 슬롯.

### 마이그레이션 방향 (승인 필요 — 미적용)
1. `competition`에 정본 컬럼 신설: `chief_judge`, `record_officer`, `recorder`, `doc_logo_left_path`, `doc_logo_right_path`. venue는 이미 정본.
2. `doc_template` sub-object는 값 있을 때만 override, 없으면 competition 정본 fallback (`getDocTemplate` server.js:8321 로직 확장).
3. comprehensive 키 ↔ ad_card 컬럼 불일치(위 버그) 먼저 해결.
4. `brand_logo`(공개 마이크로사이트) ≠ `doc_logo`(문서 헤더): 통합 말고 명칭만 분리.
5. `record_officer_key`(권한 비번)는 이름과 무관 → 통합 제외.

핵심 파일: db/schema.pg.sql, db/schema.sql, server.js(8271-8433, 8920-8962, 11197-11212), lib/fullRecordExcel.js, lib/comprehensiveByDivision.js, lib/certificatePdf.js, public/admin.html(1023-1061, 1961-2143, 7901-8166).

### Phase 2 착수 전 필수 (지시서 2.0)
- **시스템 통백업 ZIP 다운로드** (관리자가 직접, 실서버). 백업 없이 Phase 2 스키마 변경 금지.
- 마이그레이션 계획 승인 전 실제 스키마 변경 금지.

---

## 이 세션에서 못 한 것 / 주의
- 이 세션은 이미지 누적으로 캡처 시각확인이 막혀 Phase 1 구현을 보류함(측정치만 가능). 새 세션에서 진행.
- 로컬 정선 테스트데이터는 데스크탑 파일이 사라져 재구축 필요시 federation/import로 재업로드.
- 별도 기이력: 커밋 726f07d(1000m 종목 추가·연맹명단 휴대폰 저장)가 실서버 배포됐는지 미확인 → 배포 필요.
