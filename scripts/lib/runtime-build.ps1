# Shared knowledge about the pinned llmlet reference build.
#
# The Runtime does not ship stock llmlet: the reference build is
# "pinned commit + patches/*.patch". Anything that consumes the build artifacts has
# to be able to tell a patched artifact from a pre-patch one, otherwise we quietly
# hand the Web application a bundle where close_peer() still leaves a stale
# Module._connbuf slot behind on fd reuse.
#
# Dot-source this file; it defines constants and helper functions only.

$RuntimeLlmletRepository = "https://github.com/ktock/llmlet.git"
$RuntimeLlmletCommit = "730bad2f5b4d6598f55b09eb22d54b5bf2a467ed"
$RuntimeLlamaCppCommit = "c4b18b39dbebb29d2f9f934dd0b136a9493a962e"
$RuntimeBuildInfoName = "BUILD_INFO.txt"

# The files the Docker build is expected to produce. BUILD_INFO.txt records the
# SHA-256 of each one, so provenance cannot be separated from the bytes it describes:
# pairing an older llmlet-mod.wasm with a newer BUILD_INFO.txt fails verification.
$RuntimeBuildArtifacts = @("llmlet-mod.js", "llmlet-mod.wasm")

# Every patch we require, and the repository it applies to (relative to the llmlet
# checkout). A patch file that is not listed here is an error, so a stray file in
# patches/ cannot silently end up in - or out of - a build.
$RuntimePatchTargets = @(
    @{ Name = "0001-llmlet-close-peer-free-connbuf.patch"; Repo = "." },
    @{ Name = "0002-ggml-rpc-close-accepted-fd.patch"; Repo = "llama.cpp" },
    @{ Name = "0003-ggml-webgpu-keep-reg-context-on-emscripten.patch"; Repo = "llama.cpp" }
)

function Write-RuntimeTextFile {
    <#
    .SYNOPSIS
    Write UTF-8 without a BOM. Set-Content -Encoding utf8 on Windows PowerShell 5.1
    prepends EF BB BF, which puts an invisible prefix on the first line for every
    non-PowerShell reader (shell scripts, CI, the Web side).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Lines
    )

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $Lines, $Utf8NoBom)
}

function Resolve-RuntimePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }
    return (Join-Path $Root $Path)
}

function Get-RuntimePatchInventory {
    <#
    .SYNOPSIS
    List the required patches with their current SHA-256, failing on any mismatch
    between patches/ and $RuntimePatchTargets.
    #>
    param([Parameter(Mandatory = $true)][string]$PatchDir)

    if (-not (Test-Path $PatchDir -PathType Container)) {
        throw "Patch directory was not found: $PatchDir"
    }

    $OnDisk = @(Get-ChildItem -Path $PatchDir -Filter "*.patch" -File | ForEach-Object { $_.Name })
    $Expected = @($RuntimePatchTargets | ForEach-Object { $_.Name })

    foreach ($Name in $OnDisk) {
        if ($Expected -notcontains $Name) {
            throw "patches/$Name is not registered in scripts/lib/runtime-build.ps1. Add it to `$RuntimePatchTargets or remove the file."
        }
    }

    $Inventory = @()
    foreach ($Target in $RuntimePatchTargets) {
        $Path = Join-Path $PatchDir $Target.Name
        if (-not (Test-Path $Path -PathType Leaf)) {
            throw "Required patch is missing: $Path"
        }
        $Inventory += [pscustomobject]@{
            Name   = $Target.Name
            Repo   = $Target.Repo
            Path   = $Path
            Sha256 = (Get-FileHash $Path -Algorithm SHA256).Hash
        }
    }
    return $Inventory
}

function Write-RuntimeBuildInfo {
    <#
    .SYNOPSIS
    Record what actually went into an artifact directory, including the artifact
    hashes. Call this only after the build succeeded: writing it earlier would leave a
    valid looking provenance next to artifacts from an older run.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$OutputDir,
        [Parameter(Mandatory = $true)][string]$PatchDir
    )

    $Lines = @(
        "llmlet_commit=$RuntimeLlmletCommit",
        "llamacpp_commit=$RuntimeLlamaCppCommit"
    )
    foreach ($Patch in (Get-RuntimePatchInventory -PatchDir $PatchDir)) {
        $Lines += ("patch={0} sha256={1}" -f $Patch.Name, $Patch.Sha256)
    }
    foreach ($Name in $RuntimeBuildArtifacts) {
        $Path = Join-Path $OutputDir $Name
        if (-not (Test-Path $Path -PathType Leaf)) {
            throw "Cannot record provenance: the build did not produce $Name in $OutputDir"
        }
        $Lines += ("artifact={0} sha256={1}" -f $Name, (Get-FileHash $Path -Algorithm SHA256).Hash)
    }
    $Lines += ("built_utc=" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))

    $Target = Join-Path $OutputDir $RuntimeBuildInfoName
    Write-RuntimeTextFile -Path $Target -Lines $Lines
    return $Target
}

