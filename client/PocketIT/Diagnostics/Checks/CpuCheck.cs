using System.Diagnostics;

namespace PocketIT.Diagnostics.Checks;

public class CpuCheck : IDiagnosticCheck
{
    public string CheckType => "cpu";

    public async Task<DiagnosticResult> RunAsync()
    {
        // Use a process to get CPU info since PerformanceCounter needs admin on some systems
        var wmicPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wbem", "wmic.exe");
        var info = new ProcessStartInfo(wmicPath, "cpu get loadpercentage /value")
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        float cpuUsage = 0;
        try
        {
            using var process = Process.Start(info);
            if (process != null)
            {
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                // Parse "LoadPercentage=XX"
                var match = System.Text.RegularExpressions.Regex.Match(output, @"LoadPercentage=(\d+)");
                if (match.Success)
                {
                    cpuUsage = float.Parse(match.Groups[1].Value);
                }
            }
        }
        catch
        {
            // Fallback: use Process.GetCurrentProcess
            cpuUsage = -1;
        }

        string status = cpuUsage switch
        {
            < 0 => "error",
            < 70 => "ok",
            < 90 => "warning",
            _ => "error"
        };

        return new DiagnosticResult
        {
            CheckType = "cpu",
            Status = status,
            Label = "CPU Usage",
            Value = cpuUsage >= 0 ? $"{cpuUsage:F0}%" : "Unable to read",
            Details = new Dictionary<string, object>
            {
                ["usagePercent"] = cpuUsage,
                ["processorCount"] = Environment.ProcessorCount
            }
        };
    }
}
