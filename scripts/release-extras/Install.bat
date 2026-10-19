@echo off
title Nuke-Uninstaller installer
if not exist "%~dp0Install-Nuke-Uninstaller.exe" (
  echo Please unzip the whole download first, then run this file again.
  pause
  exit /b 1
)
echo Starting the Nuke-Uninstaller setup wizard. Windows may ask for permission once...
start "" /wait "%~dp0Install-Nuke-Uninstaller.exe"
if errorlevel 1 (
  echo.
  echo Setup was cancelled or did not finish, so nothing was installed.
  pause
  exit /b 1
)
echo.
echo Finished. Nuke-Uninstaller is in your Start menu and on your desktop.
timeout /t 5 >nul
