@echo off
cd /d "%~dp0"
echo 낚시 브리핑을 여는 중입니다. 사용하는 동안 이 창을 닫지 마세요.
start "" "http://127.0.0.1:8765/"
python "scripts\serve.py"
