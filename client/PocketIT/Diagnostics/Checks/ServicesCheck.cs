using System.Diagnostics;
using System.Text.Json;
using PocketIT.Core;

namespace PocketIT.Diagnostics.Checks;

public class ServicesCheck : IDiagnosticCheck
{
    public string CheckType => "services";

    public async Task<DiagnosticResult> RunAsync()
    {
        var stoppedAutoServices = new List<Dictionary<string, object>>();
        int totalRunning = 0;
        int totalStopped = 0;

        try
        {
            var psPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            var psi = new ProcessStartInfo
            {
                FileName = psPath,
                Arguments = "-NoProfile -Command \"Get-Service | Select-Object Name, DisplayName, Status, StartType | ConvertTo-Json\"",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var proc = Process.Start(psi);
            if (proc == null)
                throw new Exception("Failed to start PowerShell");

            string output = await proc.StandardOutput.ReadToEndAsync();
            await proc.WaitForExitAsync();

            using var doc = JsonDocument.Parse(output);
            var services = doc.RootElement;

            // PowerShell returns an array (or single object if only one service)
            if (services.ValueKind == JsonValueKind.Array)
            {
                foreach (var svc in services.EnumerateArray())
                {
                    ParseService(svc, ref totalRunning, ref totalStopped, stoppedAutoServices);
                }
            }
            else if (services.ValueKind == JsonValueKind.Object)
            {
                ParseService(services, ref totalRunning, ref totalStopped, stoppedAutoServices);
            }
        }
        catch (Exception ex)
        {
            Logger.Warn($"Services check failed: {ex.Message}");
            return new DiagnosticResult
            {
                CheckType = "services",
                Status = "error",
                Label = "Services",
                Value = "Unable to read services",
                Details = new Dictionary<string, object>
                {
                    ["error"] = ex.Message
                }
            };
        }

        string status = stoppedAutoServices.Count > 0 ? "warning" : "ok";
        string value = stoppedAutoServices.Count > 0
            ? $"{stoppedAutoServices.Count} auto-start service(s) stopped, {totalRunning} running"
            : $"All auto-start services running ({totalRunning} total)";

        return new DiagnosticResult
        {
            CheckType = "services",
            Status = status,
            Label = "Services",
            Value = value,
            Details = new Dictionary<string, object>
            {
                ["stoppedAutoServices"] = stoppedAutoServices,
                ["totalRunning"] = totalRunning,
                ["totalStopped"] = totalStopped
            }
        };
    }

    private static void ParseService(JsonElement svc, ref int totalRunning, ref int totalStopped,
        List<Dictionary<string, object>> stoppedAutoServices)
    {
        // PowerShell serializes enums as integers: Status (4=Running, 1=Stopped), StartType (2=Automatic)
        int statusVal = svc.TryGetProperty("Status", out var statusProp) ? statusProp.GetInt32() : 0;
        int startTypeVal = svc.TryGetProperty("StartType", out var startTypeProp) ? startTypeProp.GetInt32() : 0;
        string name = svc.TryGetProperty("Name", out var nameProp) ? nameProp.GetString() ?? "" : "";
        string displayName = svc.TryGetProperty("DisplayName", out var dnProp) ? dnProp.GetString() ?? "" : "";

        bool isRunning = statusVal == 4;
        bool isAutomatic = startTypeVal == 2;

        if (isRunning)
            totalRunning++;
        else
            totalStopped++;

        if (isAutomatic && !isRunning)
        {
            stoppedAutoServices.Add(new Dictionary<string, object>
            {
                ["name"] = name,
                ["displayName"] = displayName
            });
        }
    }
}
