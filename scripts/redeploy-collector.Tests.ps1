# Pester 3.x/5.x compatible. Run: Invoke-Pester scripts\redeploy-collector.Tests.ps1
# Never runs the destructive steps: helpers are tested directly, Stop-Process /
# Start-Process / registry / Copy-Item are mocked, and a -DryRun child checks the output.
$script = Join-Path $PSScriptRoot 'redeploy-collector.ps1'
. $script
$global:RedeployTempPaths = @()

# -Type is a registry-provider dynamic parameter; Pester 3.x cannot mock it on the cmdlet itself
# ("parameter cannot be found"). A shadowing stub with a declared $Type makes it mockable and
# fails loudly if a test forgets to mock it (so nothing here can write the real Run key).
function Set-ItemProperty { param([string]$Path, [string]$Name, $Value, [string]$Type) throw 'Set-ItemProperty must be mocked in tests' }

function New-Proc($id, $name, $cmd) { [pscustomobject]@{ ProcessId = $id; Name = $name; CommandLine = $cmd } }

Describe 'Get-CollectorProcessMatch' {
    $root = 'D:\AetherBuilds'
    $rows = @(
        (New-Proc 10 'node.exe' '"C:\Program Files\nodejs\node.exe" "D:\AetherBuilds\0.7.6\collector\dist\index.js"'),
        (New-Proc 11 'conhost.exe' 'conhost.exe --headless "node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'),
        (New-Proc 12 'node.exe' 'node.exe C:\other\app\index.js'),
        (New-Proc 13 'node.exe' $null),
        (New-Proc 14 'node.exe' 'node.exe D:\AetherBuilds\0.7.6\collector\dist\index.js'),
        (New-Proc 15 'notepad.exe' 'notepad.exe D:\AetherBuilds\0.7.6\collector\dist\index.js'),
        (New-Proc 16 'node.exe' 'node.exe C:\dev\old\collector\dist\index.js')
    )
    It 'matches only node/conhost collector index.js under the stage root' {
        $m = Get-CollectorProcessMatch -Processes $rows -StageRoot $root
        ($m | ForEach-Object { $_.ProcessId }) -join ',' | Should Be '10,11,14'
    }
    It 'excludes the given PID' {
        $m = Get-CollectorProcessMatch -Processes $rows -StageRoot $root -ExcludePid 10
        ($m | ForEach-Object { $_.ProcessId }) -join ',' | Should Be '11,14'
    }
    It 'also matches the index.js path from the old Run value outside the stage root' {
        $m = Get-CollectorProcessMatch -Processes $rows -StageRoot $root -ExtraIndexJs 'C:\dev\old\collector\dist\index.js'
        ($m | ForEach-Object { $_.ProcessId }) -join ',' | Should Be '10,11,14,16'
    }
    It 'treats wildcard characters in StageRoot literally' {
        $m = Get-CollectorProcessMatch -Processes $rows -StageRoot 'D:\Aether[Bb]uilds'
        @($m).Count | Should Be 0
    }
}

Describe 'Get-RunKeyValue / Get-IndexJsFromRunValue' {
    It 'matches the hand-made headless conhost form' {
        Get-RunKeyValue -IndexJs 'D:\AetherBuilds\1.2.3\collector\dist\index.js' -NodeExe 'C:\n\node.exe' |
            Should Be 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\1.2.3\collector\dist\index.js"'
    }
    It 'parses the index.js path back out of a Run value' {
        Get-IndexJsFromRunValue 'conhost.exe --headless "C:\n\node.exe" "D:\x y\collector\dist\index.js"' |
            Should Be 'D:\x y\collector\dist\index.js'
    }
}

$stopRoot = 'D:\AetherBuilds'
$stopProcs = @(
    (New-Proc 11 'conhost.exe' 'conhost.exe --headless "node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'),
    (New-Proc 10 'node.exe' 'node.exe D:\AetherBuilds\0.7.5\collector\dist\index.js'),
    (New-Proc 12 'node.exe' 'node.exe D:\AetherBuilds\0.7.5\collector\dist\index.js')
)

Describe 'Stop-OldCollector order and already-exited PIDs' {
    Mock Start-Sleep {}
    $global:RedeployStopped = @()
    $global:RedeployWmiCalls = 0
    Mock Get-WmiObject { $global:RedeployWmiCalls++; if ($global:RedeployWmiCalls -eq 1) { $stopProcs } else { @() } }
    Mock Get-Process { if ($Id -eq 12) { $null } else { [pscustomobject]@{ Id = $Id } } }
    Mock Stop-Process { $global:RedeployStopped += [string]$Id }
    It 'stops node before conhost and skips a PID that already exited' {
        Stop-OldCollector -StageRoot $stopRoot -Dry $false | Out-Null
        ($global:RedeployStopped -join ',') | Should Be '10,11'
    }
}

Describe 'Stop-OldCollector survivors' {
    Mock Start-Sleep {}
    Mock Get-WmiObject { $stopProcs }
    Mock Get-Process { [pscustomobject]@{ Id = $Id } }
    Mock Stop-Process {}
    It 'throws when a collector node process survives the stop' {
        $threw = $false
        try { Stop-OldCollector -StageRoot $stopRoot -Dry $false | Out-Null } catch { $threw = $_.Exception.Message -match 'still running' }
        $threw | Should Be $true
    }
}

Describe 'Stop-OldCollector dry run' {
    Mock Get-WmiObject { $stopProcs }
    Mock Stop-Process {}
    It 'stops nothing in dry-run' {
        Stop-OldCollector -StageRoot $stopRoot -Dry $true | Out-Null
        Assert-MockCalled Stop-Process -Times 0
    }
}

Describe 'Invoke-Redeploy failure handling (all side effects mocked)' {
    $fdir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-ft-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $fdir | Out-Null
    $db = Join-Path $fdir 'collector.db'
    $jp = Get-JournalPath -ExpectedDbPath $db
    Set-Content -Path $db -Value 'x'
    # The old index.js must exist on disk or the auto-rollback's R3 reports "cannot relaunch".
    $oldIdx = Join-Path $fdir 'oldcoll\collector\dist\index.js'
    New-Item -ItemType Directory -Force -Path (Split-Path $oldIdx) | Out-Null
    Set-Content -Path $oldIdx -Value 'old'
    $oldValue = 'conhost.exe --headless "C:\n\node.exe" "' + $oldIdx + '"'
    $global:RedeployTempPaths += @($fdir)
    $global:RedeployRunValue = $oldValue
    Mock Get-WmiObject { @() }
    Mock Get-Process {}
    Mock Stop-Process {}
    Mock Rename-Item {}
    Mock Test-OldCollectorRunning { $true }
    Mock Get-RunKeyKind { 'String' }
    Mock Get-ItemProperty { [pscustomobject]@{ AetherCollector = $global:RedeployRunValue } }
    $global:RedeployFailSecondSet = $false
    $global:RedeploySetCalls = 0
    Mock Set-ItemProperty { $global:RedeploySetCalls++; if ($global:RedeployFailSecondSet -and $global:RedeploySetCalls -ge 2) { throw 'access denied' }; $global:RedeployRunValue = $Value }
    Mock Start-Process {}
    Mock Start-Sleep {}
    Mock Copy-Item {}
    Mock Invoke-BuildAndStage {}
    Mock Get-FreeBytes { [int64]1GB }
    Mock Stop-OldCollector {}
    $script:counts = @()
    Mock Get-RowCount { $script:counts += 'read'; [int64]100 }

    It 'reads the baseline after the stop, then reports a crashed new collector as failure and rolls back (RC 1, old Run value back)' {
        Mock Test-CollectorAlive { $IndexJs -like '*\oldcoll\*' }
        Remove-Journal -Path $jp
        $script:RC = 99

        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 3 | Out-String
        $out | Should Match 'new collector is not running'
        $out | Should Match 'Backup path: '
        $out | Should Match '\.pre-9\.9\.9-'
        $out | Should Match 'ROLLBACK COMPLETE'
        $out | Should Not Match 'RECOVERY'
        ($global:RedeployRunValue -ceq $oldValue) | Should Be $true
        $script:RC | Should Be 1
        Test-Path $jp | Should Be $false
        Assert-MockCalled Stop-OldCollector -Times 1
        Assert-MockCalled Start-Process -Times 2   # the deploy's start + the rollback's relaunch of the old collector
        Assert-MockCalled Get-RowCount -Times 1
    }
    It 'prints the RECOVERY text and exits 3 with the journal kept when the rollback itself fails (double fault)' {
        $global:RedeployRunValue = $oldValue
        $global:RedeploySetCalls = 0; $global:RedeployFailSecondSet = $true
        Mock Test-CollectorAlive { $IndexJs -like '*\oldcoll\*' }
        Remove-Journal -Path $jp
        $script:RC = 99

        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 3 | Out-String
        $out | Should Match 'ROLLBACK INCOMPLETE'
        $out | Should Match 'RECOVERY: 2\. The old Run value was <conhost.exe --headless'
        $out | Should Match 'RECOVERY: 3\. Stop the NEW collector'
        $out | Should Match 'the db may have been migrated by the new one'
        $global:RedeployFailSecondSet = $false
        $script:RC | Should Be 3
        Test-Path $jp | Should Be $true
        Remove-Journal -Path $jp
    }
    It 'treats alive-but-no-rows as success (idle machine)' {
        $global:RedeployRunValue = $oldValue
        Mock Test-CollectorAlive { $true }
        Remove-Journal -Path $jp

        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'new collector started; no events in 1 s'
        $out | Should Match 'Done\.'
        $out | Should Not Match 'ERROR'
    }
    It 'does not copy the -shm file' {
        Assert-MockCalled Copy-Item -ParameterFilter { $Path -like '*-shm' } -Times 0
    }
    It 'writes the Run value as REG_SZ' {
        $global:RedeployRunValue = $oldValue
        Mock Test-CollectorAlive { $true }
        Remove-Journal -Path $jp

        Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-Null
        Assert-MockCalled Set-ItemProperty -ParameterFilter { $Type -eq 'String' } -Times 1
    }
    It 'fails step 6 when the read-back differs from what was written (rollback sees the old value, writes nothing)' {
        $global:RedeployRunValue = $oldValue
        $global:RedeploySetCalls = 0
        Mock Set-ItemProperty { $global:RedeploySetCalls++ }
        Mock Test-CollectorAlive { $true }
        Remove-Journal -Path $jp

        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'read-back mismatch'
        $out | Should Not Match 'Done\.'
        $out | Should Not Match 'Step 7'
        $out | Should Match 'ROLLBACK COMPLETE'
        $global:RedeploySetCalls | Should Be 1   # the deploy's write only; the rollback saw the old value and wrote nothing
        Test-Path $jp | Should Be $false
    }
    It 'restores an empty old Run value as the empty string (present, not absent)' {
        $global:RedeployRunValue = ''
        $global:RedeploySetCalls = 0
        Mock Set-ItemProperty { $global:RedeploySetCalls++; $global:RedeployRunValue = $Value }
        Mock Test-OldCollectorRunning { $false }
        Mock Test-CollectorAlive { $false }
        Remove-Journal -Path $jp
        $script:RC = 99

        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'ROLLBACK COMPLETE'
        $out | Should Not Match 'RECOVERY'
        $global:RedeploySetCalls | Should Be 2
        ($global:RedeployRunValue -is [string]) | Should Be $true
        $global:RedeployRunValue.Length | Should Be 0
        $script:RC | Should Be 1
    }
    # Last in this Describe: its Mock Get-FreeBytes persists for the Its after it.
    It 'fails before stopping anything when free space is short' {
        Mock Get-FreeBytes { [int64]0 }
        Remove-Journal -Path $jp

        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'not enough free space'
        $out | Should Not Match 'RECOVERY'
    }
}

