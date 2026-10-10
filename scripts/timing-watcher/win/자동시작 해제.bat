@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PaceRise-TimingAgent.lnk" 2>nul
echo 자동 시작을 해제했습니다.
pause
