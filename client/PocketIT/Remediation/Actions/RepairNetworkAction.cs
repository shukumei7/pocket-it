using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class RepairNetworkAction : IRemediationAction
{
    public string ActionId => "repair_network";

    public async Task<RemediationResult> ExecuteAsync()
    {
        var results = new List<string>();
        var systemDir = Environment.GetFolderPath(Environment.SpecialFolder.System);

        // Reset Winsock
        var winsockResult = await RunCommand(Path.Combine(systemDir, "netsh.exe"), "winsock reset");
        results.Add($"Winsock reset: {(winsockResult.success ? "OK" : winsockResult.error)}");

        // Reset TCP/IP
        var tcpResult = await RunCommand(Path.Combine(systemDir, "netsh.exe"), "int ip reset");
        results.Add($"TCP/IP reset: {(tcpResult.success ? "OK" : tcpResult.error)}");

        // Flush DNS
        var dnsResult = await RunCommand(Path.Combine(systemDir, "ipconfig.exe"), "/flushdns");
        results.Add($"DNS flush: {(dnsResult.success ? "OK" : dnsResult.error)}");

        // Release and renew IP
        var releaseResult = await RunCommand(Path.Combine(systemDir, "ipconfig.exe"), "/release");
        results.Add($"IP release: {(releaseResult.success ? "OK" : releaseResult.error)}");

        var renewResult = await RunCommand(Path.Combine(systemDir, "ipconfig.exe"), "/renew");
        results.Add($"IP renew: {(renewResult.success ? "OK" : renewResult.error)}");

        bool allSuccess = winsockResult.success && tcpResult.success && dnsResult.success;
        return new RemediationResult
        {
            ActionId = ActionId,
            Success = allSuccess,
            Message = string.Join("\n", results) + (allSuccess ? "\n\nNetwork stack repaired. A restart may be required for full effect." : "")
        };
    }

    private async Task<(bool success, string error)> RunCommand(string fileName, string args)
    {
        try
        {
            var info = new ProcessStartInfo(fileName, args)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var process = Process.Start(info);
            if (process == null) return (false, "Failed to start process");

            var error = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            return (process.ExitCode == 0, error.Trim());
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }
}
