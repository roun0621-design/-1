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
- 대시보드 히어로 카드 오른쪽 버튼이 `전체 시간표 | 대표팀 명단` 으로 나뉜다(관심 국가가 있는 대회만, 폰에서는 위아래로 쌓임). 명단 창은 다음 경기 순, 종목을 누르면 엔트리/결과 창.
