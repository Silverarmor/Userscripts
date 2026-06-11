<#
Organizes media files into date-based folders.

When run, this script asks which folder to organize and whether to group files by
YYYY, YYYY-MM, or YYYY-MM-DD. It also asks which date format to read from the
start of each filename, such as YYYYMMDD or YYYY-MM-DD. It can organize only
media files, all files, or selected file extensions. Files that do not match the
date format are moved into a "no date" folder. Duplicate filenames are never
overwritten; the script appends _1, _2, and so on when needed.
#>

param(
    [string]$Path,
    [ValidateSet("YYYY", "YYYY-MM", "YYYY-MM-DD")]
    [string]$GroupBy,
    [ValidateSet("YYYYMM", "YYYY-MMDD", "YYYYMMDD", "YYYY-MM-DD", "YYYYMM-DD")]
    [string]$DateFormat,
    [ValidateSet("Media", "All", "Select")]
    [string]$FileMode,
    [string[]]$Extensions
)

$ErrorActionPreference = "Stop"

# File extensions treated as media by this organizer.
$mediaExtensions = @(
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic",
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"
)

function Write-Status {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ConsoleColor]$Color = "Cyan"
    )

    Write-Host $Message -ForegroundColor $Color
}

function Get-ExtensionKey {
    param([AllowNull()][string]$Extension)

    if ([string]::IsNullOrWhiteSpace($Extension)) {
        return ""
    }

    return $Extension.ToLowerInvariant()
}

function Get-ExtensionLabel {
    param([AllowNull()][string]$Extension)

    if ([string]::IsNullOrWhiteSpace($Extension)) {
        return "(no extension)"
    }

    return $Extension
}

function ConvertTo-ExtensionKey {
    param([Parameter(Mandatory = $true)][string]$Value)

    $trimmed = $Value.Trim()

    if ($trimmed -eq "(no extension)" -or $trimmed -eq "none") {
        return ""
    }

    if (-not $trimmed.StartsWith(".")) {
        $trimmed = ".$trimmed"
    }

    return $trimmed.ToLowerInvariant()
}

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
    Write-Status "Cannot group by YYYY-MM-DD when DateFormat is $DateFormat because filenames do not include a day." "Red"
    exit 1
}

