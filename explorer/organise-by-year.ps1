<#
Organizes media files into date-based folders.

When run, this script asks which folder to organize and whether to group files by
YYYY, YYYY-MM, or YYYY-MM-DD. It also asks which date format to read from the
start of each filename, such as YYYYMMDD or YYYY-MM-DD. Files that do not match
that format are moved into a "no date" folder. Duplicate filenames are never
overwritten; the script appends _1, _2, and so on when needed.
#>

param(
    [string]$Path,
    [ValidateSet("YYYY", "YYYY-MM", "YYYY-MM-DD")]
    [string]$GroupBy,
    [ValidateSet("YYYYMM", "YYYY-MMDD", "YYYYMMDD", "YYYY-MM-DD", "YYYYMM-DD")]
    [string]$DateFormat
)

$ErrorActionPreference = "Stop"

# File extensions treated as media by this organizer.
$mediaExtensions = @(
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic",
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"
)

# Ask for the folder to organize. Pressing Enter uses the folder containing this script.
$defaultPath = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = Read-Host "Folder to organize [$defaultPath]"
}

if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = $defaultPath
}

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    Write-Host "Folder not found: $Path"
    exit 1
}

$root = (Resolve-Path -LiteralPath $Path).Path

# Ask how specific the destination folders should be.
if ([string]::IsNullOrWhiteSpace($GroupBy)) {
    Write-Host ""
    Write-Host "Group media into folders by:"
    Write-Host "1. YYYY"
    Write-Host "2. YYYY-MM"
    Write-Host "3. YYYY-MM-DD"
    $groupChoice = Read-Host "Choose 1, 2, or 3"

    switch ($groupChoice) {
        "1" { $GroupBy = "YYYY" }
        "2" { $GroupBy = "YYYY-MM" }
        "3" { $GroupBy = "YYYY-MM-DD" }
        default {
            Write-Host "Invalid choice: $groupChoice"
            exit 1
        }
    }
}

# Ask which date pattern appears at the start of the filenames.
if ([string]::IsNullOrWhiteSpace($DateFormat)) {
    Write-Host ""
    Write-Host "Read dates from filenames formatted as:"
    Write-Host "1. YYYYMM"
    Write-Host "2. YYYY-MMDD"
    Write-Host "3. YYYYMMDD"
    Write-Host "4. YYYY-MM-DD"
    Write-Host "5. YYYYMM-DD"
    $formatChoice = Read-Host "Choose 1, 2, 3, 4, or 5"

    switch ($formatChoice) {
        "1" { $DateFormat = "YYYYMM" }
        "2" { $DateFormat = "YYYY-MMDD" }
        "3" { $DateFormat = "YYYYMMDD" }
        "4" { $DateFormat = "YYYY-MM-DD" }
        "5" { $DateFormat = "YYYYMM-DD" }
        default {
            Write-Host "Invalid choice: $formatChoice"
            exit 1
        }
    }
}

$dateFormatPatterns = @{
    "YYYYMM" = "^(?<year>\d{4})(?<month>\d{2})"
    "YYYY-MMDD" = "^(?<year>\d{4})-(?<month>\d{2})(?<day>\d{2})"
    "YYYYMMDD" = "^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})"
    "YYYY-MM-DD" = "^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})"
    "YYYYMM-DD" = "^(?<year>\d{4})(?<month>\d{2})-(?<day>\d{2})"
}

$datePattern = $dateFormatPatterns[$DateFormat]
$dateFormatHasDay = $datePattern -match "\?<day>"

if ($GroupBy -eq "YYYY-MM-DD" -and -not $dateFormatHasDay) {
    Write-Host "Cannot group by YYYY-MM-DD when DateFormat is $DateFormat because filenames do not include a day."
    exit 1
}

# Create a unique destination path without overwriting an existing file.
function Get-UniqueDestinationPath {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    $destinationPath = Join-Path -Path $Directory -ChildPath $FileName

    if (-not (Test-Path -LiteralPath $destinationPath)) {
        return $destinationPath
    }

    $name = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
    $extension = [System.IO.Path]::GetExtension($FileName)
    $counter = 1

    do {
        $newName = "{0}_{1}{2}" -f $name, $counter, $extension
        $destinationPath = Join-Path -Path $Directory -ChildPath $newName
        $counter++
    } while (Test-Path -LiteralPath $destinationPath)

    return $destinationPath
}

# Build the list of media files in the selected folder, ignoring files already inside output folders.
$files = [System.IO.Directory]::EnumerateFiles($root, "*", "TopDirectoryOnly") |
    ForEach-Object { Get-Item -LiteralPath $_ } |
    Where-Object { $mediaExtensions -contains $_.Extension.ToLowerInvariant() }

$moves = @()

foreach ($file in $files) {
    $folderName = "no date"

    # Only filenames beginning with the selected date format are treated as dated files.
    if ($file.Name -match $datePattern) {
        $year = $matches["year"]
        $month = $matches["month"]
        $day = $null

        if ($dateFormatHasDay) {
            $day = $matches["day"]
        }

        switch ($GroupBy) {
            "YYYY" { $folderName = $year }
            "YYYY-MM" { $folderName = "{0}-{1}" -f $year, $month }
            "YYYY-MM-DD" { $folderName = "{0}-{1}-{2}" -f $year, $month, $day }
        }
    }

    $destinationDir = Join-Path -Path $root -ChildPath $folderName
    $destinationPath = Get-UniqueDestinationPath -Directory $destinationDir -FileName $file.Name

    $moves += [PSCustomObject]@{
        Source = $file.FullName
        Destination = $destinationPath
        Folder = $folderName
        FileName = $file.Name
    }
}

if ($moves.Count -eq 0) {
    Write-Host ""
    Write-Host "No media files found in: $root"
    exit 0
}

# Show a small preview before asking for final confirmation.
Write-Host ""
Write-Host "Folder: $root"
Write-Host "Grouping: $GroupBy"
Write-Host "Date format: $DateFormat"
Write-Host "Files to move: $($moves.Count)"
Write-Host ""
Write-Host "Preview:"

$moves | Select-Object -First 20 | ForEach-Object {
    Write-Host "  $($_.FileName) -> $($_.Folder)"
}

if ($moves.Count -gt 20) {
    Write-Host "  ...and $($moves.Count - 20) more"
}

Write-Host ""
$confirm = Read-Host "Move these files now? Type YES to continue"

if ($confirm -ne "YES") {
    Write-Host "Cancelled. No files were moved."
    exit 0
}

$moved = 0

foreach ($move in $moves) {
    $destinationDir = Split-Path -Path $move.Destination -Parent

    # Create the destination folder just before moving into it.
    if (-not (Test-Path -LiteralPath $destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir | Out-Null
    }

    Move-Item -LiteralPath $move.Source -Destination $move.Destination
    $moved++
}

Write-Host ""
Write-Host "Moved $moved file(s)."
