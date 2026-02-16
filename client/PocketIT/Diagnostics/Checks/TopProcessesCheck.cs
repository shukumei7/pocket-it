using System.Diagnostics;
using PocketIT.Core;

namespace PocketIT.Diagnostics.Checks;

public class TopProcessesCheck : IDiagnosticCheck
{
    public string CheckType => "top_processes";

    public async Task<DiagnosticResult> RunAsync()
    {
        try
        {
            var processList = new List<Dictionary<string, object>>();
            int processorCount = Environment.ProcessorCount;

            // Snapshot 1: capture TotalProcessorTime for each process
            var snapshot1 = new Dictionary<int, (string Name, TimeSpan Cpu, long MemoryBytes)>();
            foreach (var proc in Process.GetProcesses())
            {
                try
                {
                    snapshot1[proc.Id] = (proc.ProcessName, proc.TotalProcessorTime, proc.WorkingSet64);
                }
                catch
                {
                    // Access denied for system processes — expected
                }
            }

            var stopwatch = Stopwatch.StartNew();
            await Task.Delay(1000);
            stopwatch.Stop();
            double elapsedSeconds = stopwatch.Elapsed.TotalSeconds;

            // Snapshot 2: capture TotalProcessorTime again
            var snapshot2 = new Dictionary<int, (string Name, TimeSpan Cpu, long MemoryBytes)>();
            foreach (var proc in Process.GetProcesses())
            {
                try
                {
                    snapshot2[proc.Id] = (proc.ProcessName, proc.TotalProcessorTime, proc.WorkingSet64);
                }
                catch
                {
                    // Access denied for system processes — expected
                }
            }

            // Compute CPU% from delta
            var processData = new List<(string Name, int Pid, double CpuPercent, double MemoryMB)>();
            foreach (var kvp in snapshot2)
            {
                if (snapshot1.TryGetValue(kvp.Key, out var s1))
                {
                    double cpuDelta = (kvp.Value.Cpu - s1.Cpu).TotalSeconds;
                    double cpuPercent = (cpuDelta / elapsedSeconds / processorCount) * 100.0;
                    double memoryMB = kvp.Value.MemoryBytes / 1024.0 / 1024.0;
                    processData.Add((kvp.Value.Name, kvp.Key, cpuPercent, memoryMB));
                }
            }

            // Sort by memory desc, take top 15
            var top = processData
                .OrderByDescending(p => p.MemoryMB)
                .Take(15)
                .ToList();

            string worstStatus = "ok";
            string highestName = "";
            double highestMemMB = 0;

            foreach (var p in top)
            {
                if (p.CpuPercent > 50 || p.MemoryMB > 2048)
                    worstStatus = "warning";

                if (p.MemoryMB > highestMemMB)
                {
                    highestMemMB = p.MemoryMB;
                    highestName = p.Name;
                }

                processList.Add(new Dictionary<string, object>
                {
                    ["name"] = p.Name,
                    ["pid"] = p.Pid,
                    ["cpuPercent"] = Math.Round(p.CpuPercent, 1),
                    ["memoryMB"] = Math.Round(p.MemoryMB, 1)
                });
            }

            string memLabel = highestMemMB >= 1024
                ? $"{highestMemMB / 1024.0:F1} GB"
                : $"{highestMemMB:F0} MB";

            return new DiagnosticResult
            {
                CheckType = "top_processes",
                Status = worstStatus,
                Label = "Top Processes",
                Value = $"{top.Count} processes, highest: {highestName} ({memLabel})",
                Details = new Dictionary<string, object>
                {
                    ["processes"] = processList
                }
            };
        }
        catch (Exception ex)
        {
            Logger.Warn($"Top processes check failed: {ex.Message}");
            return new DiagnosticResult
            {
                CheckType = "top_processes",
                Status = "error",
                Label = "Top Processes",
                Value = "Unable to read processes",
                Details = new Dictionary<string, object>
                {
                    ["error"] = ex.Message
                }
            };
        }
    }
}
