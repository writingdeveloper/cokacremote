Option Explicit

Dim shell, args, cmd, i
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 2 Then
    WScript.Quit 2
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & QuoteArg(args(0)) & _
      " -ConfigPath " & QuoteArg(args(1))

For i = 2 To args.Count - 1
    cmd = cmd & " " & QuoteArg(args(i))
Next

WScript.Quit shell.Run(cmd, 0, True)

Function QuoteArg(value)
    QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
