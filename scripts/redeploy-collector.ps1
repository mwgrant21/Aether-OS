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
    On failure it prints the backup path. From the stop onward a journal
    (~\.aether-os\redeploy-journal.json) records the phase before each irreversible
    step; it is deleted after a verified deploy. If the deploy fails once the journal
    is open, the same rollback as -Rollback runs automatically (exit 1 when it
    completes; exit 3, journal left open and RECOVERY lines printed, when it does
    not; an open journal blocks the next deploy). A failure before the journal
    opens changed nothing but the stage dir, which is renamed aside (exit 1).
    -Rollback reads that journal and undoes an unfinished deploy: stops the NEW
    collector (exact index.js match), restores the old Run value only if it still
    holds the value this script wrote (compare-and-swap), relaunches the old
    collector once (never a second copy), moves the staged dir aside, then deletes
    the journal. It never restores the db (the backup path is printed). Idempotent.
    -DryRun (alias -WhatIf) prints every action and changes nothing.
.PARAMETER Version
    Defaults to "version" in the repo-root package.json.
.PARAMETER StageRoot
    Defaults to D:\AetherBuilds. A relative path is resolved against the current
    PowerShell location; forward slashes are normalised.
.PARAMETER Rollback
    Undo an unfinished deploy from ~\.aether-os\redeploy-journal.json. Needs no
    -Version/-StageRoot/-DbPath. With -DryRun it prints each rollback step only.
.NOTES
    Exit codes: 0 success (or dry run, or new collector alive but no events yet),
    1 failure (build/stage/backup/stop/start/verify; nothing changed, or changed
    and fully rolled back), 2 bad input
    (package.json or collector\ missing, bad version, or a preflight guard: stage
    dir already non-empty or in use by the current Run value, -DbPath other than
    ~\.aether-os\collector.db, Run command over 260 characters, an existing
    ~\.aether-os\redeploy-journal.json, a non-REG_SZ Run value, -VerifySeconds
    outside 1..60, or an unparseable -StageRoot; all checked before
    anything is changed), or -Rollback with no journal / an unreadable journal.
    3 rollback incomplete, from -Rollback or from a failed deploy's automatic
    rollback: a manual step is needed (RECOVERY lines are printed) and the journal
    is left open. -Rollback exits 0 when complete or when it only
    removed a stale journal of a deploy that had verified.
    -DryRun -Rollback always exits 0 once the journal is readable; read the printed
    lines for what a real run would leave undone.
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
    [int]$VerifySeconds = 30,
    [switch]$Rollback
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
    # The open-journal guard runs first: an unfinished redeploy means the state is unknown, so
    # every other advice (e.g. "pass a different -Version") would be premature.
    if ($JournalPath -and (Test-Path -LiteralPath $JournalPath)) {
        try {
            $j = Read-Journal -Path $JournalPath
            return "an unfinished redeploy journal exists: $JournalPath (phase $($j.phase), version $($j.version)). Run scripts\redeploy-collector.ps1 -Rollback to restore the previous state, or delete the file by hand only after checking the HKCU Run value. Nothing was changed."
        } catch {
            return "$($_.Exception.Message). Check the HKCU Run value, then delete the file by hand. Nothing was changed."
        }
    }
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
    # Counts node.exe only (a lone conhost.exe is not a running collector), mirroring R3's own check.
    param([string]$StageRoot, [string]$ExtraIndexJs)
    $procs = @(Get-CollectorProcessMatch -Processes @(Get-WmiObject Win32_Process) -StageRoot $StageRoot -ExcludePid $PID -ExtraIndexJs $ExtraIndexJs | Where-Object { $_.Name -eq 'node.exe' })
    [bool]($procs.Count -gt 0)
}

function Set-JournalPhase {
    # Stamps the phase on the in-memory journal and persists it. Call BEFORE the step the phase names.
    param([string]$Path, $Journal, [string]$Phase)
    $Journal.phase = $Phase
    $Journal.phaseUtc = [DateTime]::UtcNow.ToString('o')
    Write-Journal -Path $Path -Journal $Journal
}

