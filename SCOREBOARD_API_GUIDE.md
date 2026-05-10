# PACE RISE - 전광판 연동 API 가이드

> 외부 API 서버에서 `.lif` 경기 결과 데이터를 PACE RISE DB에 등록하기 위한 개발자 가이드

---

## 1. DB 구조 (ER 관계)

```
competition (대회)
 └── event (종목)
      └── heat (조)
           ├── heat_entry (조 배정 선수)
           │    └── event_entry ──→ athlete (선수)
           └── result ← ⭐ 기록 저장 테이블
```

### 핵심 테이블 요약

| 테이블 | 역할 | 비고 |
|--------|------|------|
| `heat` | 조 (예선 1조, 결승 등) | `scoreboard_key`로 매칭, `wind`에 풍속 저장 |
| `heat_entry` | 조에 배정된 선수 | `lane_number`, `event_entry_id` |
| `event_entry` | 종목-선수 연결 | `event_id` + `athlete_id` |
| `athlete` | 선수 정보 | `bib_number`로 매칭 |
| `result` | **경기 결과** | ⭐ 여기에 INSERT/UPDATE |

---

## 2. 테이블 상세 스키마

### `heat` (조)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | INTEGER PK | |
| `event_id` | INTEGER FK | event.id |
| `heat_number` | INTEGER | 조 번호 (1, 2, 3...) |
| `wind` | TEXT | 풍속 `"-0.3 m/s"` 형식 문자열. NULL이면 미입력 |
| `heat_name` | TEXT | 표시명 (예: "예선 2조") |
| `scoreboard_key` | TEXT | **전광판 매칭키** (예: "남자실업부 100m 예선 2조") |

### `result` (경기 결과) ⭐

| 컬럼 | 타입 | 설명 | 트랙 종목 | 필드 종목 |
|------|------|------|-----------|-----------|
| `id` | INTEGER PK | | | |
| `heat_id` | INTEGER FK | heat.id | ✅ 필수 | ✅ 필수 |
| `event_entry_id` | INTEGER FK | event_entry.id | ✅ 필수 | ✅ 필수 |
| `attempt_number` | INTEGER | 시도 번호 | **NULL** | 1~6 |
| `distance_meters` | REAL | 거리 (m) | **NULL** | 예: 7.83 |
| `time_seconds` | REAL | 기록 (초) | 예: 10.21 | **NULL** |
| `status_code` | TEXT | 상태 코드 | `''` / `'DQ'` / `'DNS'` / `'DNF'` | 동일 |
| `remark` | TEXT | 비고 | `''` (빈 문자열) | `''` |
| `wind` | REAL | 개별 시도 풍속 | **NULL** (heat.wind 사용) | 예: 1.3 |
| `created_at` | TEXT | | 자동 | 자동 |
| `updated_at` | TEXT | | 자동 | 자동 |

### `heat_entry` (조 배정 선수)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | INTEGER PK | |
| `heat_id` | INTEGER FK | heat.id |
| `event_entry_id` | INTEGER FK | event_entry.id |
| `lane_number` | INTEGER | 레인 번호 |

### `athlete` (선수)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | INTEGER PK | |
| `bib_number` | TEXT | **배번** (매칭 기준) |
| `name` | TEXT | 선수명 |
| `team` | TEXT | 소속 |
| `gender` | TEXT | `'M'` / `'F'` |

---

## 3. 데이터 입력 플로우

### Step 1: heat 찾기 (scoreboard_key 매칭)

LIF 헤더의 종목명이 `scoreboard_key`입니다.

```
LIF 헤더: "남자실업부 100m 예선 2조"
→ scoreboard_key = "남자실업부 100m 예선 2조"
```

```sql
SELECT h.id AS heat_id, h.event_id, e.competition_id
FROM heat h
JOIN event e ON e.id = h.event_id
WHERE h.scoreboard_key = '남자실업부 100m 예선 2조'
  AND e.competition_id = ?;
```

### Step 2: 선수 매칭 (BIB 번호)

```sql
SELECT he.event_entry_id, a.bib_number, a.name, a.team, he.lane_number
FROM heat_entry he
JOIN event_entry ee ON ee.id = he.event_entry_id
JOIN athlete a ON a.id = ee.athlete_id
WHERE he.heat_id = ?;
```

LIF의 `bib`과 DB의 `a.bib_number`를 매칭합니다.

> **매칭 우선순위**: BIB → 레인번호 → 이름

### Step 3: result 테이블에 INSERT

