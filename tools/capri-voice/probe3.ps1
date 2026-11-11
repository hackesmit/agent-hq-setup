$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")
Get-Command ollama,uv | Select Name,Source | Format-Table -AutoSize
ollama --version
Get-Process ollama* -ErrorAction SilentlyContinue | Select Name,Id,SessionId
