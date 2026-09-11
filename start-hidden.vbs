Option Explicit
Dim shell, fso, baseDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = baseDir
If Not fso.FolderExists(fso.BuildPath(baseDir, "node_modules")) Then
  MsgBox "node_modules is missing. Run start.bat once first so npm install can complete.", vbExclamation, "O-Steam-Idle"
  WScript.Quit 1
End If
cmd = "cmd.exe /d /c npm run build && node dist\src\server.js"
shell.Run cmd, 0, False
