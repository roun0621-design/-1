@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PACE RISE Node - 계측 에이전트
"%~dp0PaceRise-TimingAgent.exe"
echo.
echo (끝났습니다. 설정을 바꿨으면 이 창을 닫고 다시 실행하세요)
pause