```sql
-- 정상 기록
INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, status_code, remark)
VALUES (1365, 9809, NULL, 10.21, '', '');

-- DQ (실격) - time_seconds = NULL
INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, status_code, remark)
VALUES (1365, 10001, NULL, NULL, 'DQ', '');

-- DNF (미완주) - time_seconds = NULL
INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, status_code, remark)
VALUES (1365, 10002, NULL, NULL, 'DNF', '');

-- DNS (불출발) - time_seconds = NULL
INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, status_code, remark)
VALUES (1365, 10003, NULL, NULL, 'DNS', '');
```

**기존 데이터가 있을 경우 UPDATE:**

```sql
-- UPSERT 판별 조건
SELECT id FROM result
WHERE heat_id = ? AND event_entry_id = ? AND attempt_number IS NULL;

-- 있으면 UPDATE
UPDATE result
SET time_seconds = 10.21, status_code = '', remark = '', updated_at = datetime('now')
WHERE heat_id = ? AND event_entry_id = ? AND attempt_number IS NULL;
```

### Step 4: 풍속 저장

```sql
-- 풍속은 heat 테이블에 문자열로 저장
UPDATE heat SET wind = '-0.3 m/s' WHERE id = ?;
```

---

## 4. status_code 규칙

| 코드 | 의미 | time_seconds |
|------|------|-------------|
| `''` (빈 문자열) | 정상 | 기록 값 (예: 10.21) |
| `'DQ'` | 실격 (Disqualified) | `NULL` |
| `'DNS'` | 불출발 (Did Not Start) | `NULL` |
| `'DNF'` | 미완주 (Did Not Finish) | `NULL` |
| `'NM'` | 기록없음 (No Mark) | `NULL` |

---

## 5. 풍속(wind) 저장 규칙

| 위치 | 용도 | 형식 | 예시 |
|------|------|------|------|
| `heat.wind` | **조 전체 풍속** (트랙 100m/200m/허들) | TEXT 문자열 | `"-0.3 m/s"`, `"1.5 m/s"` |
| `result.wind` | 개별 시도 풍속 (필드: 멀리뛰기/세단뛰기) | REAL 숫자 | `-0.3`, `1.5` |

> **중요**: `heat.wind`는 반드시 `"N.N m/s"` **문자열** 형식으로 저장해야 합니다.
> 전광판 시스템이 이 값을 그대로 읽어서 표시합니다.

---

## 6. HTTP API 사용 (권장)

DB를 직접 건드리지 않고 HTTP API를 호출하는 방법입니다.

### 6-1. .lif 파일 통째로 업로드 (가장 간편)

```bash
POST /api/scoreboard/import
Content-Type: multipart/form-data

# form fields:
#   competition_id: 2
#   files: .lif 파일 (복수 가능)
```

→ 자동으로: scoreboard_key 매칭 → BIB 매칭 → result INSERT → wind 저장

**응답:**
```json
{
  "success": true,
  "results": [
    {
      "filename": "001-3-07.lif",
      "scoreboardKey": "남자실업부 100m 예선 2조",
      "heatInfo": { "heat_id": 1365, "event_name": "100m", "heat_number": 2 },
      "wind": "-0.3 m/s",
      "imported": 5,
      "skipped": 0,
      "details": [
        { "name": "강의빈", "bib": "78", "time": 10.21, "status": "OK" },
        { "name": "김동하", "bib": "95", "time": null, "status": "DQ" }
      ]
    }
  ]
}
```

### 6-2. 선수별 개별 등록

```bash
POST /api/results/upsert
Content-Type: application/json

# 정상 기록
{
  "heat_id": 1365,
  "event_entry_id": 9809,
  "time_seconds": 10.21,
  "status_code": "",
  "remark": ""
}

# DQ
{
  "heat_id": 1365,
  "event_entry_id": 10001,
  "time_seconds": null,
  "status_code": "DQ",
  "remark": ""
}
```

### 6-3. 풍속 저장

```bash
POST /api/heats/{heat_id}/wind
Content-Type: application/json

{ "wind": -0.3 }
```
→ DB에 `"-0.3 m/s"` 문자열로 자동 변환 저장됨

### 6-4. 풍속 조회

```bash
GET /api/heats/{heat_id}/wind
```
```json
{ "heat_id": 1365, "wind": "-0.3 m/s" }
```

### 6-5. scoreboard_key로 heat + 선수 목록 조회

```bash
GET /api/scoreboard/lookup?key=남자실업부 100m 예선 2조&competition_id=2
```
```json
{
  "heat_id": 1365,
  "heat_number": 2,
  "scoreboard_key": "남자실업부 100m 예선 2조",
  "event_name": "100m",
  "gender": "M",
  "round_type": "preliminary",
  "category": "track",
  "wind": "-0.3 m/s",
  "entries": [
    { "lane_number": 1, "event_entry_id": 9809, "athlete_id": 123, "name": "강의빈", "bib_number": "78", "team": "광주광역시청" },
    { "lane_number": 5, "event_entry_id": 9805, "athlete_id": 124, "name": "이성진", "bib_number": "130", "team": "서천군청" }
  ]
}
```

