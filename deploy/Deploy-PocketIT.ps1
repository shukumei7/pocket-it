<#
.SYNOPSIS
    Remote-deploy Pocket IT client to Windows machines via PowerShell Remoting.

.DESCRIPTION
    Copies the built Pocket IT client to one or more remote machines, pre-seeds
    the enrollment token in appsettings.json, registers a startup shortcut, and
    optionally launches the app. Requires WinRM enabled on targets (default on
    domain-joined machines).

.PARAMETER ComputerName
    One or more target machine names or IPs. Accepts pipeline input.

.PARAMETER ServerUrl
    The Pocket IT server URL (e.g., http://10.0.0.5:9100).

.PARAMETER BuildPath
    Path to the published client folder. Defaults to the self-contained publish output.

.PARAMETER Token
    Enrollment token. If omitted, the script generates one from the server API.

.PARAMETER InstallPath
    Remote install path. Default: C:\Program Files\PocketIT

.PARAMETER Credential
    PSCredential for remote access. If omitted, uses current user (Kerberos/AD).

.PARAMETER AutoLaunch
    Launch Pocket IT on the remote machine after install.

.PARAMETER Force
    Overwrite existing installation without prompting.

.EXAMPLE
    # Deploy to one machine, auto-generate token
    .\Deploy-PocketIT.ps1 -ComputerName WS-042 -ServerUrl http://10.0.0.5:9100

.EXAMPLE
    # Deploy to multiple machines from a text file
    Get-Content .\targets.txt | .\Deploy-PocketIT.ps1 -ServerUrl http://10.0.0.5:9100 -AutoLaunch

.EXAMPLE
    # Deploy with explicit credentials and token
    $cred = Get-Credential DOMAIN\Admin
    .\Deploy-PocketIT.ps1 -ComputerName WS-042,WS-043 -ServerUrl http://10.0.0.5:9100 -Token "abc-123" -Credential $cred
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
    [string[]]$ComputerName,

    [Parameter(Mandatory)]
    [string]$ServerUrl,

    [string]$BuildPath,

    [string]$Token,

    [string]$InstallPath = 'C:\Program Files\PocketIT',

    [PSCredential]$Credential,

    [switch]$AutoLaunch,

    [switch]$Force
)

begin {
    $ErrorActionPreference = 'Stop'

    # --- Resolve build path ---
    if (-not $BuildPath) {
        # Default: look for publish output relative to this script
        $clientRoot = Join-Path $PSScriptRoot '..\client\PocketIT'
        $defaultPublish = Join-Path $clientRoot 'bin\Release\net8.0-windows\publish'
        $defaultBuild   = Join-Path $clientRoot 'bin\Release\net8.0-windows'

        if (Test-Path $defaultPublish) {
            $BuildPath = $defaultPublish
        } elseif (Test-Path $defaultBuild) {
            $BuildPath = $defaultBuild
        } else {
            throw "No build output found. Run 'dotnet publish -c Release' first, or specify -BuildPath."
        }
    }

    if (-not (Test-Path $BuildPath)) {
        throw "Build path not found: $BuildPath"
    }

    # Verify PocketIT.exe exists in build
    $exePath = Join-Path $BuildPath 'PocketIT.exe'
    if (-not (Test-Path $exePath)) {
        throw "PocketIT.exe not found in $BuildPath. Ensure the project is built."
    }

    Write-Host "Build path: $BuildPath" -ForegroundColor Cyan

    # --- Generate enrollment token if needed ---
    if (-not $Token) {
        Write-Host "Generating enrollment token from $ServerUrl..." -ForegroundColor Cyan
        try {
            $tokenResponse = Invoke-RestMethod -Uri "$ServerUrl/api/enrollment/token" -Method POST -ContentType 'application/json' -Body '{"createdBy":"deploy-script"}'
            $Token = $tokenResponse.token
            Write-Host "Token generated: $Token (expires: $($tokenResponse.expiresAt))" -ForegroundColor Green
        } catch {
            throw "Failed to generate enrollment token from server: $_"
        }
    }

    # --- Prepare appsettings with pre-seeded token ---
    $appSettings = @{
        Server = @{
            Url = $ServerUrl
            ReconnectInterval = 5000
        }
        Enrollment = @{
            Token = $Token
        }
        Database = @{
            Path = 'pocket-it.db'
        }
        OfflineContacts = @{
            Phone  = ''
            Email  = ''
            Portal = ''
        }
    }

    $appSettingsJson = $appSettings | ConvertTo-Json -Depth 3

    # Session params for remoting
    $sessionParams = @{}
    if ($Credential) {
        $sessionParams['Credential'] = $Credential
    }

    # Collect results
    $results = [System.Collections.Generic.List[PSCustomObject]]::new()
}

