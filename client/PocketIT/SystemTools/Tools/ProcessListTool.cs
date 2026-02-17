using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Management;
using System.Threading.Tasks;
using PocketIT.Core;

namespace PocketIT.SystemTools.Tools;

public class ProcessListTool : ISystemTool
{
    public string ToolName => "process_list";

    public Task<SystemToolResult> ExecuteAsync(string? paramsJson)
    {
        try
        {
            var processes = new List<object>();

            // Use WMI to get process info including owner
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, Name, WorkingSetSize, UserModeTime, KernelModeTime FROM Win32_Process");

            var wmiProcesses = searcher.Get();
            var totalCpuTime = TimeSpan.Zero;
            var processInfos = new List<(uint Pid, string Name, long MemoryBytes, TimeSpan CpuTime, string User)>();

            foreach (ManagementObject obj in wmiProcesses)
            {
                var pid = (uint)obj["ProcessId"];
                var name = obj["Name"]?.ToString() ?? "Unknown";
                var memoryBytes = Convert.ToInt64(obj["WorkingSetSize"] ?? 0);
                var userTime = Convert.ToInt64(obj["UserModeTime"] ?? 0);
                var kernelTime = Convert.ToInt64(obj["KernelModeTime"] ?? 0);
                var cpuTime = TimeSpan.FromTicks(userTime + kernelTime);
                totalCpuTime += cpuTime;

                // Get owner
                string user = "";
                try
                {
                    var ownerParams = obj.InvokeMethod("GetOwner", null, null);
                    var domain = ownerParams?["Domain"]?.ToString() ?? "";
                    var userName = ownerParams?["User"]?.ToString() ?? "";
                    user = !string.IsNullOrEmpty(userName) ? $"{domain}\\{userName}" : "";
                }
                catch { }

                processInfos.Add((pid, name, memoryBytes, cpuTime, user));
            }

            // Calculate relative CPU% (approximate)
            foreach (var p in processInfos)
            {
                var cpuPercent = totalCpuTime.TotalMilliseconds > 0
                    ? Math.Round(p.CpuTime.TotalMilliseconds / totalCpuTime.TotalMilliseconds * 100 * Environment.ProcessorCount, 1)
                    : 0;

                processes.Add(new
                {
                    pid = p.Pid,
                    name = p.Name,
                    cpuPercent = cpuPercent,
                    memoryMB = Math.Round(p.MemoryBytes / 1024.0 / 1024.0, 1),
                    user = p.User
                });
            }

            // Sort by memory descending
            var sorted = processes.OrderByDescending(p =>
                ((dynamic)p).memoryMB).ToList();

            return Task.FromResult(new SystemToolResult
            {
                Success = true,
                Data = new { processes = sorted, count = sorted.Count }
            });
        }
        catch (Exception ex)
        {
            return Task.FromResult(new SystemToolResult
            {
                Success = false,
                Error = ex.Message
            });
        }
    }
}
