' Creates a desktop shortcut "PhotoCraft (GenFill)" that starts GenFill, which in turn
' starts PhotoCraft. Uses the PhotoCraft icon when the PhotoCraft folder is set.
Option Explicit
Dim sh, fso, dir, link, icon, cfg, re, m
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

icon = dir & "\node_modules\electron\dist\electron.exe,0"
If fso.FileExists(dir & "\config.json") Then
  cfg = fso.OpenTextFile(dir & "\config.json", 1).ReadAll
  Set re = New RegExp
  re.Pattern = """photocraftDir""\s*:\s*""([^""]+)"""
  Set m = re.Execute(cfg)
  If m.Count > 0 Then
    Dim exe
    exe = Replace(m(0).SubMatches(0), "\\", "\") & "\photocraft.exe"
    If fso.FileExists(exe) Then icon = exe & ",0"
  End If
End If

Set link = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\PhotoCraft (GenFill).lnk")
link.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
link.Arguments = """" & dir & "\Start GenFill.vbs"""
link.WorkingDirectory = dir
link.IconLocation = icon
link.Description = "PhotoCraft with Generative Fill (Ctrl+Alt+G)"
link.Save
MsgBox "Shortcut ""PhotoCraft (GenFill)"" created on your desktop.", 64, "GenFill"
