<#
.SYNOPSIS
  Start the CDT-KiCAD provider for a Windows Scheduled Task.
.DESCRIPTION
  Resolves KICAD_MCP_TOKEN from the inherited environment or PowerShell
  SecretManagement and starts the already-built provider in HTTP mode.
  The credential is never written to command arguments, disk, or output.
#>
[CmdletBinding()]
param(
  [int]$Port = 3100,
  [string]$HostName = "127.0.0.1",
  [string]$SecretName = "kicad_mcp_token"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $repoRoot "dist\index.js"
if (-not (Test-Path -LiteralPath $entryPoint)) {
  throw "Provider is not built: $entryPoint"
}

function Resolve-ProviderToken {
  if (-not [string]::IsNullOrWhiteSpace($env:KICAD_MCP_TOKEN)) {
    return $env:KICAD_MCP_TOKEN
  }

  $getSecret = Get-Command Get-Secret -ErrorAction SilentlyContinue
  if ($null -eq $getSecret) {
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

$env:KICAD_MCP_TOKEN = Resolve-ProviderToken
$env:MCP_TRANSPORT = "http"
$env:MCP_HOST = $HostName
$env:MCP_PORT = [string]$Port

Set-Location -LiteralPath $repoRoot
& node $entryPoint
exit $LASTEXITCODE
