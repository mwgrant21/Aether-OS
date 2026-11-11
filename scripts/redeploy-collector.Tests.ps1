# Pester 3.x/5.x compatible. Run: Invoke-Pester scripts\redeploy-collector.Tests.ps1
# Never runs the destructive steps: helpers are tested directly, Stop-Process /
# Start-Process / registry / Copy-Item are mocked, and a -DryRun child checks the output.
$script = Join-Path $PSScriptRoot 'redeploy-collector.ps1'
. $script

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
    Mock Get-ItemProperty { [pscustomobject]@{ AetherCollector = $oldValue } }
    Mock Set-ItemProperty {}
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
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -Dry $false -VerifySeconds 3 | Out-String
        $out | Should Match 'new collector is not running'
        $out | Should Match 'RECOVERY: old Run value was <conhost.exe --headless'
        $out | Should Match 'Backup path: '
        $out | Should Match '\.pre-9\.9\.9-'
        Assert-MockCalled Stop-OldCollector -Times 1
        Assert-MockCalled Start-Process -Times 1
        Assert-MockCalled Get-RowCount -Times 1
    }
    It 'treats alive-but-no-rows as success (idle machine)' {
        Mock Test-CollectorAlive { $true }
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'new collector started; no events in 1 s'
        $out | Should Match 'Done\.'
        $out | Should Not Match 'ERROR'
    }
    It 'does not copy the -shm file' {
        Assert-MockCalled Copy-Item -ParameterFilter { $Path -like '*-shm' } -Times 0
    }
    It 'fails before stopping anything when free space is short' {
        Mock Get-FreeBytes { [int64]0 }
        $out = Invoke-Redeploy -Version '9.9.9' -StageRoot 'D:\AetherBuilds' -DbPath $db -Dry $false -VerifySeconds 1 | Out-String
        $out | Should Match 'not enough free space'
        $out | Should Not Match 'RECOVERY'
    }
}

Describe 'dry run' {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-test-' + [guid]::NewGuid().ToString('N'))
    $out = & $ps -NoProfile -ExecutionPolicy Bypass -File $script -DryRun -Version 9.9.9 -StageRoot $tmp -DbPath (Join-Path $tmp 'c.db') 2>&1 | Out-String
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
