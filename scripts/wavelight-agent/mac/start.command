#!/bin/bash
cd "$(dirname "$0")"
xattr -d com.apple.quarantine ./PaceRise-WaveLightAgent 2>/dev/null
chmod +x ./PaceRise-WaveLightAgent
./PaceRise-WaveLightAgent
echo; read -n 1 -s -r -p "(끝났습니다. 아무 키나 누르면 닫힙니다)"
