[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot '..'),
    [string]$EvidenceDirectory = (Join-Path $PSScriptRoot '..\win32-native-evidence'),
    [string]$ExpectedNodeVersion = '22.19.0',
    [string]$RustToolchain = '1.88.0',
    [string]$MsvcToolsVersion = '14.44.35207'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This is a source-build and evidence harness for the closed internal Windows
# foundation. It is not a Bazframe installer, release-admission step, or
# Windows support switch.
$isWindowsRuntime = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isWindowsRuntime) {
    throw 'The native foundation harness must run in PowerShell on Windows, not WSL or Git Bash.'
}

function Assert-NativeExit {
    param([Parameter(Mandatory = $true)][string]$Operation)
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit $LASTEXITCODE."
    }
}

function Assert-LocalNtfsPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    $item = Get-Item -LiteralPath $Path
    if ($item.PSProvider.Name -ne 'FileSystem' -or $item.FullName.StartsWith('\')) {
        throw "$Purpose must be a local filesystem path."
    }
    $driveLetter = $item.PSDrive.Name
    if ($driveLetter -notmatch '^[A-Za-z]$') {
        throw "$Purpose must be on a drive-letter-backed local NTFS volume."
    }
    $logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($driveLetter):'"
    if ($null -eq $logicalDisk -or $logicalDisk.DriveType -ne 3) {
        throw "$Purpose must be on a fixed local disk."
    }
    if ($logicalDisk.FileSystem -ne 'NTFS') {
        throw "$Purpose must be on NTFS; received $($logicalDisk.FileSystem)."
    }
}

$repository = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$temporaryCandidate = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [System.IO.Path]::GetTempPath()
} else {
    $env:RUNNER_TEMP
}
$temporaryRoot = (Resolve-Path -LiteralPath $temporaryCandidate).Path
Assert-LocalNtfsPath -Path $repository -Purpose 'The Bazframe checkout'
Assert-LocalNtfsPath -Path $temporaryRoot -Purpose 'The exact conformance temporary root'

$nodeCommand = (Get-Command node.exe -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
$npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
$npxCommand = (Get-Command npx.cmd -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
$runtimeText = & $nodeCommand -e 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node}))'
Assert-NativeExit -Operation 'Node runtime inspection'
$runtime = $runtimeText | ConvertFrom-Json
if ($runtime.platform -ne 'win32' -or $runtime.arch -ne 'x64') {
    throw "The native foundation requires win32/x64; received $($runtime.platform)/$($runtime.arch)."
}
if ($runtime.version -ne $ExpectedNodeVersion) {
    throw "This evidence run requires Node.js $ExpectedNodeVersion exactly; received $($runtime.version)."
}

$sourceCommit = (& git -C $repository rev-parse HEAD).Trim()
Assert-NativeExit -Operation 'Git source revision inspection'
$worktreeState = & git -C $repository status --porcelain=v1 --untracked-files=all
Assert-NativeExit -Operation 'Git worktree inspection'
if (-not [string]::IsNullOrWhiteSpace(($worktreeState -join "`n"))) {
    throw 'The Bazframe checkout must be clean so evidence binds to one exact source commit.'
}

$evidenceRoot = [System.IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $evidenceRoot) {
    throw "The evidence directory already exists: $evidenceRoot"
}
$evidenceParent = Split-Path -Parent $evidenceRoot
if (-not (Test-Path -LiteralPath $evidenceParent)) {
    New-Item -ItemType Directory -Path $evidenceParent | Out-Null
}
Assert-LocalNtfsPath -Path $evidenceParent -Purpose 'The evidence parent'
New-Item -ItemType Directory -Path $evidenceRoot | Out-Null

$runToken = "$PID-$([guid]::NewGuid().ToString('N'))"
$packRoot = Join-Path $temporaryRoot "bazframe-native-pack-$runToken"
$installRoot = Join-Path $temporaryRoot "bazframe-native-install-$runToken"
$cargoTargetRoot = Join-Path $temporaryRoot "bazframe-native-cargo-$runToken"
$artifactPath = Join-Path $repository 'artifacts\native\win32-x64-msvc\bazframe-win32.node'
$environmentBefore = @{}
Get-ChildItem Env: | ForEach-Object { $environmentBefore[$_.Name] = $_.Value }
$binaryPayload = $null
$tarballPayload = $null
$tarballName = $null
$reportJson = $null

