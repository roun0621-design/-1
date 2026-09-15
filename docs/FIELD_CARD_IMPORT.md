# 필드 수기 기록카드 가져오기 (Field Record Card Import)

> 심판이 손으로 쓴 필드 기록카드 → 사진 → ChatGPT/Claude 전사(xlsx) → 관리자 페이지 드롭 → 미리보기(검산) → 저장.
> 태블릿 입력 없이 종이 카드만 쓰는 종목을 위한 경로. 코드: `lib/fieldCardImport.js`(파서·계산·검산), `lib/routes/field_card_import.js`(매칭·저장), `public/admin.html`(UI).

---

## 1. 운영 흐름

### 1-0. 기록 입력창에서 올리기 (기본 — 종목·조 고정)

기록 입력창(record.html)에서 필드 종목의 조를 열면 정렬 버튼 옆에 **📷 기록카드** 버튼이 있다 (`public/field-card-upload.js`).

1. 버튼을 누르면 업로드 창이 뜬다. 카드 사진을 **여러 장 차례로** 올리거나(멀리뛰기·세단뛰기는 기록표 + 풍속표), 카메라로 바로 찍거나, xlsx 를 고른 뒤 **전사 시작**.
2. 서버가 AI 로 전사하면서 종목·조를 이 화면으로 고정하고(카드의 종목명은 무시), 선수만 배번 → 순서 → 성명 순으로 맞춘다. 풍속 카드는 같은 선수 행에 합쳐진다.
3. 결과가 **편집 가능한 표**로 뜬다. 노란 칸은 AI 가 확신하지 못한 셀, 빨간 칸은 매칭 실패. 배번·성명·순서·기록·풍속·높이 마크·기록구분을 고치면 **자동으로 다시 매칭·검산**한다. 행 추가/삭제, 카드에 없는 선수 추가(칩 클릭)도 된다.
4. **저장**. 관리자 키 또는 운영키가 필요하고(없으면 입력창이 뜸), 대회가 종료되었으면 관리자만 저장할 수 있다.

서버 API: `POST /api/field-card/transcribe|preview` 에 `heat_id` 를 주면 조 고정 모드가 되고 편집용 `card` 를 함께 돌려준다. 편집 후에는 `POST /api/field-card/analyze-json` / `import-json` 에 `{ heat_id, card }` 를 보낸다.

### 1-1. 관리자 페이지에서 일괄 올리기 (사진 드롭 — 서버 AI 전사)

1. 경기 종료 후 기록실이 카드를 **정면에서 그림자 없이** 촬영한다. 멀리뛰기·세단뛰기는 기록표와 풍속표 두 장.
2. 관리자 페이지 → "필드 기록카드 가져오기" 드롭존에 사진을 끌어다 놓는다 (한 번에 4장까지). 브라우저가 긴 변 2,576px JPEG 로 줄여 올린다.
3. 서버가 Claude API(비전, 기본 `claude-opus-5`)에 사진과 전사 규칙을 보내고 **JSON 스키마로 강제한 응답**을 받는다. 보통 10~30초.
4. 응답을 xlsx 양식과 같은 시트로 바꿔 아래 xlsx 경로와 **완전히 같은 매칭·검산 미리보기**를 띄운다. AI 가 "판독 불확실"로 표시한 셀도 경고로 붙는다.
5. 경고 셀을 사진과 대조한 뒤 "기록 저장 실행". 값을 고쳐야 하면 **전사 결과 xlsx 를 내려받아** 엑셀에서 수정하고 다시 드롭한다.

서버 `.env` 에 `ANTHROPIC_API_KEY` 가 있어야 한다 (`.env.example` 참고). 키가 없으면 사진 전사만 503 으로 꺼지고 xlsx 업로드는 그대로 동작한다.
비용은 카드 1장에 약 100원(사진 ≤ 4,784 토큰 + 규칙 + 출력). 호출마다 opLog 에 토큰 수를 남긴다. 테스트 환경(NODE_ENV=test)에서는 실제 호출이 차단된다.
HEIC 사진은 브라우저(사파리 외)가 읽지 못하므로 아이폰은 "호환성 우선" 설정으로 촬영하거나 JPEG 로 변환한다.

### 1-2. xlsx 드롭 (수동 전사 / 수정 재업로드)

1. ChatGPT 또는 Claude 에 사진과 **AI 전사 프롬프트**(관리자 페이지 "AI 전사 프롬프트 복사" 버튼, `GET /api/field-card/prompt`)를 함께 넣어 xlsx 를 받는다.
2. 드롭존에 xlsx 를 끌어다 놓는다.
3. 미리보기에서 **경고(⚠)·오류(✕)가 난 셀부터** 종이 카드와 대조한다. 필요하면 xlsx 를 고쳐 다시 올린다.
4. "기록 저장 실행". 저장 후 기록 페이지(record.html)에서 한 번 더 대조한다.

미리보기는 DB 를 바꾸지 않는다. 저장은 관리자 키가 필요하다 (대회 종료 잠금은 관리자 전용이라 자동 충족).

## 2. 양식 3종

