namespace PocketIT.Remediation.Actions;

public class ClearTempFilesAction : IRemediationAction
{
    public string ActionId => "clear_temp";

    public Task<RemediationResult> ExecuteAsync()
    {
        var tempPath = Path.GetTempPath();
        int deletedFiles = 0;
        int failedFiles = 0;
        long freedBytes = 0;

        try
        {
            var tempDir = new DirectoryInfo(tempPath);
            foreach (var file in tempDir.GetFiles())
            {
                try
                {
                    freedBytes += file.Length;
                    file.Delete();
                    deletedFiles++;
                }
                catch
                {
                    failedFiles++;
                }
            }

            // Also clean subdirectories older than 1 day
            foreach (var dir in tempDir.GetDirectories())
            {
                try
                {
                    if (dir.LastWriteTime < DateTime.Now.AddDays(-1))
                    {
                        dir.Delete(true);
                        deletedFiles++;
                    }
                }
                catch
                {
                    failedFiles++;
                }
            }
        }
        catch (Exception ex)
        {
            return Task.FromResult(new RemediationResult
            {
                ActionId = ActionId,
                Success = false,
                Message = $"Error accessing temp folder: {ex.Message}"
            });
        }

        double freedMB = freedBytes / 1024.0 / 1024.0;
        return Task.FromResult(new RemediationResult
        {
            ActionId = ActionId,
            Success = true,
            Message = $"Cleared {deletedFiles} items, freed {freedMB:F1} MB.{(failedFiles > 0 ? $" {failedFiles} items in use (skipped)." : "")}"
        });
    }
}
