param(
    [string]$TaskName = "CodeforcesCoachStartup",
    [string]$ScriptPath = "D:\website Coach\scripts\start-coach.ps1"
)

$ErrorActionPreference = "Stop"

$pshPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$userId = "$env:COMPUTERNAME\$env:USERNAME"
$tr = "`"$pshPath`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`""

$trigger = New-JobTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden

Register-ScheduledTask -TaskName $TaskName -Description "Start Codeforces Coach frontend and backend automatically at user logon" -Trigger $trigger -Action (New-ScheduledTaskAction -Execute $pshPath -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`"") -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive) -Force

Write-Host "Task registered successfully"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State, Triggers | Format-List