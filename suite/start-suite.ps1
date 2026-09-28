# -*- coding: utf-8 -*-
# AD 스위트 실행: AD FACTORY · 키워드와처 · Success AI 를 창 없이 켜고 AD FACTORY 를 브라우저로 엽니다.
# 이미 켜져 있는 앱은 건너뜁니다. 로그: <ad-suite>\logs
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$suite = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$logs = Join-Path $suite 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$bunDir = Join-Path $env:USERPROFILE '.bun\bin'
if (Test-Path (Join-Path $bunDir 'bun.exe')) { $env:PATH = "$bunDir;$env:PATH" }

function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
function Write-Log([string]$msg) {
  Add-Content -Path (Join-Path $logs 'suite.log') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg) -Encoding UTF8
}

# AD FACTORY (4317): 자체 실행 스크립트가 서버를 백그라운드로 띄운 뒤 끝납니다.
$ad = Join-Path $suite 'ad-factory'
if ((Test-Path (Join-Path $ad 'start-local.ps1')) -and -not (Test-Port 4317)) {
  Write-Log 'AD FACTORY 시작'
  # 출력 리디렉션을 쓰면 백그라운드 서버가 파이프를 붙잡아 여기서 멈추므로, 별도 프로세스로 띄우고 그 프로세스만 기다린다 (서버 로그는 ad-factory\data\server-*.log)
  $adStart = Start-Process -FilePath $ps -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $ad 'start-local.ps1')`"", '-SkipBuild', '-NoBrowser')
  [void]$adStart.WaitForExit(60000)
}

# 키워드와처 (3000): 설치본의 Windows 실행 스크립트를 창 없이 실행합니다.
$kw = Join-Path $suite 'keyword-watcher'
$kwRun = Join-Path $kw 'scripts\windows\Run-Server.ps1'
if ((Test-Path $kwRun) -and -not (Test-Port 3000)) {
  $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if ($bun) {
    Write-Log '키워드와처 시작'
    Start-Process -FilePath $ps -WindowStyle Hidden -WorkingDirectory $kw -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$kwRun`"", '-BunPath', "`"$bun`"")
  } else { Write-Log '키워드와처: bun 을 찾지 못해 건너뜀' }
}

# Success AI (3001)
$sa = Join-Path $suite 'success_ai'
if ((Test-Path (Join-Path $sa 'package.json')) -and -not (Test-Port 3001)) {
  Write-Log 'Success AI 시작'
  $saLog = Join-Path $logs 'success-ai.log'
  Start-Process -FilePath $ps -WindowStyle Hidden -WorkingDirectory $sa -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Set-Location -LiteralPath '$sa'; npm run dev -- --hostname 127.0.0.1 --port 3001 *>> '$saLog'")
}

# 켜질 때까지 최대 90초 기다림
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not ((Test-Port 4317) -and (Test-Port 3000) -and (Test-Port 3001))) { Start-Sleep -Seconds 2 }
Write-Log ("상태 4317=" + (Test-Port 4317) + " 3000=" + (Test-Port 3000) + " 3001=" + (Test-Port 3001))

if (-not $NoBrowser) {
  if (Test-Port 4317) { Start-Process 'http://127.0.0.1:4317/' }
  elseif (Test-Port 3001) { Start-Process 'http://localhost:3001/' }
  elseif (Test-Port 3000) { Start-Process 'http://127.0.0.1:3000/' }
}
