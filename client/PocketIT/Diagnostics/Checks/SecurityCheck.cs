using System.Diagnostics;
using System.Text.Json;
using PocketIT.Core;

namespace PocketIT.Diagnostics.Checks;

public class SecurityCheck : IDiagnosticCheck
{
    public string CheckType => "security";

    public async Task<DiagnosticResult> RunAsync()
    {
        try
        {
            var psPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");

            var script = @"
$result = @{}
try { $result.bitlocker = Get-BitLockerVolume | Select-Object MountPoint, ProtectionStatus, EncryptionMethod, LockStatus } catch { $result.bitlocker = @{error=$_.Exception.Message} }
try { $result.defender = Get-MpComputerStatus | Select-Object AMServiceEnabled, RealTimeProtectionEnabled, AntivirusSignatureVersion, AntivirusSignatureLastUpdated, LastQuickScanEndTime, LastFullScanEndTime } catch { $result.defender = @{error=$_.Exception.Message} }
try { $result.firewall = Get-NetFirewallProfile | Select-Object Name, Enabled } catch { $result.firewall = @{error=$_.Exception.Message} }
try { $result.localAdmins = (Get-LocalGroupMember -Group 'Administrators').Name } catch { $result.localAdmins = @{error=$_.Exception.Message} }
$result | ConvertTo-Json -Depth 3";

            var scriptBytes = System.Text.Encoding.Unicode.GetBytes(script);
            var encodedScript = Convert.ToBase64String(scriptBytes);
            var info = new ProcessStartInfo(psPath, $"-NoProfile -EncodedCommand {encodedScript}")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            string rawOutput = "";
            try
            {
                using var process = Process.Start(info);
                if (process != null)
                {
                    rawOutput = await process.StandardOutput.ReadToEndAsync();
                    await process.WaitForExitAsync();
                }
            }
            catch (Exception ex)
            {
                Logger.Warn($"Security check PowerShell execution failed: {ex.Message}");
            }

            string status = "ok";
            var issues = new List<string>();
            var warnings = new List<string>();
            JsonElement parsed = default;

            if (!string.IsNullOrWhiteSpace(rawOutput))
            {
                try
                {
                    parsed = JsonSerializer.Deserialize<JsonElement>(rawOutput.Trim());

                    // Check BitLocker
                    if (parsed.TryGetProperty("bitlocker", out var bitlocker))
                    {
                        if (bitlocker.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var vol in bitlocker.EnumerateArray())
                            {
                                if (vol.TryGetProperty("ProtectionStatus", out var ps))
                                {
                                    var psStr = ps.ToString();
                                    if (psStr.Equals("Off", StringComparison.OrdinalIgnoreCase) || psStr == "0")
                                    {
                                        var mount = vol.TryGetProperty("MountPoint", out var mp) ? mp.GetString() ?? "" : "?";
                                        issues.Add($"BitLocker off on {mount}");
                                    }
                                }
                            }
                        }
                        else if (bitlocker.ValueKind == JsonValueKind.Object &&
                                 bitlocker.TryGetProperty("ProtectionStatus", out var singlePs))
                        {
                            var psStr = singlePs.ToString();
                            if (psStr.Equals("Off", StringComparison.OrdinalIgnoreCase) || psStr == "0")
                            {
                                var mount = bitlocker.TryGetProperty("MountPoint", out var mp) ? mp.GetString() ?? "" : "?";
                                issues.Add($"BitLocker off on {mount}");
                            }
                        }
                    }

                    // Check Defender
                    if (parsed.TryGetProperty("defender", out var defender) &&
                        defender.ValueKind == JsonValueKind.Object &&
                        !defender.TryGetProperty("error", out _))
                    {
                        if (defender.TryGetProperty("AMServiceEnabled", out var amService) &&
                            amService.ValueKind == JsonValueKind.False)
                        {
                            issues.Add("Defender service disabled");
                        }

                        if (defender.TryGetProperty("RealTimeProtectionEnabled", out var rtp) &&
                            rtp.ValueKind == JsonValueKind.False)
                        {
                            issues.Add("Defender real-time protection disabled");
                        }

                        // Check signature age
                        if (defender.TryGetProperty("AntivirusSignatureLastUpdated", out var sigDate))
                        {
                            var rawDate = sigDate.ToString();
                            var dateMatch = System.Text.RegularExpressions.Regex.Match(rawDate, @"/Date\((\d+)\)/");
                            DateTime? sigDateTime = null;
                            if (dateMatch.Success && long.TryParse(dateMatch.Groups[1].Value, out long ms))
                                sigDateTime = DateTimeOffset.FromUnixTimeMilliseconds(ms).LocalDateTime;
                            else if (DateTime.TryParse(rawDate, out var dt))
                                sigDateTime = dt;

                            if (sigDateTime.HasValue && (DateTime.Now - sigDateTime.Value).TotalDays > 7)
                                warnings.Add($"Defender signatures {(int)(DateTime.Now - sigDateTime.Value).TotalDays} days old");
                        }
                    }

                    // Check Firewall
                    if (parsed.TryGetProperty("firewall", out var firewall))
                    {
                        if (firewall.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var profile in firewall.EnumerateArray())
                            {
                                if (profile.TryGetProperty("Enabled", out var enabled) &&
                                    enabled.ValueKind == JsonValueKind.False)
                                {
                                    var name = profile.TryGetProperty("Name", out var n) ? n.GetString() ?? "" : "?";
                                    warnings.Add($"Firewall profile '{name}' disabled");
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Logger.Warn($"Security check JSON parse failed: {ex.Message}");
                }
            }

            if (issues.Count > 0)
                status = "error";
            else if (warnings.Count > 0)
                status = "warning";

            var allMessages = issues.Concat(warnings).ToList();
            string value = allMessages.Count > 0
                ? string.Join("; ", allMessages)
                : "All security checks passed";

            return new DiagnosticResult
            {
                CheckType = "security",
                Status = status,
                Label = "Security",
                Value = value,
                Details = new Dictionary<string, object>
                {
                    ["raw"] = rawOutput.Trim(),
                    ["issues"] = issues,
                    ["warnings"] = warnings
                }
            };
        }
        catch (Exception ex)
        {
            Logger.Warn($"Security check failed: {ex.Message}");
            return new DiagnosticResult
            {
                CheckType = "security",
                Status = "error",
                Label = "Security",
                Value = "Unable to run security checks",
                Details = new Dictionary<string, object>
                {
                    ["error"] = ex.Message
                }
            };
        }
    }
}
