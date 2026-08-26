param(
    [string]$WorkDir = ".work/llmlet",
    [string]$OutputDir = "build/reference-llmlet"
)

# Reproducible Runtime reference build: pinned llmlet commit + pinned llama.cpp fork
# commit + patches/*.patch, built in the upstream Docker image.

$ErrorActionPreference = "Stop"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib/runtime-build.ps1")

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

$ResolvedWorkDir = Resolve-RuntimePath -Root $RepositoryRoot -Path $WorkDir
$ResolvedOutputDir = Resolve-RuntimePath -Root $RepositoryRoot -Path $OutputDir
$PatchDir = Join-Path $RepositoryRoot "patches"

# Read the patch set first: a missing or unregistered patch should fail before we
# touch the checkout.
$Patches = Get-RuntimePatchInventory -PatchDir $PatchDir

if (-not (Test-Path $ResolvedWorkDir)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $ResolvedWorkDir -Parent) | Out-Null
    git clone --recurse-submodules $RuntimeLlmletRepository $ResolvedWorkDir
    Assert-LastExitCode "git clone"
}

Push-Location $ResolvedWorkDir
try {
    $Origin = git remote get-url origin
    Assert-LastExitCode "git remote get-url origin"
    $Origin = $Origin.Trim()

    if ($Origin -ne $RuntimeLlmletRepository) {
        throw "Existing worktree at '$ResolvedWorkDir' does not point to $RuntimeLlmletRepository."
    }

    git fetch origin
    Assert-LastExitCode "git fetch origin"

    # Drop patches applied by a previous run so the build always starts from the pin.
    # git clean is deliberately not used: it would delete local build output.
    git reset --hard
    Assert-LastExitCode "git reset --hard"

    git checkout --detach $RuntimeLlmletCommit
    Assert-LastExitCode "git checkout"

    git submodule sync --recursive
    Assert-LastExitCode "git submodule sync"

    git submodule update --init --recursive --force
    Assert-LastExitCode "git submodule update"

    git submodule foreach --recursive git reset --hard
    Assert-LastExitCode "git submodule reset"

    $ActualCommit = (git rev-parse HEAD).Trim()
    Assert-LastExitCode "git rev-parse HEAD"
    if ($ActualCommit -ne $RuntimeLlmletCommit) {
        throw "Expected llmlet commit $RuntimeLlmletCommit but checked out $ActualCommit."
    }

    $ActualLlamaCpp = (git -C "llama.cpp" rev-parse HEAD).Trim()
    Assert-LastExitCode "git rev-parse llama.cpp HEAD"
    if ($ActualLlamaCpp -ne $RuntimeLlamaCppCommit) {
        throw "Expected llama.cpp commit $RuntimeLlamaCppCommit but checked out $ActualLlamaCpp."
    }

    foreach ($Patch in $Patches) {
        Write-Host "Applying $($Patch.Name) to $($Patch.Repo)"
        git -C $Patch.Repo apply --check $Patch.Path
        Assert-LastExitCode "git apply --check $($Patch.Name)"
        git -C $Patch.Repo apply $Patch.Path
        Assert-LastExitCode "git apply $($Patch.Name)"
    }

    # Build into a staging directory and only publish it once everything passed.
    #
    # Writing straight into the output directory would mean a failed or partial
    # `docker build --output` leaves half a build there, and it would destroy the
    # previous working artifacts before we know the new ones are any good. Nothing
    # outside this block ever sees a directory that has BUILD_INFO.txt without the
    # artifacts it describes.
    $StagingDir = "$ResolvedOutputDir.staging"
    if (Test-Path $StagingDir) {
        Remove-Item -Recurse -Force $StagingDir
    }
    New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

    try {
        Write-Host "Building llmlet reference at $RuntimeLlmletCommit + $($Patches.Count) patch(es)"
        docker build --output "type=local,dest=$StagingDir" .
        Assert-LastExitCode "docker build"

        foreach ($Name in $RuntimeBuildArtifacts) {
            if (-not (Test-Path (Join-Path $StagingDir $Name) -PathType Leaf)) {
                throw "Build completed without expected artifact: $Name"
            }
        }

        # Provenance is written last, and it hashes the artifacts next to it.
        Write-RuntimeBuildInfo -OutputDir $StagingDir -PatchDir $PatchDir | Out-Null
        Assert-RuntimeReferenceBuild -Directory $StagingDir -PatchDir $PatchDir

        if (Test-Path $ResolvedOutputDir) {
            Remove-Item -Recurse -Force $ResolvedOutputDir
        }
        Move-Item -Path $StagingDir -Destination $ResolvedOutputDir
    }
    finally {
        # On any failure the staging directory goes away, so a later run cannot pick
        # up a half-finished build and the previous output directory is untouched.
        if (Test-Path $StagingDir) {
            Remove-Item -Recurse -Force $StagingDir
        }
    }

    Write-Host "Reference build completed."
    Write-Host "Artifacts: $ResolvedOutputDir"
    Write-Host "Provenance: $(Join-Path $ResolvedOutputDir $RuntimeBuildInfoName)"
}
finally {
    Pop-Location
}
