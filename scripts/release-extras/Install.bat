@echo off
title Nuke - System Cleaner installer
if not exist "%~dp0Nuke System Cleaner - Installer.exe" (
  echo Please unzip the whole download first, then run this file again.
  pause
  exit /b 1
)
echo Starting the Nuke - System Cleaner setup wizard. Windows may ask for permission once...
start "" /wait "%~dp0Nuke System Cleaner - Installer.exe"
if errorlevel 1 (
  echo.
  echo Setup was cancelled or did not finish, so nothing was installed.
  pause
  exit /b 1
)
echo.
echo Finished. Nuke - System Cleaner is in your Start menu and on your desktop.
timeout /t 5 >nul