function Set-JournalPhaseLagging {
    # For phases after the Run write is guarded: a failed write only leaves the file one phase behind
    # (the in-memory journal still drives auto-rollback; -Rollback's compare-and-swap copes), so it warns and continues.
    param([string]$Path, $Journal, [string]$Phase)
    try { Set-JournalPhase -Path $Path -Journal $Journal -Phase $Phase }
    catch { Write-Output "WARNING: could not write journal phase '$Phase' to $Path ($($_.Exception.Message)); continuing, the file lags one phase." }
}

function Move-FailedStageAside {
    # Failure BEFORE the journal opened: the only change is the stage dir this run created. Rename it aside
    # (never delete) so a same-version rerun is not blocked by the non-empty-stage refusal. Best effort.
    param([string]$Stage, [string]$Version, $OldRun, $OldIndex)
    $probe = [ordered]@{ stageCreated = $true; stage = $Stage; version = $Version; oldRun = $OldRun; oldIndex = $OldIndex }
    $why = Test-JournalRenamable $probe
    if ($why) { Write-Output "stage dir not moved aside: $why"; return }
    $newName = 'collector.failed-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    try {
        Write-Output "[RUN] rename $Stage -> $newName"
        Rename-Item -LiteralPath $Stage -NewName $newName
    } catch {
        Write-Output "WARNING: could not move the stage dir aside ($($_.Exception.Message)); by hand: Rename-Item -LiteralPath '$Stage' -NewName '$newName'"
    }
}

$StopNewWaitSeconds = 1   # pause between the rollback stop and the survivor check
$VersionPattern = '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$'   # same rule Invoke-Redeploy applies to -Version

function Get-ExactIndexProcessMatch {
    # Pure filter. node.exe / conhost.exe whose command line holds the exact full index.js path as a whole
    # token (so index.js.bak and sibling version dirs do not match). Misses 8.3, forward-slash and
    # relative spellings: Stop-NewCollector's broad survivor check covers those.
    param([object[]]$Processes, [string]$IndexJs, [int]$ExcludePid = 0)
    if (-not $IndexJs) { return @() }
    $re = '(?i)(^|[\s"])' + [regex]::Escape($IndexJs) + '("|\s|$)'
    @($Processes | Where-Object {
        $_.CommandLine -and ($CollectorNames -contains $_.Name) -and ([int]$_.ProcessId -ne $ExcludePid) -and ($_.CommandLine -match $re)
    })
}

function Stop-NewCollector {
    # Rollback stop: exact matches for $IndexJs only (never the StageRoot wildcard, which would also hit the
    # old collector rollback relaunches). A row that exactly matches $ExemptIndexJs (the old index, which may
    # already be running) is never stopped and never counts as a survivor. Node first, then conhost; then a
    # BROAD survivor check (any other node.exe with a collector index.js) throws.
    param([string]$IndexJs, [string]$ExemptIndexJs, [bool]$Dry)
    $all = @(Get-WmiObject Win32_Process)
    $exemptIds = @(Get-ExactIndexProcessMatch -Processes $all -IndexJs $ExemptIndexJs -ExcludePid $PID | ForEach-Object { [int]$_.ProcessId })
    $procs = @(Get-ExactIndexProcessMatch -Processes $all -IndexJs $IndexJs -ExcludePid $PID | Where-Object { $exemptIds -notcontains [int]$_.ProcessId })
    if ($procs.Count -eq 0) { Write-Output 'No running new collector matched.' }
    $ordered = @($procs | Where-Object { $_.Name -eq 'node.exe' }) + @($procs | Where-Object { $_.Name -ne 'node.exe' })
    foreach ($p in $ordered) {
        $procId = [int]$p.ProcessId
        if ($Dry) { Write-Output "[DRY-RUN] stop PID $procId ($($p.Name)): $($p.CommandLine)"; continue }
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { Write-Output "PID $procId already exited."; continue }
        Write-Output "[RUN] stop PID $procId ($($p.Name)): $($p.CommandLine)"
        Stop-Process -Id $procId -Force
    }
    if ($Dry) { return }
    Start-Sleep -Seconds $StopNewWaitSeconds
    $now = @(Get-WmiObject Win32_Process)
    $exemptNow = @(Get-ExactIndexProcessMatch -Processes $now -IndexJs $ExemptIndexJs -ExcludePid $PID | ForEach-Object { [int]$_.ProcessId })
    $left = @($now | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -and ([int]$_.ProcessId -ne $PID) -and ($_.CommandLine -like '*collector*index.js*') -and
        ($exemptNow -notcontains [int]$_.ProcessId)
    })
    if ($left.Count -gt 0) {
        throw ("collector still running after rollback stop: PID " + (($left | ForEach-Object { $_.ProcessId }) -join ',') + " - " + $left[0].CommandLine)
    }
}

