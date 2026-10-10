#!/usr/bin/env bash
# 계측 에이전트 실행 파일 묶기 (2026-10-10)
#   scripts/timing-watcher/watch.js 를 @yao-pkg/pkg 로 Windows(x64)·macOS(arm64) 실행 파일로 만들고,
#   계측 PC 에 폴더째 복사하면 되는 꾸러미(dist/timing-agent/<os>/)를 만든 뒤 zip 으로 묶는다.
#   사용: bash scripts/timing-watcher/build-agent.sh [win|mac|all]   (기본 all)  → dist/timing-agent/PaceRise-TimingAgent-win.zip 등
#   pkg 는 처음 한 번 Node 런타임(약 40MB)을 내려받는다 (~/.pkg-cache).
set -euo pipefail
cd "$(dirname "$0")/../.."
WHICH="${1:-all}"
OUT=dist/timing-agent
SRC=scripts/timing-watcher
VER=$(node -e "console.log(require('./$SRC/watch.js').AGENT_VERSION)")
rm -rf "$OUT"; mkdir -p "$OUT"

bundle() {   # $1 os (win|mac)  $2 pkg target  $3 exe 이름
    local os="$1" target="$2" exe="$3" dir="$OUT/$1/PaceRise-TimingAgent"
    mkdir -p "$dir/inbox"
    npx --yes @yao-pkg/pkg@6 "$SRC/watch.js" --targets "$target" --output "$dir/$exe" --compress GZip
    node -e "const W=require('./$SRC/watch.js'); require('fs').writeFileSync('$dir/config.json', JSON.stringify(W.CONFIG_TEMPLATE, null, 2)+'\n')"
    cp "$SRC/agent-README.txt" "$dir/README.txt"
    touch "$dir/inbox/여기에 결과 파일(lif, txt)을 넣으세요.txt.keep"
    if [ "$os" = win ]; then
        cp "$SRC/win/시작.bat" "$SRC/win/자동시작 등록.bat" "$SRC/win/자동시작 해제.bat" "$dir/"
    else
        cp "$SRC/mac/start.command" "$dir/"; chmod +x "$dir/start.command"
    fi
    (cd "$OUT/$os" && rm -f "../PaceRise-TimingAgent-$os-v$VER.zip" && zip -qr "../PaceRise-TimingAgent-$os-v$VER.zip" "PaceRise-TimingAgent")
    echo "→ $OUT/PaceRise-TimingAgent-$os-v$VER.zip"
}

case "$WHICH" in
    win) bundle win node22-win-x64 PaceRise-TimingAgent.exe ;;
    mac) bundle mac node22-macos-arm64 PaceRise-TimingAgent ;;
    all) bundle win node22-win-x64 PaceRise-TimingAgent.exe; bundle mac node22-macos-arm64 PaceRise-TimingAgent ;;
    *) echo "사용: $0 [win|mac|all]"; exit 2 ;;
esac
