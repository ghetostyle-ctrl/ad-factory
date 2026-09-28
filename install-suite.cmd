@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-suite.ps1" %*
if errorlevel 1 (
  echo.
  echo Suite install failed. Read the error above, then try again.
  pause
  exit /b 1
)
pause
