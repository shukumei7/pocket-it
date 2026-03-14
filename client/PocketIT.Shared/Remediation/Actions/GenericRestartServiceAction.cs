using System.Diagnostics;
using PocketIT.Core;

namespace PocketIT.Remediation.Actions;

public class GenericRestartServiceAction : IRemediationAction
{
    public string ActionId => "restart_service";
    public bool RequiresElevation => true;
    public bool RequiresParameter => true;
    public string ParameterLabel => "Service name";

    // Only these services may be restarted
    private static readonly HashSet<string> AllowedServices = new(StringComparer.OrdinalIgnoreCase)
    {
        "spooler", "wuauserv", "bits", "dnscache", "w32time",
        "winmgmt", "themes", "audiosrv", "wsearch"
    };

    public Task<RemediationResult> ExecuteAsync()
    {
        return Task.FromResult(new RemediationResult
        {
            ActionId = ActionId,
            Success = false,
            Message = "restart_service requires a service name parameter."
        });
    }

    public async Task<RemediationResult> ExecuteAsync(string parameter)
    {
        var serviceName = parameter.Trim().ToLowerInvariant();

        if (!AllowedServices.Contains(serviceName))
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Service '{parameter}' is not in the restart whitelist. Allowed: {string.Join(", ", AllowedServices)}"
            };
        }

        try
        {
            // Stop the service
            var (stopSuccess, stopError) = await RunNetCommand($"stop {serviceName}");
            if (!stopSuccess)
            {
                Logger.Warn($"RestartService: stop '{serviceName}' returned: {stopError}");
                // Continue anyway — service might already be stopped
            }

            // Brief pause to allow clean shutdown
            await Task.Delay(1000);

            // Start the service
            var (startSuccess, startError) = await RunNetCommand($"start {serviceName}");

            if (startSuccess)
            {
                Logger.Info($"Service '{serviceName}' restarted successfully");
                return new RemediationResult
                {
                    ActionId = ActionId,
                    Success = true,
                    Message = $"Service '{serviceName}' restarted successfully."
                };
            }
            else
            {
                return new RemediationResult
                {
                    ActionId = ActionId,
                    Success = false,
                    Message = $"Service '{serviceName}' stop succeeded but start failed: {startError}"
                };
            }
        }
        catch (Exception ex)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Failed to restart service '{serviceName}': {ex.Message}"
            };
        }
    }

    private static async Task<(bool success, string error)> RunNetCommand(string args)
    {
        var info = new ProcessStartInfo("net", args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(info);
        if (process == null) return (false, "Failed to start net command");

        var error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return (process.ExitCode == 0, error.Trim());
    }
}
