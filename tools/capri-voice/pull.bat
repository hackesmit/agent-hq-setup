@echo off
"C:\Users\owner\AppData\Local\Programs\Ollama\ollama.exe" pull qwen2.5:7b-instruct-q4_K_M > C:\Users\owner\capri-voice\pull.log 2>&1
"C:\Users\owner\AppData\Local\Programs\Ollama\ollama.exe" pull llama3.2:3b-instruct-q4_K_M >> C:\Users\owner\capri-voice\pull.log 2>&1
echo PULLDONE >> C:\Users\owner\capri-voice\pull.log
