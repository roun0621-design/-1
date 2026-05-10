# PACE RISE - 필드경기 최종기록 표출 가이드

> 외부 개발자용: 필드경기 기록이 DB에 어떻게 저장되고, 최종기록이 어떻게 계산/표출되는지 설명

---

## 개요

필드경기는 **2가지 유형**으로 나뉘며, 각각 **사용하는 DB 테이블이 다릅니다**.

| 유형 | 종목 | DB 테이블 | category 값 |
|------|------|-----------|-------------|
| 거리 종목 | 멀리뛰기, 세단뛰기, 포환던지기, 원반던지기, 해머던지기, 창던지기 | `result` | `field_distance` |
| 높이 종목 | 높이뛰기, 장대높이뛰기 | `height_attempt` | `field_height` |

---

## 1. 거리 종목 (field_distance)

### 1-1. DB 테이블: `result`

```sql
CREATE TABLE result (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id         INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id  INTEGER NOT NULL REFERENCES event_entry(id),
    attempt_number  INTEGER,          -- 시기 번호 (1~6)
    distance_meters REAL,             -- 거리 (미터)
    time_seconds    REAL,             -- 필드에서는 미사용
    remark          TEXT DEFAULT '',
    status_code     TEXT DEFAULT '',
    wind            REAL DEFAULT NULL, -- 시기별 풍속 (숫자)
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(heat_id, event_entry_id, attempt_number)
);
```

### 1-2. 데이터 저장 규칙

| 상황 | attempt_number | distance_meters | 비고 |
|------|---------------|-----------------|------|
| 정상 기록 | 1~6 | 양수 (예: 6.78) | 미터 단위, 소수 2자리 |
| 파울 (X) | 1~6 | `0` | 화면에 `X` 표시 |
| 패스 (-) | 1~6 | `-1` | 화면에 `-` 표시 |
| 미입력 | — | `NULL` 또는 row 없음 | 빈 칸 |

### 1-3. 풍속 (wind)

- **멀리뛰기, 세단뛰기**: 시기별 풍속 기록 필요 → `result.wind` 에 숫자로 저장
- **투척 종목** (포환, 원반, 해머, 창): 풍속 불필요 → `wind = NULL`
- 풍속은 **시기별로 각각** 저장됨 (6차 시기 = 6개의 wind 값)

### 1-4. 최종기록 계산 로직

```
선수의 1~6차 시기 중 distance_meters > 0 인 값만 추출
→ MAX(최대값) = 최종기록 (best)
→ 소수점 2자리 + "m" 표시
```

**SQL 예시:**
```sql
-- 특정 선수의 최고 기록
SELECT MAX(distance_meters) AS best
FROM result
WHERE heat_id = ?
  AND event_entry_id = ?
  AND distance_meters > 0;
```

### 1-5. 순위 결정 (WA 동점 처리)

```
1순위: 최고기록(best) 내림차순 (큰 값이 1등)
2순위: 동점 시 → 2번째로 좋은 기록 비교
3순위: 그래도 동점 → 3번째, 4번째... 순차 비교
```

**동점 예시:**
```
김선수: 6.78, X, 6.65, 6.54, X, 6.72  → best 6.78 / 2nd 6.72
박선수: X, 6.78, 6.71, 6.60, 6.55, X  → best 6.78 / 2nd 6.71
→ 2번째 기록 비교: 6.72 > 6.71 → 김선수가 상위
```

### 1-6. 최종기록 풍속 표시 (멀리뛰기/세단뛰기)

최고기록이 여러 시기에서 동일할 경우, **가장 나중 시기(번호가 큰 시기)** 의 풍속을 표시합니다.

```
best = 6.78 → 3차 시기에서 나온 기록
→ 3차 시기의 wind 값이 최종기록 옆에 표시
→ 예: "6.78m (+1.2)"
```

### 1-7. 화면 표출 예시

**풍속 없는 종목 (포환, 원반, 해머, 창):**

| 순위 | 선수 | 1차 | 2차 | 3차 | 4차 | 5차 | 6차 | 기록 |
|------|------|-----|-----|-----|-----|-----|-----|------|
| 1 | 김선수 | 15.32 | X | 15.87 | 15.65 | X | 15.72 | **15.87** |
| 2 | 박선수 | 14.95 | 15.21 | X | 15.10 | 15.21 | 15.05 | **15.21** |

**풍속 있는 종목 (멀리뛰기, 세단뛰기) — 2행 구조:**

| 순위 | 순번 | 성명/소속 | 배번 | 1차시기 | 2차시기 | 3차시기 | 4차시기 | 5차시기 | 6차시기 | 기록 |
|------|------|-----------|------|---------|---------|---------|---------|---------|---------|------|
| 1 | — | **김선수** | 78 | 6.54 | X | 6.78 | 6.65 | X | 6.72 | **6.78** |
| | | 서울시청 | | -0.3 | — | +1.2 | +0.5 | — | +0.8 | (+1.2) |

---

## 2. 높이 종목 (field_height)

### 2-1. DB 테이블: `height_attempt`

```sql
CREATE TABLE height_attempt (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    heat_id         INTEGER NOT NULL REFERENCES heat(id),
    event_entry_id  INTEGER NOT NULL REFERENCES event_entry(id),
    bar_height      REAL NOT NULL,     -- 바 높이 (미터)
    attempt_number  INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 3),
    result_mark     TEXT NOT NULL CHECK(result_mark IN ('O','X','-')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(heat_id, event_entry_id, bar_height, attempt_number)
);
```

