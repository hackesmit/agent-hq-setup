# Starts the Ollama tray app (which runs the server) in the owner's interactive session.
$exe = "C:\Users\owner\AppData\Local\Programs\Ollama\ollama app.exe"
schtasks /Create /TN capri-voice-ollama /TR "`"$exe`"" /SC ONCE /ST 00:00 /IT /F | Out-Null
schtasks /Run /TN capri-voice-ollama | Out-Null
Start-Sleep 6
Get-Process ollama* | Select Name,Id,SessionId | Format-Table
