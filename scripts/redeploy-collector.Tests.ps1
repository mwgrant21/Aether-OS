# Pester 3.x/5.x compatible. Run: Invoke-Pester scripts\redeploy-collector.Tests.ps1
# Never runs the destructive steps: only pure helpers and a -DryRun child process.
$script = Join-Path $PSScriptRoot 'redeploy-collector.ps1'
. $script

Describe 'Get-CollectorProcessMatch' {
    $root = 'D:\AetherBuilds'
    $rows = @(
        [pscustomobject]@{ ProcessId = 10; Name = 'node.exe'; CommandLine = '"C:\Program Files\nodejs\node.exe" "D:\AetherBuilds\0.7.6\collector\dist\index.js"' },
        [pscustomobject]@{ ProcessId = 11; Name = 'conhost.exe'; CommandLine = 'conhost.exe --headless "node.exe" "D:\AetherBuilds\0.7.5\collector\dist\index.js"' },
        [pscustomobject]@{ ProcessId = 12; Name = 'node.exe'; CommandLine = 'node.exe C:\other\app\index.js' },
        [pscustomobject]@{ ProcessId = 13; Name = 'node.exe'; CommandLine = $null },
        [pscustomobject]@{ ProcessId = 14; Name = 'node.exe'; CommandLine = 'node.exe D:\AetherBuilds\0.7.6\collector\dist\index.js' }
    )
    It 'matches only collector index.js under the stage root, never by name alone' {
        $m = Get-CollectorProcessMatch -Processes $rows -StageRoot $root
        ($m | ForEach-Object { $_.ProcessId }) -join ',' | Should Be '10,11,14'
    }
    It 'excludes the given PID' {
        $m = Get-CollectorProcessMatch -Processes $rows -StageRoot $root -ExcludePid 10
        ($m | ForEach-Object { $_.ProcessId }) -join ',' | Should Be '11,14'
    }
}

Describe 'Get-RunKeyValue' {
    It 'matches the hand-made headless conhost form' {
        Get-RunKeyValue -IndexJs 'D:\AetherBuilds\1.2.3\collector\dist\index.js' -NodeExe 'C:\n\node.exe' |
            Should Be 'conhost.exe --headless "C:\n\node.exe" "D:\AetherBuilds\1.2.3\collector\dist\index.js"'
    }
}

Describe 'dry run' {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('redeploy-test-' + [guid]::NewGuid().ToString('N'))
    $out = & $ps -NoProfile -ExecutionPolicy Bypass -File $script -DryRun -Version 9.9.9 -StageRoot $tmp -DbPath (Join-Path $tmp 'c.db') 2>&1 | Out-String
    $rc = $LASTEXITCODE
    It 'exits 0 and lists every step' {
        $rc | Should Be 0
        foreach ($s in 'Step 1: build', 'Step 2: stage', 'Step 3: back up db', 'Step 4: stop old', 'Step 5: repoint', 'Step 6: start', 'Step 7: verify') {
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
