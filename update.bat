@echo off
cd /d "%~dp0"
echo [1/2] 원노트에서 낚시 자료를 읽는 중입니다...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\export_onenote.ps1"
if errorlevel 1 goto fail
echo [2/2] 대시보드 데이터를 만드는 중입니다...
python "scripts\build.py"
if errorlevel 1 goto fail
echo 완료되었습니다. 대시보드를 새로고침해 확인하세요.
pause
exit /b 0
:fail
echo 오류가 발생했습니다. 위 메시지를 확인하세요.
pause
exit /b 1
