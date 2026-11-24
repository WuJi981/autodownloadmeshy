param(
    [int]$Port = 9222,
    [string]$ProfileDir = "$env:TEMP\meshy-cdp-profile",
    [string]$Url = "about:blank",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Test-Port {
    param([int]$P)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 3
        return $r.Content
    } catch {
        return $null
    }
}

$existing = Test-Port -P $Port
if ($existing -and -not $Force) {
    Write-Output "CDP_ALREADY_RUNNING port=$Port"
    Write-Output $existing
    exit 0
}

$candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)

$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
    throw "Chrome/Edge not found. Install a Chromium browser or pass its path by editing this script."
}

if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }

$args = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    $Url
)

Start-Process -FilePath $exe -ArgumentList $args | Out-Null

$deadline = (Get-Date).AddSeconds(20)
$content = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $content = Test-Port -P $Port
    if ($content) { break }
}

if (-not $content) {
    throw "Browser started but CDP port $Port is not reachable. Make sure the process is not being killed by a job object (run it as a persistent background task)."
}

Write-Output "CDP_READY port=$Port exe=$exe profile=$ProfileDir"
Write-Output $content
