namespace PocketIT.Remediation.Actions;

public class ClearBrowserCacheAction : IRemediationAction
{
    public string ActionId => "clear_browser_cache";

    public Task<RemediationResult> ExecuteAsync()
    {
        int deletedFiles = 0;
        int failedFiles = 0;
        long freedBytes = 0;

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        // Common browser cache paths
        var cachePaths = new[]
        {
            Path.Combine(localAppData, "Google", "Chrome", "User Data", "Default", "Cache"),
            Path.Combine(localAppData, "Google", "Chrome", "User Data", "Default", "Code Cache"),
            Path.Combine(localAppData, "Microsoft", "Edge", "User Data", "Default", "Cache"),
            Path.Combine(localAppData, "Microsoft", "Edge", "User Data", "Default", "Code Cache"),
            Path.Combine(localAppData, "Mozilla", "Firefox", "Profiles") // handled separately
        };

        foreach (var cachePath in cachePaths)
        {
            if (!Directory.Exists(cachePath)) continue;

            // For Firefox, find profile cache dirs
            if (cachePath.Contains("Firefox"))
            {
                try
                {
                    foreach (var profileDir in Directory.GetDirectories(cachePath))
                    {
                        var ffCache = Path.Combine(profileDir, "cache2");
                        if (Directory.Exists(ffCache))
                        {
                            var (d, f, b) = ClearDirectory(ffCache);
                            deletedFiles += d;
                            failedFiles += f;
                            freedBytes += b;
                        }
                    }
                }
                catch { failedFiles++; }
                continue;
            }

            var (deleted, failed, freed) = ClearDirectory(cachePath);
            deletedFiles += deleted;
            failedFiles += failed;
            freedBytes += freed;
        }

        double freedMB = freedBytes / 1024.0 / 1024.0;
        return Task.FromResult(new RemediationResult
        {
            ActionId = ActionId,
            Success = true,
            Message = $"Cleared {deletedFiles} cache files, freed {freedMB:F1} MB.{(failedFiles > 0 ? $" {failedFiles} files in use (skipped)." : "")} Close browsers for complete cleanup."
        });
    }

    private (int deleted, int failed, long freed) ClearDirectory(string path)
    {
        int deleted = 0, failed = 0;
        long freed = 0;

        try
        {
            var dir = new DirectoryInfo(path);
            foreach (var file in dir.EnumerateFiles("*", SearchOption.AllDirectories))
            {
                try
                {
                    freed += file.Length;
                    file.Delete();
                    deleted++;
                }
                catch { failed++; }
            }
        }
        catch { failed++; }

        return (deleted, failed, freed);
    }
}