# Ask which files should be considered for organizing.
if ([string]::IsNullOrWhiteSpace($FileMode)) {
    Write-Host ""
    Write-Host "Organize which files?"
    Write-Host "1. Media files only"
    Write-Host "2. All files"
    Write-Host "3. Choose extensions found in this folder"
    $fileChoice = Read-Host "Choose 1, 2, or 3"

    switch ($fileChoice) {
        "1" { $FileMode = "Media" }
        "2" { $FileMode = "All" }
        "3" { $FileMode = "Select" }
        default {
            Write-Status "Invalid choice: $fileChoice" "Red"
            exit 1
        }
    }
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

# Build the list of top-level files first so long-running folders show progress.
Write-Host ""
Write-Status "Scanning files in $root ..." "Cyan"
$filePaths = [System.IO.Directory]::GetFiles($root, "*", "TopDirectoryOnly")
$allFiles = New-Object System.Collections.Generic.List[System.IO.FileInfo]
$scanTotal = $filePaths.Count

for ($index = 0; $index -lt $scanTotal; $index++) {
    $current = $index + 1
    $percent = [int](($current / [math]::Max($scanTotal, 1)) * 100)

    Write-Progress -Activity "Scanning files" -Status "$current of $scanTotal" -PercentComplete $percent
    $allFiles.Add([System.IO.FileInfo]::new($filePaths[$index]))
}

Write-Progress -Activity "Scanning files" -Completed

if ($allFiles.Count -eq 0) {
    Write-Host ""
    Write-Status "No files found in: $root" "Yellow"
    exit 0
}

$selectedExtensionKeys = New-Object System.Collections.Generic.HashSet[string]

if ($FileMode -eq "Select") {
    $extensionGroups = $allFiles |
        Group-Object { Get-ExtensionKey $_.Extension } |
        Sort-Object -Property @{ Expression = "Count"; Descending = $true }, @{ Expression = "Name"; Descending = $false }

    Write-Host ""
    Write-Status "Extensions found:" "Cyan"

    for ($index = 0; $index -lt $extensionGroups.Count; $index++) {
        $number = $index + 1
        $label = Get-ExtensionLabel $extensionGroups[$index].Name
        Write-Host ("{0,3}. {1,-16} {2,6} file(s)" -f $number, $label, $extensionGroups[$index].Count)
    }

    if ($Extensions.Count -gt 0) {
        foreach ($extension in $Extensions) {
            [void]$selectedExtensionKeys.Add((ConvertTo-ExtensionKey $extension))
        }
    }
    else {
        Write-Host ""
        $selection = Read-Host "Enter numbers or extensions, separated by commas"
        $tokens = $selection -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

        foreach ($token in $tokens) {
            $selectionNumber = 0

            if ([int]::TryParse($token, [ref]$selectionNumber)) {
                if ($selectionNumber -ge 1 -and $selectionNumber -le $extensionGroups.Count) {
                    [void]$selectedExtensionKeys.Add($extensionGroups[$selectionNumber - 1].Name)
                }
                else {
                    Write-Status "Ignoring extension number out of range: $token" "Yellow"
                }
            }
            else {
                [void]$selectedExtensionKeys.Add((ConvertTo-ExtensionKey $token))
            }
        }
    }

    if ($selectedExtensionKeys.Count -eq 0) {
        Write-Status "No extensions selected." "Red"
        exit 1
    }
}

Write-Status "Filtering files using mode: $FileMode" "Cyan"

switch ($FileMode) {
    "Media" {
        $files = @($allFiles | Where-Object { $mediaExtensions -contains (Get-ExtensionKey $_.Extension) })
    }
    "All" {
        $files = @($allFiles)
    }
    "Select" {
        $files = @($allFiles | Where-Object { $selectedExtensionKeys.Contains((Get-ExtensionKey $_.Extension)) })
    }
}

$moves = @()

Write-Status "Planning moves for $($files.Count) file(s) ..." "Cyan"

for ($index = 0; $index -lt $files.Count; $index++) {
    $file = $files[$index]
    $current = $index + 1
    $percent = [int](($current / [math]::Max($files.Count, 1)) * 100)

    Write-Progress -Activity "Planning moves" -Status "$current of $($files.Count)" -PercentComplete $percent
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

Write-Progress -Activity "Planning moves" -Completed

if ($moves.Count -eq 0) {
    Write-Host ""
    Write-Status "No matching files found in: $root" "Yellow"
    exit 0
}

# Show a small preview before asking for final confirmation.
Write-Host ""
Write-Host "Folder: $root"
Write-Host "Grouping: $GroupBy"
Write-Host "Date format: $DateFormat"
Write-Host "File mode: $FileMode"
Write-Host "Files to move: $($moves.Count)"
Write-Host ""
Write-Status "Preview:" "Cyan"

$moves | Select-Object -First 20 | ForEach-Object {
    Write-Host "  $($_.FileName) -> $($_.Folder)"
}

if ($moves.Count -gt 20) {
    Write-Host "  ...and $($moves.Count - 20) more"
}

Write-Host ""
$confirm = Read-Host "Move these files now? Type YES to continue"

if ($confirm -ne "YES") {
    Write-Status "Cancelled. No files were moved." "Yellow"
    exit 0
}

$moved = 0

Write-Host ""
Write-Status "Moving files ..." "Cyan"

for ($index = 0; $index -lt $moves.Count; $index++) {
    $move = $moves[$index]
    $current = $index + 1
    $percent = [int](($current / [math]::Max($moves.Count, 1)) * 100)

    Write-Progress -Activity "Moving files" -Status "$current of $($moves.Count): $($move.FileName)" -PercentComplete $percent
    $destinationDir = Split-Path -Path $move.Destination -Parent

    # Create the destination folder just before moving into it.
    if (-not (Test-Path -LiteralPath $destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir | Out-Null
    }

    Move-Item -LiteralPath $move.Source -Destination $move.Destination
    $moved++
}

Write-Progress -Activity "Moving files" -Completed
Write-Host ""
Write-Status "Moved $moved file(s)." "Green"
