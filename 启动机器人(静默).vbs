' =========================================================
'  QQ Bot - Silent background launcher (no window)
'
'  Double-click to run. Log goes to logs\qq-bot.log
'  Stop with  Stop bot.ps1
'
'  Prerequisite: SnowLuma is running and QQ is logged in.
' =========================================================
Option Explicit

Dim sh, fso, scriptDir, rootDir, logDir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This file lives in the project root (also works if placed in scripts\).
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
If fso.FileExists(scriptDir & "\qq-snowluma-bot.mjs") Then
  rootDir = scriptDir
ElseIf fso.FileExists(fso.GetParentFolderName(scriptDir) & "\qq-snowluma-bot.mjs") Then
  rootDir = fso.GetParentFolderName(scriptDir)
Else
  MsgBox "Cannot find qq-snowluma-bot.mjs. Put this file in the llm-router project root.", 16, "QQ Bot"
  WScript.Quit 1
End If

logDir = rootDir & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

sh.CurrentDirectory = rootDir

' 0 = hidden window, False = do not wait.
' Wrap with cmd /c to redirect output into the log file.
sh.Run "cmd /c node qq-snowluma-bot.mjs >> logs\qq-bot.log 2>&1", 0, False
