@echo off
cd /d C:\Users\owner\capri-voice
venv\Scripts\python.exe -m voice live --phrases en --model qwen2.5:3b-instruct-q4_K_M --stt small --silence-ms 300 --mic Anker --speaker "Speakers (2- Realtek" --seconds 110 --play-inputs --out runs\live-en-small > live-en-small.out 2>&1
venv\Scripts\python.exe -m voice live --phrases en --model qwen2.5:3b-instruct-q4_K_M --stt large-v3-turbo --silence-ms 300 --mic Anker --speaker "Speakers (2- Realtek" --seconds 110 --play-inputs --out runs\live-en-turbo > live-en-turbo.out 2>&1
echo LIVEDONE > live-en.done
