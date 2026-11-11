<#
.SYNOPSIS
    Build the collector from this checkout, stage it, and repoint the HKCU Run key.
.DESCRIPTION
    Order: build -> stage -> free-space check -> stop old collector -> back up db
    (db + -wal, after the stop so the copy is consistent) -> baseline row count
    -> repoint Run key -> start -> verify the new collector is alive and rows grow.
    Build uses `npm ci` + `npm run build` in collector\, so run it from a CLEAN
    checkout (not a dirty working copy). Stage dir is <StageRoot>\<Version>\collector
    with the FULL dist tree (robocopy /E /XF *.test.js) plus package.json
    (type=module). The collector has no runtime deps (node:sqlite): no node_modules.
    Stopped: node.exe / conhost.exe processes whose CommandLine matches
    '*<StageRoot>\*collector*index.js*' or the index.js path in the current Run
    value; node first, then conhost; never by name alone, never this script.
    After the stop, any node.exe still running a collector index.js fails the run.
    On failure it prints the backup path and, if the stop already ran, how to
    restore the old Run value.
    From the stop onward a journal (~\.aether-os\redeploy-journal.json) records the
    phase before each irreversible step; it is deleted after a verified deploy and
    left open on failure (and then blocks the next deploy).
    -DryRun (alias -WhatIf) prints every action and changes nothing.
.PARAMETER Version
    Defaults to "version" in the repo-root package.json.
.PARAMETER StageRoot
    Defaults to D:\AetherBuilds.
.NOTES
    Exit codes: 0 success (or dry run, or new collector alive but no events yet),
    1 failure (build/stage/backup/stop/start/verify), 2 bad input
    (package.json or collector\ missing, bad version, or a preflight guard: stage
    dir already non-empty or in use by the current Run value, -DbPath other than
    ~\.aether-os\collector.db, Run command over 260 characters, an existing
    ~\.aether-os\redeploy-journal.json, a non-REG_SZ Run value, -VerifySeconds
    outside 1..60; all checked before
    anything is changed).
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
$CollectorNames = @('node.exe', 'conhost.exe')
$MaxRunCommandLength = 260   # same limit as MAX_RUN_COMMAND_LENGTH in collector/src/autostart.ts

