@echo off
rem Double-click on the Den Computer after this branch is checked out.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-den.ps1"
if errorlevel 1 pause
