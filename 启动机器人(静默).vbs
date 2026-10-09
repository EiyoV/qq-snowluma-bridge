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

' --use-system-ca (Node 22.15+) trusts the Windows cert store, which is needed
' behind TLS-inspecting proxies. Probe once; fall back to plain node if unsupported.
Dim caArg
caArg = ""
If sh.Run("cmd /c node --use-system-ca -e ""0"" >nul 2>&1", 0, True) = 0 Then
  caArg = "--use-system-ca "
  sh.Environment("Process")("QQBOT_USE_SYSTEM_CA") = "1"
End If

' First run on a new machine: no API key yet. Show the setup wizard in a real
' window and wait for it. Without this the bot would connect to QQ but never
' reply, and in silent mode the user would see no error at all.
If sh.Run("cmd /c node " & caArg & "scripts\check-config.mjs", 0, True) <> 0 Then
  MsgBox "No API key configured yet." & vbCrLf & vbCrLf & _
         "A setup wizard will open. Paste at least one API key, then the bot" & vbCrLf & _
         "starts by itself. API keys can be edited later in the text file" & vbCrLf & _
         "next to this launcher.", _
         64, "QQ Bot - first run"
  sh.Run "cmd /c node " & caArg & "scripts\setup.mjs", 1, True
  ' Re-check: if the wizard was dismissed without entering anything, do not start
  ' a bot that can never reply.
  If sh.Run("cmd /c node " & caArg & "scripts\check-config.mjs", 0, True) <> 0 Then
    MsgBox "Still no API key - the bot was NOT started." & vbCrLf & vbCrLf & _
           "Edit the API key text file next to this launcher, then run this" & vbCrLf & _
           "file again.", 16, "QQ Bot"
    WScript.Quit 1
  End If
End If

' Tell the bot it is running headless. Its stdout goes to the log file, so it
' must never try to prompt for input - the user would see nothing.
sh.Environment("Process")("QQBOT_SILENT") = "1"

' 0 = hidden window, False = do not wait.
' Wrap with cmd /c to redirect output into the log file.
sh.Run "cmd /c node " & caArg & "qq-snowluma-bot.mjs >> logs\qq-bot.log 2>&1", 0, False
