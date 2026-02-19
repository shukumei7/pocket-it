using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class ResetNetworkAdapterAction : IRemediationAction
{
    public string ActionId => "reset_network_adapter";

    public async Task<RemediationResult> ExecuteAsync()
    {
        try
        {
            // Use netsh to find the primary connected adapter and reset it
            var netshPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "netsh.exe");

            // Get interface names
            var info = new ProcessStartInfo(netshPath, "interface show interface")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var listProcess = Process.Start(info);
            if (listProcess == null)
                return new RemediationResult { ActionId = ActionId, Success = false, Message = "Failed to list network adapters." };

            var output = await listProcess.StandardOutput.ReadToEndAsync();
            await listProcess.WaitForExitAsync();

            // Find the first Connected adapter
            string? adapterName = null;
            foreach (var line in output.Split('\n'))
            {
                if (line.Contains("Connected") && !line.Contains("Disconnected"))
                {
                    // Format: "Enabled  Connected  Dedicated  Wi-Fi" or similar
                    var parts = line.Trim().Split(new[] { "  " }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 4)
                    {
                        adapterName = parts[^1].Trim();
                        break;
                    }
                }
            }

            if (adapterName == null)
                return new RemediationResult { ActionId = ActionId, Success = false, Message = "No connected network adapter found to reset." };

            // Disable adapter
            var disableInfo = new ProcessStartInfo(netshPath, $"interface set interface \"{adapterName}\" disable")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var disableProcess = Process.Start(disableInfo);
            if (disableProcess != null) await disableProcess.WaitForExitAsync();

            await Task.Delay(2000);

            // Re-enable adapter
            var enableInfo = new ProcessStartInfo(netshPath, $"interface set interface \"{adapterName}\" enable")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var enableProcess = Process.Start(enableInfo);
            if (enableProcess != null) await enableProcess.WaitForExitAsync();

            await Task.Delay(3000); // Give adapter time to reconnect

            return new RemediationResult
            {
                ActionId = ActionId,
                Success = true,
                Message = $"Network adapter '{adapterName}' has been reset. Connection should restore in a few seconds."
            };
        }
        catch (Exception ex)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Failed to reset network adapter: {ex.Message}"
            };
        }
    }
}
