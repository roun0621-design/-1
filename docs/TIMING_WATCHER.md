# 계측 파일 자동 취합 — 워처 · 에이전트 (2026-10-09 C1, 에이전트 2026-10-10)

계측 PC(FinishLynx 등)의 결과 폴더를 지켜보다가 새 `.lif` / `.txt` 파일이 생기면 서버에 올려 결과를 넣는다. 서버의 미리보기·매칭·적용 API(`/api/scoreboard/preview|import`, `/api/timing-txt/import`)를 그대로 쓰므로 매칭 규칙은 관리자 화면에서 손으로 올릴 때와 같다.

## 계측 PC 에 두는 에이전트 (권장)
실행 파일 하나 + `config.json` + `inbox/` 폴더가 든 꾸러미. Node 설치가 필요 없다.
```bash
bash scripts/timing-watcher/build-agent.sh [win|mac|all]   # → dist/timing-agent/PaceRise-TimingAgent-win-v1.0.0.zip 등 (pkg 가 처음 한 번 Node 런타임을 내려받음)
```
꾸러미 내용: `PaceRise-TimingAgent.exe`(또는 mac 바이너리) · `config.json` · `inbox/` · `시작.bat` · `자동시작 등록.bat` / `자동시작 해제.bat` · `README.txt`(계측 담당자용 안내, 원본 `scripts/timing-watcher/agent-README.txt`).

계측 PC 에서: ① `config.json` 에 `key`(계측 PC 전용 운영키)와 `competition_id` 만 넣고 ② `시작.bat` 더블클릭 ③ FinishLynx 저장 폴더를 `inbox` 로 잡거나 파일을 `inbox` 에 넣는다. `자동시작 등록.bat` 을 한 번 실행하면 PC 를 켤 때 같이 뜬다(시작 프로그램 바로 가기).
- 설정 우선순위: 명령 인자 > 환경변수 > `config.json` > 기본값. `config.json` 이 없고 인자도 없으면 틀을 만들어 주고 끝난다.
- `dir` 을 비우면 실행 파일 옆의 `inbox/` 를 감시한다(없으면 만든다).
- 30초마다 `POST /api/timing-agent/ping` 으로 살아 있음·처리 건수를 보내고, 관리자 › 가져오기 › 계측 › .lif 카드 위에 **"계측 에이전트 ○○ 연결됨(n초 전) · 자동 모드 · 적용 a / 확인 필요 b / 실패 c"** 로 보인다(90초 넘게 핑이 없으면 '끊김'). 상태는 서버 메모리에만 있다.

## Node 로 직접 실행 (개발·임시)
```bash
node scripts/timing-watcher/watch.js --dir "C:\Lynx\Results" --server https://pace-rise-node.com --key <운영키> --comp 63
# 또는 npm run timing-watch -- --dir ... --server ... --key ... --comp ...
```
| 옵션 | 환경변수 | config.json | 뜻 |
|---|---|---|---|
| `--dir` | `PACE_WATCH_DIR` | `dir` | 감시할 폴더 (비우면 옆의 `inbox/`) |
| `--server` | `PACE_SERVER` | `server` | 서버 주소 (기본 http://localhost:3000, 꾸러미 틀은 https://pace-rise-node.com) |
| `--key` | `PACE_KEY` | `key` | 운영키 — 관리자 › 계정·키 › 심판 운영키에서 **"계측 PC" 전용 키를 하나 발급**해 쓰면 로그에 누가 올렸는지 남고 회수도 쉽다 |
| `--comp` | `PACE_COMP` | `competition_id` | 대회 id |
| `--mode auto\|confirm` | `PACE_WATCH_MODE` | `mode` | auto(기본): 모두 매칭되면 바로 적용 / confirm: 미리보기만 하고 review/ 로 |
| `--interval` | `PACE_WATCH_INTERVAL` | `interval` | 폴더 스캔 주기(초, 기본 3) |
| `--once` | | | 지금 있는 파일만 처리하고 종료 |
| `--notify-url` | `PACE_NOTIFY_URL` | `notify_url` | 실패·확인 필요 때 `{text}` JSON 을 POST 할 웹훅(슬랙 등) |
| `--host` | `PACE_HOST` | `host` | 조직 서브도메인으로 올릴 때 Host 헤더 (예: `jp.pace-rise-node.com`) |
| `--name` | `PACE_AGENT_NAME` | `name` | 관리자 화면에 보일 이 PC 이름 (기본 컴퓨터 이름) |
| `--ping-interval` | `PACE_PING_INTERVAL` | `ping_interval` | 상태 알림 주기(초, 기본 30) |

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
- 에이전트가 '끊김': 계측 PC 의 창이 닫혔거나 인터넷이 끊김. `시작.bat` 을 다시 실행.

## 서버 쪽
`lib/routes/timing_import.js` — `POST /api/timing-agent/ping`, `GET /api/timing-agent/status`(운영키 이상, 조직·대회별). 테스트 `tests/api/61_timing_watcher.test.js`.
