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

        return profile;
    }
}
