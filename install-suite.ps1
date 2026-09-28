# -*- coding: utf-8 -*-
<#
.SYNOPSIS
  AD 스위트(AD FACTORY · Success AI · 키워드와처)를 한 번에 받고 설치합니다 (Windows).

.DESCRIPTION
  1) 필요한 도구 확인: Node.js 20+(Success AI), Bun(AD FACTORY·키워드와처, 없으면 사용자 폴더에 자동 설치)
  2) 세 저장소를 한 폴더에 받기: git 이 있으면 clone(이미 있으면 pull), 없으면 GitHub ZIP
  3) 앱별 준비: 패키지 설치, 화면 빌드, .env 양식 복사(이미 있으면 건드리지 않음)
  API 키는 넣지 않습니다. 설치가 끝나면 앱별로 본인 키를 연결하세요.

  업데이트: 이미 설치한 폴더에서 다시 실행하면 코드만 최신으로 바꿉니다.
  git 으로 받은 앱은 git pull, ZIP 으로 받은 앱은 새 ZIP 으로 코드 파일을 교체합니다.
  API 키(.env*), 작업 기록·DB(data, dev.db, *.sqlite), 로그는 건드리지 않습니다.
  업데이트 없이 설치 확인만 하려면 -NoUpdate 를 붙이세요.

.EXAMPLE
  # 이 저장소 폴더에서
  .\install-suite.ps1
  .\install-suite.ps1 -InstallDir "D:\ad-suite"
  .\install-suite.ps1 -NoUpdate      # 이미 받은 앱은 업데이트하지 않음

  # 아무 데서나
  iwr https://raw.githubusercontent.com/ghetostyle-ctrl/ad-factory/main/install-suite.ps1 -OutFile "$env:TEMP\install-suite.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-suite.ps1"
#>
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'ad-suite'),
  [switch]$SkipSetup,
  [switch]$NoUpdate
)

$ErrorActionPreference = 'Stop'
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`n[실패] $msg" -ForegroundColor Red; throw $msg }

$apps = @(
  @{ Name = 'AD FACTORY'; Repo = 'ghetostyle-ctrl/ad-factory';      Dir = 'ad-factory' },
  @{ Name = 'Success AI'; Repo = 'ghetostyle-ctrl/success_ai';      Dir = 'success_ai' },
  @{ Name = '키워드와처'; Repo = 'ghetostyle-ctrl/keyword-watcher'; Dir = 'keyword-watcher' }
)

# 1. 도구 확인 -----------------------------------------------------------------
Step '필요한 도구 확인'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 가 없습니다. https://nodejs.org 에서 20 이상 LTS 를 설치한 뒤 다시 실행하세요. (Success AI 에 필요)' }
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js $(node -v) 는 너무 낮습니다. 20 이상이 필요합니다." }
Write-Host "  Node $(node -v) OK"

$userBunDir = Join-Path $env:USERPROFILE '.bun\bin'
if (Test-Path (Join-Path $userBunDir 'bun.exe')) { $env:PATH = "$userBunDir;$env:PATH" }
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host '  Bun 이 없어 사용자 폴더(%USERPROFILE%\.bun)에 설치합니다. 관리자 권한은 필요 없습니다.'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $bunInstaller = Join-Path ([IO.Path]::GetTempPath()) ('bun-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://bun.sh/install.ps1' -OutFile $bunInstaller -TimeoutSec 120
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $bunInstaller -Version 1.3.14 | Out-Host
  } finally {
    if (Test-Path $bunInstaller) { Remove-Item $bunInstaller -Force }
  }
  $env:PATH = "$userBunDir;$env:PATH"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Fail 'Bun 설치에 실패했습니다. https://bun.sh/docs/installation 안내대로 설치한 뒤 다시 실행하세요.' }
}
Write-Host "  Bun $(bun --version) OK"

$hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
if (-not $hasGit) { Warn 'git 이 없어 ZIP 으로 받습니다. 다시 실행하면 새 ZIP 으로 업데이트됩니다.' }

# 2. 저장소 받기 / 업데이트 -----------------------------------------------------
# ZIP 업데이트 때 보존할 것: 사용자 설정·데이터·로그와, 설치 과정에서 다시 만들어지는 폴더
$keepDirs  = @('.git', 'node_modules', 'data', 'logs', 'cache', 'tmp', 'dist', '.next', '.runtime', 'generated', 'coverage', 'test-results', 'playwright-report', 'work')
$keepFiles = @('.env', '.env.local', '.env.*.local', 'dev.db', '*.db', '*.db-journal', '*.sqlite', '*.sqlite-*', '*.log', 'server.pid')

function Get-RepoZip($app) {
  $zip = Join-Path ([IO.Path]::GetTempPath()) ($app.Dir + '-' + [Guid]::NewGuid().ToString('N') + '.zip')
  $unpack = Join-Path ([IO.Path]::GetTempPath()) ($app.Dir + '-' + [Guid]::NewGuid().ToString('N'))
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$($app.Repo)/archive/refs/heads/main.zip" -OutFile $zip -TimeoutSec 300
  Expand-Archive -Path $zip -DestinationPath $unpack -Force
  Remove-Item $zip -Force
  return @{ Root = $unpack; Source = (Get-ChildItem $unpack -Directory | Select-Object -First 1).FullName }
}

function Update-FromZip($app, $target) {
  $pkg = Get-RepoZip $app
  try {
    # /MIR: 새 버전 기준으로 코드 파일을 맞춤(없어진 코드 파일은 삭제).
    # /XD /XF 로 지정한 폴더·파일은 복사도 삭제도 하지 않으므로 설정·데이터는 그대로 남음.
    $copyArgs = @($pkg.Source, $target, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2', '/XD') + $keepDirs + @('/XF') + $keepFiles
    & robocopy @copyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "$($app.Name) 업데이트 실패 (robocopy 코드 $LASTEXITCODE). 앱 실행 창을 모두 닫고 다시 실행하세요." }
  } finally {
    Remove-Item $pkg.Root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Step "AD 스위트 받기 (AD FACTORY · Success AI · 키워드와처) → $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
foreach ($app in $apps) {
  $target = Join-Path $InstallDir $app.Dir
  if (Test-Path (Join-Path $target 'package.json')) {
    if ($NoUpdate) { Write-Host "  $($app.Name): 이미 있음 → 업데이트 안 함 (-NoUpdate)"; continue }
    if (Test-Path (Join-Path $target '.git')) {
      if (-not $hasGit) { Warn "$($app.Name): git 으로 받은 폴더인데 git 이 없어 업데이트를 건너뜁니다."; continue }
      Write-Host "  $($app.Name): 이미 있음 → git 으로 최신 업데이트"
      git -C $target pull --ff-only
      if ($LASTEXITCODE -ne 0) { Warn "$($app.Name): 업데이트 실패(코드를 직접 수정했을 수 있음). 기존 상태로 계속합니다." }
    } else {
      Write-Host "  $($app.Name): 이미 있음 → 새 ZIP 으로 코드 업데이트 (설정·데이터 유지)"
      Update-FromZip $app $target
    }
    continue
  }
  if ($hasGit) {
    Write-Host "  $($app.Name): git clone"
    git clone "https://github.com/$($app.Repo).git" $target
    if ($LASTEXITCODE -ne 0) { Fail "$($app.Name) 받기 실패" }
  } else {
    Write-Host "  $($app.Name): ZIP 다운로드"
    $pkg = Get-RepoZip $app
    try { Move-Item -Path $pkg.Source -Destination $target }
    finally { Remove-Item $pkg.Root -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if ($SkipSetup) { Write-Host "`n받기만 완료했습니다 (-SkipSetup)." -ForegroundColor Green; return }

