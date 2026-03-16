# Set location to the script's directory
Set-Location -Path $PSScriptRoot

# Define the output directory
$outputDir = Join-Path $PSScriptRoot "Cleaned_Lectures"
if (!(Test-Path -LiteralPath $outputDir)) { 
    New-Item -ItemType Directory -Path $outputDir 
}

Get-ChildItem -Path $PSScriptRoot -Directory | Where-Object { $_.Name -ne "Cleaned_Lectures" } | ForEach-Object {
    $folder = $_
    $folderName = $folder.Name
    
    # Flexible Regex for any Course Code and 10-char Date
    if ($folderName -match "([A-Z]+\s\d{3}).*?-\s+(.{10})") {
        $courseCode = $Matches[1]
        $datePart = $Matches[2]
        $baseNewName = "$courseCode - $datePart"
        
        # Files to Keep and Move
        $keepFiles = @("transcription.txt", "transcription.srt")
        foreach ($fileName in $keepFiles) {
            $oldPath = Join-Path $folder.FullName $fileName
            # Using -LiteralPath to handle [brackets] safely
            if (Test-Path -LiteralPath $oldPath) {
                $extension = [System.IO.Path]::GetExtension($fileName)
                $destPath = Join-Path $outputDir "$baseNewName$extension"
                Move-Item -LiteralPath $oldPath -Destination $destPath -Force
                Write-Host "Moved: $baseNewName$extension" -ForegroundColor Green
            }
        }
        
        # Files to Delete
        $filesToDelete = @("log.txt", "metadata.txt", "transcription.json", "transcription_maxqda.txt", "transcription_timestamps.txt")
        foreach ($delFile in $filesToDelete) {
            $delPath = Join-Path $folder.FullName $delFile
            if (Test-Path -LiteralPath $delPath) { 
                Remove-Item -LiteralPath $delPath -Force 
            }
        }

        # Remove folder if empty
        $remaining = Get-ChildItem -LiteralPath $folder.FullName
        if ($null -eq $remaining) {
            Remove-Item -LiteralPath $folder.FullName -Recurse -Force
            Write-Host "Cleaned & Removed Folder: $folderName" -ForegroundColor Gray
        }
    }
}

Write-Host "`nAll operations complete!" -ForegroundColor Cyan
Pause
