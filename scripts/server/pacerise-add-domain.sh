#!/usr/bin/env bash
# 조직 서브도메인/전용 도메인 열기 (멀티테넌시 운영 작업, 2026-10-12) — 운영 서버(EC2, nginx + certbot)에서 sudo 로 실행
#   sudo pacerise-add-domain demo.pace-rise-node.com        # 또는 results.some-federation.jp
#   1) DNS 가 이 서버를 가리키는지 확인 → 2) HTTP(인증용) 서버 블록 → 3) Let's Encrypt(webroot, 자동 갱신 가능) → 4) HTTPS 블록(공용 proxy 스니펫) → reload
#   전제: DNS 에 그 이름의 A 레코드(또는 *.pace-rise-node.com 와일드카드)가 이 서버 IP 로 있어야 한다. 와일드카드 인증서는 안 쓴다(가비아 DNS 는 API 가 없어 자동 갱신 불가) — 이름마다 인증서 1장.
set -euo pipefail
FQDN="${1:-}"; [ -n "$FQDN" ] || { echo "사용: sudo $0 <도메인>"; exit 2; }
[[ "$FQDN" =~ ^[a-z0-9.-]+$ ]] || { echo "도메인 형식이 아닙니다: $FQDN"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "sudo 로 실행하세요"; exit 2; }
SNIPPET=/etc/nginx/snippets/pacerise-proxy.conf
WEBROOT=/var/www/letsencrypt
CONF=/etc/nginx/sites-available/pacerise-org-$FQDN
EMAIL=${LE_EMAIL:-info@pace-rise.com}
MYIP=$(curl -s -m 5 https://checkip.amazonaws.com || true)

# 공용 proxy 스니펫 — sites-available/pacerise 의 location 두 개와 같다 (한 곳만 고치면 조직 도메인 전부에 적용)
if [ ! -f "$SNIPPET" ]; then
cat > "$SNIPPET" <<'EOS'
# PACE RISE : Node — 조직 도메인 공용 proxy (pacerise-add-domain.sh 가 만든다)
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_cache_bypass $http_upgrade;
    proxy_read_timeout 86400;
}
EOS
echo "→ 스니펫 생성 $SNIPPET"
fi
mkdir -p "$WEBROOT"

# 1) DNS 확인
DNSIP=$(dig +short "$FQDN" A | tail -1 || true)
if [ -z "$DNSIP" ]; then echo "✖ DNS 에 $FQDN 이 없습니다. 가비아 DNS 에 A 레코드(또는 * 와일드카드)를 $MYIP 로 먼저 넣고 몇 분 뒤 다시 실행하세요."; exit 3; fi
if [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then echo "✖ $FQDN → $DNSIP 인데 이 서버는 $MYIP 입니다. DNS 를 확인하세요."; exit 3; fi
echo "✓ DNS $FQDN → $DNSIP"

# 2) 인증용 HTTP 블록 (이미 인증서가 있으면 건너뛴다)
if [ ! -f "/etc/letsencrypt/live/$FQDN/fullchain.pem" ]; then
cat > "$CONF" <<EOS
server {
    listen 80;
    server_name $FQDN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}
EOS
ln -sf "$CONF" "/etc/nginx/sites-enabled/pacerise-org-$FQDN"
nginx -t && systemctl reload nginx
# 3) 인증서 — webroot 방식이라 certbot.timer 가 자동 갱신한다
certbot certonly --webroot -w "$WEBROOT" -d "$FQDN" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
fi

# 4) HTTPS 블록
cat > "$CONF" <<EOS
# 조직 도메인 $FQDN — pacerise-add-domain.sh ($(date +%F))
server {
    listen 80;
    server_name $FQDN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $FQDN;
    ssl_certificate /etc/letsencrypt/live/$FQDN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$FQDN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    include $SNIPPET;
}
EOS
ln -sf "$CONF" "/etc/nginx/sites-enabled/pacerise-org-$FQDN"
nginx -t && systemctl reload nginx
echo "✓ 열림: https://$FQDN  — 확인: curl -s https://$FQDN/api/org"