Describe 'Invoke-Redeploy preflight guards (nothing may be changed)' {
    $pdir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-pt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $pdir | Out-Null
    $db = Join-Path $pdir 'collector.db'
    Set-Content -Path $db -Value 'x'
    $root = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-root-' + [guid]::NewGuid().ToString('N'))
    $global:RedeployTempPaths += @($pdir, $root)
    $oldValue = 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'
    $global:RedeployRunValue = $oldValue
    Mock Test-OldCollectorRunning { $true }
    Mock Get-RunKeyKind { 'String' }
    Mock Get-ItemProperty { [pscustomobject]@{ AetherCollector = $global:RedeployRunValue } }
    Mock Set-ItemProperty { $global:RedeployRunValue = $Value }
    Mock Start-Process {}
    Mock Start-Sleep {}
    Mock Copy-Item {}
    Mock Invoke-BuildAndStage {}
    Mock Get-FreeBytes { [int64]1GB }
    Mock Stop-OldCollector {}
    Mock Get-RowCount { [int64]100 }
    Mock Test-CollectorAlive { $true }

    It 'refuses a non-empty stage directory before stopping or staging anything' {
        $stage = Join-Path $root '9.9.9\collector'
        New-Item -ItemType Directory -Force -Path $stage | Out-Null
        Set-Content -Path (Join-Path $stage 'keep.txt') -Value 'x'
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'already exists and is not empty'
        $out | Should Match 'different -Version or -StageRoot'
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Invoke-BuildAndStage -Times 0
        Assert-MockCalled Set-ItemProperty -Times 0
        Test-Path (Join-Path $stage 'keep.txt') | Should Be $true
    }
    It 'refuses a stage that is the directory the current Run value points at' {
        $global:RedeployRunValue = 'conhost.exe --headless "C:\n\node.exe" "' + $root + '\8.8.8\collector\dist\index.js"'
        $out = Invoke-Redeploy -Version '8.8.8' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'is not empty \(or is the current deployment\)'
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Invoke-BuildAndStage -Times 0
    }
    It 'rejects a -DbPath that is not the collector default, case-insensitively accepting the default' {
        $other = Join-Path ([IO.Path]::GetTempPath()) 'other.db'
        $out = Invoke-Redeploy -Version '9.9.8' -StageRoot $root -DbPath $other -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'is not the database the collector opens'
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Invoke-BuildAndStage -Times 0
        (Get-PreflightError -Stage (Join-Path $root 'z\collector') -OldIndex $null -DbPath $db.ToUpper() -ExpectedDbPath $db -RunValue 'x') | Should BeNullOrEmpty
    }
    It 'rejects a Run command over 260 characters but allows exactly 260' {
        $longRoot = Join-Path $root ('p' * 250)
        $out = Invoke-Redeploy -Version '9.9.7' -StageRoot $longRoot -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'Run-key command is \d+ characters'
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Set-ItemProperty -Times 0
        $args260 = @{ Stage = (Join-Path $root 'y\collector'); OldIndex = $null; DbPath = $db; ExpectedDbPath = $db }
        (Get-PreflightError @args260 -RunValue ('a' * 260)) | Should BeNullOrEmpty
        (Get-PreflightError @args260 -RunValue ('a' * 261)) | Should Match 'Run-key command is 261'
    }
    It 'turns an unparseable -DbPath into a guard message instead of throwing' {
        foreach ($bad in '', ' ', 'C:\a|b') {
            $out = Invoke-Redeploy -Version '9.9.6' -StageRoot $root -DbPath $bad -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
            $out | Should Match 'ERROR: -DbPath'
        }
    }
    It 'treats an unquoted hand-made Run value as no old index instead of throwing' {
        Get-IndexJsFromRunValue 'node C:\x\dist\index.js' | Should BeNullOrEmpty
        $global:RedeployRunValue = 'node C:\x\dist\index.js'
        $out = Invoke-Redeploy -Version '9.9.5' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Not Match 'format|not supported'
        $out | Should Match 'Old Run value: node C:\\x\\dist\\index.js'
        $out | Should Match 'Done\.'
    }
    It 'resolves a relative -DbPath against the PowerShell location' {
        $dir = Split-Path -Parent $db
        $rel = 'rel-' + [guid]::NewGuid().ToString('N') + '.db'
        Set-Content -Path (Join-Path $dir $rel) -Value 'x'
        $global:RedeployTempPaths += @((Join-Path $dir $rel))
        Push-Location $dir
        try { $out = Invoke-Redeploy -Version '9.9.4' -StageRoot $root -DbPath $rel -ExpectedDbPath (Join-Path $dir $rel) -Dry $false -VerifySeconds 1 | Out-String }
        finally { Pop-Location }
        $out | Should Not Match 'not the database the collector opens'
        $out | Should Match 'Done\.'
    }
}
function New-TestJournal($oldRun) {
    [ordered]@{
        schema = 1; version = '9.9.9'; startedUtc = [DateTime]::UtcNow.ToString('o'); phase = 'stopping'
        phaseUtc = [DateTime]::UtcNow.ToString('o'); stage = 'D:\AetherBuilds\9.9.9\collector'; stageCreated = $true
        indexJs = 'D:\AetherBuilds\9.9.9\collector\dist\index.js'; nodeExe = 'C:\n\node.exe'
        newRunValue = 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\9.9.9\collector\dist\index.js"'
        oldRun = $oldRun; oldIndex = $null; oldWasRunning = $true; db = 'C:\x\collector.db'; bak = $null
    }
}

Describe 'journal primitives (temp dir only, never the real journal)' {
    $jdir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-jt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $jdir | Out-Null
    $global:RedeployTempPaths += @($jdir)
    $jp = Get-JournalPath -ExpectedDbPath (Join-Path $jdir 'collector.db')

    It 'puts the journal next to the expected db' {
        (Split-Path $jp -Parent) | Should Be $jdir
        (Split-Path $jp -Leaf) | Should Be 'redeploy-journal.json'
    }
    It 'round-trips every field (null / empty / quoted oldRun, string timestamps) and leaves no .tmp' {
        $quoted = 'conhost.exe --headless "C:\n\node.exe" "D:\it''s\index.js" say "hi"'
        foreach ($case in @($null, '', $quoted)) {
            $j = New-TestJournal $case
            $j.bak = 'C:\x\collector.db.pre-9.9.9.bak'
            Write-Journal -Path $jp -Journal $j
            Write-Journal -Path $jp -Journal $j   # second write takes the Replace branch
            $r = Read-Journal -Path $jp
            foreach ($k in $j.Keys) {
                if ($null -eq $j[$k]) { ($null -eq $r.$k) | Should Be $true }
                else { ($r.$k -ceq $j[$k]) | Should Be $true }
            }
            ($r.startedUtc -is [string]) | Should Be $true
            ($r.phaseUtc -is [string]) | Should Be $true
            if ($case -eq '') { ($r.oldRun -is [string]) | Should Be $true }
            Test-Path "$jp.tmp" | Should Be $false
        }
        $j = New-TestJournal $null
        $j.startedUtc = [DateTime]::UtcNow
        Write-Journal -Path $jp -Journal $j
        ((Read-Journal -Path $jp).startedUtc -is [string]) | Should Be $true
        Remove-Journal -Path $jp
        Test-Path $jp | Should Be $false
    }
    It 'returns $null for a missing journal and throws journal unreadable for garbage or an empty file' {
        Read-Journal -Path $jp | Should BeNullOrEmpty
        foreach ($bad in 'not json {', '', '5') {
            [IO.File]::WriteAllText($jp, $bad)
            $msg = $null
            try { Read-Journal -Path $jp | Out-Null } catch { $msg = $_.Exception.Message }
            $msg | Should Match 'journal unreadable'
        }
        Remove-Journal -Path $jp
    }
}

