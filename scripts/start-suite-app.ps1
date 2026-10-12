# AD 스위트의 다른 앱(키워드와처·Success AI)을 AD FACTORY 서버와 분리된 창 없는 프로세스로 켠다.
# 서버(server/suite-apps.ts)가 부르며, 이 스크립트는 Start-Process 뒤 곧바로 끝난다. 출력은 -Log 파일에 쌓인다.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Command,
  [Parameter(Mandatory = $true)][string]$Log
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Dir)) { throw "앱 폴더가 없습니다: $Dir" }
$logDir = Split-Path -Parent $Log
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
# 사용자 폴더에 설치된 Bun(키워드와처) 과 Node(npm) 가 PATH 에 없을 때를 대비한다.
$extra = @((Join-Path $env:USERPROFILE '.bun\bin'), (Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:APPDATA 'npm'))
foreach ($p in $extra) { if ((Test-Path -LiteralPath $p) -and ($env:PATH -notlike "*$p*")) { $env:PATH = "$p;$env:PATH" } }
Add-Content -Path $Log -Value ("`n==== " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " start: " + $Command) -Encoding UTF8
$inner = 'cd /d "' + $Dir + '" && ' + $Command + ' >> "' + $Log + '" 2>&1'
Start-Process -FilePath "$env:ComSpec" -ArgumentList @('/c', $inner) -WorkingDirectory $Dir -WindowStyle Hidden | Out-Null
