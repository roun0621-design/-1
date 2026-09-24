# 국제대회 동기화 (2026-09) — 공식 결과 API → Pace Rise

## 무엇
아시안게임·올림픽처럼 공식 결과 사이트가 따로 있는 대회를 **우리 양식**으로 보여준다. 심판 입력이 없고, 서버가 공식 API 를 읽어
일정·종목·조·엔트리·결과를 넣는다. 첫 대상: 2026 아이치·나고야 아시안게임 육상 (`results.asiangames2026.org`, Bornan 웹결과).

## 구조
- `lib/intl/bornan.js` — Bornan API 어댑터. 응답이 zlib 을 latin1 글자로 보내는 것을 푼다. 일정 유닛 키 `W.100M--------------.SFNL.000100--` = 성별.종목.라운드.조.
- `lib/intl/sync.js` — `setupStructure`(종목·라운드·세부종목·조·시간표) → `syncEntries`(선수=국가 소속, 계주 팀·주자) → `syncResults`(레인·기록·상태·풍속). 외부 키로 멱등.
- `lib/routes/intl.js` — `/api/admin/intl/:compId/{source,setup,sync,status,probe,athlete-info}` + 60초 스케줄러(경기 시각 −6h~+1h 창의 조만 읽음).
- 화면: 대시보드에 관심 국가(KOR) 배지 + '한국 선수' 필터, 결과 행에 한글 이름(name_alt)·PB·SB.

## 쓰는 법 (관리자 → 대회 설정 → 국제대회 동기화)
1. 대회를 만들고(연맹은 '국제대회' 같은 코드로) 카드에 `base=https://back.results.asiangames2026.org`, `champ=AG2026`, `disc=ATH`, `관심 국가=KOR`, `Referer=https://results.asiangames2026.org/` → **출처 저장**
2. **구조·엔트리 만들기** — 48종목·222조·시간표·선수 800명이 들어온다(30초 안팎). 일정이 바뀌면 '일정 다시'.
3. **선수 보조 정보** — xlsx(영문이름|reg, 한글이름, PB, SB) 올리면 한글 이름·PB·SB 가 붙는다. 이후 동기화는 이름을 덮지 않는다.
4. 대회 기간엔 스케줄러가 알아서 돈다. '지금 동기화'는 전체 조를 한 번 다시 읽는다.

## 결과 형식
대회 전에는 `results/<유닛키>` 가 `null` 이라 형식을 아직 모른다. `parseResults` 는 후보 키(Results/Partics…, Rank/Lane/Result/IRM/Wind/Qual/Record)를 넓게 보고,
못 읽은 조는 `sync_state.unknown` 에 모양을 남긴다(관리자 카드에 표시). 첫 결과(9/23 07:30 경보)가 나오면 `GET /api/admin/intl/:id/probe?unit=<키>` 로 원본을 보고 `parseResults` 를 맞춘다.


## 대표팀 명단 (2026-09-22)

- `GET /api/competitions/:id/roster[?team=KOR]` (공개) — 관심 국가 선수를 **선수 기준**으로 묶는다: 출전 종목마다 라운드·조 시각(배정된 조 → 없으면 종목 첫 조 → 시간표)·종목별 PB/SB·결과(동기화 결과 한 줄 또는 시도별 최고)·계주 멤버. 계주 멤버에게는 팀 종목이 `relay:true` 로 붙는다. `teams[]` 는 국가 팀 행.
- 대시보드 히어로 카드가 `시간표 | 대표팀 명단` 좌우 반쪽(홀짝 버튼)으로 갈린다 — 관심 국가가 있는 대회만, 일반 대회는 시간표 카드 한 장 그대로. 오른쪽 반쪽엔 인원수와 다음에 뛰는 우리 선수.
- 결과에는 조 안 순위(`place`, 동기록 같은 등수, 상태코드 제외)와 조 수(`heat_count`)가 붙는다 → 명단 창에서 결승 `3위 10.05`, 예선 `2조 3위`.
- 정렬 토글 `종목별 | 시간별`: 대시보드(시간별 = 날짜 묶음 + 다음 경기 시각순, 대회별 기억)와 명단 창(시간별 = 다음 경기 순 · 종목별 = WA 종목 순; 모든 종목이 끝나면 종목별이 기본) — 대시보드 토글은 모든 대회 공통.


## 엔트리 변경 추적 (2026-09-22)

