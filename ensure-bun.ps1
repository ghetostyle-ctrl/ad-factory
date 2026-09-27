$ErrorActionPreference = 'Stop'
$studioExistingBun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
if ($studioExistingBun) { return $studioExistingBun.Source }

$studioRuntimeRoot = Join-Path $PSScriptRoot '.runtime\bun'
$studioRuntimeBun = Join-Path $studioRuntimeRoot 'bin\bun.exe'
if (-not (Test-Path -LiteralPath $studioRuntimeBun)) {
  Write-Host 'Bun was not found. Installing Bun 1.3.14 for AD FACTORY...'
  Write-Host 'Internet access is required. This may take a few minutes.'
  $studioInstaller = Join-Path ([IO.Path]::GetTempPath()) ("ad-factory-bun-" + [Guid]::NewGuid().ToString('N') + '.ps1')
  $studioPreviousInstallRoot = $env:BUN_INSTALL
  $studioPreviousTls = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol = $studioPreviousTls -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://bun.sh/install.ps1' -OutFile $studioInstaller -TimeoutSec 120
    $env:BUN_INSTALL = $studioRuntimeRoot
    & "$env:SystemRoot\System32\WindowsPowerShell/v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $studioInstaller -Version 1.3.14 -NoPathUpdate -NoRegisterInstallation -NoCompletions | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $studioRuntimeBun)) {
      throw 'The Bun installer did not complete successfully.'
    }
  }
  catch {
    throw "Bun automatic installation failed: $($_.Exception.Message) Check your internet connection and run start-local.cmd again. Manual install: https://bun.sh/docs/installation"
  }
  finally {
    $env:BUN_INSTALL = $studioPreviousInstallRoot
    [Net.ServicePointManager]::SecurityProtocol = $studioPreviousTls
    if (Test-Path -LiteralPath $studioInstaller) { Remove-Item -LiteralPath $studioInstaller -Force }
  }
}
$studioRuntimeVersion = & $studioRuntimeBun --version
if ($LASTEXITCODE -ne 0) { throw 'The installed Bun could not run. Check Windows and CPU compatibility at https://bun.sh/docs/installation.' }
Write-Host "Using local Bun $studioRuntimeVersion"
return $studioRuntimeBun
