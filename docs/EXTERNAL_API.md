# PACE RISE — External Result-Link API

외부 시스템(예: Mac mini의 OpenClaw)이 PACE RISE의 **노출용(display) 대회**에
대한육상연맹 사이트에서 스크래핑한 **결과 링크 / 영상 링크**를 자동 등록하기 위한 API입니다.

- Base URL: `https://www.pace-rise-node.com`
- 인증: `X-API-Key` 헤더 (또는 `Authorization: Bearer <key>`)
- 콘텐츠 타입: `application/json`
- 적용 대상: **`competition.mode = 'display'`** 인 대회의 종목만 (운영용 대회는 차단)

---

## 1. 인증

요청 헤더 중 하나로 API 키를 보냅니다.

```
X-API-Key: pkr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

또는

```
Authorization: Bearer pkr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

키는 관리자 페이지(`/admin.html` → "외부 API" 탭)에서 발급합니다.

- 키는 **발급 시 1회만 표시**됩니다. 분실 시 회수 후 재발급해야 합니다.
- 키별로 다음 항목을 설정할 수 있습니다:
  - **라벨** (운영용 식별, 예: `OpenClaw - 정선 5/15`)
  - **전용 대회**(`allowed_competition_id`) — 비우면 모든 노출용 대회 허용
  - **분당 호출 한도**(`rate_limit_per_min`) — 기본 60, 최대 600
  - **만료일**(`expires_at`, 선택)

응답 헤더에 `X-RateLimit-Limit`, `X-RateLimit-Remaining`이 포함됩니다.

---

## 2. 공통 응답 구조

성공:
```json
{ "ok": true, ... }
```

실패:
```json
{ "ok": false, "code": "ERROR_CODE", "message": "사람이 읽을 수 있는 설명" }
```

### 에러 코드

| HTTP | code                    | 의미 |
|------|-------------------------|------|
| 401  | `MISSING_API_KEY`       | 헤더에 키 없음 |
| 403  | `INVALID_API_KEY`       | 일치하는 키 없음 |
| 403  | `KEY_REVOKED`           | 회수된 키 |
| 403  | `KEY_EXPIRED`           | 만료된 키 |
| 403  | `COMPETITION_FORBIDDEN` | 키 권한 외 대회 |
| 400  | `COMPETITION_REQUIRED`  | 전용 키인데 `competition_id` 누락 |
| 400  | `MISSING_COMPETITION_ID`| `competition_id` 파라미터 필요 |
| 404  | `COMPETITION_NOT_FOUND` | 대회 없음 |
| 404  | `NOT_DISPLAY_MODE`      | 노출용 대회가 아님 |
| 404  | `EVENT_NOT_FOUND`       | 종목 없음 |
| 400  | `INVALID_EVENT_ID`      | event_id 형식 오류 |
| 400  | `INVALID_URL`           | URL 형식 오류 (`https?://`, 10~2000자) |
| 400  | `INVALID_FIELD`         | `field`가 `result_url` / `video_url` 외 값 |
| 409  | `ALREADY_HAS_VALUE`     | 기존 값 존재, `force=true` 필요 |
| 400  | `EMPTY_ITEMS`           | 배치 요청 본문 비어있음 |
| 400  | `TOO_MANY_ITEMS`        | 배치 100건 초과 |
| 429  | `RATE_LIMITED`          | 분당 호출 한도 초과 |
| 500  | `INTERNAL_ERROR`        | 서버 내부 오류 |

---

## 3. 엔드포인트

### 3.1 종목 검색 — `GET /api/external/events/search`

| 파라미터          | 타입   | 필수 | 비고 |
|-------------------|--------|------|------|
| `competition_id`  | int    | ★    | 키에 전용 대회가 설정돼 있으면 자동 적용 |
| `name`            | string |      | 종목명 부분 일치 |
| `division`        | string |      | 부 부분 일치 (`선수권` → `선수권(남)/선수권(여)/선수권(혼)` 등) |
| `gender`          | M\|F\|X|      | |
| `round_type`      | string |      | `preliminary` \| `semifinal` \| `final` |
| `limit`           | int    |      | 기본 50, 최대 200 |

