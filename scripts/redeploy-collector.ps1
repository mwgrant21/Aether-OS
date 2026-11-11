<#
.SYNOPSIS
    Build the collector from this checkout, stage it, and repoint the HKCU Run key.
.DESCRIPTION
    Order: build -> stage -> back up db -> stop old collector -> repoint Run key
    -> start -> verify a usage_events row count grows.
    Build uses `npm ci` + `npm run build` in collector\, so run it from a CLEAN
    checkout (not a dirty working copy). Stage dir is <StageRoot>\<Version>\collector
    with the FULL dist tree (robocopy /E /XF *.test.js) plus package.json
    (type=module). The collector has no runtime deps (node:sqlite): no node_modules.
    Only processes whose CommandLine matches '*<StageRoot>\*collector*index.js*'
    are stopped (conhost wrapper and node), never by name alone, never this script.
    -DryRun (alias -WhatIf) prints every action and changes nothing.
.PARAMETER Version
    Defaults to "version" in the repo-root package.json.
.PARAMETER StageRoot
    Defaults to D:\AetherBuilds.
.NOTES
    Exit codes: 0 success (or dry run), 1 failure (build/stage/backup/start/verify),
    2 bad input (package.json or collector\ missing, bad version).
    PowerShell 5.1. The Run key value matches the hand-made one:
    conhost.exe --headless "<node.exe>" "<staged index.js>"
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$StageRoot = 'D:\AetherBuilds',
    [string]$DbPath = (Join-Path $env:USERPROFILE '.aether-os\collector.db'),
    [Alias('WhatIf')]
    [switch]$DryRun,
    [int]$VerifySeconds = 30
)

$ErrorActionPreference = 'Stop'
$RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunKeyName = 'AetherCollector'

function Get-CollectorProcessMatch {
    # Pure filter so tests can feed fake Win32_Process rows. Never matches by name alone.
    param([object[]]$Processes, [string]$StageRoot, [int]$ExcludePid = 0)
    $pattern = '*' + $StageRoot.TrimEnd('\') + '\*collector*index.js*'
    @($Processes | Where-Object {
        $_.CommandLine -and ($_.CommandLine -like $pattern) -and ([int]$_.ProcessId -ne $ExcludePid)
    })
}

function Get-RunKeyValue {
    param([string]$IndexJs, [string]$NodeExe)
    'conhost.exe --headless "{0}" "{1}"' -f $NodeExe, $IndexJs
}

function Invoke-Step {
    # Runs $Action unless $Dry; always prints what it is about to do.
    param([string]$Label, [scriptblock]$Action, [bool]$Dry)
    if ($Dry) { Write-Output "[DRY-RUN] $Label"; return }
    Write-Output "[RUN] $Label"
    & $Action
}

function Get-RowCount {
    param([string]$Db)
    $js = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('SELECT COUNT(*) c FROM usage_events').get().c)"
    $out = & node -e $js $Db
    if ($LASTEXITCODE -ne 0) { throw 'row count query failed' }
    [int64]($out | Select-Object -Last 1)
}

