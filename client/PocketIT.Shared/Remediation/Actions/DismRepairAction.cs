using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class DismRepairAction : IRemediationAction
{
    public string ActionId => "dism_repair";
    public bool RequiresElevation => true;

    public async Task<RemediationResult> ExecuteAsync()
    {
        var dismPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "DISM.exe");
        var info = new ProcessStartInfo(dismPath, "/Online /Cleanup-Image /RestoreHealth")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(info);
        if (process == null)
            return new RemediationResult { ActionId = ActionId, Success = false, Message = "Failed to start DISM process." };

        var output = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();

        bool success = process.ExitCode == 0;
        string summary;
        if (output.Contains("The restore operation completed successfully"))
            summary = "DISM repair completed successfully. Windows image is healthy.";
        else if (output.Contains("no component store corruption detected"))
            summary = "DISM found no component store corruption. System image is healthy.";
        else
            summary = success ? "DISM repair completed." : $"DISM repair failed with exit code {process.ExitCode}. A restart and retry may help.";

        return new RemediationResult
        {
            ActionId = ActionId,
            Success = success,
            Message = summary
        };
    }
}
