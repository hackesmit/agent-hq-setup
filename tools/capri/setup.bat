@echo off
cd /d C:\Users\owner\capri
C:\Users\owner\AppData\Local\Programs\Python\Python314\python.exe -m venv venv > setup.log 2>&1
venv\Scripts\python.exe -m pip install -q sherpa-onnx==2.0.1 sounddevice numpy pystray pillow sentencepiece >> setup.log 2>&1
echo pip exit %ERRORLEVEL% >> setup.log
venv\Scripts\python.exe -m pip list >> setup.log 2>&1