function Invoke-Redeploy {
    param([string]$Version, [string]$StageRoot, [string]$DbPath, [bool]$Dry, [int]$VerifySeconds)

    $repo = Split-Path -Parent $PSScriptRoot
    $pkgPath = Join-Path $repo 'package.json'
    $collectorDir = Join-Path $repo 'collector'
    if (-not (Test-Path $pkgPath) -or -not (Test-Path $collectorDir)) {
        Write-Output "ERROR: package.json or collector\ not found under $repo"
        $script:RC = 2; return
    }
    if (-not $Version) { $Version = (Get-Content -Raw $pkgPath | ConvertFrom-Json).version }
    if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') {
        Write-Output "ERROR: bad version '$Version'"
        $script:RC = 2; return
    }
    $stage = Join-Path (Join-Path $StageRoot $Version) 'collector'
    $indexJs = Join-Path $stage 'dist\index.js'
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    Write-Output "Version: $Version"
    Write-Output "Stage:   $stage"
    Write-Output "Db:      $DbPath"
    if ($Dry) { Write-Output 'DRY-RUN: nothing will be changed.' }

    try {
        Write-Output '===== Step 1: build ====='
        Invoke-Step 'npm ci (collector)' { Push-Location $collectorDir; try { & npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } } finally { Pop-Location } } $Dry
        Invoke-Step 'npm run build (collector)' { Push-Location $collectorDir; try { & npm run build; if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' } } finally { Pop-Location } } $Dry

        Write-Output '===== Step 2: stage ====='
        Invoke-Step "robocopy collector\dist -> $stage\dist /E /XF *.test.js" {
            New-Item -ItemType Directory -Force -Path (Join-Path $stage 'dist') | Out-Null
            & robocopy (Join-Path $collectorDir 'dist') (Join-Path $stage 'dist') /E /XF '*.test.js' /NFL /NDL /NJH /NJS | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
            Copy-Item (Join-Path $collectorDir 'package.json') (Join-Path $stage 'package.json') -Force
            if (-not (Test-Path $indexJs)) { throw "staged index.js missing: $indexJs" }
        } $Dry

        Write-Output '===== Step 3: back up db ====='
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $bak = "$DbPath.pre-$Version-$stamp.bak"
        Invoke-Step "copy $DbPath (+ -wal/-shm if present) -> $bak" {
            if (-not (Test-Path $DbPath)) { throw "db not found: $DbPath" }
            Copy-Item $DbPath $bak
            foreach ($sfx in '-wal', '-shm') { if (Test-Path "$DbPath$sfx") { Copy-Item "$DbPath$sfx" "$bak$sfx" } }
        } $Dry
        $before = $null
        if (-not $Dry) { $before = Get-RowCount $DbPath; Write-Output "usage_events rows before: $before" }

        Write-Output '===== Step 4: stop old collector ====='
        $procs = Get-CollectorProcessMatch -Processes (Get-WmiObject Win32_Process) -StageRoot $StageRoot -ExcludePid $PID
        if ($procs.Count -eq 0) { Write-Output 'No running collector matched.' }
        foreach ($p in $procs) {
            $procId = $p.ProcessId
            Invoke-Step "stop PID $procId ($($p.Name)): $($p.CommandLine)" { Stop-Process -Id $procId -Force } $Dry
        }

        Write-Output '===== Step 5: repoint Run key ====='
        $runValue = Get-RunKeyValue -IndexJs $indexJs -NodeExe $nodeExe
        Invoke-Step "set $RunKeyPath\$RunKeyName = $runValue" { Set-ItemProperty -Path $RunKeyPath -Name $RunKeyName -Value $runValue } $Dry

        Write-Output '===== Step 6: start ====='
        Invoke-Step "Start-Process conhost.exe --headless `"$nodeExe`" `"$indexJs`" (cwd $stage)" {
            Start-Process conhost.exe -ArgumentList '--headless', "`"$nodeExe`"", "`"$indexJs`"" -WorkingDirectory $stage
        } $Dry

        Write-Output '===== Step 7: verify ====='
        if ($Dry) {
            Write-Output "[DRY-RUN] poll usage_events row count for up to $VerifySeconds s; expect growth over the pre-start count"
        } else {
            $deadline = (Get-Date).AddSeconds($VerifySeconds)
            $grew = $false
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 3
                $now = Get-RowCount $DbPath
                if ($now -gt $before) { Write-Output "rows grew $before -> $now"; $grew = $true; break }
            }
            if (-not $grew) { throw "row count did not grow in $VerifySeconds s (still $before); idle machine or failed start" }
        }
        Write-Output 'Done.'
        $script:RC = 0; return
    } catch {
        Write-Output "ERROR: $($_.Exception.Message)"
        $script:RC = 1; return
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $script:RC = 1
    Invoke-Redeploy -Version $Version -StageRoot $StageRoot -DbPath $DbPath -Dry ([bool]$DryRun) -VerifySeconds $VerifySeconds
    exit $script:RC
}
