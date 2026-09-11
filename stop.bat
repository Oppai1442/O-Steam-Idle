@echo off
setlocal
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3210/api/shutdown' -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null; Write-Host 'O-Steam-Idle stopped cleanly.' } catch { Write-Host 'O-Steam-Idle is not running on 127.0.0.1:3210 (or it already stopped).' }"
timeout /t 2 /nobreak >nul
endlocal
