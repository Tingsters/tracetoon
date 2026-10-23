@echo off
rem Tracetoon launcher for cmd.exe: hands off to the PowerShell launcher.
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tracetoon.ps1" %*
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tracetoon.ps1" %*
)
exit /b %ERRORLEVEL%
