@echo off
cd /d C:\Users\owner\capri
powershell -NoProfile -Command "[console]::beep(880,400)"
venv\Scripts\python.exe -X utf8 -m capri record %1 tune\%2 TONOR,Anker > tune\record.log 2>&1
powershell -NoProfile -Command "[console]::beep(660,300);[console]::beep(440,300)"
