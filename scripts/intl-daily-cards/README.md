# 국제대회 데일리 카드 (인스타 1080×1350, 표지 1장 + 목록 1~2장)

운영 서버 API(대회 63)에서 바로 읽으므로 로컬 DB·임시 서버 필요 없음. 이 저장소 + Node + puppeteer(저장소 devDependency)만 있으면 어느 맥에서든 된다.

```bash
cd scripts/intl-daily-cards
node fetch.js                                   # roster.json · events.json → work/
# 그날 결과 (여러 날 묶기 가능)
node gen.js results 2026-09-26 "한국 선수 결과 4일차" day4_결과 && node render.js ~/Desktop/아시안게임_데일리
# 다음날 출전 예정 (스타트 리스트 PB 순번 RANK 포함)
node day_sched.js 2026-09-27 > work/day5.json
node gen.js schedule 2026-09-27 work/day5.json day5_0927_출전예정 && node render.js ~/Desktop/아시안게임_데일리
```
- 환경변수: `BASE`(기본 https://pace-rise-node.com) · `COMP`(기본 63) · `DATA`(기본 ./work) · `DAY1`(기본 2026-09-23)
- 산출물 이름: `<접두>_0.png`(표지) `_1.png` `_2.png`… 캐러셀 순서대로 올린다. 캡션은 결과 요약 3~4줄 + 해시태그.
- 규칙(사용자 확정): 표지 = `PACE RISE : Node` 크게 / 태극기 + 대회명 · 대한민국 / 제목. 라운드 색(예선 파랑·준결승 주황·결승 빨강). 결과 줄 우측 열 순서 = PB/SB · 진출/탈락 · 순위(결승 1~3위 메달 원) · 기록(우측 정렬). 계주 `혼성 4X400mR` + 주자 줄. 같은 기록 재현은 `=PB`. 7종·10종은 한 줄(Day N + 세부 시간). 출전 카드 우측은 `RANK n/N`(조 기준, 아래 전체 순번·레인), 상위 3 초록. 푸터는 스토어 배지 + 주소만, 페이지 번호 없음.
- 검수: render.js 가 넘침(OVERFLOW)과 푸터 여백을 찍는다. 이름·종목 말줄임은 gen.js 열 폭(.row .ev 272px, 우측 열 52/106/84/136) 조정.
- 캡션 규칙(폰 기준): 한 줄 20자 안팎, 항목마다 빈 줄로 띄우고, 시각·종목 → 다음 줄에 선수명. 맨 아래 `👉 PACE RISE Node 앱` + 해시태그 두 줄. 예시 `캡션_예시.txt`.
