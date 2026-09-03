[CmdletBinding()]
param(
    [string]$ProbeDirectory = (Join-Path $PSScriptRoot '..\tools\win32-fs-safe-probe')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This is an evidence-collection harness, not a Bazframe Windows installer or
# support switch. A successful process exit means the probe completed; consult
# evidence.json for the independent foundation decision. The probe always keeps
# production adoption unauthorized and the public Windows support claim false.
$isWindowsRuntime = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isWindowsRuntime) {
    throw 'The native fs-safe probe must run in PowerShell on Windows, not WSL or Git Bash.'
}

$runtime = & node -e 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node}))' |
    ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
    throw 'Node.js could not report its runtime identity.'
}
if ($runtime.platform -ne 'win32' -or $runtime.arch -ne 'x64') {
    throw "The native probe requires win32/x64; received $($runtime.platform)/$($runtime.arch)."
}
if ([version]$runtime.version -lt [version]'22.19.0') {
    throw "The native probe requires Node.js 22.19.0 or newer; received $($runtime.version)."
}

function Assert-LocalNtfsPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    $item = Get-Item -LiteralPath $Path
    if ($item.PSProvider.Name -ne 'FileSystem') {
        throw "$Purpose is not on a filesystem path."
    }
    if ($item.FullName.StartsWith('\\')) {
        throw "$Purpose must not use a UNC path."
    }

    $driveLetter = $item.PSDrive.Name
    if ($driveLetter -notmatch '^[A-Za-z]$') {
        throw "$Purpose must be on a drive-letter-backed local NTFS volume."
    }

    # DriveType 3 is a fixed local disk. This harness check prevents accidental
    # execution from a mapped network drive; it is not a substitute for the
    # product's still-unimplemented native storage-admission evidence.
    $logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($driveLetter):'"
    if ($null -eq $logicalDisk -or $logicalDisk.DriveType -ne 3) {
        throw "$Purpose must be on a fixed local disk, not mapped or network storage."
    }
    if ($logicalDisk.FileSystem -ne 'NTFS') {
        throw "$Purpose must be on NTFS; received $($logicalDisk.FileSystem)."
    }
}

$probeRoot = (Resolve-Path -LiteralPath $ProbeDirectory).Path
$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [System.IO.Path]::GetTempPath()
} else {
    $env:RUNNER_TEMP
}
$temporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path

Assert-LocalNtfsPath -Path $probeRoot -Purpose 'The probe checkout'
Assert-LocalNtfsPath -Path $temporaryRoot -Purpose 'The probe temporary root'

$hadRunnerTemp = Test-Path Env:RUNNER_TEMP
$previousRunnerTemp = if ($hadRunnerTemp) { (Get-Item Env:RUNNER_TEMP).Value } else { $null }
Push-Location $probeRoot
# Make the probe use the exact temporary root admitted above rather than
# independently resolving a relative or differently configured environment.
$env:RUNNER_TEMP = $temporaryRoot
try {
    # `npm ci` exercises ordinary optional-dependency selection from the exact
    # nested lockfile. Do not use --ignore-scripts, a compiler, or a downloaded
    # runtime binary. Verbose output is retained for native-artifact diagnosis.
    & npm ci --foreground-scripts --loglevel verbose *>&1 |
        Tee-Object -FilePath (Join-Path $probeRoot 'npm-install.log')
    $installStatus = $LASTEXITCODE
    if ($installStatus -ne 0) {
        throw "The isolated npm installation failed with exit status $installStatus; inspect npm-install.log."
    }

    & node .\probe.mjs --output .\evidence.json
    $probeStatus = $LASTEXITCODE
    if ($probeStatus -ne 0) {
        throw "The native evidence probe failed with exit status $probeStatus; inspect evidence.json."
    }

    $evidence = Get-Content -LiteralPath .\evidence.json -Raw | ConvertFrom-Json
    if ($evidence.productionAdoption -ne 'not-authorized' -or $evidence.windowsSupportClaim -ne $false) {
        throw 'The evidence report made an unauthorized adoption or Windows-support claim.'
    }

    Write-Host ''
    Write-Host "Evidence collection: $($evidence.completion)"
    Write-Host "Foundation decision: $($evidence.foundationDecision.disposition)"
    Write-Host 'Production adoption: not-authorized'
    Write-Host 'Windows support: false'
    Write-Host "Evidence report: $(Join-Path $probeRoot 'evidence.json')"
    Write-Host "Installation log: $(Join-Path $probeRoot 'npm-install.log')"
} finally {
    if ($hadRunnerTemp) {
        $env:RUNNER_TEMP = $previousRunnerTemp
    } else {
        Remove-Item Env:RUNNER_TEMP -ErrorAction SilentlyContinue
    }
    Pop-Location
}