Push-Location $repository
try {
    $env:RUNNER_TEMP = $temporaryRoot
    $env:CARGO_TARGET_DIR = $cargoTargetRoot
    & $npmCommand ci --no-audit --no-fund *>&1 |
        Tee-Object -FilePath (Join-Path $evidenceRoot 'npm-ci.log')
    Assert-NativeExit -Operation 'npm ci'

    & rustup toolchain install $RustToolchain --profile minimal --component rustfmt --no-self-update
    Assert-NativeExit -Operation "Rust $RustToolchain installation"
    & rustup run $RustToolchain rustc --version --verbose *>&1 |
        Tee-Object -FilePath (Join-Path $evidenceRoot 'rust-version.txt')
    Assert-NativeExit -Operation "Rust $RustToolchain inspection"
    & rustup target add x86_64-pc-windows-msvc --toolchain $RustToolchain
    Assert-NativeExit -Operation 'Rust Windows target admission'

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    Assert-NativeExit -Operation 'Visual Studio inspection'
    if ([string]::IsNullOrWhiteSpace($install)) {
        throw 'Visual Studio C++ build tools are unavailable.'
    }
    $toolRoot = Join-Path $install "VC\Tools\MSVC\$MsvcToolsVersion"
    if (-not (Test-Path -LiteralPath $toolRoot)) {
        throw "Pinned MSVC tools are unavailable: $MsvcToolsVersion"
    }
    Import-Module (Join-Path $install 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $install -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64 -vcvars_ver=14.44'
    $compiler = (Get-Command cl.exe).Source
    if (-not $compiler.StartsWith($toolRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Selected MSVC compiler is outside the pinned toolset: $compiler"
    }
    $compilerInfo = (Get-Item -LiteralPath $compiler).VersionInfo
    @(
        "Path=$compiler"
        "FileVersion=$($compilerInfo.FileVersion)"
        "ProductVersion=$($compilerInfo.ProductVersion)"
    ) | Set-Content (Join-Path $evidenceRoot 'msvc-version.txt')

    & cargo +$RustToolchain fmt --manifest-path native/win32/Cargo.toml -- --check
    Assert-NativeExit -Operation 'cargo fmt'
    & cargo +$RustToolchain check --locked --manifest-path native/win32/Cargo.toml --target x86_64-pc-windows-msvc
    Assert-NativeExit -Operation 'cargo check'
    & cargo +$RustToolchain test --locked --manifest-path native/win32/Cargo.toml --target x86_64-pc-windows-msvc
    Assert-NativeExit -Operation 'cargo test'
    & cargo +$RustToolchain build --locked --release --manifest-path native/win32/Cargo.toml --target x86_64-pc-windows-msvc
    Assert-NativeExit -Operation 'cargo build'

    New-Item -ItemType Directory -Force (Split-Path -Parent $artifactPath) | Out-Null
    Copy-Item (Join-Path $cargoTargetRoot 'x86_64-pc-windows-msvc\release\bazframe_win32_native.dll') $artifactPath
    $binaryHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $binaryHash | Set-Content (Join-Path $evidenceRoot 'native-binary.sha256')

    $env:BAZFRAME_WIN32_NATIVE_PACK_MODE = 'foundation-evidence'
    & $npmCommand run build
    Assert-NativeExit -Operation 'TypeScript build'
    & $npxCommand vitest run --config vitest.config.ts test/unit/core/win32-native.test.ts test/unit/state/win32-private-directory.test.ts test/unit/state/win32-directory-closure.test.ts test/unit/cli/platform-support.test.ts
    Assert-NativeExit -Operation 'Native contract tests'

    $env:BAZFRAME_WIN32_NATIVE_TEST_PARENT = $temporaryRoot
    $sourceEvidencePath = Join-Path $evidenceRoot 'native-source-evidence.json'
    & $nodeCommand .\scripts\test-win32-native-foundation.mjs --output $sourceEvidencePath
    Assert-NativeExit -Operation 'Source-tree native conformance'

    New-Item -ItemType Directory -Path $packRoot | Out-Null
    $packText = & $npmCommand pack --json --silent --pack-destination $packRoot
    Assert-NativeExit -Operation 'npm pack'
    $pack = $packText | ConvertFrom-Json
    if ($pack.Count -ne 1) {
        throw 'Expected exactly one Bazframe tarball.'
    }
    $tarball = Join-Path $packRoot $pack[0].filename
    $tarballHash = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()

    New-Item -ItemType Directory -Path $installRoot | Out-Null
    & $npmCommand install --prefix $installRoot --ignore-scripts --no-package-lock --no-audit --no-fund $tarball *>&1 |
        Tee-Object -FilePath (Join-Path $evidenceRoot 'npm-packed-install.log')
    Assert-NativeExit -Operation 'Packed npm install'
    $installed = Join-Path $installRoot 'node_modules\bazframe'
    $installedNative = Join-Path $installed 'artifacts\native\win32-x64-msvc\bazframe-win32.node'
    $installedHash = (Get-FileHash -LiteralPath $installedNative -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($installedHash -ne $binaryHash) {
        throw 'The packed native binary does not match the reviewed build output.'
    }

    $env:npm_config_offline = 'true'
    $installedEvidencePath = Join-Path $evidenceRoot 'native-installed-evidence.json'
    & $nodeCommand .\scripts\test-win32-native-foundation.mjs --package-root $installed --output $installedEvidencePath
    Assert-NativeExit -Operation 'Installed native conformance'

    $sourceEvidence = Get-Content -LiteralPath $sourceEvidencePath -Raw | ConvertFrom-Json
    $installedEvidence = Get-Content -LiteralPath $installedEvidencePath -Raw | ConvertFrom-Json
    if ($sourceEvidence.schemaVersion -ne 3 -or $installedEvidence.schemaVersion -ne 3) {
        throw 'Native conformance reports do not use evidence schema version 3.'
    }
    if ($sourceEvidence.completion -ne 'passed' -or $installedEvidence.completion -ne 'passed') {
        throw 'Native conformance reports did not both pass.'
    }
    if ($sourceEvidence.releaseAdmission -ne 'not-authorized' -or
        $installedEvidence.releaseAdmission -ne 'not-authorized' -or
        $sourceEvidence.windowsSupportClaim -ne $false -or
        $installedEvidence.windowsSupportClaim -ne $false) {
        throw 'Native conformance reports changed the closed release/support boundary.'
    }
    if ($sourceEvidence.observations.binarySha256 -ne $binaryHash -or
        $installedEvidence.observations.binarySha256 -ne $binaryHash) {
        throw 'Native conformance report digests do not match the reviewed binary.'
    }

    $finalCommit = (& git -C $repository rev-parse HEAD).Trim()
    Assert-NativeExit -Operation 'Final Git source revision inspection'
    $finalWorktreeState = & git -C $repository status --porcelain=v1 --untracked-files=all
    Assert-NativeExit -Operation 'Final Git worktree inspection'
    if ($finalCommit -ne $sourceCommit -or
        -not [string]::IsNullOrWhiteSpace(($finalWorktreeState -join "`n"))) {
        throw 'The Bazframe source changed during native evidence collection.'
    }

    $binaryPayload = [System.IO.File]::ReadAllBytes($artifactPath)
    $tarballPayload = [System.IO.File]::ReadAllBytes($tarball)
    $tarballName = Split-Path -Leaf $tarball
    $report = [ordered]@{
        schemaVersion = 3
        purpose = 'Bazframe-owned native foundation evidence only; not release admission or a Windows support claim.'
        completion = 'passed'
        sourceCommit = $sourceCommit
        node = $runtime.version
        rustToolchain = $RustToolchain
        msvcToolsVersion = $MsvcToolsVersion
        binarySha256 = $binaryHash
        tarballName = $tarballName
        tarballSha256 = $tarballHash
        sourceConformance = $sourceEvidence
        installedConformance = $installedEvidence
        releaseAdmission = 'not-authorized'
        windowsSupportClaim = $false
    }
    $reportJson = $report | ConvertTo-Json -Depth 20
} finally {
    $cleanupFailures = [System.Collections.Generic.List[string]]::new()
    foreach ($path in @($artifactPath, $installRoot, $packRoot, $cargoTargetRoot)) {
        try {
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
            }
        } catch {
            $cleanupFailures.Add("cleanup failed for a temporary path: $($_.Exception.Message)")
        }
    }
    try {
        Get-ChildItem Env: | ForEach-Object {
            if (-not $environmentBefore.ContainsKey($_.Name)) {
                [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process')
            }
        }
        foreach ($entry in $environmentBefore.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    } catch {
        $cleanupFailures.Add("environment restoration failed: $($_.Exception.Message)")
    }
    try {
        Pop-Location
    } catch {
        $cleanupFailures.Add("location restoration failed: $($_.Exception.Message)")
    }
    if ($cleanupFailures.Count -ne 0) {
        throw ($cleanupFailures -join '; ')
    }
}

$binaryOutput = Join-Path $evidenceRoot 'bazframe-win32.node'
$tarballOutput = Join-Path $evidenceRoot $tarballName
$reportPath = Join-Path $evidenceRoot 'native-foundation-evidence.json'
$reportTemporary = "$reportPath.tmp"
try {
    [System.IO.File]::WriteAllBytes($binaryOutput, $binaryPayload)
    [System.IO.File]::WriteAllBytes($tarballOutput, $tarballPayload)
    Set-Content -LiteralPath $reportTemporary -Value $reportJson
    Move-Item -LiteralPath $reportTemporary -Destination $reportPath
} catch {
    Remove-Item -LiteralPath $binaryOutput -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tarballOutput -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $reportTemporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue
    throw
}

Write-Host ''
Write-Host 'Native foundation evidence: passed'
Write-Host "Source commit: $sourceCommit"
Write-Host "Binary SHA-256: $binaryHash"
Write-Host "Tarball SHA-256: $tarballHash"
Write-Host 'Release admission: not-authorized'
Write-Host 'Windows support: false'
Write-Host "Evidence directory: $evidenceRoot"
Write-Host 'The retained logs contain local machine paths; redact them before external sharing.'
