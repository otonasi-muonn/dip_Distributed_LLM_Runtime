param(
    [string]$RuntimeDir = "build/web-runtime",
    [string]$HarnessDir = "harness/runtime-only",
    [string]$OutputDir = "build/runtime-harness"
)

# Assemble the Runtime-only integration harness: the exported Runtime plus the
# harness page. Serve the result with scripts/serve-runtime.py, which sends the
# COOP/COEP headers the pthread build needs.

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib/runtime-build.ps1")

$ResolvedRuntimeDir = Resolve-RuntimePath -Root $RuntimeRoot -Path $RuntimeDir
$ResolvedHarnessDir = Resolve-RuntimePath -Root $RuntimeRoot -Path $HarnessDir
$ResolvedOutputDir = Resolve-RuntimePath -Root $RuntimeRoot -Path $OutputDir
$PatchDir = Join-Path $RuntimeRoot "patches"

if (-not (Test-Path $ResolvedRuntimeDir -PathType Container)) {
    throw @"
Runtime export was not found: $ResolvedRuntimeDir

Run the export first:

    pwsh -NoProfile -File scripts/export-web-runtime.ps1
"@
}

# Re-verify here as well: the export could be stale relative to patches/.
Assert-RuntimeReferenceBuild -Directory $ResolvedRuntimeDir -PatchDir $PatchDir

$RuntimeFiles = @("llmlet-mod.js", "llmlet-mod.wasm", "llmlet-runtime.js", $RuntimeBuildInfoName)
foreach ($Name in $RuntimeFiles) {
    if (-not (Test-Path (Join-Path $ResolvedRuntimeDir $Name) -PathType Leaf)) {
        throw "Runtime export is incomplete, missing: $Name"
    }
}

$HarnessFiles = @(Get-ChildItem -Path $ResolvedHarnessDir -File)
if ($HarnessFiles.Count -eq 0) {
    throw "Harness directory has no files: $ResolvedHarnessDir"
}

if (Test-Path $ResolvedOutputDir) {
    Remove-Item -Recurse -Force $ResolvedOutputDir
}
New-Item -ItemType Directory -Force -Path $ResolvedOutputDir | Out-Null

foreach ($Name in $RuntimeFiles) {
    Copy-Item -Force (Join-Path $ResolvedRuntimeDir $Name) (Join-Path $ResolvedOutputDir $Name)
}
foreach ($File in $HarnessFiles) {
    Copy-Item -Force $File.FullName (Join-Path $ResolvedOutputDir $File.Name)
}

Write-Host ""
Write-Host "Harness: $ResolvedOutputDir"
Write-Host ""
Write-Host "  python scripts/serve-runtime.py $OutputDir --port 8888"
Write-Host ""
Write-Host "  peer      http://localhost:8888/?role=peer&id=peer-1&fdmax=4"
Write-Host "  requester http://localhost:8888/?role=requester&id=req-1&peers=peer-1&fdmax=4"
Write-Host ""
Write-Host "Procedure and pass criteria: docs/RUNTIME_INTERFACE.md"