Describe 'Invoke-Redeploy new preflight guards (journal, Run kind, -VerifySeconds)' {
    $gdir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-gt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $gdir | Out-Null
    $global:RedeployTempPaths += @($gdir)
    $db = Join-Path $gdir 'collector.db'
    Set-Content -Path $db -Value 'x'
    $jp = Get-JournalPath -ExpectedDbPath $db
    $root = Join-Path $gdir 'root'
    Mock Test-OldCollectorRunning { $true }
    $global:RedeployRunValue = 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'
    Mock Get-RunKeyKind { 'String' }
    Mock Get-ItemProperty { [pscustomobject]@{ AetherCollector = $global:RedeployRunValue } }
    Mock Set-ItemProperty { $global:RedeployRunValue = $Value }
    Mock Start-Process {}
    Mock Start-Sleep {}
    Mock Copy-Item {}
    Mock Invoke-BuildAndStage {}
    Mock Get-FreeBytes { [int64]1GB }
    Mock Stop-OldCollector {}
    Mock Get-RowCount { [int64]100 }
    Mock Test-CollectorAlive { $true }
    $base = @{ Stage = (Join-Path $root 'z\collector'); OldIndex = $null; DbPath = $db; ExpectedDbPath = $db; RunValue = 'x' }

    It 'refuses an open journal, in dry-run too, before anything is stopped, staged or written' {
        $j = New-TestJournal $null
        $j.phase = 'repointed'
        Write-Journal -Path $jp -Journal $j
        $before = [IO.File]::ReadAllText($jp)
        foreach ($dry in $false, $true) {
            $script:RC = 99
            $out = Invoke-Redeploy -Version '9.9.9' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $dry -VerifySeconds 1 | Out-String
            $out | Should Match 'unfinished redeploy journal exists'
            $out | Should Match 'phase repointed, version 9\.9\.9'
            $out | Should Match '-Rollback'
            $out | Should Match 'Nothing was changed'
            $script:RC | Should Be 2
        }
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Invoke-BuildAndStage -Times 0
        Assert-MockCalled Set-ItemProperty -Times 0
        Test-Path $root | Should Be $false
        [IO.File]::ReadAllText($jp) | Should Be $before
        Remove-Journal -Path $jp
    }
    It 'also refuses an unparseable journal' {
        [IO.File]::WriteAllText($jp, 'garbage {')
        $script:RC = 99
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'journal unreadable'
        $script:RC | Should Be 2
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Invoke-BuildAndStage -Times 0
        Assert-MockCalled Set-ItemProperty -Times 0
        Remove-Journal -Path $jp
    }
    It 'refuses a non-REG_SZ Run value but accepts an absent one' {
        (Get-PreflightError @base -RunKind 'ExpandString') | Should Match 'is ExpandString, not REG_SZ'
        (Get-PreflightError @base -RunKind $null) | Should BeNullOrEmpty
        (Get-PreflightError @base -RunKind 'String') | Should BeNullOrEmpty
        Mock Get-RunKeyKind { 'ExpandString' }
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $true -VerifySeconds 1 | Out-String
        $out | Should Match 'not REG_SZ'
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Set-ItemProperty -Times 0
    }
    # Last: this Mock Get-RunKeyKind persists for any It after it.
    It 'refuses -VerifySeconds outside 1..60 and accepts 1 and 60' {
        Mock Get-RunKeyKind { 'String' }
        (Get-PreflightError @base -VerifySeconds 0) | Should Match '-VerifySeconds 0 is outside 1\.\.60'
        (Get-PreflightError @base -VerifySeconds 61) | Should Match '-VerifySeconds 61 is outside 1\.\.60'
        (Get-PreflightError @base -VerifySeconds 1) | Should BeNullOrEmpty
        (Get-PreflightError @base -VerifySeconds 60) | Should BeNullOrEmpty
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 61 | Out-String
        $out | Should Match 'outside 1\.\.60'
        Assert-MockCalled Stop-OldCollector -Times 0
        Assert-MockCalled Invoke-BuildAndStage -Times 0
    }
}
Describe 'Test-OldCollectorRunning' {
    Mock Get-WmiObject { @(New-Proc 10 'node.exe' 'node.exe D:\AetherBuilds\0.7.5\collector\dist\index.js'), (New-Proc 11 'node.exe' 'node.exe C:\dev\old\collector\dist\index.js') }
    It 'is true for a collector under the stage root or the old Run index.js, false otherwise' {
        (Test-OldCollectorRunning -StageRoot 'D:\AetherBuilds' -ExtraIndexJs $null) | Should Be $true
        (Test-OldCollectorRunning -StageRoot 'E:\Elsewhere' -ExtraIndexJs 'C:\dev\old\collector\dist\index.js') | Should Be $true
        (Test-OldCollectorRunning -StageRoot 'E:\Elsewhere' -ExtraIndexJs $null) | Should Be $false
    }
}
Describe 'Test-OldCollectorRunning counts node.exe only' {
    $conhost = 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'
    It 'a lone conhost row (stage match or Run index.js match) is not a running collector' {
        Mock Get-WmiObject { @(New-Proc 10 'conhost.exe' $conhost) }
        (Test-OldCollectorRunning -StageRoot 'D:\AetherBuilds' -ExtraIndexJs $null) | Should Be $false
        (Test-OldCollectorRunning -StageRoot 'E:\Elsewhere' -ExtraIndexJs 'D:\AetherBuilds\0.7.5\collector\dist\index.js') | Should Be $false
    }
    It 'a node row alongside a conhost row is a running collector' {
        Mock Get-WmiObject { @((New-Proc 10 'conhost.exe' $conhost), (New-Proc 11 'node.exe' 'node.exe D:\AetherBuilds\0.7.5\collector\dist\index.js')) }
        (Test-OldCollectorRunning -StageRoot 'D:\AetherBuilds' -ExtraIndexJs $null) | Should Be $true
    }
}

Describe 'Invoke-Redeploy journal phase order (Write-Journal / Remove-Journal recorded, not written)' {
    $odir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-ot-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $odir | Out-Null
    $global:RedeployTempPaths += @($odir)
    $db = Join-Path $odir 'collector.db'
    Set-Content -Path $db -Value 'x'
    $oldValue = 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'
    $global:RedeployOrder = @()
    $global:RedeployThrowPhase = $null
    $global:RedeployThrowDelete = $false
    $global:RedeployRows = 0
    Mock Rename-Item {}
    Mock Test-OldCollectorRunning { $true }
    Mock Get-RunKeyKind { 'String' }
    Mock Get-ItemProperty { [pscustomobject]@{ AetherCollector = $global:RedeployRunValue } }
    Mock Set-ItemProperty { $global:RedeployOrder += 'set-run'; $global:RedeployRunValue = $Value }
    Mock Start-Process { $global:RedeployOrder += 'start' }
    Mock Start-Sleep {}
    Mock Copy-Item {}
    Mock Invoke-BuildAndStage {}
    Mock Get-FreeBytes { [int64]1GB }
    Mock Stop-OldCollector { $global:RedeployOrder += 'stop' }
    Mock Test-CollectorAlive { $global:RedeployOrder += 'alive'; $true }
    Mock Get-RowCount { $global:RedeployOrder += 'rows'; $global:RedeployRows++; if ($global:RedeployRows -eq 1) { [int64]100 } else { [int64]101 } }
    Mock Write-Journal {
        $global:RedeployOrder += ('j:' + $Journal.phase)
        if ($global:RedeployThrowPhase -eq $Journal.phase) { throw 'disk full' }
    }
    Mock Remove-Journal { $global:RedeployOrder += 'delete'; if ($global:RedeployThrowDelete) { throw 'file locked' } }
    function Start-OrderRun {
        $global:RedeployOrder = @(); $global:RedeployRows = 0; $global:RedeployRunValue = $oldValue
        $script:RC = 99
        Invoke-Redeploy -Version '9.9.9' -StageRoot (Join-Path $odir 'root') -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
    }

    It 'writes each phase BEFORE the step it names: stopping before the kill, verified before the delete' {
        $out = Start-OrderRun
        ($global:RedeployOrder -join ',') | Should Be 'j:stopping,stop,j:stopped,j:backed-up,rows,j:repointing,set-run,j:repointed,start,j:launched,alive,rows,j:verified,delete'
        $out | Should Match 'rows grew 100 -> 101'
        $script:RC | Should Be 0
    }
    It 'aborts before stopping anything when the stopping write throws (fail closed)' {
        $global:RedeployThrowPhase = 'stopping'
        $out = Start-OrderRun
        $global:RedeployThrowPhase = $null
        ($global:RedeployOrder -join ',') | Should Be 'j:stopping'
        $out | Should Match 'ERROR: disk full'
        $out | Should Not Match 'RECOVERY'
        $script:RC | Should Be 1
    }
    It 'keeps RC 0 and warns not to run -Rollback when the verified write throws' {
        $global:RedeployThrowPhase = 'verified'
        $out = Start-OrderRun
        $global:RedeployThrowPhase = $null
        $out | Should Match 'do NOT run -Rollback'
        $out | Should Match 'Done\.'
        $out | Should Not Match 'ERROR'
        $script:RC | Should Be 0
    }
    It 'keeps RC 0 and warns not to run -Rollback when the journal delete throws' {
        $global:RedeployThrowDelete = $true
        $out = Start-OrderRun
        $global:RedeployThrowDelete = $false
        $out | Should Match 'do NOT run -Rollback'
        $out | Should Not Match 'ERROR'
        $script:RC | Should Be 0
    }
}

