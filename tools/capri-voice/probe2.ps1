winget show --id Ollama.Ollama --accept-source-agreements 2>&1 | Select-String "Version|Installer Url"
winget show --id astral-sh.uv 2>&1 | Select-String "Version|Installer Url"
Test-Path "$env:LOCALAPPDATA\Programs\Ollama"
nvcc --version 2>&1 | Select-String release