공통 규칙: **1행 헤더, 2행부터 선수 1명당 1행, 셀 병합 없음, 종별·세부종목·라운드·조는 매 행 반복.**
공통 8열: `종별 | 세부종목 | 라운드 | 조 | 순서 | 배번 | 성명 | 소속`

| 양식 | 시트 | 공통 8열 뒤 | 다운로드 |
|------|------|-------------|----------|
| 투척 (포환·원반·해머·창) | 기록 | `1차 2차 3차 4차 5차 6차 최고기록 순위 기록구분 비고` | `/api/field-card/template?kind=throw` |
| 수평도약 (멀리뛰기·세단뛰기) | 기록 + **풍속** | 기록 시트는 투척과 동일. 풍속 시트: `1차풍속 … 6차풍속` | `/api/field-card/template?kind=horizontal` |
| 수직도약 (높이뛰기·장대높이뛰기) | 기록 | 바 높이를 열 헤더로 (`1.55 1.60 …` 또는 `155 160 …`) + `최고기록 순위 기록구분 비고` | `/api/field-card/template?kind=vertical` |

- 헤더는 유연하게 인식한다: `1차`/`1차시기`/`1차(m)`, `1차 풍속(m/s)`, `배번`/`bib`, `순서`/`레인`, `성명`/`이름`/`선수명`, `소속`/`팀` 등.
- 풍속 열이 기록 시트 안에 `1차, 1차풍속, 2차, 2차풍속 …` 으로 섞여 있어도 된다.
- 여러 조·여러 종목이 한 파일에 있어도 된다 (종별·세부종목·라운드·조 조합으로 그룹화).
- 혼성경기 세부종목은 세부종목에 `10종 포환던지기` / `[7종] 높이뛰기` 처럼 상위 종목을 붙인다.

## 3. 셀 표기

| 구분 | 표기 | 저장 |
|------|------|------|
| 거리 유효 기록 | `36.20` (소수 둘째 자리) | `result.distance_meters = 36.20` |
| 파울 | `X` | `distance_meters = 0` |
| 패스 | `-` | `distance_meters = -1` |
| 시도 없음 (4~6차 미진출 등) | 빈칸 | row 없음 |
| 풍속 | `+0.8` `-0.9` `0.0` — **유효 시기에만**. 부호는 칸 앞에 인쇄된 +/- 중 심판이 **동그라미 친 쪽** (AI 프롬프트에 명시, 확신 없으면 + 로 적고 불확실 표시) | `result.wind` (파울·패스 시기는 NULL, 값이 있어도 무시) |
| 높이 시도 | `O` `XO` `XXO` `XXX` `-` `X-` `XX-` | `height_attempt` 에 시도별 1행 (`O`/`X`/`PASS`) |
| 기록구분 | `DNS` `DNF` `DQ` `NM` (순위 칸의 DNS 도 인식) | `result` 의 `attempt_number NULL` 행 `status_code` |
| 최고기록·순위 | 카드에 적힌 값 그대로 | **저장하지 않음** — 계산값과 대조만 |

- 전각 문자(`Ｘ`, `－`), 소문자 `x`, `×`, 쉼표 소수점(`36,20`), `36.20m` 도 받는다.
- 높이 셀의 숫자 `0` 은 `O` 로, 끝의 `r`(기권)은 무시한다.
- 기록구분 `R`(기권)은 지원하지 않는다 — 기록은 그대로 인정되므로 표시만 무시.
- `1~3차 최고기록`, `3차 후 순위/순서` 열은 옮기지 않는다 (상위 8명은 프로그램이 계산).

## 4. 검산 (AI 오독 탐지)

카드에는 시기별 기록 외에 최고기록과 순위가 적혀 있다. 이 값을 같이 옮기게 하고, 시기별 기록으로 다시 계산한 값과 대조한다.

| 경고 | 의미 |
|------|------|
| 최고기록 불일치: 카드 49.61 / 계산 49.60 | 시기 셀 중 하나가 잘못 읽혔을 가능성 |
| 순위 불일치: 카드 2 / 계산 3 | 이 선수 또는 다른 선수의 기록 오독 |
| N차 유효 기록에 풍속 없음 | 풍속 시트 누락·행 밀림 |
| 성명 불일치: 카드 "…" / DB "…" (배번 기준 매칭) | 배번 오독 가능성 — 배번이 우선 |
| 기록구분 NM 인데 유효 기록 있음 | NM 은 저장하지 않음 |

순위 계산은 record.html 과 같다: 거리는 최고기록 → 2번째 기록 → … (WA 동점 처리), 높이는 최고 높이 → 그 높이 실패 수 → 총 실패 수.
경고는 저장을 막지 않는다 (확인 후 저장은 운영자 판단). **오류(✕)** 행은 건너뛴다: 인식 불가 셀, 선수 매칭 실패, 같은 선수 중복 행, 종목/조 매칭 실패, 양식 불일치(높이 종목에 거리 양식 등).

## 5. 저장 규칙 (선수 단위 교체)

