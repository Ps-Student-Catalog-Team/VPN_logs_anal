# Copy SoftEther server_log into D:\zmmmawzfl.github.io organized by YYMM folder
# Source and destination
$Source = 'C:\Program Files\SoftEther VPN Server Developer Edition\server_log'
$DestRoot = 'D:\\zmmmawzfl.github.io'

try {

    $files = Get-ChildItem -Path $Source -File -Recurse -Force -ErrorAction SilentlyContinue
    if (! $files) {
        Write-Output "No files found in $Source"
    } else {
        Write-Output "Found $($files.Count) files in $Source"
        $processed = 0
        $skipped = 0
        $errors = 0

        foreach ($file in $files) {
            try {
                $name = $file.Name
                # Try to find YYYYMMDD in the filename
                if ($name -match '(\d{4})(\d{2})(\d{2})') {
                    $year = $matches[1]
                    $month = $matches[2]
                    $yy = $year.Substring(2,2)
                    $subfolder = "$yy$month"
                } else {
                    # fallback to file's last write time
                    $subfolder = $file.LastWriteTime.ToString('yyMM')
                }

                $destDir = Join-Path $DestRoot $subfolder
                if (!(Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

                $target = Join-Path $destDir $name

                if (Test-Path $target) {
                    # If destination exists, compare size and hash to avoid duplicate copies.
                    $srcInfo = Get-Item $file.FullName
                    $dstInfo = Get-Item $target
                    if ($srcInfo.Length -eq $dstInfo.Length) {
                        $srcHash = (Get-FileHash -Algorithm SHA256 -Path $file.FullName).Hash
                        $dstHash = (Get-FileHash -Algorithm SHA256 -Path $target).Hash
                        if ($srcHash -eq $dstHash) {
                            Write-Output "Skipped $name - identical file exists at $target"
                            $skipped++
                            continue
                        }
                    }
                    # If different, overwrite (no timestamp appended)
                    Copy-Item -Path $file.FullName -Destination $target -Force
                    Write-Output "Overwrote $name -> $target"
                    $processed++
                } else {
                    Copy-Item -Path $file.FullName -Destination $target -Force
                    Write-Output "Copied $name -> $target"
                    $processed++
                }
            } catch {
                Write-Warning "Error processing file $($file.FullName): $_"
                $errors++
                continue
            }
        }

        Write-Output "All logs processed into $DestRoot. Processed: $processed, Skipped: $skipped, Errors: $errors"
    }


} catch {
    Write-Output "Error copying logs: $_"
    exit 1
}

