[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$BackendPort = 3001
$FrontendPort = 5173
$BackendHealthUrl = "http://127.0.0.1:$BackendPort/health"
$FrontendUrl = "http://localhost:$FrontendPort/"
$LogDirectory = Join-Path $ProjectRoot 'logs'
$StartupLog = Join-Path $LogDirectory 'startup.log'
$BackendOutputLog = Join-Path $LogDirectory 'backend.out.log'
$BackendErrorLog = Join-Path $LogDirectory 'backend.err.log'
$FrontendOutputLog = Join-Path $LogDirectory 'frontend.out.log'
$FrontendErrorLog = Join-Path $LogDirectory 'frontend.err.log'

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

function Write-StartupLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $StartupLog -Value $line -Encoding UTF8
}

function Get-SafeErrorMessage {
    param([Parameter(Mandatory)][System.Exception]$Exception)

    return ($Exception.Message `
        -replace '(?i)(authorization\s*:\s*bearer\s+)[^\s]+', '$1<redacted>' `
        -replace '(?i)(bearer\s+)[^\s]+', '$1<redacted>' `
        -replace '(?i)(COACH_API_TOKEN\s*[=:]\s*)[^\s]+', '$1<redacted>')
}

function Test-HealthyEndpoint {
    param([Parameter(Mandatory)][string]$Uri)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Get -TimeoutSec 4
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    } catch {
        return $false
    }
}

function Test-PortInUse {
    param([Parameter(Mandatory)][int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $listener
}

function Wait-ForHealthyEndpoint {
    param(
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][string]$Uri,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-HealthyEndpoint -Uri $Uri) {
            Write-StartupLog "$ServiceName is healthy: $Uri"
            return $true
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Start-CoachService {
    param(
        [Parameter(Mandatory)][string]$ServiceName,
        [Parameter(Mandatory)][string]$HealthUri,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$OutputLog,
        [Parameter(Mandatory)][string]$ErrorLog
    )

    if (Test-HealthyEndpoint -Uri $HealthUri) {
        Write-StartupLog "$ServiceName is already healthy; no new process started."
        return
    }

    if (Test-PortInUse -Port $Port) {
        throw "$ServiceName port $Port is already occupied, but its health endpoint is not ready. No duplicate process was started."
    }

    Write-StartupLog "Starting $ServiceName with npm.cmd $($Arguments -join ' ')"
    Start-Process `
        -FilePath 'npm.cmd' `
        -ArgumentList $Arguments `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutputLog `
        -RedirectStandardError $ErrorLog | Out-Null

    if (-not (Wait-ForHealthyEndpoint -ServiceName $ServiceName -Uri $HealthUri)) {
        throw "$ServiceName did not become healthy within the startup timeout. See $OutputLog and $ErrorLog."
    }
}

try {
    Write-StartupLog 'Startup request received.'

    Start-CoachService `
        -ServiceName 'Backend' `
        -HealthUri $BackendHealthUrl `
        -Port $BackendPort `
        -Arguments @('--prefix', 'backend', 'run', 'dev') `
        -OutputLog $BackendOutputLog `
        -ErrorLog $BackendErrorLog

    Start-CoachService `
        -ServiceName 'Frontend' `
        -HealthUri $FrontendUrl `
        -Port $FrontendPort `
        -Arguments @('--prefix', 'frontend', 'run', 'dev') `
        -OutputLog $FrontendOutputLog `
        -ErrorLog $FrontendErrorLog

    if (-not $NoBrowser) {
        Start-Process $FrontendUrl | Out-Null
        Write-StartupLog "Opened $FrontendUrl in the default browser."
    }

    Write-StartupLog 'Startup verification completed successfully.'
    exit 0
} catch {
    $safeMessage = Get-SafeErrorMessage -Exception $_.Exception
    Write-StartupLog "Startup failed: $safeMessage"
    exit 1
}
