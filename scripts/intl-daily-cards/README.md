# 국제대회 데일리 카드 (인스타 1080×1350)

한국 선수 **결과 다이제스트**와 **오늘의 출전** 카드를 만든다. 표지 1장 + 목록 1~2장(캐러셀).

```bash
S=<작업 폴더>   # sqlite 스냅샷·JSON·page.html 이 놓일 곳
# 1) 공식 API 를 지금 시점으로 동기화한 로컬 DB (운영 DB 를 건드리지 않는다)
sqlite3 <스냅샷.db> ".backup $S/intl_daily.db" && node cards_sync.js $S/intl_daily.db      # nr.json(한국기록) 도 같은 폴더에
SQLITE_PATH=$S/intl_daily.db PORT=3199 INTL_SYNC=off node server.js &                          # 임시 서버
curl -s localhost:3199/api/competitions/2/roster > $S/roster.json
curl -s "localhost:3199/api/events?competition_id=2" > $S/events.json
# 2) 결과 카드 (여러 날 묶기 가능)
node gen.js results 2026-09-23,2026-09-24,2026-09-25 "한국 선수 결과 1~3일차" day1-3_결과 && node render.js ~/Desktop/아시안게임_데일리
# 3) 출전 예정 카드 (스타트 리스트 PB 순번 RANK 포함)
node day_sched.js 2026-09-26 > $S/day4.json
node gen.js schedule 2026-09-26 $S/day4.json day4_0926_출전예정 && node render.js ~/Desktop/아시안게임_데일리
```
- gen.js 는 `../roster.json`, `../events.json`(자기 폴더의 상위) 를 읽는다 → 스크립트를 `$S/daily/` 에 복사해 두고 돌린다.
- 규칙: 라운드 색(예선 파랑·준결승 주황·결승 빨강), 우측 열 순서 = PB/SB · 진출/탈락 · 순위 · 기록(우측 정렬), 계주는 `혼성 4X400mR` + 주자 줄, 같은 기록 재현은 `=PB`, 7종·10종은 한 줄(Day N), 푸터는 스토어 배지 + 주소만, 페이지 번호 없음.
