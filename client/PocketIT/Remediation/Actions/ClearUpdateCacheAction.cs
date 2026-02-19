using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class ClearUpdateCacheAction : IRemediationAction
{
    public string ActionId => "clear_update_cache";
    public bool RequiresElevation => true;

    public async Task<RemediationResult> ExecuteAsync()
    {
        var netPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "net.exe");

        try
        {
            // Stop Windows Update service
            await RunCommand(netPath, "stop wuauserv");
            await RunCommand(netPath, "stop bits");

            // Clear the SoftwareDistribution folder
            var sdPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "SoftwareDistribution", "Download");
            if (Directory.Exists(sdPath))
            {
                foreach (var file in Directory.GetFiles(sdPath, "*", SearchOption.AllDirectories))
                {
                    try { File.Delete(file); } catch { }
                }
                foreach (var dir in Directory.GetDirectories(sdPath))
                {
                    try { Directory.Delete(dir, true); } catch { }
                }
            }

            // Restart services
            await RunCommand(netPath, "start wuauserv");
            await RunCommand(netPath, "start bits");

            return new RemediationResult
            {
                ActionId = ActionId,
                Success = true,
                Message = "Windows Update cache cleared and services restarted. Try checking for updates again."
            };
        }
        catch (Exception ex)
        {
            // Try to restart services even on error
            try
            {
                await RunCommand(netPath, "start wuauserv");
                await RunCommand(netPath, "start bits");
            }
            catch { }

            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Failed to clear update cache: {ex.Message}"
            };
        }
    }

    private static async Task RunCommand(string path, string args)
    {
        var info = new ProcessStartInfo(path, args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        using var process = Process.Start(info);
        if (process != null)
            await process.WaitForExitAsync();
    }
}