function Get-NodeExeFromRunValue {
    # node.exe path from the full form conhost.exe --headless "<node>" "<index.js>", else $null.
    param([string]$RunValue)
    if ($RunValue -match '^conhost\.exe --headless "([^"]+)" "[^"]+index\.js"$') { return $Matches[1] }
    return $null
}

function Get-JournalField {
    # Works on the parsed-JSON object and on the in-memory ordered hashtable alike.
    param($Journal, [string]$Name)
    if ($Journal -is [System.Collections.IDictionary]) { return $Journal[$Name] }
    return $Journal.$Name
}

function Test-JournalHasField {
    param($Journal, [string]$Name)
    if ($Journal -is [System.Collections.IDictionary]) { return $Journal.Contains($Name) }
    return [bool]($Journal.PSObject.Properties[$Name])
}

function Get-JournalOldIndexes {
    # The old index.js as the journal states it and as re-parsed from the raw old Run value.
    param($Journal)
    $oldRun = Get-JournalField $Journal 'oldRun'
    $list = @(Get-JournalField $Journal 'oldIndex')
    if ($oldRun -is [string]) { $list += @(Get-IndexJsFromRunValue $oldRun) }
    @($list | Where-Object { $_ -is [string] -and $_ })
}

function Test-JournalShape {
    # $null when the journal has every field with the right type, else a reason.
    param($Journal)
    $strings = 'version', 'phase', 'stage', 'indexJs', 'nodeExe', 'newRunValue', 'db'
    $required = $strings + @('schema', 'startedUtc', 'phaseUtc', 'stageCreated', 'oldRun', 'oldIndex', 'oldWasRunning', 'bak')
    foreach ($f in $required) {
        if (-not (Test-JournalHasField $Journal $f)) { return "journal field '$f' is missing" }
    }
    if ((Get-JournalField $Journal 'schema') -ne 1) { return 'journal schema is not 1' }
    foreach ($f in $strings) {
        if (-not ((Get-JournalField $Journal $f) -is [string])) { return "journal field '$f' is not a string" }
    }
    foreach ($f in 'startedUtc', 'phaseUtc') {
        if (-not ((Get-JournalField $Journal $f) -is [string])) { return "journal field '$f' is not a string timestamp" }
    }
    foreach ($f in 'stageCreated', 'oldWasRunning') {
        if (-not ((Get-JournalField $Journal $f) -is [bool])) { return "journal field '$f' is not a boolean" }
    }
    foreach ($f in 'oldRun', 'oldIndex', 'bak') {
        $v = Get-JournalField $Journal $f
        if ($null -ne $v -and -not ($v -is [string])) { return "journal field '$f' is neither null nor a string" }
    }
    if ((Get-JournalField $Journal 'version') -notmatch $VersionPattern) { return 'journal version is not a valid version' }
    return $null
}

