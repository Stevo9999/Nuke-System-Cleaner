@echo off
title Nuke-Uninstaller installer
if not exist "%~dp0Install-Nuke-Uninstaller.exe" (
  echo Please unzip the whole download first, then run this file again.
  pause
  exit /b 1
)
echo Installing Nuke-Uninstaller. Windows may ask for permission once...
start "" /wait "%~dp0Install-Nuke-Uninstaller.exe"
echo.
echo Finished. Nuke-Uninstaller is in your Start menu and on your desktop.
timeout /t 5 >nul
