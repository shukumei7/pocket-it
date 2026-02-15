using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class RestartSpoolerAction : IRemediationAction
{
    public string ActionId => "restart_spooler";

    public async Task<RemediationResult> ExecuteAsync()
    {
        try
        {
            // Stop the spooler service
            var stopInfo = new ProcessStartInfo("net", "stop spooler")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var stopProcess = Process.Start(stopInfo);
            if (stopProcess == null)
            {
                return new RemediationResult
                {
                    ActionId = ActionId,
                    Success = false,
                    Message = "Failed to start net stop command."
                };
            }
            await stopProcess.WaitForExitAsync();

            // Start the spooler service
            var startInfo = new ProcessStartInfo("net", "start spooler")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var startProcess = Process.Start(startInfo);
            if (startProcess == null)
            {
                return new RemediationResult
                {
                    ActionId = ActionId,
                    Success = false,
                    Message = "Spooler stopped but failed to restart."
                };
            }
            var output = await startProcess.StandardOutput.ReadToEndAsync();
            var error = await startProcess.StandardError.ReadToEndAsync();
            await startProcess.WaitForExitAsync();

            bool success = startProcess.ExitCode == 0;
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = success,
                Message = success
                    ? "Print spooler service restarted successfully."
                    : $"Spooler restart failed: {error.Trim()}"
            };
        }
        catch (Exception ex)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Error restarting spooler: {ex.Message}"
            };
        }
    }
}