function Get-CollectorProcessMatch {
    # Pure filter so tests can feed fake Win32_Process rows. Name must be node.exe
    # or conhost.exe AND the command line must match; $ExtraIndexJs adds one more
    # exact index.js path (parsed from the current Run value).
    param([object[]]$Processes, [string]$StageRoot, [int]$ExcludePid = 0, [string]$ExtraIndexJs)
    $pattern = '*' + [WildcardPattern]::Escape($StageRoot.TrimEnd('\')) + '\*collector*index.js*'
    $extra = $null
    if ($ExtraIndexJs) { $extra = '*' + [WildcardPattern]::Escape($ExtraIndexJs) + '*' }
    @($Processes | Where-Object {
        $_.CommandLine -and ($CollectorNames -contains $_.Name) -and ([int]$_.ProcessId -ne $ExcludePid) -and
        (($_.CommandLine -like $pattern) -or ($extra -and ($_.CommandLine -like $extra)))
    })
}

function Get-RunKeyValue {
    param([string]$IndexJs, [string]$NodeExe)
    'conhost.exe --headless "{0}" "{1}"' -f $NodeExe, $IndexJs
}

function Get-RunKeyKind {
    # Registry value kind name of the Run value ('String', 'ExpandString', ...), or $null when absent.
    # A function so tests can mock it instead of reading the real registry.
    try { (Get-Item -Path $RunKeyPath).GetValueKind($RunKeyName).ToString() } catch { $null }
}

function Get-IndexJsFromRunValue {
    param([string]$RunValue)
    if ($RunValue -match '"?([^"\s][^"]*index\.js)"?\s*$') {
        $p = $Matches[1]
        # An unquoted hand-made value (node C:\x\index.js) parses to a non-path: treat as no index.
        try { [void][IO.Path]::GetFullPath($p) } catch { return $null }
        return $p
    }
    return $null
}

function Get-JournalPath {
    # The journal lives next to the collector db (~\.aether-os), never under StageRoot.
    # Derived from $ExpectedDbPath so every test that passes a temp db gets a temp journal.
    param([string]$ExpectedDbPath)
    Join-Path (Split-Path $ExpectedDbPath) 'redeploy-journal.json'
}

function Write-Journal {
    # Atomic write: <path>.tmp, then Replace (target exists) or Move. UTF-8 without BOM.
    # Timestamps are stored as ISO strings: PS 5.1 ConvertTo-Json renders a DateTime as \/Date(ms)\/.
    param([string]$Path, $Journal)
    foreach ($k in 'startedUtc', 'phaseUtc') {
        if ($Journal.$k -is [DateTime]) { $Journal.$k = $Journal.$k.ToUniversalTime().ToString('o') }
    }
    $dir = Split-Path $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = "$Path.tmp"
    $text = $Journal | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
}

function Read-Journal {
    # $null when there is no journal; throws 'journal unreadable' when the file is not a JSON object.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $j = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
        if ($null -eq $j -or $j.GetType().Name -ne 'PSCustomObject') { throw 'not a JSON object' }
    } catch {
        throw "journal unreadable: $Path ($($_.Exception.Message))"
    }
    return $j
}

function Remove-Journal {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
}

function Get-PreflightError {
    # Read-only guards, run before anything is built, stopped, backed up or repointed.
    # Returns the first problem as a message, or $null when it is safe to proceed.
    # JournalPath / RunKind / VerifySeconds are optional so older named-arg callers keep working
    # (empty JournalPath skips the journal guard; empty RunKind = Run value absent).
    param([string]$Stage, [string]$OldIndex, [string]$DbPath, [string]$ExpectedDbPath, [string]$RunValue,
          [string]$JournalPath, [string]$RunKind, [int]$VerifySeconds = 30)
    $inUse = $false
    try {
        $stageFull = [IO.Path]::GetFullPath($Stage).TrimEnd('\')
        if ($OldIndex) {
            $oldFull = [IO.Path]::GetFullPath($OldIndex)
            $inUse = $oldFull.StartsWith($stageFull + '\', [StringComparison]::OrdinalIgnoreCase)
        }
    } catch {
        return "cannot resolve stage path '$Stage': $($_.Exception.Message). Nothing was changed."
    }
    $nonEmpty = (Test-Path -LiteralPath $stageFull) -and (@(Get-ChildItem -LiteralPath $stageFull -Force -ErrorAction SilentlyContinue).Count -gt 0)
    if ($inUse -or $nonEmpty) {
        return "stage directory already exists and is not empty (or is the current deployment): $stageFull. Pass a different -Version or -StageRoot. Nothing was changed."
    }
    try { $dbFull = [IO.Path]::GetFullPath($DbPath); $expFull = [IO.Path]::GetFullPath($ExpectedDbPath) }
    catch { return "-DbPath '$DbPath' is not a valid path ($($_.Exception.Message)). Omit -DbPath. Nothing was changed." }
    if ($dbFull -ne $expFull) {
        return "-DbPath '$DbPath' is not the database the collector opens ($ExpectedDbPath, fixed in collector/src/index.ts). Omit -DbPath. Nothing was changed."
    }
    if ($RunValue.Length -gt $MaxRunCommandLength) {
        return "Run-key command is $($RunValue.Length) characters; Windows ignores commands over $MaxRunCommandLength at logon. Use a shorter -StageRoot. Nothing was changed."
    }
    if ($JournalPath -and (Test-Path -LiteralPath $JournalPath)) {
        try {
            $j = Read-Journal -Path $JournalPath
            return "an unfinished redeploy journal exists: $JournalPath (phase $($j.phase), version $($j.version)). Run scripts\redeploy-collector.ps1 -Rollback to restore the previous state, or delete the file by hand only after checking the HKCU Run value. Nothing was changed."
        } catch {
            return "$($_.Exception.Message). Check the HKCU Run value, then delete the file by hand. Nothing was changed."
        }
    }
    if ($RunKind -and $RunKind -ne 'String') {
        return "the Run value $RunKeyName is $RunKind, not REG_SZ; this script only round-trips REG_SZ. Recreate it as REG_SZ by hand first. Nothing was changed."
    }
    if ($VerifySeconds -lt 1 -or $VerifySeconds -gt 60) {
        return "-VerifySeconds $VerifySeconds is outside 1..60; everything after the build is budgeted at 120 seconds. Nothing was changed."
    }
    return $null
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

function Get-FreeBytes {
    param([string]$Path)
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))
    (New-Object IO.DriveInfo($root)).AvailableFreeSpace
}

function Get-DbBackupBytes {
    param([string]$Db)
    $n = 0
    foreach ($f in $Db, "$Db-wal") { if (Test-Path $f) { $n += (Get-Item $f).Length } }
    $n
}

function Invoke-BuildAndStage {
    param([string]$CollectorDir, [string]$Stage, [string]$IndexJs)
    foreach ($cmd in 'ci', 'run build') {
        Push-Location $CollectorDir
        try { & npm $cmd.Split(' '); if ($LASTEXITCODE -ne 0) { throw "npm $cmd failed" } } finally { Pop-Location }
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'dist') | Out-Null
    & robocopy (Join-Path $CollectorDir 'dist') (Join-Path $Stage 'dist') /E /XF '*.test.js' /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
    Copy-Item (Join-Path $CollectorDir 'package.json') (Join-Path $Stage 'package.json') -Force
    if (-not (Test-Path $IndexJs)) { throw "staged index.js missing: $IndexJs" }
}

function Stop-OldCollector {
    # Stops matching node.exe first, then conhost.exe; tolerates already-exited PIDs;
    # throws if any node.exe running a collector index.js survives.
    param([string]$StageRoot, [string]$ExtraIndexJs, [bool]$Dry)
    $procs = Get-CollectorProcessMatch -Processes (Get-WmiObject Win32_Process) -StageRoot $StageRoot -ExcludePid $PID -ExtraIndexJs $ExtraIndexJs
    if ($procs.Count -eq 0) { Write-Output 'No running collector matched.' }
    $ordered = @($procs | Where-Object { $_.Name -eq 'node.exe' }) + @($procs | Where-Object { $_.Name -ne 'node.exe' })
    foreach ($p in $ordered) {
        $procId = [int]$p.ProcessId
        if ($Dry) { Write-Output "[DRY-RUN] stop PID $procId ($($p.Name)): $($p.CommandLine)"; continue }
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { Write-Output "PID $procId already exited."; continue }
        Write-Output "[RUN] stop PID $procId ($($p.Name)): $($p.CommandLine)"
        Stop-Process -Id $procId -Force
    }
    if ($Dry) { return }
    Start-Sleep -Seconds 1
    $left = @((Get-WmiObject Win32_Process) | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -and ([int]$_.ProcessId -ne $PID) -and ($_.CommandLine -like '*collector*index.js*')
    })
    if ($left.Count -gt 0) {
        throw ("collector still running after stop: PID " + (($left | ForEach-Object { $_.ProcessId }) -join ',') + " - " + $left[0].CommandLine)
    }
}

function Test-CollectorAlive {
    param([string]$IndexJs)
    $pat = '*' + [WildcardPattern]::Escape($IndexJs) + '*'
    @((Get-WmiObject Win32_Process) | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like $pat }).Count -gt 0
}

