using System.Diagnostics;
using PocketIT.Core;

namespace PocketIT.Remediation.Actions;

public class KillProcessAction : IRemediationAction
{
    public string ActionId => "kill_process";
    public bool RequiresParameter => true;
    public string ParameterLabel => "Process ID (PID)";

    // Protected system processes that must never be killed
    private static readonly HashSet<string> BlockedProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "csrss", "lsass", "winlogon", "smss", "services", "svchost",
        "wininit", "System", "Registry", "dwm", "fontdrvhost"
    };

    public Task<RemediationResult> ExecuteAsync()
    {
        return Task.FromResult(new RemediationResult
        {
            ActionId = ActionId,
            Success = false,
            Message = "kill_process requires a PID parameter."
        });
    }

    public async Task<RemediationResult> ExecuteAsync(string parameter)
    {
        if (!int.TryParse(parameter.Trim(), out int pid))
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Invalid PID: '{parameter}'. Must be a number."
            };
        }

        // Block PID 0 (System Idle) and PID 4 (System)
        if (pid == 0 || pid == 4)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = "Cannot kill system process (PID 0 or 4)."
            };
        }

        try
        {
            var process = Process.GetProcessById(pid);

            // Check against blocklist
            if (BlockedProcesses.Contains(process.ProcessName))
            {
                return new RemediationResult
                {
                    ActionId = ActionId,
                    Success = false,
                    Message = $"Cannot kill protected system process '{process.ProcessName}' (PID {pid})."
                };
            }

            // Block Session 0 processes (system services)
            try
            {
                if (process.SessionId == 0)
                {
                    return new RemediationResult
                    {
                        ActionId = ActionId,
                        Success = false,
                        Message = $"Cannot kill Session 0 process '{process.ProcessName}' (PID {pid}). This is a system service."
                    };
                }
            }
            catch
            {
                // If we can't read SessionId, proceed cautiously
                Logger.Warn($"KillProcess: could not read SessionId for PID {pid}");
            }

            string processName = process.ProcessName;
            process.Kill();
            await process.WaitForExitAsync();

            Logger.Info($"Killed process '{processName}' (PID {pid})");
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = true,
                Message = $"Process '{processName}' (PID {pid}) terminated successfully."
            };
        }
        catch (ArgumentException)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Process with PID {pid} not found. It may have already exited."
            };
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Access denied: cannot kill process PID {pid}. {ex.Message}. Try running Pocket IT as administrator."
            };
        }
        catch (Exception ex)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Failed to kill process PID {pid}: {ex.Message}"
            };
        }
    }
}