process {
    foreach ($computer in $ComputerName) {
        $computer = $computer.Trim()
        if (-not $computer) { continue }

        $result = [PSCustomObject]@{
            Computer = $computer
            Status   = 'Pending'
            Detail   = ''
        }

        if (-not $PSCmdlet.ShouldProcess($computer, "Deploy Pocket IT")) {
            $result.Status = 'Skipped'
            $result.Detail = 'WhatIf mode'
            $results.Add($result)
            continue
        }

        Write-Host "`n--- Deploying to $computer ---" -ForegroundColor Yellow

        try {
            # Test connectivity
            Write-Host "  Testing connection..." -NoNewline
            if (-not (Test-WSMan -ComputerName $computer -ErrorAction SilentlyContinue)) {
                throw "WinRM not available on $computer. Enable with: Enable-PSRemoting -Force"
            }
            Write-Host " OK" -ForegroundColor Green

            # Create remote session
            $session = New-PSSession -ComputerName $computer @sessionParams

            try {
                # Check for existing install
                $existingInstall = Invoke-Command -Session $session -ScriptBlock {
                    param($path)
                    Test-Path (Join-Path $path 'PocketIT.exe')
                } -ArgumentList $InstallPath

                if ($existingInstall -and -not $Force) {
                    Write-Host "  Existing installation found. Use -Force to overwrite." -ForegroundColor Yellow

                    # Stop running process before overwriting
                    Invoke-Command -Session $session -ScriptBlock {
                        $proc = Get-Process -Name 'PocketIT' -ErrorAction SilentlyContinue
                        if ($proc) {
                            Write-Host "  Stopping running PocketIT process..."
                            $proc | Stop-Process -Force
                            Start-Sleep -Seconds 2
                        }
                    }

                    $result.Status = 'Skipped'
                    $result.Detail = 'Existing install found, use -Force'
                    $results.Add($result)
                    continue
                }

                if ($existingInstall -and $Force) {
                    Write-Host "  Stopping existing PocketIT process..." -NoNewline
                    Invoke-Command -Session $session -ScriptBlock {
                        $proc = Get-Process -Name 'PocketIT' -ErrorAction SilentlyContinue
                        if ($proc) {
                            $proc | Stop-Process -Force
                            Start-Sleep -Seconds 2
                        }
                    }
                    Write-Host " OK" -ForegroundColor Green
                }

                # Create install directory
                Write-Host "  Creating install directory..." -NoNewline
                Invoke-Command -Session $session -ScriptBlock {
                    param($path)
                    if (-not (Test-Path $path)) {
                        New-Item -Path $path -ItemType Directory -Force | Out-Null
                    }
                } -ArgumentList $InstallPath
                Write-Host " OK" -ForegroundColor Green

                # Copy files via admin share
                Write-Host "  Copying files..." -NoNewline
                $remotePath = "\\$computer\$($InstallPath.Replace(':', '$'))"

                # Ensure the UNC path is accessible
                if (-not (Test-Path $remotePath)) {
                    # Fallback: use Copy-Item via session
                    $files = Get-ChildItem -Path $BuildPath -Recurse
                    $totalFiles = ($files | Where-Object { -not $_.PSIsContainer }).Count

                    # Copy the entire directory tree
                    Copy-Item -Path "$BuildPath\*" -Destination $InstallPath -ToSession $session -Recurse -Force
                } else {
                    Copy-Item -Path "$BuildPath\*" -Destination $remotePath -Recurse -Force
                }
                Write-Host " OK ($totalFiles files)" -ForegroundColor Green

                # Write pre-seeded appsettings.json
                Write-Host "  Pre-seeding enrollment token..." -NoNewline
                Invoke-Command -Session $session -ScriptBlock {
                    param($path, $json)
                    $settingsPath = Join-Path $path 'appsettings.json'
                    Set-Content -Path $settingsPath -Value $json -Encoding UTF8
                } -ArgumentList $InstallPath, $appSettingsJson
                Write-Host " OK" -ForegroundColor Green

                # Register elevated auto-start via Task Scheduler
                Write-Host "  Registering auto-start task..." -NoNewline
                Invoke-Command -Session $session -ScriptBlock {
                    param($installPath)
                    $exePath = Join-Path $installPath 'PocketIT.exe'
                    # Remove old startup shortcut if exists (migration)
                    $startupFolder = [Environment]::GetFolderPath('CommonStartup')
                    $oldShortcut = Join-Path $startupFolder 'Pocket IT.lnk'
                    if (Test-Path $oldShortcut) { Remove-Item $oldShortcut -Force }
                    # Create scheduled task for elevated auto-start
                    schtasks /Create /TN "PocketIT" /TR "`"$exePath`"" /SC ONLOGON /RL HIGHEST /F | Out-Null
                } -ArgumentList $InstallPath
                Write-Host " OK" -ForegroundColor Green

                # Add Windows Firewall rule
                Write-Host "  Configuring firewall..." -NoNewline
                Invoke-Command -Session $session -ScriptBlock {
                    param($installPath)
                    $exePath = Join-Path $installPath 'PocketIT.exe'
                    $existing = Get-NetFirewallRule -DisplayName 'Pocket IT' -ErrorAction SilentlyContinue
                    if (-not $existing) {
                        New-NetFirewallRule -DisplayName 'Pocket IT' -Direction Outbound -Action Allow -Program $exePath -Profile Any | Out-Null
                    }
                } -ArgumentList $InstallPath
                Write-Host " OK" -ForegroundColor Green

                # Launch if requested
                if ($AutoLaunch) {
                    Write-Host "  Launching PocketIT..." -NoNewline
                    Invoke-Command -Session $session -ScriptBlock {
                        param($installPath)
                        $exePath = Join-Path $installPath 'PocketIT.exe'
                        # Start as the logged-in user via scheduled task (one-shot)
                        $action  = New-ScheduledTaskAction -Execute $exePath -WorkingDirectory $installPath
                        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)
                        Register-ScheduledTask -TaskName 'PocketIT-Launch' -Action $action -Trigger $trigger -RunLevel Highest -Force | Out-Null
                        Start-Sleep -Seconds 6
                        Unregister-ScheduledTask -TaskName 'PocketIT-Launch' -Confirm:$false -ErrorAction SilentlyContinue
                    } -ArgumentList $InstallPath
                    Write-Host " OK" -ForegroundColor Green
                }

                $result.Status = 'Success'
                $result.Detail = "Installed to $InstallPath"

            } finally {
                Remove-PSSession -Session $session -ErrorAction SilentlyContinue
            }

        } catch {
            $result.Status = 'Failed'
            $result.Detail = $_.Exception.Message
            Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
        }

        $results.Add($result)
    }
}

end {
    # Summary
    Write-Host "`n=== Deployment Summary ===" -ForegroundColor Cyan
    $results | Format-Table -AutoSize

    $succeeded = ($results | Where-Object Status -eq 'Success').Count
    $failed    = ($results | Where-Object Status -eq 'Failed').Count
    $skipped   = ($results | Where-Object Status -eq 'Skipped').Count
    $total     = $results.Count

    Write-Host "Total: $total | Succeeded: $succeeded | Failed: $failed | Skipped: $skipped" -ForegroundColor $(if ($failed -gt 0) { 'Yellow' } else { 'Green' })

    if ($failed -gt 0) {
        Write-Host "`nFailed machines may need WinRM enabled:" -ForegroundColor Yellow
        Write-Host "  On target: Enable-PSRemoting -Force" -ForegroundColor Yellow
        Write-Host "  Or via GPO: Computer Config > Admin Templates > Windows Remote Management" -ForegroundColor Yellow
    }
}
