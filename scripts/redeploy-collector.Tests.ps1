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
    $db = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-db-' + [guid]::NewGuid().ToString('N') + '.db')
    Set-Content -Path $db -Value 'x'
    $oldValue = 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'
    $global:RedeployTempPaths += @($db)
    $global:RedeployRunValue = $oldValue
    Mock Get-RunKeyKind { 'String' }
    Mock Get-ItemProperty { [pscustomobject]@{ AetherCollector = $global:RedeployRunValue } }
    Mock Set-ItemProperty { $global:RedeployRunValue = $Value }
    Mock Start-Process {}
    Mock Start-Sleep {}
    Mock Copy-Item {}
    Mock Invoke-BuildAndStage {}
    Mock Get-FreeBytes { [int64]1GB }
    Mock Stop-OldCollector {}
    $script:counts = @()
    Mock Get-RowCount { $script:counts += 'read'; [int64]100 }

    It 'reads the baseline after the stop, then reports a crashed new collector as failure with recovery text' {
        Mock Test-CollectorAlive { $false }
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 3 | Out-String
        $out | Should Match 'new collector is not running'
        $out | Should Match 'RECOVERY: old Run value was <conhost.exe --headless'
        $out | Should Match 'Backup path: '
        $out | Should Match '\.pre-9\.9\.9-'
        Assert-MockCalled Stop-OldCollector -Times 1
        Assert-MockCalled Start-Process -Times 1
        Assert-MockCalled Get-RowCount -Times 1
    }
    It 'treats alive-but-no-rows as success (idle machine)' {
        $global:RedeployRunValue = $oldValue
        Mock Test-CollectorAlive { $true }
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
        Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-Null
        Assert-MockCalled Set-ItemProperty -ParameterFilter { $Type -eq 'String' } -Times 1
    }
    It 'fails step 6 when the read-back differs from what was written' {
        $global:RedeployRunValue = $oldValue
        Mock Set-ItemProperty {}
        Mock Test-CollectorAlive { $true }
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'read-back mismatch'
        $out | Should Not Match 'Done\.'
        $out | Should Not Match 'Step 7'
    }
    It 'treats an empty old Run value as present, not absent' {
        $global:RedeployRunValue = ''
        Mock Test-CollectorAlive { $false }
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'RECOVERY: old Run value was <>'
        $out | Should Not Match 'no old Run value existed'
    }
    # Last in this Describe: its Mock Get-FreeBytes persists for the Its after it.
    It 'fails before stopping anything when free space is short' {
        Mock Get-FreeBytes { [int64]0 }
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -ExpectedDbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'not enough free space'
        $out | Should Not Match 'RECOVERY'
    }
}

Describe 'Invoke-Redeploy preflight guards (nothing may be changed)' {
    $db = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-db-' + [guid]::NewGuid().ToString('N') + '.db')
    Set-Content -Path $db -Value 'x'
    $root = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-root-' + [guid]::NewGuid().ToString('N'))
    $global:RedeployTempPaths += @($db, $root)
    $oldValue = 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"'
    $global:RedeployRunValue = $oldValue
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
    }
    It 'rejects a bad version with exit 2' {
        & $ps -NoProfile -ExecutionPolicy Bypass -File $script -DryRun -Version 'x y' | Out-Null
        $LASTEXITCODE | Should Be 2
    }
}
