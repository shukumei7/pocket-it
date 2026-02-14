using System.Diagnostics;

namespace PocketIT.Diagnostics.Checks;

public class MemoryCheck : IDiagnosticCheck
{
    public string CheckType => "memory";

    public async Task<DiagnosticResult> RunAsync()
    {
        long totalMemoryKB = 0;
        long freeMemoryKB = 0;

        try
        {
            var info = new ProcessStartInfo("wmic", "os get TotalVisibleMemorySize,FreePhysicalMemory /value")
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

                var freeMatch = System.Text.RegularExpressions.Regex.Match(output, @"FreePhysicalMemory=(\d+)");
                var totalMatch = System.Text.RegularExpressions.Regex.Match(output, @"TotalVisibleMemorySize=(\d+)");

                if (freeMatch.Success) freeMemoryKB = long.Parse(freeMatch.Groups[1].Value);
                if (totalMatch.Success) totalMemoryKB = long.Parse(totalMatch.Groups[1].Value);
            }
        }
        catch
        {
            // Fallback
        }

        double totalGB = totalMemoryKB / 1024.0 / 1024.0;
        double freeGB = freeMemoryKB / 1024.0 / 1024.0;
        double usedGB = totalGB - freeGB;
        double usagePercent = totalMemoryKB > 0 ? (1 - (double)freeMemoryKB / totalMemoryKB) * 100 : 0;

        string status = usagePercent switch
        {
            < 70 => "ok",
            < 90 => "warning",
            _ => "error"
        };

        return new DiagnosticResult
        {
            CheckType = "memory",
            Status = status,
            Label = "Memory",
            Value = $"{usedGB:F1} / {totalGB:F1} GB ({usagePercent:F0}%)",
            Details = new Dictionary<string, object>
            {
                ["totalGB"] = Math.Round(totalGB, 1),
                ["usedGB"] = Math.Round(usedGB, 1),
                ["freeGB"] = Math.Round(freeGB, 1),
                ["usagePercent"] = Math.Round(usagePercent, 0)
            }
        };
    }
}
