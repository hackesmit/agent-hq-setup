@echo off
set OLLAMA_FLASH_ATTENTION=1
set OLLAMA_KV_CACHE_TYPE=q8_0
set OLLAMA_KEEP_ALIVE=-1
set OLLAMA_MAX_LOADED_MODELS=2
"C:\Users\owner\AppData\Local\Programs\Ollama\ollama.exe" serve > C:\Users\owner\capri-voice\ollama.log 2>&1