- 엔트리 동기화(12시간마다 자동 · 관리자 '엔트리 다시')가 이제 **공식 명단에서 빠진 출전을 지운다**(조 배정·기록이 없을 때만; 있으면 남기고 표시) 하고, **계주 주자 명단을 공식 명단으로 맞춘다**(빠진 주자 삭제·새 주자 추가·순서 갱신). 예전엔 추가만 하고 기권을 반영하지 못했다.
- 결과: `sync_state.entries = { added, removed, relay_changed, changes[] }`, 우리 선수(관심 국가) 변경은 `entries_changes`(최근 30건)에 남아 관리자 카드에 '새 출전 / 빠짐 / 계주' 로 표시된다.
- 9/22 확인: 9/21 스냅샷 대비 한국 변경 없음, 외국 기권 9(IND·PLE·AFG·QAT·PHI)·추가 4(PHI 계주 3팀·IND 멀리뛰기)·계주 주자 변경 1.

## 공식 결과 → 라운드 완료 → 알림 (2026-09-22)
- `parseResults` 가 결과 JSON 의 `Status/StatusDesc/ResultStatus/…` 에서 **Official** 여부를 읽는다(`Unofficial` 은 아님). 공식 결과가 들어온 조는 `sync_state.heat_flags[heatId]='official'`, 종목의 모든 조가 공식이면 `round_status='completed'`(결과 버튼) → `onApplied({completed:true})` → `notifyEventInterest(event,{kind:'result'})` 로 관심 등록자에게 "○○ 결승 결과 발표" 푸시. 같은 종목은 6시간에 한 번만.
- 정확한 상태 키는 9/23 첫 결과(`probe`)로 확인해 후보 목록을 맞출 것. 키가 없으면 완료로 바뀌지 않으므로 관리자 force-status 로 수동 완료 가능.
- 관심 종목 키는 `성별|종목명`(라운드 무관). 대시보드: 카드의 종 아이콘은 없애고 엔트리·스타트 리스트·결과·LIVE 창 머리글의 `알림` 토글로, 대표팀 명단 창엔 '전 종목 알림'(우리 선수 종목 전부 한 번에). 흐름 테스트 `tests/api/49_push_interest_flow`.

## 스타트 리스트 · 외국 선수 PB/SB · 종목 기록 (2026-09-24)
- 공식 API 의 `results/<유닛>` 은 경기 전엔 `Info.Status='START_LIST'` 로 레인·배번을 준다 → 시작 36시간 전부터 10분마다 읽는다(`_startListChecked`). 명단이 아직 없는 조(`Scheduled`)는 '형식 미확인'에 넣지 않는다.
- 선수별 `Extensions[Code=PB|SB]` 를 출전(event_entry)의 PB/SB 로 채운다 — **비어 있을 때만**(우리 선수는 사용자 표 값 유지). `Bib` 도 배번이 비면 채움. `RecordInd`(GR/AR/WR…)는 결과 비고로.
- 종목 기록 `Results.Records[].Records[]`(WR·AR·GR)는 `event_records`(종목별 JSON) 의 `world/area/games` 에 저장(세부종목은 부모에). `GET /api/event-records/lookup?…&event_id=` 가 합쳐 주고, 결과·LIVE 창 '기존 기록' 줄과 신기록 배지(`detectBrokenRecordsClient` WR/AR/GR/NR/DR/CR)가 쓴다.
- 7종·10종: 부모 카드의 조·레인 수는 세부종목 합산(`events_read`), 스타트 리스트 창은 세부종목 조를 순서대로(`100mH 1조 …`), 명단 없는 조는 숨김.

## 7종·10종 (2026-09-24)
- 세부종목 조(`W.HEPTATH-----------.100H.000100--`)의 공식 결과가 오면 세부종목 결과와 함께 **부모(7종경기) 종합표(`combined_score`)** 에 기록·**공식 점수**(`Extensions.Points`)를 넣는다 — 우리 WA 점수표가 아니라 공식 점수. 부모는 첫 세부종목부터 `in_progress`(카드 LIVE → 기존 종합표 화면: 세부종목 칸·일차 점수·합계·선두/차이).
- 부모 완료(결과 버튼·메달·알림)는 **모든 세부종목이 공식 완료**됐을 때만. 세부종목 완료로는 알림이 나가지 않는다(`onApplied.completed` 는 부모 기준).
- 엔트리 동기화의 '빠진 출전 삭제'는 종합표 행이 있는 출전은 지우지 않는다.

## 일정 변경 반영 (2026-09-24)
- '일정 다시'(`setupStructure`)가 이제 **공식 일정에서 사라진 조·라운드를 지운다** — 남자 세단뛰기·높이뛰기·창던지기 예선이 직결 결승으로 바뀌고, 예선 8조가 4조로 줄어든 것 등. 명단(레인)·기록이 있는 조는 남긴다. 조가 없어진 라운드는 출전을 남은 라운드(결승)로 옮기고 시간표 행과 함께 지운다. `stats.removed_heats/removed_rounds` 에 개수.
- 9/24 실제: 조 92개·라운드 3개 정리, 출전 828 그대로.

