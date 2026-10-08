<#
.SYNOPSIS
  Execute the CDT-KiCAD Windows/KiCad native acceptance lane.
.DESCRIPTION
  Exercises install/start/health/stop/restart/reconnect and records evidence
  that cannot be honestly produced on Linux: exact Windows build, KiCad CLI
  build, Git source SHA, MCP provider/contract identity, backend state, and
  caller-supplied fixture identity.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$FixtureId,
  [string]$OutputPath = "native-acceptance.json",
  [string]$TaskName = "CDT-KiCAD-Acceptance",
  [int]$Port = 3100,
  [string]$HostName = "127.0.0.1",
  [switch]$KeepInstalled
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Native acceptance requires Windows with a real KiCad installation."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$lifecycleScript = Join-Path $PSScriptRoot "windows-service.ps1"
$smokeScript = Join-Path $PSScriptRoot "native-provider-smoke.mjs"
$resolvedOutput = if ([IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath
} else {
  Join-Path $repoRoot $OutputPath
}

function Invoke-Lifecycle {
  param([string]$LifecycleAction, [switch]$SkipBuild)
  $args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $lifecycleScript,
    "-Action", $LifecycleAction,
    "-TaskName", $TaskName,
    "-Port", [string]$Port,
    "-HostName", $HostName
  )
  if ($SkipBuild) { $args += "-SkipBuild" }

  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "Lifecycle action '$LifecycleAction' failed with exit code $LASTEXITCODE."
  }
}

function Find-KiCadCli {
  $fromPath = Get-Command kicad-cli.exe -ErrorAction SilentlyContinue
  if ($null -ne $fromPath) {
    return $fromPath.Source
  }

  $root = "C:\Program Files\KiCad"
  if (Test-Path -LiteralPath $root) {
    $candidate = Get-ChildItem -LiteralPath $root -Directory |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "bin\kicad-cli.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }

  throw "kicad-cli.exe was not found. Install KiCad or add its bin directory to PATH."
}

function Resolve-AcceptanceToken {
  if (-not [string]::IsNullOrWhiteSpace($env:KICAD_MCP_TOKEN)) {
    return $env:KICAD_MCP_TOKEN
  }

  if ($null -eq (Get-Command Get-Secret -ErrorAction SilentlyContinue)) {
    throw "KICAD_MCP_TOKEN is unset and PowerShell SecretManagement/Get-Secret is unavailable."
  }

  $secret = Get-Secret -Name "kicad_mcp_token" -ErrorAction Stop
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
    throw "Secret 'kicad_mcp_token' resolved to an empty value."
  }
  return $value
}

function Read-SmokeEvidence {
  param([string]$Path)
  $env:KICAD_MCP_TOKEN = Resolve-AcceptanceToken
  & node $smokeScript --endpoint "http://${HostName}:${Port}/mcp" --output $Path | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Native MCP smoke failed with exit code $LASTEXITCODE."
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

$installed = $false
$steps = [ordered]@{
  install = $false
  start = $false
  health = $false
  stop = $false
  restart = $false
  reconnect = $false
}

try {
  Push-Location $repoRoot
  try {
    $sourceSha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceSha)) {
      throw "Unable to resolve source Git SHA."
    }

    $os = Get-CimInstance Win32_OperatingSystem
    $kicadCli = Find-KiCadCli
    $kicadBuild = (& $kicadCli --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($kicadBuild)) {
      throw "kicad-cli --version failed."
    }

    Invoke-Lifecycle -LifecycleAction "Install"
    $installed = $true
    $steps.install = $true

    Invoke-Lifecycle -LifecycleAction "Start" -SkipBuild
    $steps.start = $true

    Invoke-Lifecycle -LifecycleAction "Health" -SkipBuild
    $steps.health = $true

    $initialSmokePath = Join-Path $env:TEMP "cdt-kicad-native-initial.json"
    $initialSmoke = Read-SmokeEvidence -Path $initialSmokePath

    Invoke-Lifecycle -LifecycleAction "Stop" -SkipBuild
    $steps.stop = $true

    Invoke-Lifecycle -LifecycleAction "Start" -SkipBuild
    Invoke-Lifecycle -LifecycleAction "Restart" -SkipBuild
    $steps.restart = $true

    Invoke-Lifecycle -LifecycleAction "Reconnect" -SkipBuild | Out-Host
    $steps.reconnect = $true

    $finalSmokePath = Join-Path $env:TEMP "cdt-kicad-native-final.json"
    $finalSmoke = Read-SmokeEvidence -Path $finalSmokePath

    $evidence = [ordered]@{
      acceptance_schema = "cdt-kicad-native-acceptance-v1"
      recorded_at_utc = [DateTime]::UtcNow.ToString("o")
      source_sha = $sourceSha
      fixture_id = $FixtureId
      os = [ordered]@{
        caption = $os.Caption
        version = $os.Version
        build_number = $os.BuildNumber
        architecture = $os.OSArchitecture
      }
      kicad = [ordered]@{
        cli_path = $kicadCli
        build = $kicadBuild
      }
      node_version = (& node --version | Out-String).Trim()
      provider = [ordered]@{
        name = $finalSmoke.provider_name
        version = $finalSmoke.provider_version
        contract_version = $finalSmoke.contract_version
        contract_hash = $finalSmoke.contract_hash
        protocol_version = $finalSmoke.protocol_version
      }
      backend = $finalSmoke.backend
      initial_backend = $initialSmoke.backend
      lifecycle = $steps
      health_semantics = "liveness_only_not_backend_readiness"
      endpoint = "http://${HostName}:${Port}/mcp"
    }

    $evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8
    Write-Output "Native acceptance evidence: $resolvedOutput"
  } finally {
    Pop-Location
  }
} finally {
  if ($installed -and -not $KeepInstalled) {
    try {
      Invoke-Lifecycle -LifecycleAction "Stop" -SkipBuild
    } catch {
      Write-Warning "Cleanup stop failed: $($_.Exception.Message)"
    }
    try {
      Invoke-Lifecycle -LifecycleAction "Uninstall" -SkipBuild
    } catch {
      Write-Warning "Cleanup uninstall failed: $($_.Exception.Message)"
    }
  }
}
