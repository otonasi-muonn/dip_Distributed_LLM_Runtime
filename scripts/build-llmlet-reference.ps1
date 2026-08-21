param(
    [string]$WorkDir = ".work/llmlet",
    [string]$OutputDir = "build/reference-llmlet"
)

$ErrorActionPreference = "Stop"

$LlmletRepository = "https://github.com/ktock/llmlet.git"
$LlmletCommit = "730bad2f5b4d6598f55b09eb22d54b5bf2a467ed"

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Assert-LastExitCode([string]$Operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Assert-DockerDaemon {
    $ServerVersion = docker info --format "{{.ServerVersion}}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw @"
Docker CLI is installed, but the Docker daemon is not reachable.

On Windows, start Docker Desktop and wait until the Linux engine is running.
Verify it with:

    docker info

Then rerun this script. The existing llmlet checkout in .work/llmlet will be reused.
"@
    }

    Write-Host "Docker daemon available (server $($ServerVersion.Trim()))."
}

Require-Command "git"
Require-Command "docker"
Assert-DockerDaemon

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedWorkDir = Join-Path $RepositoryRoot $WorkDir
$ResolvedOutputDir = Join-Path $RepositoryRoot $OutputDir

if (-not (Test-Path $ResolvedWorkDir)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $ResolvedWorkDir -Parent) | Out-Null
    git clone --recurse-submodules $LlmletRepository $ResolvedWorkDir
    Assert-LastExitCode "git clone"
}

Push-Location $ResolvedWorkDir
try {
    $Origin = git remote get-url origin
    Assert-LastExitCode "git remote get-url origin"
    $Origin = $Origin.Trim()

    if ($Origin -ne $LlmletRepository) {
        throw "Existing worktree at '$ResolvedWorkDir' does not point to $LlmletRepository."
    }

    git fetch origin
    Assert-LastExitCode "git fetch origin"

    git checkout --detach $LlmletCommit
    Assert-LastExitCode "git checkout"

    git submodule sync --recursive
    Assert-LastExitCode "git submodule sync"

    git submodule update --init --recursive
    Assert-LastExitCode "git submodule update"

    $ActualCommit = git rev-parse HEAD
    Assert-LastExitCode "git rev-parse HEAD"
    $ActualCommit = $ActualCommit.Trim()

    if ($ActualCommit -ne $LlmletCommit) {
        throw "Expected llmlet commit $LlmletCommit but checked out $ActualCommit."
    }

    if (Test-Path $ResolvedOutputDir) {
        Remove-Item -Recurse -Force $ResolvedOutputDir
    }
    New-Item -ItemType Directory -Force -Path $ResolvedOutputDir | Out-Null

    Write-Host "Building llmlet reference at $LlmletCommit"
    docker build --output "type=local,dest=$ResolvedOutputDir" .
    Assert-LastExitCode "docker build"

    $ExpectedArtifacts = @(
        (Join-Path $ResolvedOutputDir "llmlet-mod.js"),
        (Join-Path $ResolvedOutputDir "llmlet-mod.wasm")
    )

    foreach ($Artifact in $ExpectedArtifacts) {
        if (-not (Test-Path $Artifact)) {
            throw "Build completed without expected artifact: $Artifact"
        }
    }

    Write-Host "Reference build completed."
    Write-Host "Artifacts: $ResolvedOutputDir"
}
finally {
    Pop-Location
}
