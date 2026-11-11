@echo off
cd /d C:\Users\owner\capri-voice
set UV=C:\Users\owner\AppData\Local\Microsoft\WinGet\Links\uv.exe
%UV% pip uninstall --python venv\Scripts\python.exe onnxruntime onnxruntime-gpu > ortgpu.log 2>&1
%UV% pip install --python venv\Scripts\python.exe "onnxruntime-gpu==1.22.0" nvidia-cuda-runtime-cu12 nvidia-cufft-cu12 nvidia-curand-cu12 >> ortgpu.log 2>&1
venv\Scripts\python.exe check.py >> ortgpu.log 2>&1