> **주의**: 높이 종목은 `result` 테이블을 사용하지 않습니다!

### 2-2. 데이터 저장 규칙

| result_mark | 의미 | 화면 표시 |
|-------------|------|-----------|
| `O` | 성공 | O (초록색) |
| `X` | 실패 | X (빨간색) |
| `-` | 패스 | - (회색) |

- 각 높이(bar_height)별로 최대 **3회 시도** (attempt_number: 1, 2, 3)
- 같은 높이에서 `X`가 3개 → **탈락**

### 2-3. 최종기록 계산 로직

```
모든 bar_height 중 result_mark = 'O' 인 높이들 추출
→ MAX(최대값) = 최종기록 (best)
→ 소수점 2자리 + "m" 표시
```

**SQL 예시:**
```sql
-- 특정 선수의 최고 성공 높이
SELECT MAX(bar_height) AS best
FROM height_attempt
WHERE heat_id = ?
  AND event_entry_id = ?
  AND result_mark = 'O';
```

### 2-4. 탈락 판정

```sql
-- 특정 높이에서 실패 횟수 확인
SELECT COUNT(*) AS fail_count
FROM height_attempt
WHERE heat_id = ?
  AND event_entry_id = ?
  AND bar_height = ?
  AND result_mark = 'X';
-- fail_count >= 3 → 탈락
```

### 2-5. 순위 결정

```
최고 성공 높이(best) 내림차순 (높은 값이 1등)
```

### 2-6. 화면 표출 예시

| 순위 | 선수 | 1.85 | 1.90 | 1.95 | 2.00 | 2.05 | 2.10 | 최고 | 상태 |
|------|------|------|------|------|------|------|------|------|------|
| 1 | 김선수 | O | O | O | XO | XXO | XXX | **2.05m** | 탈락 |
| 2 | 박선수 | O | XO | O | XXX | | | **2.00m** | 탈락 |
| 3 | 이선수 | O | O | XXX | | | | **1.90m** | 탈락 |

- `XO` = 1차 실패, 2차 성공
- `XXO` = 1차 실패, 2차 실패, 3차 성공
- `XXX` = 3회 모두 실패 → 탈락

---

## 3. 핵심 비교표

| 구분 | 거리 종목 | 높이 종목 |
|------|-----------|-----------|
| **category** | `field_distance` | `field_height` |
| **DB 테이블** | `result` | `height_attempt` |
| **기록 컬럼** | `distance_meters` (REAL) | `bar_height` (REAL) |
| **시기/시도** | `attempt_number` 1~6 | `attempt_number` 1~3 (높이별) |
| **최종기록** | MAX(distance_meters > 0) | MAX(bar_height WHERE mark='O') |
| **파울** | `distance_meters = 0` | `result_mark = 'X'` |
| **패스** | `distance_meters = -1` | `result_mark = '-'` |
| **풍속** | `result.wind` (시기별, 숫자) | 없음 |
| **표시 형식** | `6.78m` (소수 2자리) | `2.05m` (소수 2자리) |
| **TOP 8** | 3차 시기까지의 상위 8명이 4~6차 진출 | 해당 없음 |

---

## 4. API 엔드포인트

### 거리 종목 기록 등록/수정

```
POST /api/results/upsert
Content-Type: application/json

{
  "heat_id": 1365,
  "event_entry_id": 9809,
  "attempt_number": 3,
  "distance_meters": 6.78,
  "wind": -0.3
}
```

| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| heat_id | INTEGER | O | 조 ID |
| event_entry_id | INTEGER | O | 선수 출전 ID |
| attempt_number | INTEGER | O | 시기 번호 (1~6) |
| distance_meters | REAL | O | 거리 (미터). 파울=0, 패스=-1 |
| wind | REAL | — | 시기별 풍속 (멀리뛰기/세단뛰기만) |

### 높이 종목 시도 등록/수정

```
POST /api/height-attempts/save
Content-Type: application/json

{
  "heat_id": 1365,
  "event_entry_id": 9809,
  "bar_height": 2.05,
  "attempt_number": 2,
  "result_mark": "O"
}
```

| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| heat_id | INTEGER | O | 조 ID |
| event_entry_id | INTEGER | O | 선수 출전 ID |
| bar_height | REAL | O | 바 높이 (미터) |
| attempt_number | INTEGER | O | 시도 번호 (1~3) |
| result_mark | TEXT | O | `O`(성공), `X`(실패), `-`(패스) |

### 기록 조회

```
GET /api/results?heat_id=1365          → 거리 종목 전체 결과
GET /api/height-attempts?heat_id=1365  → 높이 종목 전체 시도 기록
```

---

## 5. 주의사항 체크리스트

- [ ] 거리 종목과 높이 종목은 **테이블이 다름** — 혼동 금지
- [ ] 높이 종목은 `result` 테이블에 데이터를 넣지 않음
- [ ] `distance_meters = 0` 은 파울(X), `NULL`이 아님
- [ ] `distance_meters = -1` 은 패스(-), 마이너스가 아님
- [ ] `result_mark`는 반드시 `O`, `X`, `-` 중 하나 (대문자 영문 O, X)
- [ ] 높이 종목의 `attempt_number`는 1~3, 거리 종목은 1~6
- [ ] 최종기록은 DB에 별도 저장하지 않음 — **항상 계산으로 도출**
- [ ] 풍속은 멀리뛰기/세단뛰기만 해당, 투척 종목은 풍속 없음
