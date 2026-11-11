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
