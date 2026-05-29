#Requires -Version 5.1
<#
  DEPRECATED for routine ops — prefer Railway Dashboard Variable References for DATABASE_URL.
  SSOT: documents/spec/infrastructure.md (postgres-prd-v2, not legacy postgres-prd).
  Only run when bootstrapping a fresh Railway project; never against production without review.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Token = (Get-Content (Join-Path $PSScriptRoot "..\secrets.txt") -Raw).Trim() -replace '^RailwayAPI=', ''
$ProjectId = "82730a82-b4d4-47d0-b578-f951465465fc"
$BackendId = "29539998-d8d9-4e41-82a5-f71ca223f96c"
$PostgresDevId = "43bc8dc5-c9c9-4fa3-9b7e-fd9079fd5c0a"
$PostgresStgId = "7234bbc3-c482-4009-9c88-03063521ffd1"
$PostgresPrdId = "1509c487-cf03-4c50-8c9d-8781d53ee19a"  # postgres-prd-v2 (SSOT: infrastructure.md)
$EnvProduction = "c1a3cdfc-9aa3-420d-b101-e6497714ccb9"
$EnvStaging = "c807d209-0624-4e13-aff6-61332cd0bb29"
$EnvPreview = "9bed9d58-203f-4bb5-bb17-858bcb3e2513"
$EnvDevelopment = "0951c467-6bc3-418f-af75-a96e810f4946"

$DevDbPassword = "ps-dev-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
$StgDbPassword = "ps-stg-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
$PrdDbPassword = "ps-prd-" + [guid]::NewGuid().ToString("N").Substring(0, 12)

function Invoke-Railway {
  param([string]$Query)
  $headers = @{ Authorization = "Bearer $Token"; "Content-Type" = "application/json" }
  $body = @{ query = $Query } | ConvertTo-Json -Compress
  $resp = Invoke-RestMethod -Uri "https://backboard.railway.com/graphql/v2" -Method Post -Headers $headers -Body $body
  if ($resp.PSObject.Properties.Name -contains "errors") {
    throw ($resp.errors | ConvertTo-Json -Depth 6)
  }
  return $resp.data
}

function Set-RailwayVar {
  param(
    [string]$EnvironmentId,
    [string]$ServiceId,
    [string]$Name,
    [string]$Value,
    [bool]$SkipDeploys = $false
  )
  $escaped = $Value -replace '\\', '\\\\' -replace '"', '\"'
  $skip = if ($SkipDeploys) { "skipDeploys: true" } else { "" }
  $q = "mutation { variableUpsert(input: { projectId: `"$ProjectId`", environmentId: `"$EnvironmentId`", serviceId: `"$ServiceId`", name: `"$Name`", value: `"$escaped`", $skip }) }"
  Invoke-Railway -Query $q | Out-Null
}

function Set-PostgresVars {
  param(
    [string]$EnvironmentId,
    [string]$ServiceId,
    [string]$User,
    [string]$Password,
    [string]$Database
  )
  Set-RailwayVar -EnvironmentId $EnvironmentId -ServiceId $ServiceId -Name "POSTGRES_USER" -Value $User -SkipDeploys $true
  Set-RailwayVar -EnvironmentId $EnvironmentId -ServiceId $ServiceId -Name "POSTGRES_PASSWORD" -Value $Password -SkipDeploys $true
  Set-RailwayVar -EnvironmentId $EnvironmentId -ServiceId $ServiceId -Name "POSTGRES_DB" -Value $Database -SkipDeploys $true
  Set-RailwayVar -EnvironmentId $EnvironmentId -ServiceId $ServiceId -Name "PGDATA" -Value "/var/lib/postgresql/data/pgdata" -SkipDeploys $true
}

function Update-BackendInstance {
  param([string]$EnvironmentId)
  $q = @"
mutation {
  serviceInstanceUpdate(
    serviceId: "$BackendId"
    environmentId: "$EnvironmentId"
    input: {
      rootDirectory: "backend"
      healthcheckPath: "/health"
      healthcheckTimeout: 120
      startCommand: "npm start"
    }
  )
}
"@
  Invoke-Railway -Query $q | Out-Null
}

function New-BackendDomain {
  param([string]$EnvironmentId)
  $q = "mutation { serviceDomainCreate(input: { serviceId: `"$BackendId`", environmentId: `"$EnvironmentId`" }) { domain } }"
  return (Invoke-Railway -Query $q).serviceDomainCreate.domain
}

