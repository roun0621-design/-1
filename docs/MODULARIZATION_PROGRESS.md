# server.js 모듈 분리 진행 현황

> audit P0 (2단계). 17,438줄 단일 파일 → `/lib/routes/` 도메인별 분해.

## 목표

- **시작**: `server.js` 17,438줄 / 281 라우트 / 단일 파일
- **목표**: server.js는 부팅·미들웨어·DB·헬퍼만 담는 얇은 진입점 (~3,000줄 이하)
- **방식**: 도메인 단위 점진적 추출. 각 단계마다 `npm test` 통과 필수.

## 분리 패턴 (factory function)

```js
// lib/routes/<domain>.js
module.exports = function mount<Domain>Routes(app, deps) {
    const { db, isAdminKey, opLog, /* ... */ } = deps;
    if (!app || !db || ...) throw new Error('...mount requires {...}');

    app.get('/api/<domain>', async (req, res) => { ... });
    // ...
};

// server.js
require('./lib/routes/<domain>')(app, { db, isAdminKey, opLog });
```

**장점**:
- server.js 의 헬퍼 함수·DB 객체를 그대로 전달 → 동작 보장
- 의존성 명시 (`deps`) → 무엇이 필요한지 한눈에
- 테스트 격리 가능
- Express 라우트 등록 순서 유지 (auto-match 같은 prefix 라우트는 `/:id` 보다 먼저 등록되도록 모듈 내부에서 명시)

## 진행 현황

### ✅ 1차 (5/30, commit pending)

| 모듈 | 라우트 수 | 파일 | 의존성 |
|------|---------|------|--------|
| federations.js | 5 | 94줄 | db, isAdminKey, opLog |
| home_popups.js | 5 | 124줄 | db, isAdminKey, opLog |
| competition_series.js | 4 | 95줄 | db, isAdminKey, opLog |
| event_links.js | 4 | 102줄 | db, isOperationKey, opLog, generateJointScoreboardKey |
| **합계** | **18** | **415줄** | — |

**효과**:
- server.js: 17,438 → 17,144 (**-294줄, -1.7%**)
- 라우트 등록: 281개 그대로 유지
- 테스트: 17개 → 28개 (회귀 안전망 확장)
- 운영 영향: 0 (PM2 재시작 후 모든 라우트 HTTP 200 확인)

### 🔄 다음 사이클 후보 (우선순위)

| 도메인 | 라우트 수 | 위험도 | 비고 |
|--------|---------|-------|------|
| record-breaks | 5 | 낮음 | 의존성 정리 필요 (broadcastSSE, getJudgeName) |
| qualifications | 3 | 낮음 | 단순 |
| athletes (GET 부분) | 2 | 낮음 | upload 라우트는 별도 |
| events (GET 부분) | 10+ | 중간 | 부분 추출 가능 |
| timetable | 12 | 중간 | 한 곳에 모여있음 |
| documents | 9 | 중간 | PDF/Excel 생성 — 큰 함수 다수 |
| display | 25 | 높음 | display-mode 별도 마이그레이션 코드와 얽힘 |
| admin | 68 | **매우 높음** | **가장 마지막**. SMS/Certificate/Full-backup 등 큼 |

### 다음 사이클에서 할 일

1. record-breaks 추출 (의존성 `broadcastSSE`, `getJudgeName`, `isRecordOfficerOrAdmin`, `isAdminKey` 전달)
2. qualifications 추출
3. events 의 단순 GET 라우트들 부분 추출
4. timetable 전체 추출

각 단계 후 `npm test` → PM2 재시작 → HTTP 200 검증 → 커밋·푸시.

## 안전 수칙

1. **테스트 없는 도메인은 추출 전에 회귀 테스트 1개 이상 추가**
2. **라우트 등록 순서 유지** — `/<prefix>` 가 `/:id` 보다 먼저 등록되어야 하는 경우 모듈 내부에서 명시
3. **transaction / async 호출 패턴 보존** — `db.transaction(async () => {...})()` 같은 형태 그대로
4. **`opLog` 호출은 추출 후에도 동일하게 동작** — message 포맷 변경 금지
5. **`broadcastSSE` 같은 사이드 이펙트도 deps 로 전달, 호출 시점 동일하게**

## 진행 지표

```
[##########............] 1.7% (294 / 17,438 lines)
[##....................] 6.4% (18 / 281 routes)
```

다음 사이클 목표: 누적 10% (≈1,750 lines, ≈28 routes)

### ✅ qualifications 추출 (6/10)

| 모듈 | 라우트 수 | 의존성 |
|------|---------|--------|
| qualifications.js | 3 | db, isOperationKey |

- 동작 동일 추출 (인증 없음 — 심판 화면용, 운영 정책상 키 미요구)
- GET `/api/qualifications`는 dashboard/results 조회용

### ✅ field_card_import 신규 모듈 (9/15)

server.js 에서 추출한 것이 아니라 처음부터 모듈로 작성 (`lib/routes/field_card_import.js`, 4 라우트).
- 파서/계산/검산은 `lib/fieldCardImport.js` 순수 함수로 분리 → DB 없이 단위 테스트 (`tests/lib/fieldCardImport.test.js`)
- deps: `db, isAdminKey, opLog, broadcastSSE, audit, upload, recx{normBib,divToken,genderOf,round}, runRecordCompareHook`
- `recx` 는 server.js 의 기록 엑셀 가져오기 정규화 헬퍼(`_recx*`)를 그대로 주입 — 종별/성별/라운드 해석 규칙 단일화
- `runRecordCompareHook` 은 `lib/routes/results.js` 의 mount 반환값으로 노출 (신기록 감지 경로 재사용)
- 문서: `docs/FIELD_CARD_IMPORT.md`
- 사진 → 서버 AI 전사(`/api/field-card/transcribe`)는 `lib/fieldCardVision.js` 가 Claude API 호출과 카드 JSON → 시트 변환을 담당하고, 라우트는 같은 모듈에 있음. 의존성 `@anthropic-ai/sdk` 추가 (9/15)

### ✅ heat_assignment 추출 (2026-09-18)
- `lib/routes/heat_assignment.js` — 조편성 미리보기/적용 2라우트 + 파서·정규화 헬퍼 (867줄). deps: db, upload, isAdminKey, opLog, normalizeDivisionLabel, resolveFedEventName, guessEventCategory, autoLinkDisplayTimetable
- 회귀: tests/flows/01_yecheon_pipeline(30건), tests/api/25_heat_assignment_round_sync. server.js 15,372 → 14,509줄

### ✅ timing_import 추출 (2026-09-18)
- `lib/routes/timing_import.js` — .lif/기록 xlsx/.txt 가져오기 5라우트 + 파서·매칭 헬퍼 (891줄). 반환 `{ recx }` 를 field_card_import 가 공유. server.js 14,509 → 13,714줄

### ✅ pdf_documents 추출 (2026-09-18)
- `lib/routes/pdf_documents.js` — 스타트리스트·결과지(+PNG)·ID카드 PDF 3라우트 + 글꼴/표/머리글 헬퍼 (1,658줄). deps: db, getDocTemplate, orderByBibSql, PORT. server.js 13,714 → 12,060줄
