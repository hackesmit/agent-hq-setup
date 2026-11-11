Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$op = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
$t = $asTask.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]).Invoke($null, @($op)); $null = $t.Wait(5000); $m = $t.Result
$cur = $m.GetCurrentSession()
$all = @($m.GetSessions() | ForEach-Object { @{ app = $_.SourceAppUserModelId; status = $_.GetPlaybackInfo().PlaybackStatus.ToString() } })
@{ current = $(if ($cur) { $cur.SourceAppUserModelId } else { $null }); sessions = $all } | ConvertTo-Json -Compress -Depth 4
