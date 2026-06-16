# Script PowerShell to find and kill process on port 3001
Write-Host "🔍 Searching for process on port 3001..." -ForegroundColor Yellow

$port = 3001
$processes = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique

if ($processes) {
    Write-Host "✅ Found processes using port $port :" -ForegroundColor Green
    foreach ($pid in $processes) {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "   PID: $pid - Name: $($proc.ProcessName) - Path: $($proc.Path)" -ForegroundColor Cyan
        }
    }
    
    Write-Host "`n🛑 Killing processes..." -ForegroundColor Yellow
    foreach ($pid in $processes) {
        try {
            Stop-Process -Id $pid -Force -ErrorAction Stop
            Write-Host "   ✅ Killed process $pid" -ForegroundColor Green
        } catch {
            Write-Host "   ❌ Failed to kill process $pid : $_" -ForegroundColor Red
        }
    }
    
    Write-Host "`n✅ Done! Port $port should now be available." -ForegroundColor Green
} else {
    Write-Host "ℹ️  No process found on port $port" -ForegroundColor Cyan
}

