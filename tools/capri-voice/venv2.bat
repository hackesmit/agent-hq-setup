@echo off
cd /d C:\Users\owner\capri-voice
set UV=C:\Users\owner\AppData\Local\Microsoft\WinGet\Links\uv.exe
C:\Users\owner\AppData\Roaming\uv\python\cpython-3.12.16-windows-x86_64-none\python.exe -m venv --without-pip venv3 > venv2.log 2>&1
%UV% pip install --python venv3\Scripts\python.exe faster-whisper kokoro-onnx onnxruntime-gpu sounddevice soundfile numpy nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" >> venv2.log 2>&1
venv3\Scripts\python.exe check.py >> venv2.log 2>&1
echo VENVDONE >> venv2.log
