Option Explicit

' Use the windowless script host so the scheduled check never opens a terminal.
' Wait for PowerShell and preserve its exit code for Task Scheduler.
Dim shell, fso, root, powershell, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = Chr(34) & powershell & Chr(34) & " -NoProfile -NonInteractive -WindowStyle Hidden -File " & Chr(34) & root & "\Start-TraeAPI.ps1" & Chr(34) & " -Scheduled"
WScript.Quit shell.Run(command, 0, True)
