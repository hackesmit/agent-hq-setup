@echo off
cd /d C:\Users\owner\capri-voice
venv\Scripts\python.exe loopcheck.py > devs.log 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Select Name,Status | Format-Table" >> devs.log