function Deploy-Service {
  param([string]$EnvironmentId, [string]$ServiceId)
  $q = "mutation { serviceInstanceDeployV2(serviceId: `"$ServiceId`", environmentId: `"$EnvironmentId`") }"
  Invoke-Railway -Query $q | Out-Null
}

Write-Host "Configuring postgres-dev (preview + development shared credentials)..."
Set-PostgresVars -EnvironmentId $EnvDevelopment -ServiceId $PostgresDevId -User "passshare_dev" -Password $DevDbPassword -Database "passshare_dev"
Set-PostgresVars -EnvironmentId $EnvPreview -ServiceId $PostgresDevId -User "passshare_dev" -Password $DevDbPassword -Database "passshare_dev"

Write-Host "Configuring postgres-stg..."
Set-PostgresVars -EnvironmentId $EnvStaging -ServiceId $PostgresStgId -User "passshare_stg" -Password $StgDbPassword -Database "passshare_stg"

Write-Host "Configuring postgres-prd-v2..."
Set-PostgresVars -EnvironmentId $EnvProduction -ServiceId $PostgresPrdId -User "passshare_prd" -Password $PrdDbPassword -Database "passshare_prd"

$DevDatabaseUrl = "postgresql://passshare_dev:$DevDbPassword@postgres-dev.railway.internal:5432/passshare_dev"
$StgDatabaseUrl = "postgresql://passshare_stg:$StgDbPassword@postgres-stg.railway.internal:5432/passshare_stg"
$PrdDatabaseUrl = "postgresql://passshare_prd:$PrdDbPassword@postgres-prd-v2.railway.internal:5432/passshare_prd"

foreach ($envId in @($EnvProduction, $EnvStaging, $EnvPreview, $EnvDevelopment)) {
  Write-Host "Updating backend instance in $envId..."
  Update-BackendInstance -EnvironmentId $envId
}

Write-Host "Setting backend variables..."
Set-RailwayVar -EnvironmentId $EnvProduction -ServiceId $BackendId -Name "APP_ENV" -Value "prd" -SkipDeploys $true
Set-RailwayVar -EnvironmentId $EnvProduction -ServiceId $BackendId -Name "DATABASE_URL" -Value $PrdDatabaseUrl -SkipDeploys $true
Set-RailwayVar -EnvironmentId $EnvStaging -ServiceId $BackendId -Name "APP_ENV" -Value "stg" -SkipDeploys $true
Set-RailwayVar -EnvironmentId $EnvStaging -ServiceId $BackendId -Name "DATABASE_URL" -Value $StgDatabaseUrl -SkipDeploys $true
Set-RailwayVar -EnvironmentId $EnvPreview -ServiceId $BackendId -Name "APP_ENV" -Value "preview" -SkipDeploys $true
Set-RailwayVar -EnvironmentId $EnvPreview -ServiceId $BackendId -Name "DATABASE_URL" -Value $DevDatabaseUrl -SkipDeploys $true
Set-RailwayVar -EnvironmentId $EnvDevelopment -ServiceId $BackendId -Name "APP_ENV" -Value "dev" -SkipDeploys $true
Set-RailwayVar -EnvironmentId $EnvDevelopment -ServiceId $BackendId -Name "DATABASE_URL" -Value $DevDatabaseUrl -SkipDeploys $true

Write-Host "Creating backend domains..."
$domains = @{
  production = New-BackendDomain -EnvironmentId $EnvProduction
  staging = New-BackendDomain -EnvironmentId $EnvStaging
  preview = New-BackendDomain -EnvironmentId $EnvPreview
  development = New-BackendDomain -EnvironmentId $EnvDevelopment
}

Write-Host "Deploying postgres services..."
Deploy-Service -EnvironmentId $EnvDevelopment -ServiceId $PostgresDevId
Deploy-Service -EnvironmentId $EnvPreview -ServiceId $PostgresDevId
Deploy-Service -EnvironmentId $EnvStaging -ServiceId $PostgresStgId
Deploy-Service -EnvironmentId $EnvProduction -ServiceId $PostgresPrdId

Write-Host "Deploying backend services..."
Deploy-Service -EnvironmentId $EnvProduction -ServiceId $BackendId
Deploy-Service -EnvironmentId $EnvStaging -ServiceId $BackendId
Deploy-Service -EnvironmentId $EnvPreview -ServiceId $BackendId
Deploy-Service -EnvironmentId $EnvDevelopment -ServiceId $BackendId

@{
  projectId = $ProjectId
  serviceId = $BackendId
  environments = @{
    production = $EnvProduction
    staging = $EnvStaging
    preview = $EnvPreview
    development = $EnvDevelopment
  }
  domains = $domains
} | ConvertTo-Json -Depth 4
