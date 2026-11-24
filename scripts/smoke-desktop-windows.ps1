# Runs the Windows app as users get it, against a throwaway data folder: installs it silently for this user only (no
# administrator prompt), starts it, waits for its dashboard (`[tokentracky] page-load finished path=/` on stderr),
# quits it and uninstalls it, which must leave neither the program nor its launch at login behind.
param([Parameter(Mandatory)] [string] $Installer)
$ErrorActionPreference = 'Stop'
$folder = Join-Path $env:LOCALAPPDATA 'Tokentracky'
$app = Join-Path $folder 'tokentracky-mac.exe'
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$work = Join-Path ([IO.Path]::GetTempPath()) "tokentracky-smoke-$PID"
New-Item -ItemType Directory -Force (Join-Path $work 'data') | Out-Null
$env:TOKENTRACKY_HOME = Join-Path $work 'data'
$env:TOKENTRACKY_PRICING_REFRESH = 'off'

Write-Host '== Install for this user, silently'
$install = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0 -or -not (Test-Path $app)) { throw "the installer did not put the app at $app ($($install.ExitCode))" }

Write-Host '== Start it and wait for the dashboard'
$log = Join-Path $work 'stderr.txt'
$running = Start-Process -FilePath $app -ArgumentList '--open-dashboard' -PassThru `
  -RedirectStandardError $log -RedirectStandardOutput (Join-Path $work 'stdout.txt')
$loaded = $false
for ($i = 0; $i -lt 120 -and -not $loaded; $i++) {
  Start-Sleep -Seconds 1
  $loaded = (Test-Path $log) -and (Select-String -Path $log -SimpleMatch '[tokentracky] page-load finished path=/' -Quiet)
}
if (Test-Path $log) { Get-Content $log | Where-Object { $_ -like '[tokentracky]*' } }
if (-not $loaded) { throw 'the dashboard did not load' }

Write-Host '== Quit it, then uninstall'
Start-Process -FilePath $app -ArgumentList '--quit' -Wait
if (-not $running.WaitForExit(30000)) { throw 'the app did not quit' }
Start-Process -FilePath (Join-Path $folder 'uninstall.exe') -ArgumentList '/S' -Wait
# The uninstaller copies itself elsewhere and goes on from there.
for ($i = 0; $i -lt 60 -and (Test-Path $app); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $app) { throw 'the uninstaller left the app behind' }
if (Get-ItemProperty -Path $run -Name Tokentracky -ErrorAction SilentlyContinue) { throw 'the uninstaller left launch at login behind' }
Remove-Item -Recurse -Force $work
Write-Host 'Installed, opened the dashboard, quit and uninstalled.'