function Copy-EnvTemplate($dir, $names) {
  foreach ($n in $names) {
    $dest = Join-Path $dir $n
    if (-not (Test-Path $dest)) { Copy-Item (Join-Path $dir '.env.example') $dest; Write-Host "  $n 생성 (값은 비어 있음)" }
  }
}

# 3. 앱별 준비 -----------------------------------------------------------------
$adDir = Join-Path $InstallDir 'ad-factory'
Step 'AD FACTORY 준비 (패키지 설치 + 화면 빌드)'
Push-Location $adDir
try {
  bun install --frozen-lockfile; if ($LASTEXITCODE -ne 0) { Fail 'AD FACTORY 패키지 설치 실패' }
  bun run build;                 if ($LASTEXITCODE -ne 0) { Fail 'AD FACTORY 빌드 실패' }
} finally { Pop-Location }

$kwDir = Join-Path $InstallDir 'keyword-watcher'
Step '키워드와처 준비 (패키지 설치 + 화면 빌드 + .env 양식)'
Push-Location $kwDir
try {
  bun install --frozen-lockfile; if ($LASTEXITCODE -ne 0) { Fail '키워드와처 패키지 설치 실패' }
  bun run build;                 if ($LASTEXITCODE -ne 0) { Fail '키워드와처 빌드 실패' }
  Copy-EnvTemplate $kwDir @('.env')
} finally { Pop-Location }

$saDir = Join-Path $InstallDir 'success_ai'
Step 'Success AI 준비 (자체 설치 스크립트 실행, 2~5분)'
Push-Location $saDir
try {
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $saDir 'install.ps1')
  if ($LASTEXITCODE -ne 0) { Fail 'Success AI 설치 실패. 위 메시지를 확인하세요.' }
} finally { Pop-Location }

# 4. 안내 ----------------------------------------------------------------------
Write-Host "`nAD 스위트 설치 완료: $InstallDir" -ForegroundColor Green
Write-Host @"

실행 (각각 더블클릭, 창을 닫으면 해당 앱이 꺼집니다)
  AD FACTORY  : $adDir\start-local.cmd            → http://127.0.0.1:4317
  키워드와처  : $kwDir\Start-KeywordWatcher.cmd   → http://127.0.0.1:3000
  Success AI  : 바탕화면 'Success AI 실행' 아이콘  → http://localhost:3001

API 키는 각자 발급해서 본인 PC에만 넣습니다 (이 설치는 키를 넣지 않습니다)
  AD FACTORY  : 앱 화면의 [연결 설정]에서 OpenAI·Gemini 등 키 저장
  키워드와처  : $kwDir\.env 에 네이버 검색광고 API 키·비밀 키·고객 ID (발급: SETUP.md)
  Success AI  : $saDir\.env 와 .env.local 의 YOUTUBE_API_KEY (선택)

영상 기능(AD FACTORY)에는 FFmpeg(ffmpeg, ffprobe)가 PATH 에 있어야 합니다.

업데이트한 경우: 켜져 있던 앱은 실행 창을 닫았다가 다시 켜야 새 버전이 적용됩니다.
나중에 최신 버전으로 올리려면 이 스크립트를 다시 실행하세요 (설정·데이터는 유지).
"@
