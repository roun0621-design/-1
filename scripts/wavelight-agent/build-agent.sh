#!/usr/bin/env bash
# WaveLight 에이전트 실행 파일 묶기 — 계측 에이전트(scripts/timing-watcher/build-agent.sh)와 같은 방식
#   scripts/wavelight-agent/agent.js 를 @yao-pkg/pkg 로 Windows(x64)·macOS(arm64) 실행 파일로 만들고,
#   WaveLight PC 에 폴더째 복사하면 되는 꾸러미(dist/wavelight-agent/<os>/)를 zip 으로 묶는다.
#   사용: bash scripts/wavelight-agent/build-agent.sh [win|mac|all]   (기본 all)
set -euo pipefail
cd "$(dirname "$0")/../.."
WHICH="${1:-all}"
OUT=dist/wavelight-agent
SRC=scripts/wavelight-agent
VER=$(node -e "console.log(require('./$SRC/agent.js').AGENT_VERSION)")
rm -rf "$OUT"; mkdir -p "$OUT"

bundle() {   # $1 os (win|mac)  $2 pkg target  $3 exe 이름
    local os="$1" target="$2" exe="$3" dir="$OUT/$1/PaceRise-WaveLightAgent"
    mkdir -p "$dir/wavelight"
    npx --yes @yao-pkg/pkg@6 "$SRC/agent.js" --targets "$target" --output "$dir/$exe" --compress GZip
    node -e "const A=require('./$SRC/agent.js'); require('fs').writeFileSync('$dir/config.json', JSON.stringify(A.CONFIG_TEMPLATE, null, 2)+'\n')"
    cp "$SRC/agent-README.txt" "$dir/README.txt"
    if [ "$os" = win ]; then
        cp "$SRC/win/시작.bat" "$dir/"
    else
        cp "$SRC/mac/start.command" "$dir/"; chmod +x "$dir/start.command"
    fi
    (cd "$OUT/$os" && rm -f "../PaceRise-WaveLightAgent-$os-v$VER.zip" && zip -qr "../PaceRise-WaveLightAgent-$os-v$VER.zip" "PaceRise-WaveLightAgent")
    echo "→ $OUT/PaceRise-WaveLightAgent-$os-v$VER.zip"
}

case "$WHICH" in
    win) bundle win node22-win-x64 PaceRise-WaveLightAgent.exe ;;
    mac) bundle mac node22-macos-arm64 PaceRise-WaveLightAgent ;;
    all) bundle win node22-win-x64 PaceRise-WaveLightAgent.exe; bundle mac node22-macos-arm64 PaceRise-WaveLightAgent ;;
    *) echo "사용: $0 [win|mac|all]"; exit 2 ;;
esac
