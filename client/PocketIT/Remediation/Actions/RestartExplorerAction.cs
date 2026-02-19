using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class RestartExplorerAction : IRemediationAction
{
    public string ActionId => "restart_explorer";

    public async Task<RemediationResult> ExecuteAsync()
    {
        try
        {
            // Kill explorer.exe
            foreach (var proc in Process.GetProcessesByName("explorer"))
            {
                proc.Kill();
                await proc.WaitForExitAsync();
            }

            // Wait briefly for clean shutdown
            await Task.Delay(1000);

            // Restart explorer
            var explorerPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            Process.Start(explorerPath);

            return new RemediationResult
            {
                ActionId = ActionId,
                Success = true,
                Message = "Windows Explorer restarted successfully. Taskbar and start menu should be responsive."
            };
        }
        catch (Exception ex)
        {
            return new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Failed to restart Explorer: {ex.Message}"
            };
        }
    }
}
