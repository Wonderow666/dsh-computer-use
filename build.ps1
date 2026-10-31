# Rebuilds bin/cu.exe (the Win32 + UI Automation bridge) from bridge/cu.cs, and
# with -Test also the WinForms fixture used by test/input.mjs.
#
# Needs nothing but the .NET Framework that ships with Windows: csc.exe v4.0.30319
# plus the in-box WPF UI Automation assemblies. No SDK, no NuGet, no network.
#
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test
param([switch]$Test)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSCommandPath
$fw   = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc  = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc (need .NET Framework 4.x)" }

function Build-Exe {
    param([string]$Source, [string]$Output, [string]$Target, [string[]]$References, [switch]$Console)

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
    $args = @('/nologo', "/target:$Target", '/platform:anycpu', '/optimize+', "/out:$Output")
    foreach ($r in $References) { $args += "/r:$r" }
    $args += $Source

    & $csc @args
    if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE for $Source" }
    Write-Host ("built {0} ({1} bytes)" -f $Output, (Get-Item $Output).Length)
}

Build-Exe -Source (Join-Path $root 'bridge\cu.cs') -Output (Join-Path $root 'bin\cu.exe') -Target 'winexe' -References @(
    "$fw\WPF\UIAutomationClient.dll",
    "$fw\WPF\UIAutomationTypes.dll",
    "$fw\WPF\WindowsBase.dll",
    'System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll'
)
& (Join-Path $root 'bin\cu.exe') info

if ($Test) {
    Build-Exe -Source (Join-Path $root 'test\target\Target.cs') -Output (Join-Path $root 'test\target\target.exe') -Target 'winexe' -References @(
        'System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll'
    )
}
