#!/usr/bin/env bash
#
# scripts/deploy.sh — 프로덕션(EC2) 배포 자동화 스크립트
#
# 사용:
#   ./scripts/deploy.sh                  # genspark_ai_developer 브랜치 배포
#   ./scripts/deploy.sh main             # main 브랜치 배포
#   FORCE_NPM_CI=1 ./scripts/deploy.sh   # 의존성 변경 의심 시 npm ci 강제
#
# 동작 순서:
#   1. 현재 작업트리 dirty 검사 → 더러우면 중단
#   2. git fetch + 변경된 파일 보기 → 표시
#   3. package.json 변경 감지 → 자동 npm ci --omit=dev
#   4. git pull
#   5. PM2 graceful restart (서버 부팅 self-check 통과해야만 살아남음)
#   6. 부팅 후 5초 대기 → /api/health 또는 HTTP 200 확인
#   7. 실패 시 직전 커밋으로 자동 롤백
#
# 종료 코드: 0=성공, 1=배포 실패, 2=롤백 후 실패
#

set -euo pipefail

# ─── 설정 ──────────────────────────────────────────────────────────────
BRANCH="${1:-genspark_ai_developer}"
PM2_APP="${PM2_APP:-pacerise}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/health}"
WAIT_AFTER_RESTART="${WAIT_AFTER_RESTART:-5}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$PROJECT_DIR"

# 색상 헬퍼
C_GREEN='\033[1;32m'; C_RED='\033[1;31m'; C_YELLOW='\033[1;33m'; C_BLUE='\033[1;34m'; C_OFF='\033[0m'
log()    { printf "${C_BLUE}[deploy]${C_OFF} %s\n" "$*"; }
ok()     { printf "${C_GREEN}[OK]${C_OFF}     %s\n" "$*"; }
warn()   { printf "${C_YELLOW}[WARN]${C_OFF}   %s\n" "$*"; }
err()    { printf "${C_RED}[ERR]${C_OFF}    %s\n" "$*" >&2; }

# ─── 1. 작업트리 dirty 검사 ───────────────────────────────────────────
log "1/7 작업트리 상태 확인..."
if [[ -n "$(git status --porcelain)" ]]; then
    err "uncommitted 변경 사항이 있습니다. 먼저 처리하세요:"
    git status --short
    exit 1
fi
ok "작업트리 깨끗함"

# ─── 2. fetch + 변경 표시 ────────────────────────────────────────────
log "2/7 git fetch + 변경 사항 표시..."
PREV_COMMIT=$(git rev-parse HEAD)
git fetch origin "$BRANCH" --quiet
NEW_COMMIT=$(git rev-parse "origin/$BRANCH")
if [[ "$PREV_COMMIT" == "$NEW_COMMIT" ]]; then
    ok "이미 최신 ($PREV_COMMIT). 배포할 변경 없음."
    exit 0
fi
echo "  배포 대상 커밋: $PREV_COMMIT → $NEW_COMMIT"
echo "  변경 파일:"
git diff --stat "$PREV_COMMIT" "$NEW_COMMIT" | sed 's/^/    /'

# ─── 3. package.json 변경 감지 + npm ci ───────────────────────────────
log "3/7 의존성 변경 감지..."
DEPS_CHANGED=0
if git diff --name-only "$PREV_COMMIT" "$NEW_COMMIT" | grep -qE '^(package\.json|package-lock\.json)$'; then
    DEPS_CHANGED=1
    log "  package.json/lock 변경 감지 → npm ci 필요"
fi
if [[ "${FORCE_NPM_CI:-0}" == "1" ]]; then
    DEPS_CHANGED=1
    log "  FORCE_NPM_CI=1 → npm ci 강제 실행"
fi

# ─── 4. git pull ──────────────────────────────────────────────────────
log "4/7 git pull..."
git pull origin "$BRANCH" --quiet
ok "pull 완료 (HEAD=$(git rev-parse --short HEAD))"

# ─── 5. npm ci (필요 시) ──────────────────────────────────────────────
if [[ "$DEPS_CHANGED" == "1" ]]; then
    log "5/7 npm ci --omit=dev 실행 (의존성 변경)..."
    if npm ci --omit=dev --silent; then
        ok "npm ci 완료"
    else
        err "npm ci 실패. 롤백합니다."
        git reset --hard "$PREV_COMMIT"
        exit 2
    fi
else
    log "5/7 의존성 변경 없음 — npm ci 스킵"
fi

# ─── 6. PM2 restart ───────────────────────────────────────────────────
log "6/7 PM2 restart $PM2_APP..."
pm2 restart "$PM2_APP" --update-env
ok "PM2 restart 신호 전송 완료"

# ─── 7. 헬스체크 ──────────────────────────────────────────────────────
log "7/7 ${WAIT_AFTER_RESTART}초 대기 후 헬스체크 ($HEALTH_URL)..."
sleep "$WAIT_AFTER_RESTART"

HEALTH_OK=0
for i in 1 2 3; do
    HTTP_CODE=$(curl -sS -o /tmp/_deploy_health.txt -w '%{http_code}' "$HEALTH_URL" || echo "000")
    if [[ "$HTTP_CODE" =~ ^(200|204)$ ]]; then
        HEALTH_OK=1
        break
    fi
    warn "헬스체크 시도 $i/3 실패 (HTTP $HTTP_CODE). 2초 후 재시도..."
    sleep 2
done

if [[ "$HEALTH_OK" == "1" ]]; then
    ok "헬스체크 통과 ✓"
    echo
    printf "${C_GREEN}════════════════════════════════════════════${C_OFF}\n"
    printf "${C_GREEN}  배포 성공 — $(git rev-parse --short HEAD)${C_OFF}\n"
    printf "${C_GREEN}════════════════════════════════════════════${C_OFF}\n"
    echo
    echo "  PM2 상태:"
    pm2 status | grep -E "^│ id|$PM2_APP" || true
    echo
    echo "  부팅 로그 (최근 20줄):"
    pm2 logs "$PM2_APP" --lines 20 --nostream | tail -25
    exit 0
else
    err "헬스체크 실패 — 자동 롤백 시작"
    git reset --hard "$PREV_COMMIT"
    if [[ "$DEPS_CHANGED" == "1" ]]; then
        warn "  의존성도 롤백 (npm ci 재실행)"
        npm ci --omit=dev --silent || true
    fi
    pm2 restart "$PM2_APP" --update-env
    sleep "$WAIT_AFTER_RESTART"
    err "롤백 완료 (HEAD=$PREV_COMMIT). 로그 확인:"
    echo "  pm2 logs $PM2_APP --err --lines 40 --nostream"
    exit 2
fi