function Test-JournalKillable {
    # Gates the rollback kill: $null when indexJs is a normalised collector path inside this version's stage
    # and is not the old index; else a reason.
    param($Journal)
    $ix = [string](Get-JournalField $Journal 'indexJs')
    $stage = [string](Get-JournalField $Journal 'stage')
    $ver = [string](Get-JournalField $Journal 'version')
    if ($ver -notmatch $VersionPattern) { return 'journal version is not a valid version' }
    if (-not [IO.Path]::IsPathRooted($ix)) { return "indexJs is not an absolute path: $ix" }
    try { $full = [IO.Path]::GetFullPath($ix) } catch { return "indexJs is not a valid path: $ix" }
    if (-not ($full -ceq $ix)) { return "indexJs is not a normalised path (.., forward slashes or relative parts): $ix" }
    if (-not $ix.EndsWith('\collector\dist\index.js', [StringComparison]::OrdinalIgnoreCase)) { return "indexJs does not end in \collector\dist\index.js: $ix" }
    if (-not $ix.Equals($stage + '\dist\index.js', [StringComparison]::OrdinalIgnoreCase)) { return "indexJs is not stage + \dist\index.js (stage $stage): $ix" }
    if (-not $stage.EndsWith("\$ver\collector", [StringComparison]::OrdinalIgnoreCase)) { return "stage does not end in \$ver\collector: $stage" }
    foreach ($old in @(Get-JournalOldIndexes $Journal)) {
        try { $oldFull = [IO.Path]::GetFullPath($old) } catch { continue }
        if ($oldFull.Equals($full, [StringComparison]::OrdinalIgnoreCase)) { return "indexJs is the old collector's index.js: $ix" }
    }
    return $null
}

function Test-JournalRestorable {
    # Gates the Run-value restore (the write itself is the ordinal compare-and-swap in the engine).
    param($Journal)
    $new = Get-JournalField $Journal 'newRunValue'
    if (-not ($new -is [string]) -or $new.Length -eq 0) { return 'newRunValue is not a non-empty string' }
    $old = Get-JournalField $Journal 'oldRun'
    if ($null -ne $old -and -not ($old -is [string])) { return 'oldRun is neither null nor a string' }
    return $null
}