Describe 'Invoke-Redeploy journal contents and verify-loop tolerance (real journal in a temp dir)' {
    $rdir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-rt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $rdir | Out-Null
    $global:RedeployTempPaths += @($rdir)
    $db = Join-Path $rdir 'collector.db'
    Set-Content -Path $db -Value 'x'
    $jp = Get-JournalPath -ExpectedDbPath $db
    # The old index.js must exist on disk or the auto-rollback's R3 reports "cannot relaunch".
    $oldIdx = Join-Path $rdir 'oldcoll\collector\dist\index.js'
    New-Item -ItemType Directory -Force -Path (Split-Path $oldIdx) | Out-Null
    Set-Content -Path $oldIdx -Value 'old'
    $oldValue = 'conhost.exe --headless "C:\n\node.exe" "' + $oldIdx + '"'
    $global:RedeployRunValue = $oldValue
    $global:RedeployRows = 0
    $global:RedeployAliveCalls = 0
    Mock Get-WmiObject { @() }
    Mock Get-Process {}
    Mock Stop-Process {}
    Mock Rename-Item {}
    Mock Test-OldCollectorRunning { $true }
    Mock Get-RunKeyKind { 'String' }
    Mock Get-ItemProperty { [pscustomobject]@{ AetherCollector = $global:RedeployRunValue } }
    Mock Set-ItemProperty { $global:RedeployRunValue = $Value }
    Mock Start-Process {}
    Mock Start-Sleep {}
    Mock Copy-Item {}
    Mock Invoke-BuildAndStage {}
    Mock Get-FreeBytes { [int64]1GB }
    Mock Stop-OldCollector {}
    function Start-RealRun {
        Remove-Journal -Path $jp
        $global:RedeployRunValue = $oldValue; $global:RedeployRows = 0; $global:RedeployAliveCalls = 0
        $script:RC = 99
        Invoke-Redeploy -Version '9.9.9' -StageRoot (Join-Path $rdir 'root') -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
    }

    It 'deletes the journal after a verified deploy' {
        Mock Get-RowCount { $global:RedeployRows++; if ($global:RedeployRows -eq 1) { [int64]100 } else { [int64]101 } }
        Mock Test-CollectorAlive { $true }
        $out = Start-RealRun
        $out | Should Match 'Done\.'
        Test-Path $jp | Should Be $false
    }
    It 'survives a throwing verify-loop sample (one throw then growth) and prints rows grew' {
        Mock Get-RowCount { $global:RedeployRows++; if ($global:RedeployRows -eq 1) { [int64]100 } elseif ($global:RedeployRows -eq 2) { throw 'row count query failed' } else { [int64]101 } }
        Mock Test-CollectorAlive { $true }
        $out = Start-RealRun
        $out | Should Match 'row count sample failed: row count query failed'
        $out | Should Match 'rows grew 100 -> 101'
        $out | Should Not Match 'ERROR'
        $script:RC | Should Be 0
    }
    It 'ends as the idle success when every sample throws and the collector is alive' {
        Mock Get-RowCount { $global:RedeployRows++; if ($global:RedeployRows -eq 1) { [int64]100 } else { throw 'row count query failed' } }
        Mock Test-CollectorAlive { $true }
        $out = Start-RealRun
        $out | Should Match 'new collector started; no events in 1 s'
        $out | Should Not Match 'ERROR'
        $script:RC | Should Be 0
    }
    It 'still fails when the collector dies during the wait (liveness stays fatal)' {
        Mock Get-RowCount { $global:RedeployRows++; if ($global:RedeployRows -eq 1) { [int64]100 } else { throw 'row count query failed' } }
        Mock Test-CollectorAlive { if ($IndexJs -like '*\oldcoll\*') { return $true }; $global:RedeployAliveCalls++; $global:RedeployAliveCalls -eq 1 }
        $out = Start-RealRun
        $out | Should Match 'new collector died while waiting for events'
        $script:RC | Should Be 1
    }
    It 'leaves the journal at phase repointed with the rollback fields when Start-Process throws' {
        Mock Get-RowCount { [int64]100 }
        Mock Test-CollectorAlive { $true }
        Mock Start-Process { throw 'cannot start' }
        $out = Start-RealRun
        $out | Should Match 'ERROR: cannot start'
        $out | Should Match 'ROLLBACK INCOMPLETE'   # the rollback's own relaunch of the old collector throws too, so the journal stays
        $j = Read-Journal -Path $jp
        $j.phase | Should Be 'repointed'
        ($j.oldRun -ceq $oldValue) | Should Be $true
        $j.newRunValue | Should Match 'index\.js"$'
        $j.bak | Should Match '\.pre-9\.9\.9-.*\.bak$'
        $j.oldWasRunning | Should Be $true
        $j.stageCreated | Should Be $true
        $j.version | Should Be '9.9.9'
        ($j.stage -like '*9.9.9\collector') | Should Be $true
        Remove-Journal -Path $jp
    }
    It 'records oldWasRunning=false and keeps an empty old Run value (not null) in the journal' {
        Mock Test-OldCollectorRunning { $false }
        Mock Start-Process { throw 'cannot start' }
        Mock Invoke-Rollback {}   # keep the journal on disk so its contents can be read
        Remove-Journal -Path $jp
        $global:RedeployRunValue = ''
        $script:RC = 99
        Invoke-Redeploy -Version '9.9.9' -StageRoot (Join-Path $rdir 'root') -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-Null
        $j = Read-Journal -Path $jp
        $j.oldWasRunning | Should Be $false
        ($null -eq $j.oldRun) | Should Be $false
        Remove-Journal -Path $jp
    }
    # Last: this Mock Get-FreeBytes persists for any It after it.
    It 'leaves no journal and prints no RECOVERY when free space is short' {
        Mock Get-FreeBytes { [int64]0 }
        $out = Start-RealRun
        $out | Should Match 'not enough free space'
        $out | Should Not Match 'RECOVERY'
        Test-Path $jp | Should Be $false
    }
}

Describe 'Get-ExactIndexProcessMatch' {
    $ix = 'D:\AetherBuilds\0.7.6\collector\dist\index.js'
    $rows = @(
        (New-Proc 10 'node.exe' ('"C:\Program Files\nodejs\node.exe" "' + $ix + '"')),
        (New-Proc 11 'conhost.exe' ('conhost.exe --headless "node.exe" "' + $ix + '"')),
        (New-Proc 12 'node.exe' ('node.exe "' + $ix + '.bak"')),
        (New-Proc 13 'node.exe' 'node.exe "D:\AetherBuilds\0.7.5\collector\dist\index.js"'),
        (New-Proc 14 'node.exe' $null),
        (New-Proc 15 'notepad.exe' ('notepad.exe ' + $ix)),
        (New-Proc 16 'node.exe' ('node.exe ' + $ix))
    )
    It 'returns an empty array for zero rows' {
        @(Get-ExactIndexProcessMatch -Processes @() -IndexJs $ix).Count | Should Be 0
    }
    It 'returns the one matching node row' {
        $m = @(Get-ExactIndexProcessMatch -Processes @($rows[0]) -IndexJs $ix)
        $m.Count | Should Be 1
        $m[0].ProcessId | Should Be 10
    }
    It 'returns node and conhost, not index.js.bak, a sibling version, a null command line or another image' {
        $m = Get-ExactIndexProcessMatch -Processes $rows -IndexJs $ix -ExcludePid 16
        ($m | ForEach-Object { $_.ProcessId }) -join ',' | Should Be '10,11'
    }
    It 'includes the own-PID row when ExcludePid is not given' {
        (@(Get-ExactIndexProcessMatch -Processes $rows -IndexJs $ix | ForEach-Object { $_.ProcessId }) -join ',') | Should Be '10,11,16'
    }
}

Describe 'Stop-NewCollector order and the exempt old collector' {
    $new = 'D:\AetherBuilds\0.7.6\collector\dist\index.js'
    $old = 'D:\AetherBuilds\0.7.5\collector\dist\index.js'
    $global:NcRows = @(
        (New-Proc 11 'conhost.exe' ('conhost.exe --headless "node.exe" "' + $new + '"')),
        (New-Proc 10 'node.exe' ('node.exe "' + $new + '"')),
        (New-Proc 12 'node.exe' ('node.exe "' + $old + '"')),
        (New-Proc 13 'conhost.exe' ('conhost.exe --headless "node.exe" "' + $old + '"')),
        (New-Proc 14 'node.exe' ('node.exe "' + $old + '" "' + $new + '"'))
    )
    $global:NcStopped = @()
    $global:NcImmortal = @()
    Mock Start-Sleep {}
    Mock Get-Process { [pscustomobject]@{ Id = $Id } }
    Mock Stop-Process { $global:NcStopped += [string]$Id }
    Mock Get-WmiObject { @($global:NcRows | Where-Object { ($global:NcStopped -notcontains [string]$_.ProcessId) -or ($global:NcImmortal -contains [string]$_.ProcessId) }) }
    It 'stops node before conhost, and never a row that exactly matches the exempt old collector (PID 14 matches both)' {
        $global:NcStopped = @()
        $null = Stop-NewCollector -IndexJs $new -ExemptIndexJs $old -Dry $false
        ($global:NcStopped -join ',') | Should Be '10,11'
    }
    It 'does not count the running exempt old collector as a survivor' {
        $global:NcStopped = @()
        $threw = $false
        try { $null = Stop-NewCollector -IndexJs $new -ExemptIndexJs $old -Dry $false } catch { $threw = $true }
        $threw | Should Be $false
    }
}

