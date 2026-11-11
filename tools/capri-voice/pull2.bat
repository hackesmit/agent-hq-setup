@echo off
"C:\Users\owner\AppData\Local\Programs\Ollama\ollama.exe" pull qwen2.5:3b-instruct-q4_K_M > C:\Users\owner\capri-voice\pull2.log 2>&1
echo PULLDONE >> C:\Users\owner\capri-voice\pull2.log
