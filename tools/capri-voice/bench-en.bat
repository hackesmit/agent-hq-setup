@echo off
cd /d C:\Users\owner\capri-voice
set M=qwen2.5:7b-instruct-q4_K_M,qwen2.5:3b-instruct-q4_K_M,llama3.2:3b-instruct-q4_K_M
venv\Scripts\python.exe -m voice bench --phrases en --models %M% --stt small,large-v3-turbo --silence-ms 300 --out runs\bench-en > bench-en.log 2>&1
venv\Scripts\python.exe -m voice bench --phrases en --stt-lang en --models %M% --stt small,large-v3-turbo --silence-ms 300 --out runs\bench-en-fixed > bench-en-fixed.log 2>&1
venv\Scripts\python.exe -m voice accuracy --phrases en --models %M% --out runs\bench-en > acc-en.log 2>&1
echo BENCHDONE >> bench-en-fixed.log
