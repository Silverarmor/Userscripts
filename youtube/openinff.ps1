# Handler for openinff: links, registered by openinff.reg.
# Chrome passes the whole link (e.g. "openinff:https://www.youtube.com/watch?v=...")
# as one argument. The URL is treated as data and only YouTube links are opened,
# so a page can't use openinff: to run commands or open arbitrary URLs.

param([string]$Url)

$target = $Url -replace '^openinff:', ''
$uri = $null
if (-not [uri]::TryCreate($target, [UriKind]::Absolute, [ref]$uri)) { exit 1 }
if ($uri.Scheme -notin 'http', 'https') { exit 1 }
if ($uri.Host -notmatch '^((www|m|music)\.)?youtube\.com$|^youtu\.be$') { exit 1 }

$firefox = @(
  "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
  "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $firefox) { exit 1 }

# AbsoluteUri is percent-encoded, so it has no spaces or quotes.
Start-Process -FilePath $firefox -ArgumentList "`"$($uri.AbsoluteUri)`""
