$ErrorActionPreference = "Continue"
winget install --id astral-sh.uv --version 0.13.7 --exact --silent --accept-package-agreements --accept-source-agreements 2>&1 | Select-Object -Last 3
winget install --id Ollama.Ollama --version 0.40.14 --exact --silent --accept-package-agreements --accept-source-agreements 2>&1 | Select-Object -Last 3
