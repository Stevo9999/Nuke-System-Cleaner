# Builds release\Nuke-Uninstaller-<version>-windows-x64.zip from the electron-builder output. Run after: npx electron-builder --win --x64
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$v = (Get-Content package.json | ConvertFrom-Json).version
$stage = 'release\stage'; Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $stage | Out-Null
Copy-Item 'release\Install-Nuke-Uninstaller.exe','release\Nuke-Uninstaller-Portable.exe','LICENSE','THIRD_PARTY_NOTICES.md','scripts\release-extras\Install.bat','scripts\release-extras\READ-ME-FIRST.txt' $stage
$zip = "release\Nuke-Uninstaller-$v-windows-x64.zip"; Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
"$zip  SHA-256: " + (Get-FileHash $zip -Algorithm SHA256).Hash
