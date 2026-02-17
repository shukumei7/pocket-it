using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Threading.Tasks;
using PocketIT.Core;

namespace PocketIT.SystemTools.Tools;

public class ProcessKillTool : ISystemTool
{
    public string ToolName => "process_kill";

    // Processes that should never be killed
    private static readonly HashSet<string> BlockedProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "System", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
        "services.exe", "lsass.exe", "svchost.exe", "dwm.exe",
        "PocketIT.exe" // Don't kill ourselves
    };

    public Task<SystemToolResult> ExecuteAsync(string? paramsJson)
    {
        try
        {
            if (string.IsNullOrEmpty(paramsJson))
                return Task.FromResult(new SystemToolResult { Success = false, Error = "Missing params: pid required" });

            using var doc = JsonDocument.Parse(paramsJson);
            var root = doc.RootElement;

            if (!root.TryGetProperty("pid", out var pidProp))
                return Task.FromResult(new SystemToolResult { Success = false, Error = "Missing param: pid" });

            var pid = pidProp.GetInt32();
            var process = Process.GetProcessById(pid);

            // Safety check
            if (BlockedProcesses.Contains(process.ProcessName + ".exe") ||
                BlockedProcesses.Contains(process.ProcessName))
            {
                return Task.FromResult(new SystemToolResult
                {
                    Success = false,
                    Error = $"Cannot kill protected process: {process.ProcessName} (PID {pid})"
                });
            }

            var processName = process.ProcessName;
            process.Kill(entireProcessTree: true);
            Logger.Info($"Process killed: {processName} (PID {pid})");

            return Task.FromResult(new SystemToolResult
            {
                Success = true,
                Data = new { pid, name = processName, message = $"Process {processName} (PID {pid}) terminated" }
            });
        }
        catch (ArgumentException)
        {
            return Task.FromResult(new SystemToolResult { Success = false, Error = "Process not found" });
        }
        catch (Exception ex)
        {
            return Task.FromResult(new SystemToolResult { Success = false, Error = ex.Message });
        }
    }
}
