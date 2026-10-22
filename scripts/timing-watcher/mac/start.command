#!/bin/bash
cd "$(dirname "$0")"
xattr -d com.apple.quarantine ./PaceRise-TimingAgent 2>/dev/null
chmod +x ./PaceRise-TimingAgent
./PaceRise-TimingAgent
echo; read -n 1 -s -r -p "(끝났습니다. 아무 키나 누르면 닫힙니다)"
