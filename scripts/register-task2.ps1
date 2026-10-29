$taskName = "CodeforcesCoachStartup"
$scriptPath = "D:\website Coach\scripts\start-coach.ps1"
$pshPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$userId = "$env:COMPUTERNAME\$env:USERNAME"

$tr = "`"$pshPath`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"`$scriptPath`""

$argList = @(
    "/Create",
    "/TN", "`"$taskName`"",
    "/TR", $tr,
    "/SC", "ONLOGON",
    "/RU", "`"$userId`"",
    "/RL", "HIGHEST",
    "/F"
)

Write-Host "Running: schtasks.exe $argList"
& "schtasks.exe" $argList