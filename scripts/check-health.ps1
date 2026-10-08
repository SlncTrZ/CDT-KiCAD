<#
.SYNOPSIS
  Liveness probe for a Windows-native CDT-KiCAD provider instance.
.DESCRIPTION
  Polls GET /healthz on the provider's HTTP port. Exit 0 = healthy,
  exit 1 = unhealthy. Intended for Task Scheduler / NSSM / orchestrator
  health checks. No credentials needed (health endpoint is unauthenticated
  by design) and no side effects.
.EXAMPLE
  .\scripts\check-health.ps1 -Port 3100
#>
param(
  [string]$Server = "127.0.0.1",
  [int]$Port = 3100,
  [int]$TimeoutSec = 5
)

try {
  $res = Invoke-RestMethod -Uri "http://${Server}:${Port}/healthz" -TimeoutSec $TimeoutSec
  if ($res.status -eq "ok" -and $res.provider -eq "kicad") {
    Write-Output ("OK {0} contract={1}" -f $res.provider_version, $res.contract_version)
    exit 0
  }
  Write-Output ("UNHEALTHY body: {0}" -f ($res | ConvertTo-Json -Compress))
  exit 1
} catch {
  Write-Output ("UNHEALTHY {0}" -f $_.Exception.Message)
  exit 1
}
