param(
    [string]$WorkDir = ".work/llmlet",
    [string]$OutputDir = "build/reference-llmlet"
)

$ErrorActionPreference = "Stop"

$LlmlletRepository = "https://github.com/ktock/llmlet.git"
$LlmlletCommit = "730bad2f5b4d6598f55b09eb22d54b5bf2a467ed"

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

Require-Command "git"
Require-Command "docker"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedWorkDir = Join-Path $RepositoryRoot $WorkDir
$ResolvedOutputDir = Join-Path $RepositoryRoot $OutputDir

if (-not (Test-Path $ResolvedWorkDir)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $ResolvedWorkDir -Parent) | Out-Null
    git clone --recurse-submodules $LlmlletRepository $ResolvedWorkDir
}

Push-Location $ResolvedWorkDir
try {
    $Origin = (git remote get-url origin).Trim()
    if ($Origin -ne $LlmlletRepository) {
        throw "Existing worktree at '$ResolvedWorkDir' does not point to $LlmlletRepository."
    }

    git fetch origin
    git checkout --detach $LlmlletCommit
    git submodule sync --recursive
    git submodule update --init --recursive

    $ActualCommit = (git rev-parse HEAD).Trim()
    if ($ActualCommit -ne $LlmlletCommit) {
        throw "Expected llmlet commit $LlmlletCommit but checked out $ActualCommit."
    }

    if (Test-Path $ResolvedOutputDir) {
        Remove-Item -Recurse -Force $ResolvedOutputDir
    }
    New-Item -ItemType Directory -Force -Path $ResolvedOutputDir | Out-Null

    Write-Host "Building llmlet reference at $LlmlletCommit"
    docker build --output "type=local,dest=$ResolvedOutputDir" .

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