**응답 (200)**
```json
{
  "ok": true,
  "competition": { "id": 31, "name": "...", "mode": "display", "start_date": "...", "end_date": "..." },
  "count": 12,
  "limit": 50,
  "items": [
    {
      "id": 12345,
      "competition_id": 31,
      "name": "100m",
      "category": "track",
      "gender": "M",
      "division": "선수권(남)",
      "round_type": "final",
      "round_status": "created",
      "sort_order": 10,
      "result_url": "",
      "video_url": ""
    }
  ]
}
```

### 3.2 종목 단건 조회 — `GET /api/external/event/:id`

**응답 (200)**
```json
{
  "ok": true,
  "competition": { "id": 31, "name": "...", "mode": "display", ... },
  "event": { "id": 12345, "name": "100m", "gender": "M", "division": "선수권(남)", ... }
}
```

### 3.3 단건 결과 링크 저장 — `POST /api/external/event-result-link`

**요청 본문**
```json
{
  "event_id": 12345,
  "url":      "https://www.kafa.or.kr/result/abc",
  "field":    "result_url",   // (선택) "result_url"(기본) | "video_url"
  "dry_run":  false,          // (선택) true면 검증만 수행
  "force":    false           // (선택) 기존 값 덮어쓰기 허용
}
```

**응답 (200, 저장 성공)**
```json
{
  "ok": true,
  "saved": true,
  "event_id": 12345,
  "field": "result_url",
  "previous_value": "",
  "new_value": "https://...",
  "overwritten": false,
  "event": { "id": 12345, "name": "100m", "division": "선수권(남)", "gender": "M", "round_type": "final" }
}
```

**응답 (200, dry_run)**
```json
{
  "ok": true,
  "dry_run": true,
  "event_id": 12345,
  "field": "result_url",
  "current_value": "",
  "requested_value": "https://...",
  "will_overwrite": false,
  "event": { ... }
}
```

**응답 (409, 이미 값이 있음)**
```json
{
  "ok": false,
  "code": "ALREADY_HAS_VALUE",
  "message": "이 종목에는 이미 result_url이(가) 저장되어 있습니다. 덮어쓰려면 force=true 를 보내세요.",
  "event_id": 12345,
  "field": "result_url",
  "current_value": "https://...(기존)",
  "requested_value": "https://...(요청)"
}
```

### 3.4 배치 결과 링크 저장 — `POST /api/external/event-result-link/batch`

**요청 본문**
```json
{
  "items": [
    { "event_id": 12345, "url": "https://...", "field": "result_url", "force": false },
    { "event_id": 12346, "url": "https://...", "force": true }
  ],
  "dry_run":       false,
  "stop_on_error": false
}
```

- `items`: 1~100건
- `stop_on_error: true` → 검증 단계에서 첫 실패 발생 시 전체 거부 (`BATCH_VALIDATION_FAILED`)
- 트랜잭션 내에서 일괄 적용 → 부분 실패 발생 시 검증 통과한 항목만 적용됨 (실패 항목은 results에 코드와 함께 표기)

**응답 (200)**
```json
{
  "ok": true,
  "total": 2,
  "applied": 2,
  "failed": 0,
  "results": [
    { "index": 0, "ok": true, "applied": true, "event_id": 12345, "field": "result_url",
      "previous_value": "", "new_value": "https://...", "overwritten": false, "event": { ... } },
    { "index": 1, "ok": true, "applied": true, "event_id": 12346, "field": "result_url",
      "previous_value": "https://(old)", "new_value": "https://(new)", "overwritten": true, "event": { ... } }
  ]
}
```

---

## 4. 운영 모드 차단

이 API는 **노출용(display) 대회**에서만 동작합니다.
운영용(operation) 대회 종목 ID로 호출하면 `404 NOT_DISPLAY_MODE`가 반환됩니다.

매 대회마다 PACE RISE에서 노출용 대회를 새로 생성하므로,
OpenClaw 측에서는 대회별 `competition_id`를 갱신해 주세요. (검색 API로 매번 ID를 찾아도 됩니다.)

---

## 5. OpenClaw 추천 워크플로우

연맹 사이트에서 단일 토너먼트가 PACE RISE에는 여러 종목으로 매핑되는 경우가 일반적입니다.
대회명/종목명 표기가 달라도 `division` 부분 일치와 `name` 부분 일치를 적절히 조합하면 매칭됩니다.

