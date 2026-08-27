param(
    [string]$WorkDir = ".work/llmlet",
    [string]$HarnessDir = "harness/backend-ops",
    [string]$OutputDir = "build/backend-ops"
)

# Build llama.cpp's tests/test-backend-ops for the browser and assemble the page that
# runs it.
#
# This answers a question the Runtime harness cannot: whether a WebGPU kernel computes
# the right numbers. test-backend-ops runs each op on the backend under test and on the
# CPU backend in the same process and compares them, so it is upstream's own oracle
# rather than a comparison we invent.
#
# It builds from the same pinned checkout and the same patches as the reference build,
# so the shaders under test are the ones the Runtime ships. Unlike the reference build
# it does not go through llmlet's Makefile - it configures llama.cpp directly with
# LLAMA_BUILD_TESTS=ON. See harness/backend-ops/Dockerfile for why RPC is off.
#
# Run scripts/build-llmlet-reference.ps1 first: it is what places the pinned checkout
# in .work/llmlet with patches/ applied, and this script reuses that tree as-is.

$ErrorActionPreference = "Stop"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib/runtime-build.ps1")

function Assert-LastExitCode([string]$Operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

$ResolvedWorkDir = Resolve-RuntimePath -Root $RepositoryRoot -Path $WorkDir
$ResolvedHarnessDir = Resolve-RuntimePath -Root $RepositoryRoot -Path $HarnessDir
$ResolvedOutputDir = Resolve-RuntimePath -Root $RepositoryRoot -Path $OutputDir
$Dockerfile = Join-Path $ResolvedHarnessDir "Dockerfile"

if (-not (Test-Path $ResolvedWorkDir -PathType Container)) {
    throw @"
Pinned checkout was not found: $ResolvedWorkDir

Run the reference build first; it clones the pin and applies patches/:

    pwsh -NoProfile -File scripts/build-llmlet-reference.ps1
"@
}

# Report which tree is being tested. The reference build leaves patches/ applied, so a
# tree that is clean here is a tree with no patches in it - which would silently test
# the unpatched shaders and make a MUL_MAT_ID pass meaningless.
$Applied = @(git -C (Join-Path $ResolvedWorkDir "llama.cpp") status --porcelain)
Assert-LastExitCode "git status"
if ($Applied.Count -eq 0) {
    throw @"
$ResolvedWorkDir/llama.cpp has no local modifications, so patches/ are not applied to
it and this build would test the unpatched shaders. Run the reference build first:

    pwsh -NoProfile -File scripts/build-llmlet-reference.ps1
"@
}
Write-Host "Testing the checkout with these modified files:"
$Applied | ForEach-Object { Write-Host "  $_" }

$StagingDir = "$ResolvedOutputDir.staging"
if (Test-Path $StagingDir) {
    Remove-Item -Recurse -Force $StagingDir
}
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

try {
    docker build -f $Dockerfile --output "type=local,dest=$StagingDir" $ResolvedWorkDir
    Assert-LastExitCode "docker build"

    foreach ($Name in @("test-backend-ops.js", "test-backend-ops.wasm")) {
        if (-not (Test-Path (Join-Path $StagingDir $Name) -PathType Leaf)) {
            throw "Build completed without expected artifact: $Name"
        }
    }

    foreach ($File in (Get-ChildItem -Path $ResolvedHarnessDir -File -Filter "*.html")) {
        Copy-Item -Force $File.FullName (Join-Path $StagingDir $File.Name)
    }

    if (Test-Path $ResolvedOutputDir) {
        Remove-Item -Recurse -Force $ResolvedOutputDir
    }
    Move-Item -Path $StagingDir -Destination $ResolvedOutputDir
}
finally {
    if (Test-Path $StagingDir) {
        Remove-Item -Recurse -Force $StagingDir
    }
}

Write-Host ""
Write-Host "Harness: $ResolvedOutputDir"
Write-Host ""
Write-Host "  python scripts/serve-runtime.py $OutputDir --port 8889"
Write-Host ""
Write-Host "  MUL_MAT_ID only  http://localhost:8889/?args=-o%20MUL_MAT_ID"
Write-Host "  everything       http://localhost:8889/"
Write-Host ""
Write-Host "A pass means the backend under test matched the CPU reference. Check the"
Write-Host "'Backend n/N' line in the output to confirm WebGPU was one of them."
