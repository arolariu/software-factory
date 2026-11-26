#Requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$NpmConfig,
    [string]$DockerContext = 'default',
    [string]$Image = 'software-factory:foundation-smoke',
    [switch]$Browser
)

$ErrorActionPreference = 'Stop'
$npmConfigPath = (Resolve-Path -LiteralPath $NpmConfig).Path
$nonce = [guid]::NewGuid().ToString('N').Substring(0, 12)
$instance = "factory-smoke-$nonce"
$data = "$instance-data"
$restored = "$instance-restore"
$running = $false

function Invoke-Docker {
    $output = & docker --context $DockerContext @args
    if ($LASTEXITCODE -ne 0) { throw "Docker $($args[0]) failed (exit $LASTEXITCODE)." }
    $output
}

function Wait-ForPortal {
    $address = (Invoke-Docker port $instance '3000/tcp' | Select-Object -First 1).Trim()
    $origin = "http://$address"
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "$origin/healthz" -SkipHttpErrorCheck -TimeoutSec 2
            if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).status -eq 'ok') {
                return $origin
            }
        } catch [System.Net.Http.HttpRequestException] {
            if ((Invoke-Docker inspect --format '{{.State.Running}}' $instance) -eq 'false') { break }
        }
        Start-Sleep -Milliseconds 300
    }
    Invoke-Docker logs $instance | Write-Host
    throw 'The app did not become healthy.'
}

function Start-Portal([string]$volume) {
    Invoke-Docker run -d --name $instance --read-only --cap-drop ALL `
        --security-opt no-new-privileges --stop-timeout 10 `
        --mount "type=volume,source=$volume,target=/data" -p '127.0.0.1::3000' $Image | Out-Null
    $script:running = $true
    Wait-ForPortal
}

function Stop-Portal {
    Invoke-Docker stop $instance | Out-Null
    $status = Invoke-Docker inspect --format '{{.State.ExitCode}}' $instance
    if ($status -ne '0') { throw "The app did not shut down cleanly (exit $status)." }
    Invoke-Docker rm $instance | Out-Null
    $script:running = $false
}

function Use-Database([string]$volume, [string]$scriptText, [string]$backupVolume) {
    $options = @('--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', "type=volume,source=$volume,target=/data")
    if ($backupVolume) { $options += @('--mount', "type=volume,source=$backupVolume,target=/backup") }
    Invoke-Docker run @options --entrypoint node $Image --input-type=module -e $scriptText
}

function Assert-BootFails([string]$reason, [string[]]$options) {
    $name = "$instance-negative"
    Invoke-Docker run -d --name $name @options $Image | Out-Null
    try {
        for ($i = 0; $i -lt 40; $i++) {
            $status = Invoke-Docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' $name
            if ($status -eq 'exited 1') { return }
            if ($status -like 'exited *') { throw "Unexpected shutdown status: $status ($reason)." }
            Start-Sleep -Milliseconds 250
        }
        throw "Container accepted an unusable data location: $reason."
    } finally {
        Invoke-Docker rm --force $name | Out-Null
    }
}

