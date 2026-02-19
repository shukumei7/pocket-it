using System.Diagnostics;

namespace PocketIT.Remediation.Actions;

public class SfcScanAction : IRemediationAction
{
    public string ActionId => "sfc_scan";
    public bool RequiresElevation => true;

    public async Task<RemediationResult> ExecuteAsync()
    {
        var sfcPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "sfc.exe");
        var info = new ProcessStartInfo(sfcPath, "/scannow")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(info);
        if (process == null)
            return new RemediationResult { ActionId = ActionId, Success = false, Message = "Failed to start SFC process." };

        var output = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();

        bool success = process.ExitCode == 0;
        string summary;
        if (output.Contains("did not find any integrity violations"))
            summary = "System File Checker found no integrity violations. System files are healthy.";
        else if (output.Contains("successfully repaired"))
            summary = "System File Checker found and repaired corrupted files.";
        else if (output.Contains("found corrupt files but was unable to fix"))
            summary = "System File Checker found corrupted files but could not repair them. DISM repair may be needed.";
        else
            summary = success ? "System File Checker completed." : $"SFC completed with exit code {process.ExitCode}.";

        return new RemediationResult
        {
            ActionId = ActionId,
            Success = success,
            Message = summary
        };
    }
}
