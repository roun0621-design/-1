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
