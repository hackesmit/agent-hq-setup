@echo off
cd /d C:\Users\owner\capri-voice
set UV=C:\Users\owner\AppData\Local\Microsoft\WinGet\Links\uv.exe
%UV% python install 3.12 > venv.log 2>&1
%UV% venv --python 3.12 venv >> venv.log 2>&1
%UV% pip install --python venv\Scripts\python.exe faster-whisper kokoro-onnx onnxruntime-gpu sounddevice soundfile numpy nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" >> venv.log 2>&1
echo VENVDONE >> venv.log
