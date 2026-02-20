using System.Diagnostics;
using System.Text.Json;
using PocketIT.Core;

namespace PocketIT.Diagnostics.Checks;

public class BatteryCheck : IDiagnosticCheck
{
    public string CheckType => "battery";

    public async Task<DiagnosticResult> RunAsync()
    {
        try
        {
            var psPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");

            var script = @"
$battery = Get-WmiObject Win32_Battery
if ($battery) {
    $static = Get-CimInstance -ClassName BatteryStaticData -Namespace root/WMI -ErrorAction SilentlyContinue
    @{
        hasBattery = $true
        chargePercent = $battery.EstimatedChargeRemaining
        status = $battery.Status
        designCapacityMWh = if ($static) { $static.DesignedCapacity } else { $null }
        fullChargeCapacityMWh = if ($static) { $static.FullChargedCapacity } else { $null }
        healthPercent = if ($static -and $static.DesignedCapacity -gt 0) { [math]::Round(($static.FullChargedCapacity / $static.DesignedCapacity) * 100) } else { $null }
        cycleCount = if ($static) { $static.CycleCount } else { $null }
        estimatedRuntimeMinutes = $battery.EstimatedRunTime
    } | ConvertTo-Json
} else {
    @{ hasBattery = $false } | ConvertTo-Json
}";

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
                Logger.Warn($"Battery check PowerShell execution failed: {ex.Message}");
            }

            if (string.IsNullOrWhiteSpace(rawOutput))
            {
                return new DiagnosticResult
                {
                    CheckType = "battery",
                    Status = "ok",
                    Label = "Battery",
                    Value = "No battery detected (desktop)",
                    Details = new Dictionary<string, object>
                    {
                        ["hasBattery"] = false
                    }
                };
            }

            JsonElement parsed;
            try
            {
                parsed = JsonSerializer.Deserialize<JsonElement>(rawOutput.Trim());
            }
            catch (Exception ex)
            {
                Logger.Warn($"Battery check JSON parse failed: {ex.Message}");
                return new DiagnosticResult
                {
                    CheckType = "battery",
                    Status = "error",
                    Label = "Battery",
                    Value = "Unable to parse battery data",
                    Details = new Dictionary<string, object>
                    {
                        ["error"] = ex.Message
                    }
                };
            }

            bool hasBattery = parsed.TryGetProperty("hasBattery", out var hasBatteryProp) &&
                              hasBatteryProp.ValueKind == JsonValueKind.True;

            if (!hasBattery)
            {
                return new DiagnosticResult
                {
                    CheckType = "battery",
                    Status = "ok",
                    Label = "Battery",
                    Value = "No battery detected (desktop)",
                    Details = new Dictionary<string, object>
                    {
                        ["hasBattery"] = false
                    }
                };
            }

            int? chargePercent = null;
            if (parsed.TryGetProperty("chargePercent", out var cp) && cp.ValueKind == JsonValueKind.Number)
                chargePercent = cp.GetInt32();

            int? healthPercent = null;
            if (parsed.TryGetProperty("healthPercent", out var hp) && hp.ValueKind == JsonValueKind.Number)
                healthPercent = hp.GetInt32();

            string status = "ok";
            if ((healthPercent.HasValue && healthPercent.Value < 50) ||
                (chargePercent.HasValue && chargePercent.Value < 10))
            {
                status = "error";
            }
            else if ((healthPercent.HasValue && healthPercent.Value < 80) ||
                     (chargePercent.HasValue && chargePercent.Value < 20))
            {
                status = "warning";
            }

            var parts = new List<string>();
            if (chargePercent.HasValue)
                parts.Add($"{chargePercent.Value}% charge");
            if (healthPercent.HasValue)
                parts.Add($"{healthPercent.Value}% health");
            string value = parts.Count > 0 ? string.Join(", ", parts) : "Battery detected";

            return new DiagnosticResult
            {
                CheckType = "battery",
                Status = status,
                Label = "Battery",
                Value = value,
                Details = new Dictionary<string, object>
                {
                    ["raw"] = rawOutput.Trim()
                }
            };
        }
        catch (Exception ex)
        {
            Logger.Warn($"Battery check failed: {ex.Message}");
            return new DiagnosticResult
            {
                CheckType = "battery",
                Status = "error",
                Label = "Battery",
                Value = "Unable to run battery check",
                Details = new Dictionary<string, object>
                {
                    ["error"] = ex.Message
                }
            };
        }
    }
}
