# Set location to the script's directory
Set-Location -Path $PSScriptRoot

# Define month abbreviations to numbers for the MMDD format
$months = @{
    "Jan"="01"; "Feb"="02"; "Mar"="03"; "Apr"="04";
    "May"="05"; "Jun"="06"; "Jul"="07"; "Aug"="08";
    "Sep"="09"; "Oct"="10"; "Nov"="11"; "Dec"="12"
}

# Process every .srt file in the current directory
Get-ChildItem -Filter "*.srt" | ForEach-Object {
    $originalFile = $_.FullName
    $fileName = $_.Name

    # Regex to extract Course Code, Course Number, Stream Code, Day, and Month.
    # Matches: [401-401] CIVIL 790 T01C - Fri 01 May ...
    if ($fileName -match '\]\s*([A-Z]+)\s+(\d{3})\s+(\S+)\s*-\s*[A-Za-z]{3}\s+(\d{2})\s+([A-Za-z]{3})') {
        $courseCode = $matches[1]
        $courseNum = $matches[2]
        $streamCode = $matches[3]
        $day = $matches[4]
        $monthStr = $matches[5]
        $monthNum = $months[$monthStr]

        # Construct new names and paths
        $newBaseName = "$monthNum$day - $courseCode $courseNum $streamCode"
        $newSrtName = "$newBaseName.srt"
        $newTxtName = "$newBaseName.txt"
        
        $folderName = "$courseCode $courseNum"
        $folderPath = Join-Path -Path $_.DirectoryName -ChildPath $folderName
        $targetSrtPath = Join-Path -Path $folderPath -ChildPath $newSrtName
        $targetTxtPath = Join-Path -Path $folderPath -ChildPath $newTxtName
        $tempSrtPath = Join-Path -Path $_.DirectoryName -ChildPath $newSrtName
        $tempTxtPath = Join-Path -Path $_.DirectoryName -ChildPath $newTxtName

        # Skip this file if any output already exists.
        $pathsToCheck = @($targetSrtPath, $targetTxtPath, $tempTxtPath)
        if ($tempSrtPath -ne $originalFile) {
            $pathsToCheck += $tempSrtPath
        }

        $existingOutputs = $pathsToCheck | Where-Object { Test-Path -LiteralPath $_ }
        if ($existingOutputs.Count -gt 0) {
            Write-Warning "Skipped: $fileName (Output already exists; not overwriting)"
            foreach ($existingOutput in $existingOutputs) {
                Write-Warning "  Existing: $existingOutput"
            }
            return
        }

        # 1. Generate the TXT file content
        $srtContent = Get-Content -LiteralPath $originalFile -Raw
        $blocks = $srtContent -split "(?:\r?\n){2,}" # Split by empty lines
        
        $txtLines = @()
        foreach ($block in $blocks) {
            $lines = $block -split "\r?\n"
            # Make sure the block actually contains text (Index + Timestamp + at least 1 line of text)
            if ($lines.Count -ge 3) {
                # Join multi-line captions (like lines 3+4) into a single line with a space
                $caption = ($lines[2..($lines.Count-1)]) -join " "
                if (-not [string]::IsNullOrWhiteSpace($caption)) {
                    $txtLines += $caption
                }
            }
        }
        
        # 2. Save the TXT file to the current directory temporarily
        $txtLines | Set-Content -LiteralPath $tempTxtPath -Encoding UTF8

        # 3. Rename the original SRT file
        Rename-Item -LiteralPath $originalFile -NewName $newSrtName

        # 4. Create the target course folder if it doesn't exist
        if (-not (Test-Path -Path $folderPath)) {
            New-Item -ItemType Directory -Path $folderPath | Out-Null
        }

        # 5. Move both files into the target folder
        Move-Item -LiteralPath $tempSrtPath -Destination $folderPath
        Move-Item -LiteralPath $tempTxtPath -Destination $folderPath
        
        Write-Host "Processed and moved: $newBaseName" -ForegroundColor Green
    } else {
        Write-Host "Skipped: $fileName (Did not match the expected naming format)" -ForegroundColor Yellow
    }
}
pause
