@echo off
cd /d C:\Users\owner\capri
venv\Scripts\python.exe -X utf8 tune\grid.py %1 %2 > check.log 2>&1
