namespace PocketIT.Diagnostics.Checks;

public class DiskCheck : IDiagnosticCheck
{
    public string CheckType => "disk";

    public Task<DiagnosticResult> RunAsync()
    {
        var drives = DriveInfo.GetDrives()
            .Where(d => d.IsReady && d.DriveType == DriveType.Fixed)
            .ToList();

        var driveDetails = new List<Dictionary<string, object>>();
        string worstStatus = "ok";

        foreach (var drive in drives)
        {
            double totalGB = drive.TotalSize / 1024.0 / 1024.0 / 1024.0;
            double freeGB = drive.AvailableFreeSpace / 1024.0 / 1024.0 / 1024.0;
            double usagePercent = (1 - drive.AvailableFreeSpace / (double)drive.TotalSize) * 100;

            string driveStatus = usagePercent switch
            {
                < 80 => "ok",
                < 95 => "warning",
                _ => "error"
            };

            if (driveStatus == "error" || (driveStatus == "warning" && worstStatus == "ok"))
                worstStatus = driveStatus;

            driveDetails.Add(new Dictionary<string, object>
            {
                ["drive"] = drive.Name,
                ["totalGB"] = Math.Round(totalGB, 1),
                ["freeGB"] = Math.Round(freeGB, 1),
                ["usagePercent"] = Math.Round(usagePercent, 0),
                ["status"] = driveStatus
            });
        }

        var primaryDrive = drives.FirstOrDefault();
        double primaryFreeGB = primaryDrive != null ? primaryDrive.AvailableFreeSpace / 1024.0 / 1024.0 / 1024.0 : 0;

        return Task.FromResult(new DiagnosticResult
        {
            CheckType = "disk",
            Status = worstStatus,
            Label = "Disk Space",
            Value = primaryDrive != null ? $"{primaryFreeGB:F1} GB free on {primaryDrive.Name}" : "No drives found",
            Details = new Dictionary<string, object>
            {
                ["drives"] = driveDetails
            }
        });
    }
}
