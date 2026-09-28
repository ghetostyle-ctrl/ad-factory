# -*- coding: utf-8 -*-
# AD 스위트 종료: 이 설치 폴더에서 켠 AD FACTORY · 키워드와처 · Success AI 만 끕니다.
# 다른 프로그램이 같은 포트를 쓰고 있으면 건드리지 않습니다.
$ErrorActionPreference = 'SilentlyContinue'
$suite = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$adPidFile = Join-Path $suite 'ad-factory\data\server.pid'
$adPid = if (Test-Path $adPidFile) { [int](Get-Content $adPidFile -TotalCount 1) } else { 0 }

function Get-Chain([int]$id) {
  $chain = @()
  for ($i = 0; $i -lt 6 -and $id -gt 0; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if (-not $p) { break }
    $chain += $p
    $id = [int]$p.ParentProcessId
  }
  return $chain
}

$stopped = 0
foreach ($port in 4317, 3000, 3001) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -First 1
  if (-not $conn) { continue }
  $owner = [int]$conn.OwningProcess
  $chain = Get-Chain $owner
  $ours = ($owner -eq $adPid) -or ($chain | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($suite) })
  if (-not $ours) { Write-Host "  포트 $port 는 다른 프로그램이 사용 중이라 건너뜀"; continue }
  # 실행 래퍼(powershell)까지 같이 끄되, 설치 폴더와 관련된 프로세스만
  foreach ($p in $chain) {
    if ($p.ProcessId -eq $owner -or ($p.CommandLine -and $p.CommandLine.Contains($suite))) {
      Stop-Process -Id $p.ProcessId -Force
    }
  }
  $stopped++
}
Write-Host "AD 스위트 종료: $stopped 개 앱을 껐습니다."
