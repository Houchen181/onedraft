; Uninstalling removes "Start OneDraft when you sign in to Windows" (Settings → App), which the app
; registers under this name (LOGIN_ITEM in src/main/index.ts). An update keeps it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.onedraft.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "app.onedraft.desktop"
  ${endIf}
!macroend
