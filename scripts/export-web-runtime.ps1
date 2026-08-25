param(
    [Parameter(Mandatory = $true)]
    [string]$WebRepo,
    [string]$BuildDir = "build/reference-llmlet",
    [string]$Adapter = "runtime/llmlet-runtime.js"
)

$ErrorActionPreference = "Stop"

$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedWebRepo = (Resolve-Path $WebRepo).Path
$ResolvedBuildDir = Join-Path $RuntimeRoot $BuildDir
$ResolvedAdapter = Join-Path $RuntimeRoot $Adapter
$Destination = Join-Path $ResolvedWebRepo "apps/server/public/wasm"

$Inputs = @(
    (Join-Path $ResolvedBuildDir "llmlet-mod.js"),
    (Join-Path $ResolvedBuildDir "llmlet-mod.wasm"),
    $ResolvedAdapter
)

foreach ($InputPath in $Inputs) {
    if (-not (Test-Path $InputPath -PathType Leaf)) {
        throw "Required Runtime artifact was not found: $InputPath"
    }
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$Copies = @(
    @{ Source = $Inputs[0]; Name = "llmlet-mod.js" },
    @{ Source = $Inputs[1]; Name = "llmlet-mod.wasm" },
    @{ Source = $Inputs[2]; Name = "llmlet-runtime.js" }
)

foreach ($Copy in $Copies) {
    $Target = Join-Path $Destination $Copy.Name
    Copy-Item -Force $Copy.Source $Target
}

Write-Host "Exported Runtime files to: $Destination"
Write-Host ""

foreach ($Copy in $Copies) {
    $Target = Join-Path $Destination $Copy.Name
    $Hash = Get-FileHash $Target -Algorithm SHA256
    Write-Host ("{0}  {1}" -f $Hash.Hash, $Copy.Name)
}