### 6-6. 전체 scoreboard_key 목록 조회

```bash
GET /api/scoreboard/keys?competition_id=2
```
```json
[
  { "heat_id": 1365, "heat_number": 1, "scoreboard_key": "남자실업부 100m 예선 1조", "event_name": "100m", "gender": "M", "round_type": "preliminary", "wind": null },
  { "heat_id": 1366, "heat_number": 2, "scoreboard_key": "남자실업부 100m 예선 2조", "event_name": "100m", "gender": "M", "round_type": "preliminary", "wind": "-0.3 m/s" }
]
```

---

## 7. 실전 예시: .lif → DB 전체 흐름

**.lif 파일 내용 (UTF-16 LE):**
```
1,1,1,남자실업부 100m 예선 2조,-0.3,m/s S,,,,,14:25:10.0032
1,78,1,,강의빈,광주광역시청,10.21,,10.21,,,14:25:10.01,,,,10.21,10.21
2,130,5,,이성진,서천군청,10.35,,0.14,,,14:25:10.01,,,,0.14,0.14
3,190,3,,이용문,국군체육부대,10.42,,0.21,,,14:25:10.01,,,,0.21,0.21
4,166,4,,박시영,경산시청,10.58,,0.37,,,14:25:10.01,,,,0.37,0.37
5,49,6,,문해진,안양시청,10.67,,0.46,,,14:25:10.01,,,,0.46,0.46
DQ,95,7,,김동하,보은군청,,,,,,14:25:10.01,,,,,
DNF,217,8,,하도연,포항시체육회,,,,,,14:25:10.01,,,,,
```

**헤더 파싱:**
```
[0] = "1"          → status
[1] = "1"          → competitionNum
[2] = "1"          → eventNum
[3] = "남자실업부 100m 예선 2조" → scoreboard_key
[4] = "-0.3"       → 풍속 값
[5] = "m/s S"      → 풍속 단위 (m/s가 포함되면 풍속 데이터 있음)
[10] = "14:25:10.0032" → timestamp
```

**데이터 행 파싱:**
```
[0] = 순위 ("1", "2", ... 또는 "DQ", "DNF", "DNS")
[1] = BIB 번호
[2] = 레인 번호
[3] = (비어있음)
[4] = 선수명
[5] = 소속
[6] = 기록 (초) — DQ/DNF/DNS이면 비어있음
```

**→ DB 작업:**
```sql
-- 1) heat 찾기
SELECT id FROM heat WHERE scoreboard_key = '남자실업부 100m 예선 2조';
-- → heat_id = 1365

-- 2) BIB으로 event_entry_id 매칭 후 result INSERT
INSERT INTO result (heat_id, event_entry_id, attempt_number, time_seconds, status_code, remark)
VALUES
  (1365, ?, NULL, 10.21, '', ''),    -- BIB 78 강의빈
  (1365, ?, NULL, 10.35, '', ''),    -- BIB 130 이성진
  (1365, ?, NULL, 10.42, '', ''),    -- BIB 190 이용문
  (1365, ?, NULL, 10.58, '', ''),    -- BIB 166 박시영
  (1365, ?, NULL, 10.67, '', ''),    -- BIB 49 문해진
  (1365, ?, NULL, NULL,  'DQ', ''),  -- BIB 95 김동하
  (1365, ?, NULL, NULL,  'DNF', ''); -- BIB 217 하도연

-- 3) 풍속 저장
UPDATE heat SET wind = '-0.3 m/s' WHERE id = 1365;
```

---

## 8. 주의사항 체크리스트

- [ ] 트랙 종목 result의 `attempt_number`는 반드시 **NULL**
- [ ] DQ/DNF/DNS일 때 `time_seconds`는 반드시 **NULL**
- [ ] `remark`는 빈 문자열 `''` (NULL 아님)
- [ ] `heat.wind`는 **문자열** `"N.N m/s"` 형식 (예: `"-0.3 m/s"`, `"1.5 m/s"`)
- [ ] `result.wind`는 **숫자** (REAL) — 필드 종목 시도별 풍속만 해당
- [ ] UPSERT 시 기존 데이터 판별: `heat_id + event_entry_id + attempt_number IS NULL`
- [ ] `scoreboard_key`에 "N조" 접미사가 없으면 결승 단일 조이므로 "1조" 자동 추가됨
