@echo off
chcp 65001 >nul
rem PC 를 켤 때 에이전트가 자동으로 켜지도록 시작 프로그램에 바로 가기를 만든다
set "SC=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PaceRise-TimingAgent.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SC%'); $s.TargetPath='%~dp0시작.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()"
if exist "%SC%" (echo 등록했습니다. 다음에 PC 를 켜면 자동으로 시작됩니다.) else (echo 등록에 실패했습니다. 시작.bat 의 바로 가기를 shell:startup 폴더에 직접 넣어 주세요.)
pause
