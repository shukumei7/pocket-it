using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class FlushDnsAction : IRemediationAction
{
    public string ActionId => "flush_dns";

    public async Task<RemediationResult> ExecuteAsync()
    {
        var ipconfigPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "ipconfig.exe");
        var info = new ProcessStartInfo(ipconfigPath, "/flushdns")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(info);
        if (process == null)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = "Failed to start ipconfig process."
            };
        }

        var output = await process.StandardOutput.ReadToEndAsync();
        var error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();

        bool success = process.ExitCode == 0;
        return new RemediationResult
        {
            ActionId = ActionId,
            Success = success,
            Message = success
                ? "DNS cache flushed successfully."
                : $"DNS flush failed: {error.Trim()}"
        };
    }
}
