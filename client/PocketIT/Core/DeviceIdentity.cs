using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace PocketIT.Core;

public static class DeviceIdentity
{
    public static string GetMachineId()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        return key?.GetValue("MachineGuid")?.ToString() ?? Guid.NewGuid().ToString();
    }

    public static string GetHostname() => Environment.MachineName;
    public static string GetOsVersion() => Environment.OSVersion.ToString();

    public static async Task<Dictionary<string, object>> GetSystemProfileAsync()
    {
        var profile = new Dictionary<string, object>
        {
            ["hostname"] = Environment.MachineName,
            ["osVersion"] = Environment.OSVersion.ToString(),
            ["processorCount"] = Environment.ProcessorCount
        };

        // Get CPU model via wmic
        var cpuModel = "Unknown";
        try
        {
            var wmicPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wbem", "wmic.exe");
            var info = new ProcessStartInfo(wmicPath, "cpu get Name /value")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var match = Regex.Match(output, @"Name=(.+)");
                if (match.Success)
                {
                    cpuModel = match.Groups[1].Value.Trim();
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: CPU model query failed: {ex.Message}");
        }
        profile["cpuModel"] = cpuModel;

        // Get total RAM via wmic
        var totalRamGB = 0.0;
        try
        {
            var wmicPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wbem", "wmic.exe");
            var info = new ProcessStartInfo(wmicPath, "os get TotalVisibleMemorySize /value")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var match = Regex.Match(output, @"TotalVisibleMemorySize=(\d+)");
                if (match.Success)
                {
                    var totalKB = long.Parse(match.Groups[1].Value);
                    totalRamGB = Math.Round(totalKB / 1024.0 / 1024.0, 1);
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: RAM query failed: {ex.Message}");
        }
        profile["totalRamGB"] = totalRamGB;

        // Get total disk space from all fixed drives
        var totalDiskGB = 0.0;
        try
        {
            totalDiskGB = Math.Round(
                DriveInfo.GetDrives()
                    .Where(d => d.DriveType == DriveType.Fixed)
                    .Sum(d => d.TotalSize) / 1024.0 / 1024.0 / 1024.0,
                1
            );
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: Disk query failed: {ex.Message}");
        }
        profile["totalDiskGB"] = totalDiskGB;

        // v0.9.0: Enhanced system profile
        // OS Edition from registry
        try
        {
            using var osKey = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            profile["osEdition"] = osKey?.GetValue("ProductName")?.ToString() ?? "Unknown";
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: OS edition query failed: {ex.Message}");
            profile["osEdition"] = "Unknown";
        }

        // OS Build (Build.UBR format)
        try
        {
            var build = Environment.OSVersion.Version.Build;
            int ubr = 0;
            using var verKey = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            if (verKey?.GetValue("UBR") is int ubrVal) ubr = ubrVal;
            profile["osBuild"] = $"{build}.{ubr}";
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: OS build query failed: {ex.Message}");
            profile["osBuild"] = Environment.OSVersion.Version.Build.ToString();
        }

        // OS Architecture
        profile["osArchitecture"] = Environment.Is64BitOperatingSystem ? "64-bit" : "32-bit";

        // BIOS Manufacturer
        try
        {
            var wmicPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wbem", "wmic.exe");
            var info = new ProcessStartInfo(wmicPath, "bios get Manufacturer /value")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var match = Regex.Match(output, @"Manufacturer=(.+)");
                profile["biosManufacturer"] = match.Success ? match.Groups[1].Value.Trim() : "Unknown";
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: BIOS manufacturer query failed: {ex.Message}");
            profile["biosManufacturer"] = "Unknown";
        }

        // BIOS Version
        try
        {
            var wmicPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wbem", "wmic.exe");
            var info = new ProcessStartInfo(wmicPath, "bios get SMBIOSBIOSVersion /value")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var match = Regex.Match(output, @"SMBIOSBIOSVersion=(.+)");
                profile["biosVersion"] = match.Success ? match.Groups[1].Value.Trim() : "Unknown";
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: BIOS version query failed: {ex.Message}");
            profile["biosVersion"] = "Unknown";
        }

        // GPU Model
        try
        {
            var wmicPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wbem", "wmic.exe");
            var info = new ProcessStartInfo(wmicPath, "path win32_VideoController get Name /value")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var matches = Regex.Matches(output, @"Name=(.+)");
                var gpus = matches.Cast<Match>().Select(m => m.Groups[1].Value.Trim()).ToList();
                profile["gpuModel"] = gpus.Count > 0 ? string.Join("; ", gpus) : "Unknown";
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: GPU query failed: {ex.Message}");
            profile["gpuModel"] = "Unknown";
        }

        // Serial Number
        try
        {
            var wmicPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wbem", "wmic.exe");
            var info = new ProcessStartInfo(wmicPath, "bios get SerialNumber /value")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var match = Regex.Match(output, @"SerialNumber=(.+)");
                profile["serialNumber"] = match.Success ? match.Groups[1].Value.Trim() : "Unknown";
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: Serial number query failed: {ex.Message}");
            profile["serialNumber"] = "Unknown";
        }

        // Domain
        profile["domain"] = Environment.UserDomainName;

        // Last boot time and uptime
        var uptimeMs = Environment.TickCount64;
        var uptimeHours = Math.Round(uptimeMs / 3600000.0, 1);
        var lastBootTime = DateTime.Now.AddMilliseconds(-uptimeMs);
        profile["lastBootTime"] = lastBootTime.ToString("o");
        profile["uptimeHours"] = uptimeHours;

        // Logged in users
        try
        {
            var info = new ProcessStartInfo("query", "user")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Skip(1); // skip header
                var users = lines.Select(l => l.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault())
                    .Where(u => !string.IsNullOrWhiteSpace(u))
                    .Distinct()
                    .ToList();
                // Fallback: if query user returned nothing, use Environment.UserName
                if (users.Count == 0 && !string.IsNullOrWhiteSpace(Environment.UserName))
                {
                    users.Add(Environment.UserName);
                }
                profile["loggedInUsers"] = users;
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: Logged in users query failed: {ex.Message}");
            // Fallback to Environment.UserName
            var fallbackUser = Environment.UserName;
            profile["loggedInUsers"] = !string.IsNullOrWhiteSpace(fallbackUser)
                ? new List<string> { fallbackUser }
                : new List<string>();
        }

        // Network adapters via PowerShell
        try
        {
            var psScript = "Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { $ip = (Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress; [PSCustomObject]@{Name=$_.Name;Status=$_.Status;MacAddress=$_.MacAddress;Speed=$_.LinkSpeed;IPv4=$ip} } | ConvertTo-Json -Compress";
            var info = new ProcessStartInfo("powershell", $"-NoProfile -Command \"{psScript}\"")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                var trimmed = output.Trim();
                if (!string.IsNullOrEmpty(trimmed))
                {
                    profile["networkAdapters"] = System.Text.Json.JsonSerializer.Deserialize<object>(trimmed);
                }
                else
                {
                    profile["networkAdapters"] = new List<object>();
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"System profile: Network adapters query failed: {ex.Message}");
            profile["networkAdapters"] = new List<object>();
        }

        return profile;
    }
}
