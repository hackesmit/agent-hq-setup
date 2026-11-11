@echo off
cd /d C:\Users\owner\capri-voice
venv\Scripts\python.exe -m voice live --model qwen2.5:3b-instruct-q4_K_M --stt large-v3-turbo --silence-ms 300 --mic Anker --speaker "Speakers (2- Realtek" --seconds 100 --play-inputs > live.out 2>&1
echo LIVEDONE >> live.out