```
1) 대회 시작 전, 관리자에서 키 발급 (전용 대회 ID 지정 권장)
2) OpenClaw가 연맹 페이지에서 결과 링크 스크래핑
3) GET  /api/external/events/search?competition_id=31&name=100m&division=선수권&gender=M&round_type=final
4) (필요 시) GET /api/external/event/:id 로 종목 정보 재확인
5) POST /api/external/event-result-link  with dry_run=true 로 검증
6) 검증 OK 면 dry_run 빼고 본 호출
7) 묶음 처리할 거면 batch 엔드포인트 사용
```

### cURL 예시

```bash
# 1) 검색
curl -H "X-API-Key: $KEY" \
  "https://www.pace-rise-node.com/api/external/events/search?competition_id=31&name=100m&division=%EC%84%A0%EC%88%98%EA%B6%8C"

# 2) 저장 (dry_run)
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"event_id":12345,"url":"https://www.kafa.or.kr/result/abc","dry_run":true}' \
  "https://www.pace-rise-node.com/api/external/event-result-link"

# 3) 본 저장
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"event_id":12345,"url":"https://www.kafa.or.kr/result/abc"}' \
  "https://www.pace-rise-node.com/api/external/event-result-link"

# 4) 배치
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"items":[{"event_id":12345,"url":"https://a"},{"event_id":12346,"url":"https://b","force":true}]}' \
  "https://www.pace-rise-node.com/api/external/event-result-link/batch"
```

### Python 예시

```python
import requests

API_BASE = "https://www.pace-rise-node.com"
API_KEY  = "pkr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
HEADERS  = {"X-API-Key": API_KEY, "Content-Type": "application/json"}

# 1) 검색
r = requests.get(f"{API_BASE}/api/external/events/search",
                 params={"competition_id": 31, "name": "100m", "division": "선수권"},
                 headers=HEADERS, timeout=15)
events = r.json()["items"]

# 2) 단건 저장 (dry_run으로 먼저 검증 후 실제 저장)
for e in events:
    payload = {"event_id": e["id"], "url": "https://www.kafa.or.kr/result/abc"}
    dry = requests.post(f"{API_BASE}/api/external/event-result-link",
                        json={**payload, "dry_run": True}, headers=HEADERS).json()
    if not dry.get("ok"):
        print("dry-run failed:", dry); continue
    res = requests.post(f"{API_BASE}/api/external/event-result-link",
                        json=payload, headers=HEADERS).json()
    print(res)

# 3) 배치 저장 (한 번에 최대 100건)
items = [{"event_id": e["id"], "url": f"https://www.kafa.or.kr/result/{e['id']}"} for e in events[:50]]
batch = requests.post(f"{API_BASE}/api/external/event-result-link/batch",
                      json={"items": items}, headers=HEADERS).json()
print("applied:", batch["applied"], "failed:", batch["failed"])
```

---

## 6. 보안 메모

- 키는 bcrypt 해시로만 DB에 저장되며, **발급 시 1회만 평문으로 표시**됩니다.
- 회수(`revoked_at`)된 키는 즉시 무효화됩니다.
- 모든 요청은 `external_api_log` 테이블에 자동 기록됩니다 (엔드포인트, IP, UA, 응답 상태, 소요 시간).
- 분당 호출 한도(슬라이딩 윈도우, 메모리)를 초과하면 `429 RATE_LIMITED` 반환.

---

## 7. 관리 엔드포인트 (관리자 전용)

`admin_key`(관리자 비밀번호)가 필요하며, **관리자 UI(`/admin.html` → 외부 API 탭)에서 호출됩니다**.

| Method | Path                                    | 설명 |
|--------|-----------------------------------------|------|
| POST   | `/api/admin/external-keys`              | 키 발급 (응답 1회 평문 노출) |
| GET    | `/api/admin/external-keys`              | 키 목록 |
| POST   | `/api/admin/external-keys/:id/revoke`   | 키 회수 |
| GET    | `/api/admin/external-keys/logs`         | 호출 로그 조회 (`?api_key_id=`, `?limit=`) |
