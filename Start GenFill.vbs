' Starts GenFill in the background (no console window). On first run it installs
' the dependencies. GenFill then starts PhotoCraft itself with the control port open.
' Open the prompt bar with the shortcut (default Ctrl+Alt+G).
Option Explicit
Dim sh, fso, dir, electron
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
electron = dir & "\node_modules\electron\dist\electron.exe"

If sh.Run("cmd /c where npm >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.", 48, "GenFill"
  WScript.Quit 1
End If

If Not fso.FileExists(electron) Then
  MsgBox "First start: installing dependencies. This takes about a minute, GenFill opens when it is done.", 64, "GenFill"
  If sh.Run("cmd /c npm install --no-audit --no-fund", 0, True) <> 0 Then
    MsgBox "npm install failed. Run start-debug.cmd to see the error.", 16, "GenFill"
    WScript.Quit 1
  End If
End If

' compile (fast) so local code changes are always picked up
If sh.Run("cmd /c npm run build", 0, True) <> 0 Then
  MsgBox "Build failed. Run start-debug.cmd to see the error.", 16, "GenFill"
  WScript.Quit 1
End If

' window style 1: Electron has no console, and style 0 would stop it from painting its window
sh.Run """" & electron & """ """ & dir & """ --hidden", 1, False