Describe 'Stop-NewCollector survivors' {
    $new = 'D:\AetherBuilds\0.7.6\collector\dist\index.js'
    $old = 'D:\AetherBuilds\0.7.5\collector\dist\index.js'
    $global:NcStopped = @()
    $global:NcImmortal = @()
    Mock Start-Sleep {}
    Mock Get-Process { [pscustomobject]@{ Id = $Id } }
    Mock Stop-Process { $global:NcStopped += [string]$Id }
    Mock Get-WmiObject { @($global:NcRows | Where-Object { ($global:NcStopped -notcontains [string]$_.ProcessId) -or ($global:NcImmortal -contains [string]$_.ProcessId) }) }
    It 'throws on an exact-match survivor' {
        $global:NcRows = @((New-Proc 10 'node.exe' ('node.exe "' + $new + '"')), (New-Proc 12 'node.exe' ('node.exe "' + $old + '"')))
        $global:NcStopped = @(); $global:NcImmortal = @('10')
        $msg = ''
        try { $null = Stop-NewCollector -IndexJs $new -ExemptIndexJs $old -Dry $false } catch { $msg = $_.Exception.Message }
        $msg | Should Match 'still running after rollback stop: PID 10 '
    }
    It 'also throws on a forward-slash survivor the exact matcher misses' {
        $global:NcRows = @((New-Proc 10 'node.exe' ('node.exe "' + $new + '"')), (New-Proc 20 'node.exe' 'node.exe D:/AetherBuilds/0.7.6/collector/dist/index.js'), (New-Proc 12 'node.exe' ('node.exe "' + $old + '"')))
        $global:NcStopped = @(); $global:NcImmortal = @()
        $msg = ''
        try { $null = Stop-NewCollector -IndexJs $new -ExemptIndexJs $old -Dry $false } catch { $msg = $_.Exception.Message }
        $msg | Should Match 'PID 20 '
        $msg | Should Not Match 'PID 12'
        ($global:NcStopped -join ',') | Should Be '10'
    }
    It 'stops nothing in dry-run' {
        $global:NcRows = @((New-Proc 10 'node.exe' ('node.exe "' + $new + '"')))
        $global:NcStopped = @()
        $null = Stop-NewCollector -IndexJs $new -ExemptIndexJs $old -Dry $true
        $global:NcStopped.Count | Should Be 0
    }
}

Describe 'Get-NodeExeFromRunValue' {
    It 'returns the node path from the headless form' {
        Get-NodeExeFromRunValue 'conhost.exe --headless "C:\Program Files\nodejs\node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"' | Should Be 'C:\Program Files\nodejs\node.exe'
    }
    It 'returns $null for an unquoted hand-made value' {
        Get-NodeExeFromRunValue 'node C:\x\dist\index.js' | Should BeNullOrEmpty
    }
    It 'returns $null when there is an extra argument' {
        Get-NodeExeFromRunValue 'conhost.exe --headless "C:\n\node.exe" "C:\x\dist\index.js" --extra' | Should BeNullOrEmpty
    }
    It 'returns $null when the value has a prefix before conhost.exe' {
        Get-NodeExeFromRunValue 'cmd /c conhost.exe --headless "C:\n\node.exe" "C:\x\dist\index.js"' | Should BeNullOrEmpty
    }
    It 'returns $null for an empty value' {
        Get-NodeExeFromRunValue '' | Should BeNullOrEmpty
    }
}

function New-RbJournal($mods) {
    $oldIdx = 'D:\AetherBuilds\9.9.8\collector\dist\index.js'
    $j = New-TestJournal ('conhost.exe --headless "C:\n\node.exe" "' + $oldIdx + '"')
    $j.oldIndex = $oldIdx
    if ($mods) { foreach ($k in @($mods.Keys)) { $j[$k] = $mods[$k] } }
    $j
}

Describe 'Test-JournalShape' {
    It 'accepts a good journal, in memory and after a JSON round trip' {
        Test-JournalShape (New-RbJournal @{}) | Should BeNullOrEmpty
        Test-JournalShape ((New-RbJournal @{}) | ConvertTo-Json -Depth 3 | ConvertFrom-Json) | Should BeNullOrEmpty
    }
    It 'rejects a missing field' {
        $j = New-RbJournal @{}; $j.Remove('phase')
        Test-JournalShape $j | Should Match "'phase' is missing"
    }
    It 'rejects a DateTime-typed timestamp' {
        Test-JournalShape (New-RbJournal @{ startedUtc = [DateTime]::UtcNow }) | Should Match 'timestamp'
    }
}

Describe 'Test-JournalKillable' {
    $cases = @(
        @{ n = 'a relative path'; m = @{ indexJs = 'dist\index.js' }; r = 'not an absolute path' },
        @{ n = 'a path with ..'; m = @{ indexJs = 'D:\AetherBuilds\9.9.9\collector\..\collector\dist\index.js' }; r = 'normalised' },
        @{ n = 'forward slashes'; m = @{ indexJs = 'D:/AetherBuilds/9.9.9/collector/dist/index.js' }; r = 'normalised' },
        @{ n = 'a wrong tail'; m = @{ indexJs = 'D:\AetherBuilds\9.9.9\collector\dist\other.js' }; r = 'does not end in' },
        @{ n = 'indexJs not stage + \dist\index.js'; m = @{ stage = 'D:\AetherBuilds\9.9.9\x\collector' }; r = 'not stage' },
        @{ n = 'a stage not ending \<version>\collector'; m = @{ version = '9.9.9'; stage = 'D:\AetherBuilds\9.9.8\collector'; indexJs = 'D:\AetherBuilds\9.9.8\collector\dist\index.js'; oldIndex = $null; oldRun = $null }; r = 'stage does not end in' },
        @{ n = 'indexJs equal to the journal oldIndex'; m = @{ oldIndex = 'D:\AetherBuilds\9.9.9\collector\dist\index.js'; oldRun = $null }; r = "old collector" },
        @{ n = 'indexJs equal to the index parsed from oldRun'; m = @{ oldIndex = $null; oldRun = 'conhost.exe --headless "C:\n\node.exe" "d:\aetherbuilds\9.9.9\collector\dist\index.js"' }; r = 'old collector' }
    )
    foreach ($c in $cases) {
        It ('rejects ' + $c.n) {
            Test-JournalKillable (New-RbJournal $c.m) | Should Match $c.r
        }
    }
    It 'accepts a good journal' {
        Test-JournalKillable (New-RbJournal @{}) | Should BeNullOrEmpty
    }
}

Describe 'Test-JournalRestorable' {
    It 'rejects an empty newRunValue' { Test-JournalRestorable (New-RbJournal @{ newRunValue = '' }) | Should Match 'newRunValue' }
    It 'rejects a non-string newRunValue' { Test-JournalRestorable (New-RbJournal @{ newRunValue = 5 }) | Should Match 'newRunValue' }
    It 'rejects a non-string, non-null oldRun' { Test-JournalRestorable (New-RbJournal @{ oldRun = 5 }) | Should Match 'oldRun' }
    It 'accepts oldRun = empty string and oldRun = $null' {
        Test-JournalRestorable (New-RbJournal @{ oldRun = '' }) | Should BeNullOrEmpty
        Test-JournalRestorable (New-RbJournal @{ oldRun = $null }) | Should BeNullOrEmpty
    }
}

