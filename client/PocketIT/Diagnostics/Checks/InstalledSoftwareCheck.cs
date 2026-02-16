using Microsoft.Win32;
using PocketIT.Core;

namespace PocketIT.Diagnostics.Checks;

public class InstalledSoftwareCheck : IDiagnosticCheck
{
    public string CheckType => "installed_software";

    public Task<DiagnosticResult> RunAsync()
    {
        var programs = new List<Dictionary<string, object>>();

        try
        {
            string[] registryPaths = new[]
            {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            };

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var path in registryPaths)
            {
                using var key = Registry.LocalMachine.OpenSubKey(path);
                if (key == null) continue;

                foreach (var subKeyName in key.GetSubKeyNames())
                {
                    try
                    {
                        using var subKey = key.OpenSubKey(subKeyName);
                        if (subKey == null) continue;

                        // Filter out system components
                        var systemComponent = subKey.GetValue("SystemComponent");
                        if (systemComponent is int sc && sc == 1) continue;

                        var displayName = subKey.GetValue("DisplayName") as string;
                        if (string.IsNullOrWhiteSpace(displayName)) continue;

                        // Deduplicate across 32/64-bit registry
                        if (!seen.Add(displayName)) continue;

                        programs.Add(new Dictionary<string, object>
                        {
                            ["name"] = displayName,
                            ["version"] = subKey.GetValue("DisplayVersion") as string ?? "",
                            ["publisher"] = subKey.GetValue("Publisher") as string ?? "",
                            ["installDate"] = subKey.GetValue("InstallDate") as string ?? ""
                        });
                    }
                    catch (Exception ex)
                    {
                        Logger.Warn($"InstalledSoftware: error reading subkey {subKeyName}: {ex.Message}");
                    }
                }
            }

            programs.Sort((a, b) => string.Compare(
                a["name"] as string ?? "",
                b["name"] as string ?? "",
                StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception ex)
        {
            Logger.Warn($"InstalledSoftware check failed: {ex.Message}");
            return Task.FromResult(new DiagnosticResult
            {
                CheckType = "installed_software",
                Status = "error",
                Label = "Installed Software",
                Value = "Unable to read installed software",
                Details = new Dictionary<string, object>
                {
                    ["error"] = ex.Message
                }
            });
        }

        return Task.FromResult(new DiagnosticResult
        {
            CheckType = "installed_software",
            Status = "ok",
            Label = "Installed Software",
            Value = $"{programs.Count} programs installed",
            Details = new Dictionary<string, object>
            {
                ["programs"] = programs,
                ["totalCount"] = programs.Count
            }
        });
    }
}
