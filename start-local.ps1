param(
  [switch]$NoBrowser,
  [switch]$SkipBuild,
  [ValidateRange(1, 120)][int]$ReadyTimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$studioBun = & (Join-Path $PSScriptRoot 'ensure-bun.ps1')
$studioPortOutput = & $studioBun --print 'process.env.PORT || "4317"'
$studioPort = 0
if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse(($studioPortOutput | Out-String).Trim(), [ref]$studioPort) -or $studioPort -lt 1024 -or $studioPort -gt 65535) { throw 'PORT must be an integer from 1024 to 65535.' }
$studioUrl = "http://127.0.0.1:$studioPort"
$studioPathIdentity = $PSScriptRoot.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
$studioHasher = [Security.Cryptography.SHA256]::Create()
try { $studioInstallation = ([BitConverter]::ToString($studioHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($studioPathIdentity)))).Replace('-', '').ToLowerInvariant().Substring(0, 32) }
finally { $studioHasher.Dispose() }

function Get-StudioHealth {
  try { return Invoke-RestMethod -Uri "$studioUrl/api/health" -TimeoutSec 2 -ErrorAction Stop }
  catch { return $null }
}
function Test-StudioPort {
  $studioClient = [Net.Sockets.TcpClient]::new()
  try { return $studioClient.ConnectAsync('127.0.0.1', $studioPort).Wait(500) -and $studioClient.Connected }
  catch { return $false }
  finally { $studioClient.Dispose() }
}
function Show-StudioReady($studioHealth) {
  Write-Host "Meta Ad Studio is ready at $studioUrl"
  Write-Host "Server PID: $($studioHealth.pid). To stop it: Stop-Process -Id $($studioHealth.pid)"
  if (-not $NoBrowser) { Start-Process $studioUrl }
}

$studioMutex = [Threading.Mutex]::new($false, "Local\MetaAdStudio-$studioInstallation")
$studioMutexHeld = $false
try {
  try { $studioMutexHeld = $studioMutex.WaitOne(60000) }
  catch [Threading.AbandonedMutexException] { $studioMutexHeld = $true }
  if (-not $studioMutexHeld) { throw 'Another launcher is still starting this installation. Try again after it finishes.' }
  $studioExisting = Get-StudioHealth
  if ($studioExisting -and $studioExisting.app -eq 'meta-ad-studio' -and $studioExisting.installationId -eq $studioInstallation -and $studioExisting.pid -gt 0) {
    Show-StudioReady $studioExisting
    return
  }
  if (Test-StudioPort) { throw "Port $studioPort is occupied by another or older service. Stop that service or choose a different PORT; this launcher will not replace it." }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    & $studioBun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }
  if (-not $SkipBuild) {
    & $studioBun run build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed.' }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist\index.html'))) { throw 'Production UI is missing. Run bun run build before skipping the build.' }
  $studioLogs = Join-Path $PSScriptRoot 'data'
  New-Item -ItemType Directory -Path $studioLogs -Force | Out-Null
  $studioRunId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $studioStdout = Join-Path $studioLogs "server-$studioRunId.stdout.log"
  $studioStderr = Join-Path $studioLogs "server-$studioRunId.stderr.log"
  $studioProcess = Start-Process -FilePath $studioBun -ArgumentList @('run', 'server/index.ts') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $studioStdout -RedirectStandardError $studioStderr -PassThru
  $studioDeadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $studioDeadline) {
    $studioProcess.Refresh()
    if ($studioProcess.HasExited) { throw "Server exited before readiness (exit $($studioProcess.ExitCode)). See $studioStderr" }
    $studioHealth = Get-StudioHealth
    if ($studioHealth -and $studioHealth.app -eq 'meta-ad-studio' -and $studioHealth.installationId -eq $studioInstallation -and $studioHealth.pid -eq $studioProcess.Id) {
      Set-Content -LiteralPath (Join-Path $studioLogs 'server.pid') -Value $studioHealth.pid
      Show-StudioReady $studioHealth
      return
    }
    Start-Sleep -Milliseconds 200
  }
  if (-not $studioProcess.HasExited) { Stop-Process -Id $studioProcess.Id -ErrorAction SilentlyContinue }
  throw "Server readiness timed out. See $studioStderr"
}
finally {
  if ($studioMutexHeld) { $studioMutex.ReleaseMutex() }
  $studioMutex.Dispose()
}
