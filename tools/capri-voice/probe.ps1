nvidia-smi --query-gpu=name,memory.used,memory.total,driver_version --format=csv
Get-Command ollama,uv,py,python,winget -ErrorAction SilentlyContinue | Select Name,Source | Format-Table -AutoSize
py -0p
whoami
Get-ScheduledTask | ? {$_.TaskName -match "capri|hands"} | Select TaskName,State | Format-Table
Get-CimInstance Win32_Processor | Select Name
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB
Get-PnpDevice -Class AudioEndpoint -Status OK | Select FriendlyName | Format-Table
query user