Push-Location (Join-Path $PSScriptRoot '..\..')
$publicRoot = Join-Path (Get-Location).Path 'src\web\public'
$hadPublicRoot = Test-Path -LiteralPath $publicRoot
$fixtureName = "$instance-private.txt"
$publicFixture = Join-Path $publicRoot $fixtureName
try {
    if (-not $hadPublicRoot) { New-Item -ItemType Directory -Path $publicRoot | Out-Null }
    Set-Content -LiteralPath $publicFixture -Value 'This untracked local file must not enter the image.'
    & docker --context $DockerContext build --secret "id=npm_config,src=$npmConfigPath" --tag $Image .
    if ($LASTEXITCODE -ne 0) { throw 'The foundation image failed to build.' }

    Assert-BootFails 'overridden ephemeral directory' @('--env', 'FACTORY_DATA_DIR=/tmp')

    foreach ($volume in @($data, $restored)) {
        Invoke-Docker volume create $volume | Out-Null
        Invoke-Docker run --rm --user root --mount "type=volume,source=$volume,target=/data" `
            --entrypoint node $Image -e "const fs=require('node:fs'); fs.chownSync('/data', 1000, 1000); fs.chmodSync('/data', 0o700)" | Out-Null
    }

    $origin = Start-Portal $data
    $entry = Invoke-WebRequest -Uri "$origin/connections/example/issues" -Headers @{ Accept = 'text/html' }
    if ($entry.StatusCode -ne 200 -or $entry.Content -notmatch '/assets/[^" ]+\.js') {
        throw 'The deployed image did not serve the compiled Svelte entry.'
    }
    foreach ($missing in @('/api/missing', '/auth/github/callback', '/assets/missing.js')) {
        $response = Invoke-WebRequest -Uri "$origin$missing" -Headers @{ Accept = 'text/html' } -SkipHttpErrorCheck
        if ($response.StatusCode -ne 404 -or $response.Headers['Content-Type'] -like '*text/html*') {
            throw "$missing did not return a non-HTML 404."
        }
    }
    $metadata = Invoke-RestMethod -Uri "$origin/api/build"
    if ($metadata.PSObject.Properties.Name.Count -ne 3 -or
        $null -ne $metadata.revision -or $null -ne $metadata.builtAt -or $null -ne $metadata.runUrl) {
        throw 'Local image reported invented build provenance.'
    }
    Invoke-Docker exec $instance node --input-type=module -e @'
import { existsSync } from 'node:fs';
const privateFixture = `/app/dist/web/${process.argv[1]}`;
if (process.getuid() === 0 || ['/app/src', '/app/tests', '/app/.npmrc', '/app/node_modules/vitest', privateFixture].some(existsSync)) {
  process.exit(1);
}
'@ $fixtureName

    if ($Browser) {
        $env:FACTORY_SMOKE_URL = $origin
        try {
            & node '.\node_modules\@playwright\test\cli.js' test
            if ($LASTEXITCODE -ne 0) { throw 'The browser smoke failed.' }
        } finally {
            Remove-Item Env:\FACTORY_SMOKE_URL -ErrorAction SilentlyContinue
        }
    }
    Stop-Portal

    Use-Database $data @'
import { openDatabase } from './dist/server/persistence/open.js';
const db = openDatabase('/data/factory.sqlite');
db.exec(`
  INSERT INTO users(id) VALUES ('smoke-user');
  INSERT INTO identities(id, user_id, provider, issuer, subject)
    VALUES ('smoke-identity', 'smoke-user', 'github', 'github.com', '42');
  INSERT INTO repositories(id, provider, canonical_host, provider_scope, provider_repo_id, canonical_url)
    VALUES ('smoke-repo', 'github', 'github.com', 'test', '42', 'https://github.com/example/fixture');
  INSERT INTO repo_connections(id, repo_id, user_id, identity_id, connected_at)
    VALUES ('smoke-connection', 'smoke-repo', 'smoke-user', 'smoke-identity', 1);
`);
db.close();
'@

    $origin = Start-Portal $data
    $assertConnection = @'
import { openDatabase } from './dist/server/persistence/open.js';
const db = openDatabase('/data/factory.sqlite');
if (!db.prepare("SELECT 1 FROM repo_connections WHERE id = 'smoke-connection'").get()) throw Error('Connection missing');
db.close();
'@
    Use-Database $data $assertConnection
    Use-Database $data @'
import { openDatabase } from './dist/server/persistence/open.js';
const db = openDatabase('/data/factory.sqlite');
await db.backup('/backup/factory.sqlite');
db.close();
'@ $restored
    Stop-Portal

    $origin = Start-Portal $restored
    Use-Database $restored $assertConnection
    Stop-Portal
    Invoke-Docker run --rm --user root --mount "type=volume,source=$restored,target=/data" `
        --entrypoint node $Image -e "require('node:fs').chmodSync('/data/factory.sqlite', 0o400)" | Out-Null
    Assert-BootFails 'read-only current-schema SQLite file' @('--mount', "type=volume,source=$restored,target=/data")
    Write-Host 'Container smoke passed: non-root, compiled shell, route boundaries, native SQLite, restart, and online backup restore.'
} finally {
    if ($running) { & docker --context $DockerContext rm --force $instance | Out-Null }
    foreach ($volume in @($data, $restored)) {
        & docker --context $DockerContext volume rm $volume 2>$null | Out-Null
    }
    if (Test-Path -LiteralPath $publicFixture) { Remove-Item -LiteralPath $publicFixture }
    if (-not $hadPublicRoot -and (Test-Path -LiteralPath $publicRoot) -and
        -not (Get-ChildItem -LiteralPath $publicRoot -Force)) { Remove-Item -LiteralPath $publicRoot }
    Pop-Location
}
