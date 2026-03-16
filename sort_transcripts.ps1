# Define the output directory
$outputDir = Join-Path $PSScriptRoot "Cleaned_Lectures"
if (!(Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir }

Get-ChildItem -Path $PSScriptRoot -Directory | Where-Object { $_.Name -ne "Cleaned_Lectures" } | ForEach-Object {
    $folder = $_
    $folderName = $folder.Name
    
    # Updated Regex: 
    # ([A-Z]+\s\d{3}) -> Finds any uppercase letters, a space, and 3 digits (e.g., ENVENG 200)
    # .*?-\s+        -> Skips middle text until the dash
    # (.{10})        -> Grabs the 10-character date
    if ($folderName -match "([A-Z]+\s\d{3}).*?-\s+(.{10})") {
        $courseCode = $Matches[1]
        $datePart = $Matches[2]
        $baseNewName = "$courseCode - $datePart"
        
        # Files to Keep and Move
        $keepFiles = @("transcription.txt", "transcription.srt")
        foreach ($fileName in $keepFiles) {
            $oldPath = Join-Path $folder.FullName $fileName
            if (Test-Path $oldPath) {
                $extension = [System.IO.Path]::GetExtension($fileName)
                $destPath = Join-Path $outputDir "$baseNewName$extension"
                Move-Item -Path $oldPath -Destination $destPath -Force
                Write-Host "Moved: $baseNewName$extension" -ForegroundColor Green
            }
        }
        
        # Files to Delete
        $filesToDelete = @("log.txt", "metadata.txt", "transcription.json", "transcription_maxqda.txt", "transcription_timestamps.txt")
        foreach ($delFile in $filesToDelete) {
            $delPath = Join-Path $folder.FullName $delFile
            if (Test-Path $delPath) { Remove-Item -Path $delPath -Force }
        }

        # Remove folder if empty
        $remaining = Get-ChildItem -Path $folder.FullName
        if ($null -eq $remaining) {
            Remove-Item -Path $folder.FullName -Recurse -Force
        }
    } else {
        Write-Host "Skipped (No match): $folderName" -ForegroundColor Yellow
    }
}

Write-Host "`nCleanup Complete! Files are in: $outputDir" -ForegroundColor Cyan
Pause
