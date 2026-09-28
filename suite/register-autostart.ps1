# -*- coding: utf-8 -*-
# AD 스위트 로그온 자동 실행 등록/해제 (관리자 권한 불필요, 현재 사용자만)
#   등록: powershell -ExecutionPolicy Bypass -File register-autostart.ps1
#   해제: powershell -ExecutionPolicy Bypass -File register-autostart.ps1 -Remove
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'AD-Suite-Start'
if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "로그온 자동 실행을 해제했습니다 ($taskName)."
  } else { Write-Host '등록된 자동 실행이 없습니다.' }
  return
}

$start = Join-Path $PSScriptRoot 'start-suite.ps1'
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`" -NoBrowser"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Description 'AD 스위트(AD FACTORY · 키워드와처 · Success AI) 로그온 시 자동 실행' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "로그온 자동 실행을 등록했습니다 ($taskName). 다음 로그인부터 세 앱이 자동으로 켜집니다."