function Test-OldCollectorRunning {
    # Read-only. Same matcher as Stop-OldCollector: every collector under <StageRoot>\*collector*index.js*
    # plus the old Run value's index.js, so it may be a different version than the Run value names.
    param([string]$StageRoot, [string]$ExtraIndexJs)
    $procs = @(Get-CollectorProcessMatch -Processes @(Get-WmiObject Win32_Process) -StageRoot $StageRoot -ExcludePid $PID -ExtraIndexJs $ExtraIndexJs)
    [bool]($procs.Count -gt 0)
}

function Set-JournalPhase {
    # Stamps the phase on the in-memory journal and persists it. Call BEFORE the step the phase names.
    param([string]$Path, $Journal, [string]$Phase)
    $Journal.phase = $Phase
    $Journal.phaseUtc = [DateTime]::UtcNow.ToString('o')
    Write-Journal -Path $Path -Journal $Journal
}

function Invoke-Redeploy {
    param([string]$Version, [string]$StageRoot, [string]$DbPath, [bool]$Dry, [int]$VerifySeconds,
          [string]$ExpectedDbPath = (Join-Path $env:USERPROFILE '.aether-os\collector.db'))

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

    $oldRun = $null
    $prop = Get-ItemProperty -Path $RunKeyPath -Name $RunKeyName -ErrorAction SilentlyContinue
    if ($prop) { $oldRun = $prop.$RunKeyName }
    $oldIndex = Get-IndexJsFromRunValue $oldRun
    Write-Output "Old Run value: $oldRun"

    $runValue = Get-RunKeyValue -IndexJs $indexJs -NodeExe $nodeExe
    # Resolve a relative -DbPath against the PowerShell location (not the .NET cwd) so the guard and later copies agree.
    try { if ($DbPath -and -not [IO.Path]::IsPathRooted($DbPath)) { $DbPath = Join-Path (Get-Location).Path $DbPath } } catch { }
    $preflight = Get-PreflightError -Stage $stage -OldIndex $oldIndex -DbPath $DbPath -ExpectedDbPath $ExpectedDbPath -RunValue $runValue `
        -JournalPath (Get-JournalPath -ExpectedDbPath $ExpectedDbPath) -RunKind (Get-RunKeyKind) -VerifySeconds $VerifySeconds
    if ($preflight) {
        Write-Output "ERROR: $preflight"
        $script:RC = 2; return
    }

    $stopRan = $false
    $journalPath = Get-JournalPath -ExpectedDbPath $ExpectedDbPath
    $journal = $null
    $bak = "$DbPath.pre-$Version-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    try {
        Write-Output '===== Step 1: build + stage ====='
        if ($Dry) {
            Write-Output '[DRY-RUN] npm ci; npm run build (collector)'
            Write-Output "[DRY-RUN] robocopy collector\dist -> $stage\dist /E /XF *.test.js; copy package.json"
        } else {
            Write-Output "[RUN] build collector and stage at $stage"
            Invoke-BuildAndStage -CollectorDir $collectorDir -Stage $stage -IndexJs $indexJs
        }

        Write-Output '===== Step 2: free-space check ====='
        if ($Dry) {
            Write-Output "[DRY-RUN] require free space on the db drive >= 2x (db + -wal)"
            Write-Output "[DRY-RUN] write journal $journalPath (phase stopping ... verified)"
        } else {
            if (-not (Test-Path $DbPath)) { throw "db not found: $DbPath" }
            $need = 2 * (Get-DbBackupBytes $DbPath)
            $free = Get-FreeBytes $DbPath
            if ($free -lt $need) { throw "not enough free space for backup: need $need bytes, have $free" }
            Write-Output "ok: need $need bytes, free $free"
            # Copy-aside state for rollback. Step 1 ran, so this run created the stage (preflight guarantees it was absent or empty).
            $now = [DateTime]::UtcNow.ToString('o')
            $journal = [ordered]@{
                schema = 1; version = $Version; startedUtc = $now; phase = 'stopping'; phaseUtc = $now
                stage = $stage; stageCreated = $true; indexJs = $indexJs; nodeExe = $nodeExe; newRunValue = $runValue
                oldRun = $oldRun; oldIndex = $oldIndex
                oldWasRunning = (Test-OldCollectorRunning -StageRoot $StageRoot -ExtraIndexJs $oldIndex)
                db = $DbPath; bak = $null
            }
        }

        Write-Output '===== Step 3: stop old collector ====='
        # Written before the kill; if this throws nothing has been stopped (fail closed).
        if (-not $Dry) { Set-JournalPhase -Path $journalPath -Journal $journal -Phase 'stopping' }
        $stopRan = $true
        Stop-OldCollector -StageRoot $StageRoot -ExtraIndexJs $oldIndex -Dry $Dry
        if (-not $Dry) { Set-JournalPhase -Path $journalPath -Journal $journal -Phase 'stopped' }

        Write-Output '===== Step 4: back up db (after stop; db + -wal, not -shm) ====='
        Invoke-Step "copy $DbPath (+ -wal if present) -> $bak" {
            Copy-Item $DbPath $bak
            if (Test-Path "$DbPath-wal") { Copy-Item "$DbPath-wal" "$bak-wal" }
        } $Dry
        if (-not $Dry) { $journal.bak = $bak; Set-JournalPhase -Path $journalPath -Journal $journal -Phase 'backed-up' }

        Write-Output '===== Step 5: baseline row count ====='
        $before = $null
        if ($Dry) { Write-Output '[DRY-RUN] read usage_events row count (baseline, collector stopped)' }
        else { $before = Get-RowCount $DbPath; Write-Output "baseline usage_events rows: $before" }

        Write-Output '===== Step 6: repoint Run key ====='
        Invoke-Step "set $RunKeyPath\$RunKeyName = $runValue" {
            Set-JournalPhase -Path $journalPath -Journal $journal -Phase 'repointing'
            Set-ItemProperty -Path $RunKeyPath -Name $RunKeyName -Value $runValue -Type String
            $readBack = (Get-ItemProperty -Path $RunKeyPath -Name $RunKeyName).$RunKeyName
            if (-not ($readBack -is [string]) -or -not ($readBack -ceq $runValue)) {
                throw "Run key read-back mismatch: wrote <$runValue>, read <$readBack>"
            }
            Set-JournalPhase -Path $journalPath -Journal $journal -Phase 'repointed'
        } $Dry

        Write-Output '===== Step 7: start ====='
        Invoke-Step "Start-Process conhost.exe --headless `"$nodeExe`" `"$indexJs`" (cwd $stage)" {
            Start-Process conhost.exe -ArgumentList '--headless', "`"$nodeExe`"", "`"$indexJs`"" -WorkingDirectory $stage
            Set-JournalPhase -Path $journalPath -Journal $journal -Phase 'launched'
        } $Dry

        Write-Output '===== Step 8: verify ====='
        if ($Dry) {
            Write-Output '[DRY-RUN] sleep 2 s, confirm a node.exe with the staged index.js is alive'
            Write-Output "[DRY-RUN] poll usage_events for up to $VerifySeconds s; growth over baseline = success; alive but no rows = exit 0 (idle); not alive = exit 1"
        } else {
            Start-Sleep -Seconds 2
            if (-not (Test-CollectorAlive $indexJs)) { throw 'new collector is not running 2 s after start (crashed?); run: node dist\index.js in the stage dir to see the error' }
            $deadline = (Get-Date).AddSeconds($VerifySeconds)
            $grew = $false
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 3
                # A throwing sample is "no sample": it never fails the deploy (only liveness does).
                $rows = $null
                try { $rows = Get-RowCount $DbPath } catch { Write-Output "row count sample failed: $($_.Exception.Message)" }
                if ($null -ne $rows -and $rows -gt $before) { Write-Output "rows grew $before -> $rows"; $grew = $true; break }
            }
            if (-not $grew) {
                if (-not (Test-CollectorAlive $indexJs)) { throw 'new collector died while waiting for events' }
                Write-Output "new collector started; no events in $VerifySeconds s (idle machine?)"
            }
            # The deploy has succeeded here: a journal failure only warns and never changes RC.
            try {
                Set-JournalPhase -Path $journalPath -Journal $journal -Phase 'verified'
                Remove-Journal -Path $journalPath
            } catch {
                Write-Output "WARNING: could not finalize the journal $journalPath ($($_.Exception.Message)). The deploy succeeded; do NOT run -Rollback; delete the journal file by hand."
            }
        }
        if ($Dry) { Write-Output "[DRY-RUN] delete journal $journalPath" }
        Write-Output 'Done.'
        $script:RC = 0; return
    } catch {
        Write-Output "ERROR: $($_.Exception.Message)"
        Write-Output "Backup path: $bak"
        if ($stopRan) {
            if ($null -ne $oldRun) {
                Write-Output "RECOVERY: old Run value was <$oldRun>; restore with Set-ItemProperty -Path $RunKeyPath -Name $RunKeyName -Value '$oldRun'; backup at $bak"
            } else {
                Write-Output "RECOVERY: no old Run value existed; backup at $bak"
            }
            Write-Output 'RECOVERY: the old collector was stopped; start the previous version by hand if needed.'
        }
        $script:RC = 1; return
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $script:RC = 1
    Invoke-Redeploy -Version $Version -StageRoot $StageRoot -DbPath $DbPath -Dry ([bool]$DryRun) -VerifySeconds $VerifySeconds
    exit $script:RC
}
