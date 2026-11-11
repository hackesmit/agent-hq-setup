@echo off
cd /d C:\Users\owner\capri-voice
for %%d in (live live-en-small live-en-turbo) do (
echo %%d
venv\Scripts\python.exe -m voice acoustic runs\%%d\session-mic.wav 2>ac-err.log
)
