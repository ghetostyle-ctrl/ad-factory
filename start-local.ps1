param(
  [switch]$NoBrowser,
  [switch]$SkipBuild,
  [switch]$NoUpdate,
  [switch]$NotifyUpdate,
  [ValidateRange(1, 120)][int]$ReadyTimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$studioBun = & (Join-Path $PSScriptRoot 'ensure-bun.ps1')
$studioNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $studioNode) { throw 'Node.js 22 or newer is required for HyperFrames. Install the LTS version from https://nodejs.org.' }
$studioNodeMajor = [int]((& $studioNode.Source --version).TrimStart('v').Split('.')[0])
if ($studioNodeMajor -lt 22) { throw 'Node.js 22 or newer is required for HyperFrames.' }
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
  if (-not $NoUpdate) {
    $studioDataOutput = & $studioBun --print 'process.env.DATA_DIR'
    if ($LASTEXITCODE -ne 0) { throw 'Could not determine the data directory safely.' }
    $studioData = ($studioDataOutput | Out-String).Trim()
    if (-not $studioData -or $studioData -eq 'undefined') { $studioData = 'data' }
    & $studioNode.Source (Join-Path $PSScriptRoot 'scripts/launcher-update.mjs') --root $PSScriptRoot --bun $studioBun --port $studioPort --data $studioData
    if ($LASTEXITCODE -eq 2) { throw 'Update recovery needs attention. Read .runtime/update-status.json before restarting.' }
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Update check failed. Continuing with the existing installation.' }
  }
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.runtime/pending-update.json')) {
    throw 'An incomplete update is pending. Run without -NoUpdate to recover, or inspect .runtime/updates.'
  }
  if ((-not $NoBrowser -or $NotifyUpdate) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.runtime/update-status.json'))) {
    try {
      $updateState = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime/update-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $NoUpdate -and $updateState.kind -in @('fallback', 'rollback', 'busy', 'skipped')) {
        $notice = switch ($updateState.kind) {
          'fallback' { '업데이트를 확인하거나 설치하지 못했습니다. 기존 버전으로 실행합니다.' }
          'rollback' { '업데이트에 실패하여 이전 버전으로 복구했습니다.' }
          'busy' { '광고 제작 중이므로 업데이트를 보류하고 현재 앱을 엽니다.' }
          'skipped' { '수정한 코드 또는 개발용 설치를 보호하기 위해 자동 업데이트를 건너뜁니다.' }
        }
        $shellNotice = New-Object -ComObject WScript.Shell
        [void]$shellNotice.Popup($notice, 5, 'AD FACTORY 업데이트', 64)
      }
    } catch { Write-Warning 'Update status is available in .runtime/update-status.json.' }
  }
  $studioExisting = Get-StudioHealth
  if ($studioExisting -and $studioExisting.app -eq 'meta-ad-studio' -and $studioExisting.installationId -eq $studioInstallation -and $studioExisting.pid -gt 0) {
    Show-StudioReady $studioExisting
    return
  }
  if (Test-StudioPort) { throw "Port $studioPort is occupied by another or older service. Stop that service or choose a different PORT; this launcher will not replace it." }
  $studioLockHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'bun.lock') -Algorithm SHA256).Hash
  $studioRuntimeRoot = Join-Path $PSScriptRoot '.runtime'
  $studioDependencyStamp = Join-Path $studioRuntimeRoot 'dependency-lock.sha256'
  $studioInstalledHash = if (Test-Path -LiteralPath $studioDependencyStamp) { (Get-Content -LiteralPath $studioDependencyStamp -Raw).Trim() } else { '' }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules')) -or $studioInstalledHash -ne $studioLockHash) {
    & $studioBun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    New-Item -ItemType Directory -Path $studioRuntimeRoot -Force | Out-Null
    Set-Content -LiteralPath $studioDependencyStamp -Value $studioLockHash
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
