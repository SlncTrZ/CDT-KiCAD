<#
.SYNOPSIS
  Reproducible Windows-native lifecycle for CDT-KiCAD.
.DESCRIPTION
  Uses the built-in Windows Task Scheduler so no third-party service wrapper is
  required. Supported actions: install, start, health, stop, restart, reconnect,
  status, uninstall. Health is liveness only; reconnect performs the MCP read-only
  smoke that proves a client can establish a fresh session after restart.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Start", "Health", "Stop", "Restart", "Reconnect", "Status", "Uninstall")]
  [string]$Action,
  [string]$TaskName = "CDT-KiCAD",
  [int]$Port = 3100,
  [string]$HostName = "127.0.0.1",
  [string]$SecretName = "kicad_mcp_token",
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start-native-service.ps1"
$smokeScript = Join-Path $PSScriptRoot "native-provider-smoke.mjs"
$endpoint = "http://${HostName}:${Port}/mcp"
$healthUri = "http://${HostName}:${Port}/healthz"

function Assert-Windows {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "windows-service.ps1 requires Windows."
  }
}

function Test-ProviderHealth {
  try {
    $response = Invoke-RestMethod -Uri $healthUri -TimeoutSec 3
    return ($response.status -eq "ok" -and $response.provider -eq "kicad")
  } catch {
    return $false
  }
}

function Wait-ProviderHealth {
  param([bool]$ExpectedHealthy, [int]$TimeoutSec = 300)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    $healthy = Test-ProviderHealth
    if ($healthy -eq $ExpectedHealthy) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  $state = if ($ExpectedHealthy) { "healthy" } else { "stopped" }
  throw "Provider did not become $state within $TimeoutSec seconds."
}

function Resolve-ProviderToken {
  if (-not [string]::IsNullOrWhiteSpace($env:KICAD_MCP_TOKEN)) {
    return $env:KICAD_MCP_TOKEN
  }

  if ($null -eq (Get-Command Get-Secret -ErrorAction SilentlyContinue)) {
    throw "KICAD_MCP_TOKEN is unset and PowerShell SecretManagement/Get-Secret is unavailable."
  }

  $secret = Get-Secret -Name $SecretName -ErrorAction Stop
  if ($secret -is [Security.SecureString]) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try {
      return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }

  $value = [string]$secret
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Secret '$SecretName' resolved to an empty value."
  }
  return $value
}

function Assert-DurableCredential {
  $userToken = [Environment]::GetEnvironmentVariable("KICAD_MCP_TOKEN", "User")
  $machineToken = [Environment]::GetEnvironmentVariable("KICAD_MCP_TOKEN", "Machine")
  if (-not [string]::IsNullOrWhiteSpace($userToken) -or -not [string]::IsNullOrWhiteSpace($machineToken)) {
    return
  }

  if ($null -eq (Get-Command Get-Secret -ErrorAction SilentlyContinue)) {
    throw "Scheduled service needs a durable credential: configure user/machine KICAD_MCP_TOKEN or PowerShell SecretManagement '$SecretName'."
  }

  $null = Get-Secret -Name $SecretName -ErrorAction Stop
}

function Install-ProviderTask {
  Assert-DurableCredential

  if (-not $SkipBuild) {
    Push-Location $repoRoot
    try {
      & npm ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
      & npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
  }

  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "dist\index.js"))) {
    throw "dist\index.js is missing; run npm run build before service installation."
  }

  $powerShellExe = Join-Path $PSHOME "powershell.exe"
  if (-not (Test-Path -LiteralPath $powerShellExe)) {
    $powerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
  }

  $escapedScript = '"' + $startScript.Replace('"', '""') + '"'
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $escapedScript -Port $Port -HostName $HostName -SecretName $SecretName"
  $taskAction = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $currentIdentity -or [string]::IsNullOrWhiteSpace($currentIdentity.Name)) {
    throw "Unable to resolve the current Windows account for the scheduled-task principal."
  }
  $userId = $currentIdentity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description "CDT-KiCAD native MCP provider" -Force | Out-Null
  Write-Output "Installed scheduled task '$TaskName'."
}

function Start-ProviderTask {
  Start-ScheduledTask -TaskName $TaskName
  Wait-ProviderHealth -ExpectedHealthy $true
  Write-Output "Started '$TaskName'; liveness health is OK."
}

function Stop-ProviderTask {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Wait-ProviderHealth -ExpectedHealthy $false
  Write-Output "Stopped '$TaskName'; liveness endpoint is down."
}

function Invoke-ReconnectSmoke {
  $env:KICAD_MCP_TOKEN = Resolve-ProviderToken
  & node $smokeScript --endpoint $endpoint
  if ($LASTEXITCODE -ne 0) {
    throw "MCP reconnect smoke failed with exit code $LASTEXITCODE."
  }
}

Assert-Windows

switch ($Action) {
  "Install" {
    Install-ProviderTask
  }
  "Start" {
    Start-ProviderTask
  }
  "Health" {
    if (-not (Test-ProviderHealth)) {
      throw "Liveness check failed: $healthUri"
    }
    Write-Output "HEALTHY $healthUri (liveness only; not backend readiness)."
  }
  "Stop" {
    Stop-ProviderTask
  }
  "Restart" {
    Stop-ProviderTask
    Start-ProviderTask
  }
  "Reconnect" {
    if (-not (Test-ProviderHealth)) {
      Start-ProviderTask
    }
    Invoke-ReconnectSmoke
  }
  "Status" {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    [PSCustomObject]@{
      task_name = $TaskName
      task_state = [string]$task.State
      liveness = Test-ProviderHealth
      endpoint = $endpoint
    } | ConvertTo-Json -Depth 4
  }
  "Uninstall" {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Output "Uninstalled scheduled task '$TaskName'."
  }
}
