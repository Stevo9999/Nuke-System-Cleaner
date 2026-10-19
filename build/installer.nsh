; Extra NSIS settings for electron-builder (nsis.include in electron-builder.yml).
; customHeader runs at the top of the generated installer script, before any page is defined.
; Caption is the title bar text of the setup wizard; UninstallCaption is the title bar text of the uninstaller.
!macro customHeader
  Caption "Nuke System Cleaner - Installer"
  UninstallCaption "Nuke System Cleaner - Uninstaller"
!macroend
