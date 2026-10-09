# 계측 파일 자동 취합 워처 (2026-10-09, C1)

계측 PC(FinishLynx 등)의 결과 폴더를 지켜보다가 새 `.lif` / `.txt` 파일이 생기면 서버에 올려 결과를 넣는다. 서버의 미리보기·매칭·적용 API(`/api/scoreboard/preview|import`, `/api/timing-txt/import`)를 그대로 쓰므로 매칭 규칙은 관리자 화면에서 손으로 올릴 때와 같다.

## 설치·실행 (계측 PC, Node 18 이상)
```bash
# 저장소를 받거나 scripts/timing-watcher/watch.js 한 파일만 복사해도 된다 (외부 패키지 없음)
node scripts/timing-watcher/watch.js --dir "C:\Lynx\Results" --server https://pace-rise-node.com --key <운영키> --comp 63
# 또는 npm run timing-watch -- --dir ... --server ... --key ... --comp ...
```
| 옵션 | 환경변수 | 뜻 |
|---|---|---|
| `--dir` | `PACE_WATCH_DIR` | 감시할 폴더 (필수) |
| `--server` | `PACE_SERVER` | 서버 주소 (기본 http://localhost:3000) |
| `--key` | `PACE_KEY` | 운영키 — 관리자 › 계정·키 › 심판 운영키에서 **"계측 PC" 전용 키를 하나 발급**해 쓰면 로그에 누가 올렸는지 남고 회수도 쉽다 |
| `--comp` | `PACE_COMP` | 대회 id |
| `--mode auto\|confirm` | `PACE_WATCH_MODE` | auto(기본): 모두 매칭되면 바로 적용 / confirm: 미리보기만 하고 review/ 로 |
| `--interval` | `PACE_WATCH_INTERVAL` | 폴더 스캔 주기(초, 기본 3) |
| `--once` | | 지금 있는 파일만 처리하고 종료 |
| `--notify-url` | `PACE_NOTIFY_URL` | 실패·확인 필요 때 `{text}` JSON 을 POST 할 웹훅(슬랙 등) |
| `--host` | `PACE_HOST` | 조직 서브도메인으로 올릴 때 Host 헤더 (예: `jp.pace-rise-node.com`) |

## 동작
1. 파일 크기가 1초 동안 그대로면(다 써졌으면) 미리보기 API 로 올린다.
2. **auto 모드**: 모든 파일이 조에 매칭되고(전광판 키·합동 키·구조 매칭), 후보가 둘 이상이 아니고, 선수 미매칭이 없으면 적용 API 로 올린다 → `done/`. 하나라도 걸리면 적용하지 않고 `review/` 로 옮기고 사유를 `.log` 에 남긴다(웹훅 알림).
3. **confirm 모드**: 항상 `review/` 로. 관리자가 화면(가져오기 › 계측)에서 확인 후 올린다.
4. 서버 오류·연결 실패는 `failed/` + `.log`.
같은 파일을 두 번 올려도 기록은 덮어쓰기(멱등)라 안전하지만, 워처는 처리한 파일을 옮기므로 보통 한 번만 올라간다.

## 자주 걸리는 것
- "조를 못 찾음": `.lif` 머리글의 종목 이름이 조의 **전광판 키**와 다르다 → 관리자 › 종목 › 조 탭에서 키를 맞추거나, 계측 PC 의 종목 이름을 `남자 100m 예선 1조` 형식으로.
- "후보 조가 둘 이상": 성별·부가 라벨에 없어 두 종목이 걸림 → 라벨에 성별(남자/여자)과 부를 넣는다.
- 종료된 대회에는 운영키로 못 올린다(관리자 키만).
