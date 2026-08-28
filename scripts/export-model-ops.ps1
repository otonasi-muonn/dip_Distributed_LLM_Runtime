param(
    [Parameter(Mandatory = $true)][string]$HfRepo,
    [string]$Name,
    [string]$WorkDir = ".work/llmlet",
    [string]$OutputDir = "build/backend-ops",
    [string]$Image = "llamacpp-export-ops:local"
)

# Write out the ops a model's graph actually contains, from its GGUF metadata alone.
#
# This is how a model gets tested at its real dimensions without downloading it. For
# Qwen3.6-35B-A3B that is 256 experts and k=2048 against 12.93 GB of weights we never
# fetch: common_params_parse sets skip_model_download for this example and the model is
# built with no_alloc, so only the header crosses the network.
#
# The output goes next to the backend-ops harness, which loads it with --test-file and
# runs every case against both the backend under test and the CPU reference.
#
#     pwsh -File scripts/export-model-ops.ps1 -HfRepo mradermacher/Qwen3.6-35B-A3B-GGUF:Q2_K -Name qwen36
#
# Then open:
#     http://localhost:8889/?args=--test-file%20/qwen36-ops.txt
#
# A pass needs FAIL == 0 *and* NOT SUPPORTED == 0. The harness page computes that; the
# program's own "n/n tests passed" excludes the cases it declined to run.

$ErrorActionPreference = "Stop"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib/runtime-build.ps1")

function Assert-LastExitCode([string]$Operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

$ResolvedWorkDir = Resolve-RuntimePath -Root $RepositoryRoot -Path $WorkDir
$ResolvedOutputDir = Resolve-RuntimePath -Root $RepositoryRoot -Path $OutputDir
$Dockerfile = Join-Path $RepositoryRoot "harness/backend-ops/Dockerfile.export-ops"

if (-not (Test-Path $ResolvedWorkDir -PathType Container)) {
    throw @"
Pinned checkout was not found: $ResolvedWorkDir

Run the reference build first; it clones the pin and applies patches/:

    pwsh -NoProfile -File scripts/build-llmlet-reference.ps1
"@
}

if (-not $Name) {
    # mradermacher/Qwen3.6-35B-A3B-GGUF:Q2_K -> qwen3.6-35b-a3b-gguf-q2_k
    $Name = ($HfRepo -split "/")[-1].Replace(":", "-").ToLowerInvariant()
}
$OutFile = "$Name-ops.txt"

New-Item -ItemType Directory -Force -Path $ResolvedOutputDir | Out-Null

Write-Host "Building $Image (cached after the first run)"
docker build -f $Dockerfile -t $Image $ResolvedWorkDir
Assert-LastExitCode "docker build"

Write-Host ""
Write-Host "Exporting graph ops for $HfRepo (metadata only, no weights)"
docker run --rm -v "$($ResolvedOutputDir):/out" $Image -hf $HfRepo -o "/out/$OutFile"
Assert-LastExitCode "export-graph-ops"

$Written = Join-Path $ResolvedOutputDir $OutFile
if (-not (Test-Path $Written -PathType Leaf)) {
    throw "export-graph-ops reported success but did not write $Written"
}

$Lines = (Get-Content $Written | Measure-Object -Line).Lines
Write-Host ""
Write-Host "Wrote $Written ($Lines op(s))"
Write-Host ""
Write-Host "  python scripts/serve-runtime.py $OutputDir --port 8889"
Write-Host "  http://localhost:8889/?args=--test-file%20/$OutFile"
Write-Host ""
Write-Host "Pass condition: FAIL == 0 AND NOT SUPPORTED == 0."
Write-Host "The page computes that. Do not read the program's own 'n/n tests passed' as a"
Write-Host "pass: it counts only the cases it ran, so a run that executed nothing prints 0/0."