## 우리 선수 진출·최종 순위 (2026-09-24)
- `lib/intl/placing.js spotStatus`: 관심 국가 선수의 라운드별 상태 — 예선·준결승 결과의 `Q/q`(비고) → `결승 진출`(준결승이 있으면 `준결승 진출`), 없으면 `예선 탈락`(회색), 결승 완료 → 최종 순위(1~3위 메달 원, 그 밖은 회색 `N위`). `/api/events` 의 `spot_status` 로 카드 태극기 옆 칩, 대표팀 명단 종목 줄에도.
- `GET /api/events/:id/spotlight`: 결과·LIVE 창 위 '한국 선수' 블록(조·레인·순위·전체 순위·기록·진출 종류) + 아래 '진출 규칙'(`QRules` → 한글) 과 진출자 명단(Q/q 전원). 규칙 문구는 조 결과의 `Results.Extensions[QRules]` 에서 `event_records.qrules` 에 저장.

## 기록 표시(NR·PB·SB)와 필드 시기표 (2026-09-24)
- 주최 측 API 는 한국기록·계주 팀 PB 를 관리하지 않는다(KOR 혼성 계주 3:18.66 에 `RecordInd`·`HasPB` 모두 빈 값). 그래서 `sync._recordFlags` 가 결과마다 판정해 비고(`result.remark`)에 `NR`·`PB`·`SB` 를 적는다(공식 GR·AR·WR 표시와 Q·q 는 그대로 함께).
  - **NR**: 관심 국가(KOR) 선수·팀만. 우리 기록표 `event_record(record_type='national')` 를 종목명 정규화로 찾아 비교(동률 포함). **공식 결과**면 기록표를 새 값·보유자·연도로 갱신하고 `record_breaking_log` 에 `approved`(reviewed_by `intl-sync`, review_note 끝에 `종전 값 · 보유자 · 연도`) 한 줄 — `/api/event-records/lookup?event_id=` 가 그 대회에서 세운 기록이면 `national.new_here`·`prev` 로 돌려준다. 7종·10종 세부종목은 제외, 풍속 +2.0 초과는 제외.
  - **PB/SB**: 기준은 같은 종목(이름·성별) 모든 라운드 출전의 PB/SB 중 최고(+개인 종목은 선수 표 값), 또는 주최 측 `HasPB/HasSB`. 공식 결과면 같은 종목 모든 라운드 출전의 PB/SB 를 갱신 → 결승 스타트 리스트·명단에 새 PB 가 바로 보인다. 다시 읽어 값이 PB 와 같아져도 태그는 유지(동률=PB).
- 화면: 기록 바로 오른쪽에 태그 **하나**(WR>AR>GR>NR>PB>SB, `placing.recordTag`) — 결과·LIVE 행, 한국 선수 블록, 대표팀 명단. 비고의 Q·q 는 하단 메타에 남는다. 줄을 늘리지 않는다.
- 필드 시기표: 결과 JSON 의 `Splits` 를 읽는다. 높이 `{Distance:'1.71', AttResult:'XO'}` → `height_attempt`(높이·시도별 O/X/-), 거리 `{Distance:'3', Result:'13.45'|'X'|'-'}` + `Wind` → `result`(시도별, 파울 0·패스 -1). 최고 기록은 그대로 `attempt_number NULL` 행. 화면은 시기표가 없어도 최고 기록만 있는 행을 읽는다.

## 경기 전 기록 방어 (2026-09-24)
- 9/24 남자 원반던지기: 시작 2시간 전 `START_LIST` 응답에 연습 투척 같은 값(20.91·27.71·37.17)이 잠깐 실려 와 우리 표에 들어가고 카드가 LIVE 로 떴다. 그 뒤 API 는 빈 값으로 돌아갔지만 우리는 지우지 않았다.
- 이제 `parseResults.status`(Info.Status)가 `START_LIST`/`SCHEDULED` 면 기록을 받지 않는다. 또 API 행에 기록이 없으면 그 출전의 우리 기록(시기 포함)을 지우고, 종목의 어느 조에도 기록이 없으면 `in_progress` → `created` 로 되돌린다. 배포 뒤 다음 읽기에서 자동 정리된다.
- 우리 선수 상태의 '다음 라운드'는 대회의 모든 라운드(event 표)로 판단 — 준결승에 아직 출전이 없어도 '준결승 진출'.