function Assert-RuntimeReferenceBuild {
    <#
    .SYNOPSIS
    Refuse to use artifacts that were not produced from the pinned commits with the
    current patch set applied.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$PatchDir
    )

    $InfoPath = Join-Path $Directory $RuntimeBuildInfoName
    if (-not (Test-Path $InfoPath -PathType Leaf)) {
        throw @"
$RuntimeBuildInfoName was not found in: $Directory

That directory holds artifacts built before the Runtime patches existed, so close_peer()
still leaves a stale Module._connbuf slot behind when an fd number is reused
(patches/0001, patches/0002). Rebuild first:

    pwsh -NoProfile -File scripts/build-llmlet-reference.ps1
"@
    }

    $FirstBytes = [System.IO.File]::ReadAllBytes($InfoPath) | Select-Object -First 3
    if ($FirstBytes.Count -ge 3 -and $FirstBytes[0] -eq 0xEF -and $FirstBytes[1] -eq 0xBB -and $FirstBytes[2] -eq 0xBF) {
        throw "$InfoPath starts with a UTF-8 BOM. Shell and CI readers see it as part of the first key; rewrite it without one."
    }

    $Info = @{}
    $Patches = @{}
    $Artifacts = @{}
    foreach ($Line in (Get-Content -Path $InfoPath)) {
        $Trimmed = $Line.Trim()
        if ($Trimmed.Length -eq 0) { continue }
        if ($Trimmed -match "^patch=(?<name>\S+)\s+sha256=(?<sha>[0-9A-Fa-f]+)$") {
            $Patches[$Matches["name"]] = $Matches["sha"].ToUpperInvariant()
            continue
        }
        if ($Trimmed -match "^artifact=(?<name>\S+)\s+sha256=(?<sha>[0-9A-Fa-f]+)$") {
            $Artifacts[$Matches["name"]] = $Matches["sha"].ToUpperInvariant()
            continue
        }
        if ($Trimmed -match "^(?<key>[a-z_]+)=(?<value>.*)$") {
            $Info[$Matches["key"]] = $Matches["value"]
        }
    }

    if ($Info["llmlet_commit"] -ne $RuntimeLlmletCommit) {
        throw "Artifacts were built from llmlet $($Info['llmlet_commit']) but the pin is $RuntimeLlmletCommit."
    }
    if ($Info["llamacpp_commit"] -ne $RuntimeLlamaCppCommit) {
        throw "Artifacts were built from llama.cpp $($Info['llamacpp_commit']) but the pin is $RuntimeLlamaCppCommit."
    }

    $Inventory = Get-RuntimePatchInventory -PatchDir $PatchDir
    foreach ($Patch in $Inventory) {
        if (-not $Patches.ContainsKey($Patch.Name)) {
            throw "Artifacts were built without patches/$($Patch.Name). Rebuild with scripts/build-llmlet-reference.ps1."
        }
        if ($Patches[$Patch.Name] -ne $Patch.Sha256) {
            throw "patches/$($Patch.Name) changed since these artifacts were built (recorded $($Patches[$Patch.Name]), now $($Patch.Sha256)). Rebuild with scripts/build-llmlet-reference.ps1."
        }
    }
    foreach ($Recorded in $Patches.Keys) {
        if (@($Inventory | ForEach-Object { $_.Name }) -notcontains $Recorded) {
            throw "Artifacts carry patch $Recorded, which no longer exists in patches/. Rebuild with scripts/build-llmlet-reference.ps1."
        }
    }

    # Tie the provenance to the bytes. Without this, an older llmlet-mod.js/.wasm
    # sitting next to a freshly written BUILD_INFO.txt would pass every check above.
    foreach ($Name in $RuntimeBuildArtifacts) {
        if (-not $Artifacts.ContainsKey($Name)) {
            throw "$RuntimeBuildInfoName in $Directory records no hash for $Name. It predates artifact pinning; rebuild with scripts/build-llmlet-reference.ps1."
        }
        $Path = Join-Path $Directory $Name
        if (-not (Test-Path $Path -PathType Leaf)) {
            throw "$Name is missing from $Directory, but $RuntimeBuildInfoName says it should be there."
        }
        $Actual = (Get-FileHash $Path -Algorithm SHA256).Hash
        if ($Actual -ne $Artifacts[$Name]) {
            throw "$Name in $Directory does not match its provenance (recorded $($Artifacts[$Name]), found $Actual). These artifacts and this $RuntimeBuildInfoName come from different builds; rebuild with scripts/build-llmlet-reference.ps1."
        }
    }

    Write-Host ("Verified reference build: llmlet {0} / llama.cpp {1} + {2} patch(es), {3} artifact hash(es)." -f `
            $RuntimeLlmletCommit.Substring(0, 12), $RuntimeLlamaCppCommit.Substring(0, 12), `
            $Inventory.Count, $RuntimeBuildArtifacts.Count)
}

function Write-RuntimeChecksums {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    $Lines = @()
    foreach ($Name in $Names) {
        $Hash = Get-FileHash (Join-Path $Directory $Name) -Algorithm SHA256
        $Lines += ("{0}  {1}" -f $Hash.Hash, $Name)
    }
    Write-RuntimeTextFile -Path (Join-Path $Directory "SHA256SUMS.txt") -Lines $Lines
    return $Lines
}