function Test-JournalRenamable {
    # Gates the best-effort stage rename: $null when this run created the stage, its shape is
    # <...>\<version>\collector, the old index is not under it and it is a real (non-reparse) directory.
    param($Journal)
    if ((Get-JournalField $Journal 'stageCreated') -ne $true) { return 'this run did not create the stage dir' }
    $stage = [string](Get-JournalField $Journal 'stage')
    $ver = [string](Get-JournalField $Journal 'version')
    $trim = $stage.TrimEnd('\')
    if (-not $trim) { return 'stage is empty' }
    if (-not ([IO.Path]::GetFileName($trim)).Equals('collector', [StringComparison]::OrdinalIgnoreCase)) { return "stage leaf is not 'collector': $stage" }
    $parent = Split-Path $trim
    if (-not $parent -or -not ([IO.Path]::GetFileName($parent)).Equals($ver, [StringComparison]::OrdinalIgnoreCase)) { return "stage parent is not the version dir '$ver': $stage" }
    foreach ($old in @(Get-JournalOldIndexes $Journal)) {
        try { $oldFull = [IO.Path]::GetFullPath($old) } catch { continue }
        if ($oldFull.StartsWith($trim + '\', [StringComparison]::OrdinalIgnoreCase)) { return "the old index.js is under the stage dir: $old" }
    }
    $item = Get-Item -LiteralPath $trim -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or -not $item.PSIsContainer) { return "stage dir does not exist: $stage" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return "stage dir is a reparse point (junction or symlink), not renamed: $stage" }
    return $null
}

$RelaunchWaitSeconds = 2   # pause between relaunching the old collector and its liveness check

function Get-RunValueNow {
    # Current Run value, or $null when absent. An empty string is a real value, not absent.
    $p = Get-ItemProperty -Path $RunKeyPath -Name $RunKeyName -ErrorAction SilentlyContinue
    if ($p) { return $p.$RunKeyName }
    return $null
}

function Write-RecoveryText {
    # Printed with exit 3, and in a dry run that previews an incomplete rollback. Order matters: check, old value, stop the NEW collector before starting the old one, db, re-run.
    param($Journal, [string]$JournalPath)
    $oldRun = Get-JournalField $Journal 'oldRun'
    $ix = Get-JournalField $Journal 'indexJs'
    $bak = Get-JournalField $Journal 'bak'
    Write-Output "RECOVERY: 1. Check the Run value first: Get-ItemProperty -Path '$RunKeyPath' -Name '$RunKeyName'"
    if ($null -eq $oldRun) {
        Write-Output "RECOVERY: 2. There was no old Run value; remove the current one: Remove-ItemProperty -Path '$RunKeyPath' -Name '$RunKeyName'"
    } else {
        Write-Output "RECOVERY: 2. The old Run value was <$oldRun>; restore it: Set-ItemProperty -Path '$RunKeyPath' -Name '$RunKeyName' -Value '$($oldRun.Replace("'", "''"))' -Type String"
    }
    Write-Output "RECOVERY: 3. Stop the NEW collector (index.js $ix) BEFORE starting the old one: two collectors writing one db break the single-writer assumption."
    Write-Output "RECOVERY: 4. The db backup is at $bak and is NOT restored automatically. If the old collector exits right after it is relaunched, the db may have been migrated by the new one; the backup is at $bak"
    Write-Output "RECOVERY: 5. After fixing, re-run scripts\redeploy-collector.ps1 -Rollback (it is idempotent); the journal $JournalPath is left open."
}

function Invoke-Rollback {
    # Reports the outcome ONLY through $script:RC (0 complete, 3 incomplete; a dry run is always 0), never by returning a value.
    # Each step is idempotent. R2 runs even when R1 failed; R3 and R4 are skipped when R1 failed.
    param($Journal, [string]$JournalPath, [bool]$Dry)
    if ((Get-JournalField $Journal 'phase') -eq 'verified') {
        if ($Dry) { Write-Output "[DRY-RUN] delete stale journal $JournalPath" } else { Remove-Journal -Path $JournalPath }
        Write-Output 'deploy completed, stale journal removed'
        $script:RC = 0; return
    }
    $bad = Test-JournalShape $Journal
    if ($bad) {
        if ($Dry) { Write-Output "DRY-RUN: a real rollback would be INCOMPLETE: journal is not valid ($bad); nothing was touched." }
        else { Write-Output "ROLLBACK INCOMPLETE: journal is not valid ($bad); nothing was touched." }
        Write-Output "RECOVERY: check the Run value by hand (Get-ItemProperty -Path '$RunKeyPath' -Name '$RunKeyName'), then delete $JournalPath by hand."
        if ($Dry) { $script:RC = 0 } else { $script:RC = 3 }
        return
    }
    $oldRun = Get-JournalField $Journal 'oldRun'
    $newRun = Get-JournalField $Journal 'newRunValue'
    $ix = Get-JournalField $Journal 'indexJs'
    $stage = Get-JournalField $Journal 'stage'
    $oldIdx = Get-JournalField $Journal 'oldIndex'
    if (-not $oldIdx -and $oldRun) { $oldIdx = Get-IndexJsFromRunValue $oldRun }
    $problems = @()
    $r1ok = $true

    Write-Output '===== R1: stop the new collector ====='
    $why = Test-JournalKillable $Journal
    if ($why) {
        $r1ok = $false; $problems += "R1 skipped ($why)"
        Write-Output "WARNING: R1 skipped, the journal fields do not allow a kill: $why"
    } else {
        if ($Dry) { Write-Output "[DRY-RUN] R1 stop the new collector $ix (never the old one)" }
        try { Stop-NewCollector -IndexJs $ix -ExemptIndexJs $oldIdx -Dry $Dry }
        catch { $r1ok = $false; $problems += "R1 failed ($($_.Exception.Message))"; Write-Output "WARNING: R1 failed: $($_.Exception.Message)" }
    }

    Write-Output '===== R2: restore the Run value ====='
    $why = Test-JournalRestorable $Journal
    if ($why) {
        $problems += "R2 skipped ($why)"
        Write-Output "WARNING: R2 skipped: $why"
    } else {
        try {
            $cur = Get-RunValueNow
            $kind = Get-RunKeyKind
            $oldTxt = if ($null -eq $oldRun) { '<absent>' } else { "<$oldRun>" }
            if ($null -ne $cur -and $kind -ne 'String') {
                $problems += "R2 not written (the Run value is $kind, not REG_SZ)"
                Write-Output "WARNING: R2 not written: the Run value is $kind, not REG_SZ. Current <$cur>; old $oldTxt; new <$newRun>."
            } elseif ($null -eq $oldRun -and $null -eq $cur) {
                Write-Output 'R2: the Run value is already absent (the old state); no write.'
            } elseif ($null -ne $oldRun -and $cur -ceq $oldRun) {
                Write-Output 'R2: the Run value is already the old value; no write.'
            } elseif ($null -ne $cur -and $cur -ceq $newRun) {
                if ($Dry) {
                    Write-Output "[DRY-RUN] R2 restore the Run value to $oldTxt"
                } elseif ($null -eq $oldRun) {
                    Write-Output "[RUN] remove $RunKeyPath\$RunKeyName"
                    Remove-ItemProperty -Path $RunKeyPath -Name $RunKeyName
                    if ($null -ne (Get-RunValueNow)) { throw 'Run key read-back mismatch: the value is still present after removal' }
                } else {
                    Write-Output "[RUN] set $RunKeyPath\$RunKeyName = $oldRun"
                    Set-ItemProperty -Path $RunKeyPath -Name $RunKeyName -Value $oldRun -Type String
                    $readBack = Get-RunValueNow
                    if (-not ($readBack -is [string]) -or -not ($readBack -ceq $oldRun)) { throw "Run key read-back mismatch: wrote <$oldRun>, read <$readBack>" }
                }
            } elseif ($null -eq $cur) {
                $problems += 'R2 not written (the Run value is absent, expected the old or the new value)'
                Write-Output "WARNING: R2 not written: the Run value is absent, expected the old or the new value (someone else deleted it). Old $oldTxt; new <$newRun>. A human decides."
            } else {
                $problems += 'R2 not written (the Run value is neither the old nor the new value)'
                Write-Output "WARNING: R2 not written: the Run value was changed by someone else. Current <$cur>; old $oldTxt; new <$newRun>. A human decides."
            }
        } catch {
            $problems += "R2 failed ($($_.Exception.Message))"
            Write-Output "WARNING: R2 failed: $($_.Exception.Message)"
        }
    }

    Write-Output '===== R3: relaunch the old collector ====='
    $oldTail = 'old collector was not running before'
    if (-not $r1ok) {
        $problems += 'R3 skipped (the new collector may still be running)'
        Write-Output 'WARNING: R3 skipped: the new collector may still be running, so a second writer is not safe.'
    } elseif (-not (Get-JournalField $Journal 'oldWasRunning')) {
        Write-Output 'the old collector was not running before this run; not started'
    } elseif ([string]::IsNullOrEmpty($oldRun)) {
        Write-Output 'R3: the old Run value is empty or absent, so the old collector was not launched via the Run key; nothing to relaunch.'
        $oldTail = 'old collector was running before but has no Run-key launch command, so it was not relaunched; start it by hand if you need it'
    } else {
        try {
            $manual = "check that no collector (a node.exe running an index.js) is already running, then start it by hand: $oldRun"
            $existing = @(Get-ExactIndexProcessMatch -Processes @(Get-WmiObject Win32_Process) -IndexJs $oldIdx -ExcludePid $PID | Where-Object { $_.Name -eq 'node.exe' })
            $node = Get-NodeExeFromRunValue $oldRun
            if ($existing.Count -gt 0) {
                $oldTail = 'old collector running'
                Write-Output "R3: the old collector is already running (PID $($existing[0].ProcessId)); not started again."
            } elseif (-not $oldIdx -or -not $node -or -not (Test-Path -LiteralPath $oldIdx)) {
                $problems += "R3 cannot relaunch the old collector ($manual)"
                Write-Output "WARNING: R3 cannot relaunch: no usable old index.js / node.exe in the old Run value or the index.js is missing; $manual"
            } elseif ($Dry) {
                $oldTail = 'old collector would be relaunched'
                Write-Output "[DRY-RUN] R3 Start-Process conhost.exe --headless `"$node`" `"$oldIdx`" (cwd $(Split-Path (Split-Path $oldIdx)))"
            } else {
                Write-Output "[RUN] Start-Process conhost.exe --headless `"$node`" `"$oldIdx`""
                Start-Process conhost.exe -ArgumentList '--headless', "`"$node`"", "`"$oldIdx`"" -WorkingDirectory (Split-Path (Split-Path $oldIdx))
                Start-Sleep -Seconds $RelaunchWaitSeconds
                if (Test-CollectorAlive $oldIdx) { $oldTail = 'old collector running'; Write-Output 'R3: the old collector is running.' }
                else { $problems += "R3 old collector is not running after relaunch ($manual)"; Write-Output "WARNING: R3 the old collector is not running after relaunch; $manual" }
            }
        } catch {
            $problems += "R3 failed ($($_.Exception.Message))"
            Write-Output "WARNING: R3 failed: $($_.Exception.Message)"
        }
    }

    Write-Output '===== R4: move the staged dir aside ====='
    if (-not $r1ok) {
        Write-Output 'R4 skipped: the new collector may still be running.'
    } else {
        $why = Test-JournalRenamable $Journal
        if ($why) {
            Write-Output "WARNING: R4 skipped: $why"
        } else {
            $newName = 'collector.failed-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
            if ($Dry) {
                Write-Output "[DRY-RUN] R4 rename $stage -> $newName"
            } else {
                try {
                    Write-Output "[RUN] rename $stage -> $newName"
                    Rename-Item -LiteralPath $stage -NewName $newName
                } catch {
                    Write-Output "WARNING: R4 could not move the stage dir aside ($($_.Exception.Message)); by hand: Rename-Item -LiteralPath '$stage' -NewName '$newName'"
                }
            }
        }
    }

    Write-Output '===== R5: journal ====='
    if ($problems.Count -eq 0) {
        if ($Dry) { Write-Output "[DRY-RUN] R5 delete journal $JournalPath" }
        else {
            try { Remove-Journal -Path $JournalPath; Write-Output "journal deleted: $JournalPath" }
            catch { Write-Output "WARNING: could not delete the journal $JournalPath ($($_.Exception.Message)); delete it by hand." }
        }
        Write-Output "ROLLBACK COMPLETE: previous Run value restored, $oldTail"
        $script:RC = 0
    } else {
        if ($Dry) { Write-Output "DRY-RUN: a real rollback would be INCOMPLETE: $($problems -join '; ')" }
        else { Write-Output "ROLLBACK INCOMPLETE: $($problems -join '; ')" }
        Write-RecoveryText -Journal $Journal -JournalPath $JournalPath
        if ($Dry) { $script:RC = 0 } else { $script:RC = 3 }
    }
}

function Invoke-RollbackCommand {
    param([bool]$Dry, [string]$ExpectedDbPath = (Join-Path $env:USERPROFILE '.aether-os\collector.db'))
    $journalPath = Get-JournalPath -ExpectedDbPath $ExpectedDbPath
    try { $journal = Read-Journal -Path $journalPath }
    catch { Write-Output "ERROR: $($_.Exception.Message)"; $script:RC = 2; return }
    if ($null -eq $journal) {
        Write-Output "ERROR: no redeploy journal at $journalPath; nothing to roll back."
        $script:RC = 2; return
    }
    if ($Dry) { Write-Output 'DRY-RUN: nothing will be changed.' }
    Write-Output '===== Rollback ====='
    Invoke-Rollback -Journal $journal -JournalPath $journalPath -Dry $Dry
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
    if ([string]::IsNullOrWhiteSpace($StageRoot)) {
        Write-Output 'ERROR: -StageRoot must not be empty. Nothing was changed.'
        $script:RC = 2; return
    }
    # Drive-relative (C:x) and root-relative (\x, /x) shapes resolve against the .NET process cwd, not the
    # PowerShell location. \\server\share and //server/share (two leading separators) stay accepted.
    if ($StageRoot -match '^[A-Za-z]:(?![\\/])' -or $StageRoot -match '^[\\/](?![\\/])') {
        Write-Output "ERROR: -StageRoot '$StageRoot' is drive-relative or root-relative and would resolve against the process working directory. Use a full path (C:\...) or a path relative to the current directory. Nothing was changed."
        $script:RC = 2; return
    }
    try {
        if (-not [IO.Path]::IsPathRooted($StageRoot)) { $StageRoot = Join-Path (Get-Location).Path $StageRoot }
        $StageRoot = [IO.Path]::GetFullPath($StageRoot)
    } catch {
        Write-Output "ERROR: -StageRoot '$StageRoot' is not a valid path ($($_.Exception.Message)). Nothing was changed."
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
        if (-not $Dry) { Set-JournalPhaseLagging -Path $journalPath -Journal $journal -Phase 'stopped' }

        Write-Output '===== Step 4: back up db (after stop; db + -wal, not -shm) ====='
        Invoke-Step "copy $DbPath (+ -wal if present) -> $bak" {
            Copy-Item $DbPath $bak
            if (Test-Path "$DbPath-wal") { Copy-Item "$DbPath-wal" "$bak-wal" }
        } $Dry
        if (-not $Dry) { $journal.bak = $bak; Set-JournalPhaseLagging -Path $journalPath -Journal $journal -Phase 'backed-up' }

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
            Set-JournalPhaseLagging -Path $journalPath -Journal $journal -Phase 'repointed'
        } $Dry

        Write-Output '===== Step 7: start ====='
        Invoke-Step "Start-Process conhost.exe --headless `"$nodeExe`" `"$indexJs`" (cwd $stage)" {
            Start-Process conhost.exe -ArgumentList '--headless', "`"$nodeExe`"", "`"$indexJs`"" -WorkingDirectory $stage
            Set-JournalPhaseLagging -Path $journalPath -Journal $journal -Phase 'launched'
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
        if ($stopRan -and $null -ne $journal) {
            # The journal is open (phase stopping or later, never verified here): roll back from the in-memory copy.
            # RC starts at 3 so anything Invoke-Rollback does not settle fails safe; only a complete rollback lowers it to 1.
            Write-Output '===== Rollback ====='
            $script:RC = 3
            try { Invoke-Rollback -Journal $journal -JournalPath $journalPath -Dry $false }
            catch {
                Write-Output "ROLLBACK INCOMPLETE: $($_.Exception.Message)"
                Write-RecoveryText -Journal $journal -JournalPath $journalPath
                $script:RC = 3
            }
            if ($script:RC -eq 0) { $script:RC = 1 }
            return
        }
        # The journal never opened: nothing but the stage dir changed. No rollback, no RECOVERY text.
        if (-not $Dry) {
            try { Move-FailedStageAside -Stage $stage -Version $Version -OldRun $oldRun -OldIndex $oldIndex }
            catch { Write-Output "WARNING: could not check the stage dir ($($_.Exception.Message))" }
        }
        $script:RC = 1; return
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $script:RC = 1
    if ($Rollback) { Invoke-RollbackCommand -Dry ([bool]$DryRun) }
    else { Invoke-Redeploy -Version $Version -StageRoot $StageRoot -DbPath $DbPath -Dry ([bool]$DryRun) -VerifySeconds $VerifySeconds }
    exit $script:RC
}