Describe 'Test-JournalRenamable (real temp dirs)' {
    $rroot = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-rn-' + [guid]::NewGuid().ToString('N'))
    $global:RedeployTempPaths += @($rroot)
    $good = Join-Path $rroot '9.9.9\collector'
    $wrongLeaf = Join-Path $rroot '9.9.9\other'
    $wrongParent = Join-Path $rroot '1.1.1\collector'
    $target = Join-Path $rroot 'junction-target'
    $link = Join-Path $rroot '8.8.8\collector'
    foreach ($d in $good, $wrongLeaf, $wrongParent, $target, (Join-Path $rroot '8.8.8')) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    $junctionOk = $false
    try {
        & cmd.exe /c mklink /J "$link" "$target" 2>&1 | Out-Null
        $junctionOk = (Test-Path -LiteralPath $link) -and ((Get-Item -LiteralPath $link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    } catch { $junctionOk = $false }
    function New-RnJournal($stage, $mods) {
        $m = @{ stage = $stage; indexJs = $stage + '\dist\index.js'; oldIndex = 'D:\elsewhere\9.9.8\collector\dist\index.js'; oldRun = $null }
        if ($mods) { foreach ($k in @($mods.Keys)) { $m[$k] = $mods[$k] } }
        New-RbJournal $m
    }
    It 'accepts a real stage dir this run created' { Test-JournalRenamable (New-RnJournal $good $null) | Should BeNullOrEmpty }
    It 'rejects stageCreated = $false' { Test-JournalRenamable (New-RnJournal $good @{ stageCreated = $false }) | Should Match 'did not create' }
    It 'rejects a stage whose leaf is not collector' { Test-JournalRenamable (New-RnJournal $wrongLeaf $null) | Should Match "leaf is not 'collector'" }
    It 'rejects a stage whose parent leaf is not the version' { Test-JournalRenamable (New-RnJournal $wrongParent $null) | Should Match 'parent is not the version' }
    It 'rejects an oldIndex under the stage (journal value)' {
        Test-JournalRenamable (New-RnJournal $good @{ oldIndex = ($good + '\dist\index.js') }) | Should Match 'under the stage'
    }
    It 'rejects an oldIndex under the stage (parsed from oldRun)' {
        Test-JournalRenamable (New-RnJournal $good @{ oldIndex = $null; oldRun = ('conhost.exe --headless "C:\n\node.exe" "' + $good + '\dist\index.js"') }) | Should Match 'under the stage'
    }
    It 'rejects a stage that is a reparse point (skipped if mklink /J cannot be created)' -Skip:(-not $junctionOk) {
        Test-JournalRenamable (New-RnJournal $link @{ version = '8.8.8' }) | Should Match 'reparse point'
    }
    if ($junctionOk) { & cmd.exe /c rmdir "$link" | Out-Null }
}

$global:RbCalls = @(); $global:RbRun = $null; $global:RbKind = 'String'; $global:RbProcs = @(); $global:RbDead = @(); $global:RbImmortal = @()
$global:RbRenameThrows = $false; $global:RbStartAlive = $true; $global:RbOldIdx = ''

function New-RbCase($mods, $run, $kind, [bool]$junction) {
    # A real temp tree: <dir>\9.9.9\collector (new stage), <dir>\9.9.8\collector\dist\index.js (old), a journal file.
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-rb-' + [guid]::NewGuid().ToString('N'))
    $global:RedeployTempPaths += @($dir)
    $stage = Join-Path $dir '9.9.9\collector'
    $oldIdx = Join-Path $dir '9.9.8\collector\dist\index.js'
    New-Item -ItemType Directory -Force -Path (Join-Path $dir '9.9.8\collector\dist') | Out-Null
    Set-Content -Path $oldIdx -Value 'old'
    if ($junction) {
        $target = Join-Path $dir 'junction-target'
        New-Item -ItemType Directory -Force -Path (Join-Path $target 'dist'), (Join-Path $dir '9.9.9') | Out-Null
        & cmd.exe /c mklink /J "$stage" "$target" 2>&1 | Out-Null
    } else {
        New-Item -ItemType Directory -Force -Path (Join-Path $stage 'dist') | Out-Null
    }
    Set-Content -Path (Join-Path $stage 'dist\index.js') -Value 'new'
    $ix = $stage + '\dist\index.js'
    $oldRun = 'conhost.exe --headless "C:\n\node.exe" "' + $oldIdx + '"'
    $m = @{ stage = $stage; indexJs = $ix; oldRun = $oldRun; oldIndex = $oldIdx; newRunValue = (Get-RunKeyValue -IndexJs $ix -NodeExe 'C:\n\node.exe'); phase = 'repointed' }
    if ($mods) { foreach ($k in @($mods.Keys)) { $m[$k] = $mods[$k] } }
    $jp = Join-Path $dir 'redeploy-journal.json'
    $j = New-RbJournal $m
    if ($j.Contains('phase') -and $null -eq $j['phase']) { $j.Remove('phase') }
    Write-Journal -Path $jp -Journal $j
    $global:RbCalls = @(); $global:RbDead = @(); $global:RbImmortal = @(); $global:RbRenameThrows = $false; $global:RbStartAlive = $true
    $global:RbOldIdx = $oldIdx; $global:RbKind = $kind
    $global:RbRun = $run
    $global:RbProcs = @(
        (New-Proc 10 'node.exe' ('"C:\n\node.exe" "' + $ix + '"')),
        (New-Proc 11 'conhost.exe' ('conhost.exe --headless "C:\n\node.exe" "' + $ix + '"'))
    )
    @{ Dir = $dir; JP = $jp; Stage = $stage; OldIdx = $oldIdx; NewRun = $m.newRunValue; OldRun = $m.oldRun; Ix = $ix }
}

function Invoke-RbEngine($case, [bool]$dry) {
    $j = Read-Journal -Path $case.JP
    $script:RC = 99
    $out = Invoke-Rollback -Journal $j -JournalPath $case.JP -Dry $dry | Out-String
    @{ Out = $out; RC = $script:RC }
}

function Get-RbCount([string]$pattern) { @($global:RbCalls | Where-Object { $_ -match $pattern }).Count }

Describe 'Invoke-Rollback engine (every process / registry cmdlet mocked; journal and stage are real temp dirs)' {
    $newR = 'conhost.exe --headless "C:\n\node.exe" "X"'
    Mock Start-Sleep {}
    Mock Get-Process { [pscustomobject]@{ Id = $Id } }
    Mock Stop-Process { $global:RbCalls += "Stop:$Id"; $global:RbDead += [string]$Id }
    Mock Start-Process {
        $global:RbCalls += 'Start'
        if ($global:RbStartAlive) { $global:RbProcs += (New-Proc 50 'node.exe' ('"C:\n\node.exe" "' + $global:RbOldIdx + '"')) }
    }
    Mock Get-WmiObject { @($global:RbProcs | Where-Object { ($global:RbDead -notcontains [string]$_.ProcessId) -or ($global:RbImmortal -contains [string]$_.ProcessId) }) }
    Mock Get-RunKeyKind { $global:RbKind }
    Mock Get-ItemProperty { if ($null -eq $global:RbRun) { $null } else { [pscustomobject]@{ AetherCollector = $global:RbRun } } }
    Mock Set-ItemProperty { $global:RbCalls += 'Set'; $global:RbRun = $Value }
    Mock Remove-ItemProperty { $global:RbCalls += 'Remove'; $global:RbRun = $null }
    Mock Rename-Item {
        $global:RbCalls += 'Rename'
        if ($global:RbRenameThrows) { throw 'rename denied' }
        [IO.Directory]::Move($LiteralPath, (Join-Path (Split-Path $LiteralPath) $NewName))
    }

    $probe = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-jx-' + [guid]::NewGuid().ToString('N'))
    $global:RedeployTempPaths += @($probe)
    New-Item -ItemType Directory -Force -Path (Join-Path $probe 'target') | Out-Null
    $junctionOk = $false
    try {
        & cmd.exe /c mklink /J (Join-Path $probe 'link') (Join-Path $probe 'target') 2>&1 | Out-Null
        $junctionOk = (Test-Path -LiteralPath (Join-Path $probe 'link')) -and ((Get-Item -LiteralPath (Join-Path $probe 'link') -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    } catch { $junctionOk = $false }
    if ($junctionOk) { & cmd.exe /c rmdir (Join-Path $probe 'link') | Out-Null }

    It 'R-pre: a verified journal is deleted, nothing is stopped, started, set or removed, RC 0' {
        $c = New-RbCase @{ phase = 'verified' } $null 'String'
        $r = Invoke-RbEngine $c $false
        $r.Out | Should Match 'deploy completed, stale journal removed'
        $r.RC | Should Be 0
        Test-Path $c.JP | Should Be $false
        Get-RbCount '.' | Should Be 0
    }
    It 'R2: current == new value -> restored with Set and read back, RC 0, journal deleted' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Set$' | Should Be 1
        Get-RbCount '^Remove$' | Should Be 0
        $global:RbRun | Should Be $c.OldRun
        $r.RC | Should Be 0
        $r.Out | Should Match 'ROLLBACK COMPLETE: previous Run value restored, old collector was not running before'
        Test-Path $c.JP | Should Be $false
    }
    It 'R2: current == old value -> no write, RC 0' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $c.OldRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^(Set|Remove)$' | Should Be 0
        $r.RC | Should Be 0
        $r.Out | Should Match 'already the old value'
    }
    It 'R2: current is neither old nor new -> no write, RC 3, both values printed, journal kept' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = 'conhost.exe --headless "C:\other\node.exe" "C:\other\index.js"'
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^(Set|Remove)$' | Should Be 0
        $global:RbRun | Should Be 'conhost.exe --headless "C:\other\node.exe" "C:\other\index.js"'
        $r.RC | Should Be 3
        $r.Out | Should Match ([regex]::Escape($c.OldRun))
        $r.Out | Should Match ([regex]::Escape($c.NewRun))
        $r.Out | Should Match 'ROLLBACK INCOMPLETE'
        $r.Out | Should Match 'RECOVERY: 1\.'
        Test-Path $c.JP | Should Be $true
    }
    It 'R2: a value that differs from the new value only in case is "neither": no write, RC 3' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $c.NewRun.ToUpper()
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^(Set|Remove)$' | Should Be 0
        $r.RC | Should Be 3
    }
    It 'R2: current kind is not String -> no write, RC 3' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'ExpandString'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^(Set|Remove)$' | Should Be 0
        $r.RC | Should Be 3
        $r.Out | Should Match 'ExpandString'
    }
    It 'R2: oldRun = $null -> Remove-ItemProperty (not Set), value gone, RC 0' {
        $c = New-RbCase @{ oldWasRunning = $false; oldRun = $null; oldIndex = $null } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Remove$' | Should Be 1
        Get-RbCount '^Set$' | Should Be 0
        $global:RbRun | Should BeNullOrEmpty
        $r.RC | Should Be 0
    }
    It 'R2: oldRun = empty string is a real value -> restored with Set (not Remove)' {
        $c = New-RbCase @{ oldWasRunning = $false; oldRun = ''; oldIndex = $null } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Set$' | Should Be 1
        Get-RbCount '^Remove$' | Should Be 0
        ($global:RbRun -is [string]) | Should Be $true
        $global:RbRun.Length | Should Be 0
        $r.RC | Should Be 0
    }
    It 'R3: oldWasRunning with an empty old Run value -> nothing to relaunch, not a problem: RC 0, no Start, no empty manual line' {
        $c = New-RbCase @{ oldWasRunning = $true; oldRun = ''; oldIndex = $null } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 0
        $r.RC | Should Be 0
        $r.Out | Should Match 'nothing to relaunch'
        $r.Out | Should Not Match 'start it by hand: \s*$'
        Test-Path $c.JP | Should Be $false
    }
    It 'R2: the Run value deleted by someone else (oldRun non-null) -> says absent, no write, RC 3, journal kept' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $null
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^(Set|Remove)$' | Should Be 0
        $r.RC | Should Be 3
        $r.Out | Should Match 'the Run value is absent, expected the old or the new value'
        $r.Out | Should Not Match 'Current <>'
        Test-Path $c.JP | Should Be $true
    }
    It 'R3: relaunches the old collector (headless form, index exists), alive -> RC 0' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 1
        $r.RC | Should Be 0
        $r.Out | Should Match 'ROLLBACK COMPLETE: previous Run value restored, old collector running'
    }
    It 'R3: relaunch but not alive -> RC 3 with the manual command' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = $c.NewRun
        $global:RbStartAlive = $false
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 1
        $r.RC | Should Be 3
        $r.Out | Should Match 'start it by hand: conhost\.exe --headless'
    }
    It 'R3: oldWasRunning = $false -> not started, RC 0' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 0
        $r.RC | Should Be 0
        $r.Out | Should Match 'not running before this run; not started'
    }
    It 'R3: an unquoted hand-made old Run value cannot be relaunched -> RC 3 with the manual command, no Start' {
        $handMade = 'node.exe D:\x\collector\dist\index.js'
        $c = New-RbCase @{ oldRun = $handMade } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 0
        $r.RC | Should Be 3
        $r.Out | Should Match 'start it by hand: node\.exe D:\\x'
    }
    It 'R3: an old collector that is already alive (exact token) is never started again, RC 0' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = $c.NewRun
        $global:RbProcs += (New-Proc 60 'node.exe' ('"C:\n\node.exe" "' + $c.OldIdx + '"'))
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 0
        $r.RC | Should Be 0
        $r.Out | Should Match 'already running'
    }
    It 'R3: an old node and its conhost both alive -> still never started again, RC 0' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = $c.NewRun
        $global:RbProcs += (New-Proc 60 'node.exe' ('"C:\n\node.exe" "' + $c.OldIdx + '"'))
        $global:RbProcs += (New-Proc 61 'conhost.exe' ('conhost.exe --headless "C:\n\node.exe" "' + $c.OldIdx + '"'))
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 0
        $r.RC | Should Be 0
        $r.Out | Should Match 'already running'
    }
    It 'R3: only the old conhost is alive (its node exited) -> the old collector is relaunched once, RC 0' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = $c.NewRun
        $global:RbProcs += (New-Proc 61 'conhost.exe' ('conhost.exe --headless "C:\n\node.exe" "' + $c.OldIdx + '"'))
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Start$' | Should Be 1
        $r.RC | Should Be 0
        $r.Out | Should Not Match 'already running'
    }
    It 'R3: re-running the engine after an RC 3 does not start a second old collector' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = 'conhost.exe --headless "C:\other\node.exe" "C:\other\index.js"'
        $r1 = Invoke-RbEngine $c $false
        $r2 = Invoke-RbEngine $c $false
        $r1.RC | Should Be 3
        $r2.RC | Should Be 3
        Get-RbCount '^Start$' | Should Be 1
    }
    It 'R1 survivor: R2 still writes the Run value, R3 and R4 are NOT run, RC 3' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = $c.NewRun
        $global:RbImmortal = @('10')
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Set$' | Should Be 1
        $global:RbRun | Should Be $c.OldRun
        Get-RbCount '^Start$' | Should Be 0
        Get-RbCount '^Rename$' | Should Be 0
        Test-Path $c.Stage | Should Be $true
        $r.RC | Should Be 3
        $r.Out | Should Match 'R3 skipped'
        Test-Path $c.JP | Should Be $true
    }
    It 'invalid kill fields: R1 skipped (no Stop), R2 still runs, R3 and R4 skipped, RC 3' {
        $c = New-RbCase @{ indexJs = 'D:\other\collector\dist\index.js' } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        Get-RbCount '^Stop:' | Should Be 0
        Get-RbCount '^Set$' | Should Be 1
        Get-RbCount '^Start$' | Should Be 0
        Get-RbCount '^Rename$' | Should Be 0
        $r.RC | Should Be 3
        $r.Out | Should Match 'R1 skipped'
    }
    It 'R4: renames the real stage dir to collector.failed-* and keeps its contents' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $c.OldRun
        $r = Invoke-RbEngine $c $false
        $r.RC | Should Be 0
        Test-Path $c.Stage | Should Be $false
        $moved = @(Get-ChildItem -LiteralPath (Join-Path $c.Dir '9.9.9') -Directory | Where-Object { $_.Name -like 'collector.failed-*' })
        $moved.Count | Should Be 1
        Test-Path (Join-Path $moved[0].FullName 'dist\index.js') | Should Be $true
    }
    It 'R4: a reparse-point stage is skipped with a warning, RC unaffected (skipped if mklink /J fails)' -Skip:(-not $junctionOk) {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String' $true
        try {
            $global:RbRun = $c.OldRun
            $r = Invoke-RbEngine $c $false
            $r.RC | Should Be 0
            Get-RbCount '^Rename$' | Should Be 0
            $r.Out | Should Match 'R4 skipped: stage dir is a reparse point'
            Test-Path (Join-Path $c.Dir 'junction-target\dist\index.js') | Should Be $true
        } finally { & cmd.exe /c rmdir "$($c.Stage)" | Out-Null }
    }
    It 'R4: a rename failure is a warning only, RC stays 0' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $c.OldRun
        $global:RbRenameThrows = $true
        $r = Invoke-RbEngine $c $false
        $r.RC | Should Be 0
        $r.Out | Should Match 'R4 could not move the stage dir aside'
        Test-Path $c.Stage | Should Be $true
    }
    It 'shape failure: RC 3, nothing touched, journal kept' {
        $c = New-RbCase @{ phase = $null } $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $false
        $r.RC | Should Be 3
        $r.Out | Should Match "'phase' is missing"
        Get-RbCount '.' | Should Be 0
        $global:RbRun | Should Be $c.NewRun
        Test-Path $c.JP | Should Be $true
    }
    It 'R5: the journal is deleted when everything succeeded and kept when it did not' {
        $c = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = $c.OldRun
        $null = Invoke-RbEngine $c $false
        Test-Path $c.JP | Should Be $false
        $c2 = New-RbCase @{ oldWasRunning = $false } $null 'String'
        $global:RbRun = 'something else'
        $r2 = Invoke-RbEngine $c2 $false
        $r2.RC | Should Be 3
        Test-Path $c2.JP | Should Be $true
    }
    It '-Dry makes zero Stop / Start / Set / Remove / Rename calls, prints [DRY-RUN] for R1-R5, RC 0' {
        $c = New-RbCase @{} $null 'String'
        $global:RbRun = $c.NewRun
        $r = Invoke-RbEngine $c $true
        Get-RbCount '.' | Should Be 0
        $r.RC | Should Be 0
        foreach ($s in 'R1', 'R2', 'R3', 'R4', 'R5') { $r.Out | Should Match ('\[DRY-RUN\] ' + $s) }
        Test-Path $c.JP | Should Be $true
        Test-Path $c.Stage | Should Be $true
        $global:RbRun | Should Be $c.NewRun
    }
    It 'Invoke-RollbackCommand: no journal -> RC 2 "no redeploy journal"; unparseable -> RC 2 "journal unreadable"; a verified journal -> RC 0' {
        $c = New-RbCase @{ phase = 'verified' } $null 'String'
        $db = Join-Path $c.Dir 'collector.db'
        Remove-Item -LiteralPath $c.JP
        $script:RC = 99
        $out = Invoke-RollbackCommand -Dry $false -ExpectedDbPath $db | Out-String
        $script:RC | Should Be 2
        $out | Should Match 'no redeploy journal'
        [IO.File]::WriteAllText((Get-JournalPath -ExpectedDbPath $db), '{ not json')
        $script:RC = 99
        $out = Invoke-RollbackCommand -Dry $false -ExpectedDbPath $db | Out-String
        $script:RC | Should Be 2
        $out | Should Match 'journal unreadable'
        Remove-Item -LiteralPath (Get-JournalPath -ExpectedDbPath $db)
        $j = New-RbJournal @{ phase = 'verified' }
        Write-Journal -Path (Get-JournalPath -ExpectedDbPath $db) -Journal $j
        $script:RC = 99
        $out = Invoke-RollbackCommand -Dry $false -ExpectedDbPath $db | Out-String
        $script:RC | Should Be 0
        $out | Should Match 'stale journal removed'
        Get-RbCount '.' | Should Be 0
    }
}

