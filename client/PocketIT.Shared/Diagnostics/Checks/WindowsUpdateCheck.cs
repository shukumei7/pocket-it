using System.Diagnostics;
using System.Text.Json;
using Microsoft.Win32;
using PocketIT.Core;

namespace PocketIT.Diagnostics.Checks;

public class WindowsUpdateCheck : IDiagnosticCheck
{
    public string CheckType => "windows_update";

    public async Task<DiagnosticResult> RunAsync()
    {
        try
        {
            var lastUpdates = new List<Dictionary<string, object>>();
            DateTime? mostRecentDate = null;

            // Get recent hotfixes via PowerShell
            var psPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");

            var command = "Get-HotFix | Sort-Object InstalledOn -Descending -ErrorAction SilentlyContinue | Select-Object -First 5 HotFixID, Description, InstalledOn | ConvertTo-Json";
            var info = new ProcessStartInfo(psPath, $"-NoProfile -Command \"{command}\"")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            try
            {
                using var process = Process.Start(info);
                if (process != null)
                {
                    var output = await process.StandardOutput.ReadToEndAsync();
                    await process.WaitForExitAsync();

                    if (!string.IsNullOrWhiteSpace(output))
                    {
                        // PowerShell returns a single object (not array) if only 1 result
                        var trimmed = output.Trim();
                        JsonElement[] items;

                        if (trimmed.StartsWith("["))
                        {
                            items = JsonSerializer.Deserialize<JsonElement[]>(trimmed) ?? Array.Empty<JsonElement>();
                        }
                        else
                        {
                            var single = JsonSerializer.Deserialize<JsonElement>(trimmed);
                            items = new[] { single };
                        }

                        foreach (var item in items)
                        {
                            string hotFixId = item.TryGetProperty("HotFixID", out var hf) ? hf.GetString() ?? "" : "";
                            string description = item.TryGetProperty("Description", out var desc) ? desc.GetString() ?? "" : "";
                            string installedOn = "";
                            DateTime? parsedDate = null;

                            if (item.TryGetProperty("InstalledOn", out var installedProp))
                            {
                                // PowerShell serializes DateTime as "/Date(milliseconds)/" or ISO string
                                var raw = installedProp.ToString();
                                var dateMatch = System.Text.RegularExpressions.Regex.Match(raw, @"/Date\((\d+)\)/");
                                if (dateMatch.Success && long.TryParse(dateMatch.Groups[1].Value, out long ms))
                                {
                                    parsedDate = DateTimeOffset.FromUnixTimeMilliseconds(ms).LocalDateTime;
                                    installedOn = parsedDate.Value.ToString("yyyy-MM-dd");
                                }
                                else if (DateTime.TryParse(raw, out var dt))
                                {
                                    parsedDate = dt;
                                    installedOn = dt.ToString("yyyy-MM-dd");
                                }
                            }

                            if (parsedDate.HasValue && (!mostRecentDate.HasValue || parsedDate.Value > mostRecentDate.Value))
                                mostRecentDate = parsedDate.Value;

                            lastUpdates.Add(new Dictionary<string, object>
                            {
                                ["hotFixId"] = hotFixId,
                                ["description"] = description,
                                ["installedOn"] = installedOn
                            });
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Warn($"Windows update PowerShell check failed: {ex.Message}");
            }

            // Check for pending reboot via registry
            bool pendingReboot = false;
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired");
                pendingReboot = key != null;
            }
            catch (Exception ex)
            {
                Logger.Warn($"Windows update reboot check failed: {ex.Message}");
            }

            int daysSinceLastUpdate = mostRecentDate.HasValue
                ? (int)(DateTime.Now - mostRecentDate.Value).TotalDays
                : -1;

            // Determine status
            string status;
            if (pendingReboot || daysSinceLastUpdate > 90)
                status = "error";
            else if (daysSinceLastUpdate > 30)
                status = "warning";
            else
                status = "ok";

            // Build value summary
            string value;
            if (daysSinceLastUpdate < 0)
                value = "Unable to determine last update date";
            else if (pendingReboot)
                value = $"PENDING REBOOT — last update {daysSinceLastUpdate} days ago";
            else
                value = $"Last update {daysSinceLastUpdate} days ago";

            return new DiagnosticResult
            {
                CheckType = "windows_update",
                Status = status,
                Label = "Windows Update",
                Value = value,
                Details = new Dictionary<string, object>
                {
                    ["lastUpdates"] = lastUpdates,
                    ["pendingReboot"] = pendingReboot,
                    ["daysSinceLastUpdate"] = daysSinceLastUpdate
                }
            };
        }
        catch (Exception ex)
        {
            Logger.Warn($"Windows update check failed: {ex.Message}");
            return new DiagnosticResult
            {
                CheckType = "windows_update",
                Status = "error",
                Label = "Windows Update",
                Value = "Unable to check Windows Update status",
                Details = new Dictionary<string, object>
                {
                    ["error"] = ex.Message
                }
            };
        }
    }
}