- 파일에 기록이 있는 선수만, 그 선수의 그 조 시기 전체를 파일대로 다시 쓴다 (기존 시기·기록구분 삭제 후 삽입, audit_log 에 `field-card` 로 기록).
- 빈 행, 파일에 없는 선수, 오류 행은 건드리지 않는다. → 3차 후 / 6차 후 두 번 올려도 된다.
- 선수 매칭: 배번 → 순서(lane_number) → 성명 순. 배번 앞자리 0 은 무시.
- 종목 매칭: 종별(성별·부) + 세부종목명 + 라운드 + 조. 조 번호가 없고 조가 하나뿐이면 그 조.
- 저장 후: `round_status` 자동 진행중 전환(기존 upsert 와 같은 opLog 포맷), `result_update`/`height_update` SSE, opLog `필드 기록카드 가져오기: {종목} {라운드} {성별} {조}조 — {n}명 입력`, 유효 시기에 대해 신기록 감지 훅(혼성 세부종목이면 종합점수 동기화 포함).

## 6. API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/field-card/template?kind=throw\|horizontal\|vertical` | 양식 xlsx (예시 행 + 설명 시트) |
| GET | `/api/field-card/prompt` | AI 전사 프롬프트 (text/plain) |
| POST | `/api/field-card/preview` | multipart `file`, `competition_id`, `admin_key`(또는 `x-admin-key`) → `{ groups:[{ label, kind, matchStatus, heatInfo, heights, issues, rows }], issues }` |
| POST | `/api/field-card/transcribe` | multipart `images`(≤4장, JPEG/PNG/WebP), `competition_id`, `admin_key`, 선택 `hint` → 미리보기와 같은 `groups/issues` + `xlsx_base64`, `xlsx_filename`, `transcription{ cards, model, usage, cost_usd, uncertain_cells, images, notes }`. 503 = 키 미설정, 422 = 카드 인식 실패/거부/응답 잘림, 502 = API 호출 실패 |
| POST | `/api/field-card/import` | 같은 입력 → `{ results:[{ label, imported, skipped, issues, rows }], issues }`. transcribe 응답의 xlsx 를 그대로 올리면 된다 |
| POST | `/api/field-card/analyze-json` | JSON `{ heat_id, competition_id?, admin_key, card }` → 조 고정 재매칭·재검산 `{ groups, issues, card, target }`. `groups[0].unmatched_entries` 는 카드에 없는 선수 |
| POST | `/api/field-card/import-json` | 같은 입력 → 저장 `{ results, issues }` |

`heat_id` 가 있는 요청은 관리자 키 또는 운영키(`admin_key` / `key` / `x-admin-key`)를 받는다. 없는 일괄 요청은 관리자 키만. 종료된 대회는 관리자만 저장(전역 종료 잠금 + `requireAdminAfterCompEnd`).
편집용 `card`: `{ kind:'distance'|'height', bar_heights:[], athletes:[{ order, bib, name, team, attempts[6], winds[6], marks[], best, rank, status, remark, uncertain[] }] }`.

`rows[]` 주요 필드: `attempts{n:{kind,value,wind,disp}}`, `marks{"1.55":"XO"}`, `computed{best,rank,bestWind}`, `card{best,bestNM,rank}`, `status`, `db{event_entry_id,name,bib,lane}`, `match_method`, `existing`, `changed`, `will_import`, `issues[{level,msg}]`.

## 7. 알려진 제한

- 높이뛰기 순위결정전(jump-off)은 모델이 없다. 카드 순위와 계산 순위가 다르면 경고가 뜨고, 필요하면 기록 페이지의 수동 순위로 정리한다.
- 트랙 종목 카드는 대상이 아니다 (기존 "기록 엑셀 가져오기" 또는 LIF 사용).
- 사진 전사의 정확도는 손글씨 상태에 달려 있다. 검산 경고와 "판독 불확실" 경고가 난 셀은 반드시 사진과 대조한다. 정밀도를 더 올려야 하면 모델이 셀 영역을 잘라 확대해 다시 보는 도구(crop tool)를 붙이는 것이 다음 단계다.
- 서버 전사 코드: `lib/fieldCardVision.js` (스키마·프롬프트·이미지 축소·호출), 라우트는 `lib/routes/field_card_import.js` 의 `/transcribe`. 모델은 `FIELD_CARD_MODEL` 로 바꿀 수 있다.

## 8. 테스트

- `tests/lib/fieldCardImport.test.js` — 토큰·헤더·풍속 병합·계산·검산·양식 자기 검증
- `tests/lib/fieldCardVision.test.js` — 이미지 축소, 요청 형태(구조화 출력·폴백), 오류 코드, 카드 JSON → 시트 변환 (가짜 클라이언트, 실제 호출 없음)
- `tests/api/31_field_card_import.test.js` — 투척/수평도약/수직도약/혼성 세부종목 미리보기·저장·재업로드·오류 처리
- `tests/api/32_field_card_transcribe.test.js` — 사진 → 전사(픽스처) → 미리보기 → xlsx → 저장, 403/400/503/422
- `tests/api/33_field_card_heat_mode.test.js` — 조 고정 모드: 운영키, 풍속 카드 병합, 배번 수정 재매칭, analyze-json/import-json, 종료 대회 잠금