Describe 'Invoke-Redeploy auto-rollback fault injection (everything mocked; journal, stage and old index.js are real temp files)' {
    $ftdir = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-fi-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $ftdir | Out-Null
    $global:RedeployTempPaths += @($ftdir)
    $db = Join-Path $ftdir 'collector.db'
    Set-Content -Path $db -Value 'x'
    $jp = Get-JournalPath -ExpectedDbPath $db
    $oldIdx = Join-Path $ftdir 'oldcoll\collector\dist\index.js'
    New-Item -ItemType Directory -Force -Path (Split-Path $oldIdx) | Out-Null
    Set-Content -Path $oldIdx -Value 'old'
    $global:FtOld = 'conhost.exe --headless "C:\n\node.exe" "' + $oldIdx + '"'
    $global:FtRun = $global:FtOld
    $global:FtSets = 0; $global:FtSetThrowAt = 0; $global:FtSetNoWrite = $false
    $global:FtStarts = 0; $global:FtStartThrowAt = 0
    $global:FtRows = 0; $global:FtRowThrowAt = 0
    $global:FtStops = 0; $global:FtNewAlive = $true; $global:FtBuildThrows = $false; $global:FtThrowPhases = @()
    Mock Test-OldCollectorRunning { $true }
    Mock Get-RunKeyKind { 'String' }
    Mock Get-ItemProperty { if ($null -eq $global:FtRun) { $null } else { [pscustomobject]@{ AetherCollector = $global:FtRun } } }
    Mock Set-ItemProperty {
        $global:FtSets++
        if ($global:FtSetThrowAt -eq $global:FtSets) { throw 'registry write denied' }
        if (-not $global:FtSetNoWrite) { $global:FtRun = $Value }
    }
    Mock Start-Process { $global:FtStarts++; if ($global:FtStartThrowAt -eq $global:FtStarts) { throw 'cannot start' } }
    Mock Start-Sleep {}
    Mock Copy-Item {}
    Mock Get-FreeBytes { [int64]1GB }
    Mock Stop-OldCollector { $global:FtStops++ }
    Mock Get-WmiObject { @() }
    Mock Get-Process {}
    Mock Stop-Process {}
    Mock Rename-Item { [IO.Directory]::Move($LiteralPath, (Join-Path (Split-Path $LiteralPath) $NewName)) }
    Mock Invoke-BuildAndStage {
        New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'dist') | Out-Null
        Set-Content -Path (Join-Path $Stage 'dist\index.js') -Value 'new'
        if ($global:FtBuildThrows) { throw 'npm build failed' }
    }
    Mock Test-CollectorAlive { if ($IndexJs -like '*\oldcoll\*') { return $true }; $global:FtNewAlive }
    Mock Get-RowCount {
        $global:FtRows++
        if ($global:FtRowThrowAt -eq $global:FtRows) { throw 'row count query failed' }
        if ($global:FtRows -eq 1) { [int64]100 } else { [int64]101 }
    }
    Mock Write-Journal {
        if ($global:FtThrowPhases -contains $Journal.phase) { throw 'disk full' }
        Set-Content -LiteralPath $Path -Value ($Journal | ConvertTo-Json)
    }
    function New-FtRoot { Join-Path $ftdir ([guid]::NewGuid().ToString('N')) }
    function Reset-Ft {
        Remove-Journal -Path $jp
        $global:FtRun = $global:FtOld
        $global:FtSets = 0; $global:FtSetThrowAt = 0; $global:FtSetNoWrite = $false
        $global:FtStarts = 0; $global:FtStartThrowAt = 0
        $global:FtRows = 0; $global:FtRowThrowAt = 0
        $global:FtStops = 0; $global:FtNewAlive = $true; $global:FtBuildThrows = $false; $global:FtThrowPhases = @()
    }
    function Start-FtDeploy($root) {
        $script:RC = 99
        Invoke-Redeploy -Version '9.9.9' -StageRoot $root -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
    }
    function Test-StageAside($root) {
        (-not (Test-Path -LiteralPath (Join-Path $root '9.9.9\collector'))) -and (@(Get-ChildItem -LiteralPath (Join-Path $root '9.9.9') -Filter 'collector.failed-*').Count -eq 1)
    }

    It 'baseline Get-RowCount throws (phase backed-up): Run never written, rolled back, RC 1, journal removed, stage aside' {
        Reset-Ft; $global:FtRowThrowAt = 1; $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'ERROR: row count query failed'
        $out | Should Match 'ROLLBACK COMPLETE'
        $out | Should Not Match 'RECOVERY'
        $global:FtSets | Should Be 0
        ($global:FtRun -ceq $global:FtOld) | Should Be $true
        $script:RC | Should Be 1
        Test-Path $jp | Should Be $false
        Test-StageAside $root | Should Be $true
    }
    It 'Set-ItemProperty throws (phase repointing): CAS sees the old value, no restore write, RC 1' {
        Reset-Ft; $global:FtSetThrowAt = 1; $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'ERROR: registry write denied'
        $out | Should Match 'already the old value'
        $out | Should Match 'ROLLBACK COMPLETE'
        $global:FtSets | Should Be 1
        ($global:FtRun -ceq $global:FtOld) | Should Be $true
        $script:RC | Should Be 1
        Test-Path $jp | Should Be $false
    }
    It 'read-back mismatch (phase repointing): no restore write, RC 1, never reaches Start-Process for the new collector' {
        Reset-Ft; $global:FtSetNoWrite = $true; $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'read-back mismatch'
        $out | Should Match 'already the old value'
        $global:FtSets | Should Be 1
        $global:FtStarts | Should Be 1   # only the rollback's relaunch of the old collector
        ($global:FtRun -ceq $global:FtOld) | Should Be $true
        $script:RC | Should Be 1
        Test-Path $jp | Should Be $false
    }
    It 'Start-Process throws (phase repointed): the Run value is restored with a write, RC 1' {
        Reset-Ft; $global:FtStartThrowAt = 1; $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'ERROR: cannot start'
        $out | Should Match 'ROLLBACK COMPLETE'
        $global:FtSets | Should Be 2
        ($global:FtRun -ceq $global:FtOld) | Should Be $true
        $script:RC | Should Be 1
        Test-Path $jp | Should Be $false
        Test-StageAside $root | Should Be $true
    }
    It 'new collector dead at verify (phase launched): Run restored, old collector relaunched, RC 1' {
        Reset-Ft; $global:FtNewAlive = $false; $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'new collector is not running'
        $out | Should Match 'ROLLBACK COMPLETE: previous Run value restored, old collector running'
        $global:FtSets | Should Be 2
        $global:FtStarts | Should Be 2
        ($global:FtRun -ceq $global:FtOld) | Should Be $true
        $script:RC | Should Be 1
        Test-Path $jp | Should Be $false
    }
    It 'double fault: the rollback restore throws -> RC 3, journal kept, RECOVERY has the old value, stop-new-first and the migrated-db sentence' {
        Reset-Ft; $global:FtNewAlive = $false; $global:FtSetThrowAt = 2; $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'ROLLBACK INCOMPLETE'
        $out | Should Match 'R2 failed \(registry write denied\)'
        $out | Should Match ('RECOVERY: 2\. The old Run value was <' + [regex]::Escape($global:FtOld))
        $out | Should Match 'RECOVERY: 3\. Stop the NEW collector'
        $out | Should Match 'the db may have been migrated by the new one'
        $script:RC | Should Be 3
        Test-Path $jp | Should Be $true
        Remove-Journal -Path $jp
    }
    It 'pre-journal failure (build throws): stage aside, no journal, no rollback, no RECOVERY, nothing stopped, RC 1' {
        Reset-Ft; $global:FtBuildThrows = $true; $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'ERROR: npm build failed'
        $out | Should Not Match 'RECOVERY'
        $out | Should Not Match 'Rollback'
        Test-Path $jp | Should Be $false
        $global:FtStops | Should Be 0
        $global:FtSets | Should Be 0
        $script:RC | Should Be 1
        Test-StageAside $root | Should Be $true
    }
    It 'a failed journal-open write (stopping) is pre-journal: nothing stopped, stage aside, RC 1' {
        Reset-Ft; $global:FtThrowPhases = @('stopping'); $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'ERROR: disk full'
        $out | Should Not Match 'RECOVERY'
        $global:FtStops | Should Be 0
        $global:FtSets | Should Be 0
        $script:RC | Should Be 1
        Test-StageAside $root | Should Be $true
    }
    It 'a second same-version run after an auto-rolled-back failure does not hit the stage-dir refusal' {
        Reset-Ft; $global:FtNewAlive = $false; $root = New-FtRoot
        Start-FtDeploy $root | Out-Null
        $script:RC | Should Be 1
        Reset-Ft
        $out = Start-FtDeploy $root
        $out | Should Not Match 'stage directory already exists'
        $out | Should Match 'Done\.'
        $script:RC | Should Be 0
    }
    It 'later journal writes are best-effort: a throwing stopped / backed-up / repointed / launched write warns and the deploy succeeds' {
        foreach ($phase in 'stopped', 'backed-up', 'repointed', 'launched') {
            Reset-Ft; $global:FtThrowPhases = @($phase); $root = New-FtRoot
            $out = Start-FtDeploy $root
            $out | Should Match ("WARNING: could not write journal phase '" + $phase + "'")
            $out | Should Match 'Done\.'
            $out | Should Not Match 'ERROR'
            $script:RC | Should Be 0
        }
    }
    It 'the repointing write stays fail-closed: when it throws the Run value is never written, rolled back, RC 1' {
        Reset-Ft; $global:FtThrowPhases = @('repointing'); $root = New-FtRoot
        $out = Start-FtDeploy $root
        $out | Should Match 'ERROR: disk full'
        $out | Should Match 'ROLLBACK COMPLETE'
        $global:FtSets | Should Be 0
        ($global:FtRun -ceq $global:FtOld) | Should Be $true
        $script:RC | Should Be 1
    }
}

