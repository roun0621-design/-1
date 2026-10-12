# PACE RISE : Node — Public Read API v1 (2026-10-12)

전광판 제조사·방송 그래픽·외부 결과 사이트가 대회 데이터를 **읽기만** 하는 API. 필드 이름과 모양을 고정하고(`v1`) 버전을 올릴 때만 바꾼다. 쓰기(결과 링크 등록)는 기존 `docs/EXTERNAL_API.md`.

- Base URL: `https://pace-rise-node.com` (조직 서브도메인이면 그 호스트)
- 인증: `X-API-Key: pkr_…` — 관리자 › 계정·키 › **외부 API** 에서 발급. 키는 발급한 조직의 대회만, `allowed_competition_id` 가 있으면 그 대회만. 분당 한도(`X-RateLimit-Limit` / `X-RateLimit-Remaining`), 모든 호출은 외부 API 로그에 남는다.
- 명세: `GET /api/v1/openapi.json` (키 없이) — OpenAPI 3.0, Swagger UI 등에 바로 넣을 수 있다.
- 응답: `{ "success": true, "data": …, "meta": { "version": "v1", "generated_at": "…", "count": n } }` / 오류 `{ "success": false, "error_code": "…", "message": "…" }` (401 키 없음 · 403 키 무효/회수/만료/범위 밖 · 404 없음 · 429 한도)
- 개인정보(생년월일·연락처)는 어떤 경로로도 나가지 않는다.

| 경로 | 뜻 |
|---|---|
| `GET /api/v1/competitions` | 이 키의 조직 대회 목록(홈 숨김 제외, 최근 순) |
| `GET /api/v1/competitions/{id}` | 대회 + `event_count`, `athlete_count` |
| `GET /api/v1/competitions/{id}/events` | 종목: `code`(사전 코드 `100m`, `LJ`…), `name_en`, `gender`, `division`, `category`, `round`, `round_status`, `heat_count`, `entry_count`, `entry_standard`, `target_time`, `height_progression`, `wind_affected` |
| `GET /api/v1/competitions/{id}/athletes` | 선수: `bib`, `name`, `family_name`, `given_name`, `name_alt`, `team`, `gender`, `grade`, `personal_best`, `season_best` |
| `GET /api/v1/competitions/{id}/results/latest?limit=10` | 결과가 가장 최근에 바뀐 **완료 종목**들의 순위표(전광판 '최근 결과' 용) |
| `GET /api/v1/events/{id}` | 종목 상세 |
| `GET /api/v1/events/{id}/startlist` | 조별 스타트리스트: `heats[{ heat_number, scheduled_at, wind, entries[{ lane, bib, name, team, status, personal_best, season_best }] }]` |
| `GET /api/v1/events/{id}/results` | 순위표 — **상장·기록지와 같은 순위 규칙**(동률 같은 순위, DQ/DNS/DNF/NM 은 `rank: null`, `status` 에 코드) |

### 순위표 행 (`ResultRow`)
```json
{ "rank": 2, "heat_rank": 1, "entry_id": 318, "athlete_id": 77, "bib": "12", "name": "홍길동", "team": "서울시청",
  "heat_id": 51, "heat_number": 2, "lane": 4, "status": null, "status_label": null,
  "mark": "10.80", "time_seconds": 10.8, "wind": 1.2 }
```
- 트랙·도로·릴레이: `time_seconds`(초) + `mark`(`10.80`, `1:45.30`, `2:10:05.00`)
- 필드: `distance_meters`(높이뛰기는 통과 높이) + `mark`(`7.80m`)
- 종합: `points` + `mark`(`4123점`)
- 라벨(`*_label`)은 영문. 한국어·일본어 라벨이 필요하면 코드로 직접 매핑한다(`lib/labels.js` 사전과 같음).

### 예시
```bash
curl -H "X-API-Key: pkr_xxx" https://pace-rise-node.com/api/v1/competitions
curl -H "X-API-Key: pkr_xxx" https://pace-rise-node.com/api/v1/competitions/63/results/latest?limit=3
curl -H "X-API-Key: pkr_xxx" https://pace-rise-node.com/api/v1/events/1021/results
```
전광판은 보통 ① `competitions/{id}/events` 로 종목 목록을 받아 두고 ② 진행 중인 종목의 `startlist` ③ 완료되면 `results` 를 5~10초 간격으로 읽는다(분당 한도 안에서). 실시간 푸시가 필요하면 WebSocket `/ws/scoreboard`(`SCOREBOARD_API_GUIDE.md`).

구현: `lib/routes/public_v1.js` (인증·범위·로그는 `externalApiAuth`/`_checkCompetitionScope` 공용, 순위는 `getEventResultsForCert`). 테스트 `tests/api/64_public_v1.test.js`.
