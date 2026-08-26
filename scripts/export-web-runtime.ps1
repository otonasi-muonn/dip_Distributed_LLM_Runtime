param(
    [string]$BuildDir = "build/reference-llmlet",
    [string]$OutputDir = "build/web-runtime",
    [string]$Adapter = "runtime/llmlet-runtime.js"
)

# Runtime-only export. This script deliberately knows nothing about the Web
# application's directory layout: it produces the three files the Web repo consumes
# plus their provenance, and copying them into a static serving directory is the Web
# side's decision.

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib/runtime-build.ps1")

$ResolvedBuildDir = Resolve-RuntimePath -Root $RuntimeRoot -Path $BuildDir
$ResolvedOutputDir = Resolve-RuntimePath -Root $RuntimeRoot -Path $OutputDir
$ResolvedAdapter = Resolve-RuntimePath -Root $RuntimeRoot -Path $Adapter
$PatchDir = Join-Path $RuntimeRoot "patches"

# Fails when the artifacts predate the patches, so a pre-patch WASM bundle cannot be
# exported by accident.
Assert-RuntimeReferenceBuild -Directory $ResolvedBuildDir -PatchDir $PatchDir

$Copies = @(
    @{ Source = (Join-Path $ResolvedBuildDir "llmlet-mod.js"); Name = "llmlet-mod.js" },
    @{ Source = (Join-Path $ResolvedBuildDir "llmlet-mod.wasm"); Name = "llmlet-mod.wasm" },
    @{ Source = $ResolvedAdapter; Name = "llmlet-runtime.js" },
    @{ Source = (Join-Path $ResolvedBuildDir $RuntimeBuildInfoName); Name = $RuntimeBuildInfoName }
)

foreach ($Copy in $Copies) {
    if (-not (Test-Path $Copy.Source -PathType Leaf)) {
        throw "Required Runtime artifact was not found: $($Copy.Source)"
    }
}

New-Item -ItemType Directory -Force -Path $ResolvedOutputDir | Out-Null

foreach ($Copy in $Copies) {
    Copy-Item -Force $Copy.Source (Join-Path $ResolvedOutputDir $Copy.Name)
}

$Checksums = Write-RuntimeChecksums -Directory $ResolvedOutputDir -Names @($Copies | ForEach-Object { $_.Name })

Write-Host ""
Write-Host "Runtime export: $ResolvedOutputDir"
foreach ($Line in $Checksums) {
    Write-Host "  $Line"
}
Write-Host ""
Write-Host "Copy llmlet-mod.js, llmlet-mod.wasm and llmlet-runtime.js into the Web"
Write-Host "application's static serving directory. They must be served from a"
Write-Host "cross-origin-isolated secure origin (see docs/RUNTIME_INTERFACE.md)."