Describe '-Rollback launch mode (child powershell.exe; nothing to roll back)' {
    $realJournal = Join-Path $env:USERPROFILE '.aether-os\redeploy-journal.json'
    $skip = Test-Path -LiteralPath $realJournal
    if ($skip) { Write-Output "SKIPPED: a real journal exists at $realJournal; this test never creates or touches one." }
    It 'exits 2 with "no redeploy journal" when there is no journal' -Skip:$skip {
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $out = & $ps -NoProfile -ExecutionPolicy Bypass -File $script -Rollback -DryRun 2>&1 | Out-String
        $LASTEXITCODE | Should Be 2
        $out | Should Match 'no redeploy journal'
        Test-Path -LiteralPath $realJournal | Should Be $false
    }
}

foreach ($p in @($global:RedeployTempPaths)) { if ($p) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $p } }

Describe 'temp cleanup' {
    It 'leaves none of the temp db / stage-root paths the suite created' {
        @($global:RedeployTempPaths).Count | Should BeGreaterThan 0
        @($global:RedeployTempPaths | Where-Object { $_ -and (Test-Path $_) }).Count | Should Be 0
    }
}

Describe 'dry run' {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-test-' + [guid]::NewGuid().ToString('N'))
    $out = & $ps -NoProfile -ExecutionPolicy Bypass -File $script -DryRun -Version 9.9.9 -StageRoot $tmp 2>&1 | Out-String
    $rc = $LASTEXITCODE
    It 'exits 0 and lists every step' {
        $rc | Should Be 0
        foreach ($s in 'Step 1: build', 'Step 2: free-space', 'Step 3: stop old', 'Step 4: back up', 'Step 5: baseline', 'Step 6: repoint', 'Step 7: start', 'Step 8: verify') {
            $out | Should Match ([regex]::Escape($s))
        }
    }
    It 'changes nothing' {
        Test-Path $tmp | Should Be $false
        Test-Path (Join-Path $env:USERPROFILE '.aether-os\redeploy-journal.json') | Should Be $false
    }
    It 'prints the journal lines but writes no journal' {
        $out | Should Match '\[DRY-RUN\] write journal .*redeploy-journal\.json \(phase stopping \.\.\. verified\)'
        $out | Should Match '\[DRY-RUN\] delete journal'
    }
    It 'rejects a bad version with exit 2' {
        & $ps -NoProfile -ExecutionPolicy Bypass -File $script -DryRun -Version 'x y' | Out-Null
        $LASTEXITCODE | Should Be 2
    }
}
