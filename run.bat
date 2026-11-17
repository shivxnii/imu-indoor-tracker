@echo off
REM Starts the IMU Indoor Tracker dev server (HTTPS) on Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
pause
