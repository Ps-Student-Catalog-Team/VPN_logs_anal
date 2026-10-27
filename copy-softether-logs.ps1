# Copy SoftEther server_log into D:\VPN_logs_anal organized by YYMM folder
$Source = 'C:\Program Files\SoftEther VPN Server\server_log'
$DestRoot = 'D:\VPN_logs_anal'

function Get-CachedFileHash {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    $fullPath = $item.FullName
    $prefix = $fullPath + '|'
    $cacheKey = '{0}{1}|{2}' -f $prefix, $item.Length, $item.LastWriteTimeUtc.Ticks

    if ($script:HashCache.ContainsKey($cacheKey)) {
        return $script:HashCache[$cacheKey]
    }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fullPath -ErrorAction Stop).Hash
    foreach ($oldKey in @($script:HashCache.Keys | Where-Object {
        $_.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
    })) {
        $script:HashCache.Remove($oldKey)
    }
    $script:HashCache[$cacheKey] = $hash
    return $hash
}

function Save-FileHashCache {
    try {
        $cacheDirectory = Split-Path -Parent $script:HashCachePath
        if (!(Test-Path -LiteralPath $cacheDirectory)) {
            New-Item -ItemType Directory -Path $cacheDirectory -Force -ErrorAction Stop | Out-Null
        }
        ConvertTo-Json -InputObject $script:HashCache -Depth 3 |
            Set-Content -LiteralPath $script:HashCachePath -Encoding UTF8 -ErrorAction Stop
    } catch {
        Write-Warning "Could not save the local file hash cache: $_"
    }
}

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$GitArguments)

    & git -C $script:DestRoot @GitArguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

try {
    if ($env:LOCALAPPDATA) {
        $cacheBase = Join-Path $env:LOCALAPPDATA 'SoftEtherLogSync'
    } elseif ($env:TEMP) {
        $cacheBase = Join-Path $env:TEMP 'SoftEtherLogSync'
    } else {
        $cacheBase = Join-Path ([System.IO.Path]::GetTempPath()) 'SoftEtherLogSync'
    }
    $script:HashCachePath = Join-Path $cacheBase 'hash-cache.json'
    $script:HashCache = @{}

    if (Test-Path -LiteralPath $script:HashCachePath) {
        try {
            $cacheContent = Get-Content -LiteralPath $script:HashCachePath -Raw -ErrorAction Stop
            if ($cacheContent) {
                $cachedEntries = ConvertFrom-Json -InputObject $cacheContent -ErrorAction Stop
                foreach ($entry in $cachedEntries.PSObject.Properties) {
                    if ($entry.Value -is [string]) {
                        $script:HashCache[$entry.Name] = $entry.Value
                    }
                }
            }
        } catch {
            Write-Warning "Could not read the local file hash cache; hashes will be recomputed: $_"
            $script:HashCache = @{}
        }
    }

    $files = @(Get-ChildItem -Path $Source -File -Recurse -Force -ErrorAction Stop)
    if ($files.Count -eq 0) {
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
                if ($name -match '(\d{4})(\d{2})(\d{2})') {
                    $year = $matches[1]
                    $month = $matches[2]
                    $yy = $year.Substring(2, 2)
                    $subfolder = "$yy$month"
                } else {
                    $subfolder = $file.LastWriteTime.ToString('yyMM')
                }

                $destDir = Join-Path $DestRoot $subfolder
                if (!(Test-Path -LiteralPath $destDir)) {
                    New-Item -ItemType Directory -Path $destDir -Force -ErrorAction Stop | Out-Null
                }

                $target = Join-Path $destDir $name
                $shouldCopy = $true
                if (Test-Path -LiteralPath $target) {
                    $srcInfo = Get-Item -LiteralPath $file.FullName -ErrorAction Stop
                    $dstInfo = Get-Item -LiteralPath $target -ErrorAction Stop
                    if ($srcInfo.Length -eq $dstInfo.Length) {
                        $srcHash = Get-CachedFileHash -Path $file.FullName
                        $dstHash = Get-CachedFileHash -Path $target
                        if ($srcHash -eq $dstHash) {
                            Write-Output "Skipped $name - identical file exists at $target"
                            $skipped++
                            $shouldCopy = $false
                        }
                    }
                }

                if (!$shouldCopy) {
                    continue
                }

                Copy-Item -LiteralPath $file.FullName -Destination $target -Force -ErrorAction Stop
                Write-Output "Copied or overwrote $name -> $target"
                $changed.Add($target.Substring($DestRoot.Length).TrimStart('\').Replace('\', '/'))
                $processed++
            } catch {
                Write-Warning "Error processing file $($file.FullName): $_"
                $errors++
            }
        }

        Save-FileHashCache
        Write-Output "Logs processed into $DestRoot. Processed: $processed, Skipped: $skipped, Errors: $errors"

        if ($changed.Count -gt 0) {
            Push-Location $DestRoot
            try {
                & node generate-analysis.js
                if ($LASTEXITCODE -ne 0) {
                    throw "node generate-analysis.js failed with exit code $LASTEXITCODE"
                }
            } finally {
                Pop-Location
            }

            try {
                Get-Command git -ErrorAction Stop | Out-Null
                $gitPaths = @($changed | Sort-Object -Unique)

                for ($i = 0; $i -lt $gitPaths.Count; $i += 100) {
                    $end = [Math]::Min($i + 99, $gitPaths.Count - 1)
                    $batch = @($gitPaths[$i..$end])
                    Invoke-Git -GitArguments (@('add', '--') + $batch)
                }
                Invoke-Git -GitArguments @('add', '-f', '--', 'analysis')

                & git -C $DestRoot diff --cached --quiet -- $gitPaths analysis
                $diffExitCode = $LASTEXITCODE
                if ($diffExitCode -eq 1) {
                    $message = "Auto: add SoftEther logs ($($changed.Count) files) $(Get-Date -Format 'yyyy-MM-dd_HH:mm:ss')"
                    $commitArguments = @(
                        '-c', 'user.name=LogBot',
                        '-c', 'user.email=logbot@local',
                        'commit', '-m', $message, '--'
                    ) + $gitPaths + @('analysis')
                    Invoke-Git -GitArguments $commitArguments

                    Invoke-Git -GitArguments @('pull', '--rebase', '--autostash')
                    Invoke-Git -GitArguments @('push')
                    Write-Output "Git: committed and pushed $($changed.Count) log files and generated analysis"
                } elseif ($diffExitCode -eq 0) {
                    Write-Output "Git: no staged changes to commit"
                } else {
                    throw "git diff --cached failed with exit code $diffExitCode"
                }
            } catch {
                Write-Warning "Git synchronization failed: $_"
                throw
            }
        } else {
            Write-Output "No files changed; skipping analysis and git commit"
        }
    }
} catch {
    Write-Error "Log synchronization failed: $_"
    exit 1
}
