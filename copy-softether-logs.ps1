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
        $changed = New-Object System.Collections.Generic.List[string]
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
                    $rel = $target.Substring($DestRoot.Length + 1).TrimStart('\\')
                    $changed.Add($rel)
                    $processed++
                } else {
                    Copy-Item -Path $file.FullName -Destination $target -Force
                    Write-Output "Copied $name -> $target"
                    $rel = $target.Substring($DestRoot.Length + 1).TrimStart('\\')
                    $changed.Add($rel)
                    $processed++
                }
            } catch {
                Write-Warning "Error processing file $($file.FullName): $_"
                $errors++
                continue
            }
        }

        Write-Output "All logs processed into $DestRoot. Processed: $processed, Skipped: $skipped, Errors: $errors"

        node generate-analysis.js

        # Git commit & push changed files
        if ($changed.Count -gt 0) {
            try {
                Get-Command git -ErrorAction Stop | Out-Null
                git -C $DestRoot add -- $changed
                $status = git -C $DestRoot status --porcelain
                if ($status) {
                    $message = "Auto: add SoftEther logs ($($changed.Count) files) $(Get-Date -Format 'yyyy-MM-dd_HH:mm:ss')"
                    git -C $DestRoot commit -m $message
                    git -C $DestRoot push
                    Write-Output "Git: committed and pushed $($changed.Count) files"
                } else {
                    Write-Output "Git: no changes to commit"
                }
            } catch {
                Write-Warning "Git push failed: $_"
            }
        } else {
            Write-Output "No files changed; skipping git commit"
        }
    }


} catch {
    Write-Output "Error copying logs: $_"
    exit 1
}

