# Define the output directory
$outputDir = Join-Path $PSScriptRoot "Cleaned_Lectures"
if (!(Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir }

Get-ChildItem -Path $PSScriptRoot -Directory | Where-Object { $_.Name -ne "Cleaned_Lectures" } | ForEach-Object {
    $folder = $_
    $folderName = $folder.Name
    
    # 1. Clean the folder name to "Course - Date"
    if ($folderName -match "^(.*?)\s+L01C\s+-\s+(.{10})") {
        $baseNewName = "$($Matches[1]) - $($Matches[2])"
        
        # 2. Files to Keep and Move
        $keepFiles = @("transcription.txt", "transcription.srt")
        foreach ($fileName in $keepFiles) {
            $oldPath = Join-Path $folder.FullName $fileName
            if (Test-Path $oldPath) {
                $extension = [System.IO.Path]::GetExtension($fileName)
                $destPath = Join-Path $outputDir "$baseNewName$extension"
                Move-Item -Path $oldPath -Destination $destPath -Force
            }
        }
        
        # 3. Delete the specific unwanted files
        $filesToDelete = @("log.txt", "metadata.txt", "transcription.json", "transcription_maxqda.txt", "transcription_timestamps.txt")
        foreach ($delFile in $filesToDelete) {
            $delPath = Join-Path $folder.FullName $delFile
            if (Test-Path $delPath) { Remove-Item -Path $delPath -Force }
        }

        # 4. Remove the folder if it's now empty (or only contains ignored files)
        $remaining = Get-ChildItem -Path $folder.FullName
        if ($null -eq $remaining) {
            Remove-Item -Path $folder.FullName -Recurse -Force
            Write-Host "Processed and removed: $folderName" -ForegroundColor Green
        }
    }
}

Write-Host "Done! Files moved to: $outputDir" -ForegroundColor Cyan
Pause
