<#
.SYNOPSIS
    Runs ONE interactive Claude session against the synthetic bridge server.

.DESCRIPTION
    This is the only model-bearing step in the harness. It spends real
    subscription usage and must not be run without explicit operator approval.

    Argument shape deliberately mirrors production (launchConfig.ts):
      --mcp-config <file> --allowedTools <t1> <t2> <t3>
    as THREE separate allowlist arguments, and with NO --permission-mode.
    The 2.1.270 probe passed one comma-joined allowlist and forced
    'manual' mode, so it validated a launch shape production never uses.
    -PermissionMode is available to reproduce that older shape on purpose;
    whatever is requested is recorded in session.json for the auditor.

.NOTES
    Write-Output only (repo rule): Write-Host bypasses the pipeline.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [string]$PermissionMode,
    [switch]$WhatIfSyntaxOnly
)

$ErrorActionPreference = 'Stop'

$sessionPath = Join-Path $RunDir 'session.json'
if (-not (Test-Path -LiteralPath $sessionPath)) { throw "No session.json in $RunDir - run prepare-run.mjs first" }
$session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json

$debugFile = Join-Path $RunDir 'client-debug.log'
if (Test-Path -LiteralPath $debugFile) { throw 'Probe already ran in this directory; prepare a fresh run.' }

$prompt = 'Run the operator-approved synthetic compatibility check only. Start one fake consultation using a stable request key, retrieve its answer with the single server-side quiet wait, then cancel for its cleanup receipt. Make exactly these three fake tool calls in order and no other tool calls. Do not run initialization, learning, triage, searches, files, shell commands, another server, or delegated agents. No real Codex call. Return only the three receipt UUIDs from the retrieved result and the cleanup receipt. If the fake tools are unavailable, stop without fallback.'

$arguments = @(
    '--session-id', $session.session_id,
    '--debug-file', $debugFile,
    '--mcp-config', (Join-Path $RunDir 'mcp.json'),
    '--allowedTools',
    'mcp__aether-bridge__ask_codex',
    'mcp__aether-bridge__get_codex_exchange',
    'mcp__aether-bridge__cancel_codex_exchange'
)
if ($PermissionMode) { $arguments += @('--permission-mode', $PermissionMode) }
$arguments += @('--', $prompt)

# Record what was actually requested, so the auditor reports requested vs
# effective mode instead of assuming they match.
$session | Add-Member -NotePropertyName 'requested_permission_mode' -NotePropertyValue $PermissionMode -Force
$session | Add-Member -NotePropertyName 'launch_arguments' -NotePropertyValue $arguments -Force
$session | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sessionPath -Encoding utf8

if ($WhatIfSyntaxOnly) {
    Write-Output 'Syntax/preparation check only. No model session started.'
    Write-Output ("client:    " + $session.client)
    Write-Output ("version:   " + $session.version)
    Write-Output ("workspace: " + $session.cwd)
    Write-Output ("arguments: " + ($arguments -join ' '))
    exit 0
}

# Clear inherited client/provider configuration so the probe measures the
# installed client's own defaults, not this shell's leftovers.
foreach ($name in (Get-ChildItem Env:).Name) {
    if ($name -match '^(CLAUDE|ANTHROPIC|ELECTRON_|NODE_ENV)') {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
}
$env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '120000'

Set-Location -LiteralPath $session.cwd
& $session.client @arguments
exit $LASTEXITCODE
