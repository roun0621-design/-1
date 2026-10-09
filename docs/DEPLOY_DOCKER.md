# 배포 — 컨테이너·서브도메인(조직) 운영 (2026-10-09)

지금 운영(EC2 + PM2 + nginx + RDS PostgreSQL)은 그대로 둔다. 이 문서는 ① 조직(서브도메인)을 열 때 nginx·DNS 에 손댈 것, ② 리전을 하나 더 올리거나 고객 요구로 격리 설치할 때 쓰는 Docker 이미지를 적는다.

## 1. 조직 서브도메인 열기 (지금 서버에서 바로 할 것)
조직은 `jp.pace-rise-node.com` 처럼 **첫 라벨 = 조직 slug** 로 구분된다(`lib/org.js`). 전용 도메인은 조직 설정의 `custom_domain` 에 적으면 된다.

1. **DNS**: `*.pace-rise-node.com` A 레코드 → 서버 IP (또는 ALB). 전용 도메인은 그 도메인의 A/CNAME 을 서버로.
2. **인증서**: 와일드카드는 DNS-01 챌린지로만 발급된다.
   ```bash
   sudo certbot certonly --manual --preferred-challenges dns -d pace-rise-node.com -d '*.pace-rise-node.com'
   # 또는 Route53 플러그인: certbot certonly --dns-route53 -d pace-rise-node.com -d '*.pace-rise-node.com'
   ```
3. **nginx** `server_name` 에 와일드카드 추가. 앱은 `Host` 헤더로 조직을 고르므로 `proxy_set_header Host $host;` 가 반드시 있어야 한다.
   ```nginx
   server {
       listen 443 ssl http2;
       server_name pace-rise-node.com *.pace-rise-node.com;
       ssl_certificate     /etc/letsencrypt/live/pace-rise-node.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/pace-rise-node.com/privkey.pem;
       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Host $host;                 # ← 조직 선택에 필수
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade $http_upgrade;       # /ws/scoreboard
           proxy_set_header Connection "upgrade";
       }
   }
   server { listen 80; server_name pace-rise-node.com *.pace-rise-node.com; return 301 https://$host$request_uri; }
   ```
4. **.env**(선택): `COOKIE_DOMAIN=.pace-rise-node.com` 을 두면 플랫폼 관리자가 조직 주소를 옮겨 다닐 때 다시 로그인하지 않는다. 비우면 주소마다 따로 로그인(기본).
5. 확인: `curl -H 'Host: jp.pace-rise-node.com' https://pace-rise-node.com/api/org` → `{"slug":"jp",...}`. 모르는 서브도메인은 기본 조직으로 떨어진다.

조직 만들기: 관리자(기본 조직 주소) › 시스템 › 조직 → 추가 → 그 주소로 들어가 같은 플랫폼 계정으로 로그인 → 계정 관리에서 그 조직의 관리자 계정 생성 → 연맹·기록표·상장 양식·문자 설정을 그 조직에서 채운다.

## 2. Docker 이미지
```bash
docker build -t pacerise .                       # node:22-bookworm-slim + canvas 라이브러리 + Noto CJK 글꼴
docker compose up -d app                         # SQLite (볼륨 pacerise-db)
docker compose --profile pg up -d                # PostgreSQL 16 포함 (.env: DB_BACKEND=postgres, DATABASE_URL=postgres://pacerise:...@postgres:5432/pacerise)
curl -fsS localhost:3000/api/health
```
- 이미지 하나로 모든 조직을 돌린다. **고객마다 이미지를 나누지 않는다.** 리전(EU 등)에 올릴 때만 같은 이미지를 한 벌 더.
- 볼륨 3개: `db/`(SQLite 파일), `public/uploads/`(로고·상장 이미지), `backups/`. PG 를 쓰면 `db/` 볼륨은 비어 있어도 된다.
- 비밀값은 전부 `.env`(`ADMIN_PW`, `OPERATION_KEY`, `JWT_SECRET`, `DATABASE_URL`, `BACKUP_S3_*`, `ANTHROPIC_API_KEY`). 이미지에 굽지 않는다(`.dockerignore` 가 `.env` 를 뺀다).
- `TRUST_PROXY=1` 기본 — 앞에 nginx·ALB 가 하나 있는 구성. 직접 노출하면 `false`.
- 업데이트: `docker compose build && docker compose up -d app` (기존 PM2 배포는 `scripts/deploy.sh` 그대로).

## 3. 아직 안 한 것 (고객이 생기면)
- 과금·플랜·셀프 가입(조직 생성은 플랫폼 관리자만), 조직별 리소스 한도.
- 리전별 배포 자동화(CI 에서 이미지 빌드 → 리전 레지스트리).
