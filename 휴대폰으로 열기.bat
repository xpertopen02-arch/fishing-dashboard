@echo off
cd /d "%~dp0"
echo 휴대폰 브라우저에서 아래 주소를 여세요. 휴대폰과 이 PC가 같은 공유기에 연결되어 있어야 합니다.
echo 사용하는 동안 이 창을 닫지 마세요. 창을 닫으면 접속이 끊깁니다.
python "scripts\serve.py" --lan
