using PocketIT.Core;

namespace PocketIT.FileAccess;

public class FileEntry
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "file"; // "file" or "dir"
    public long SizeBytes { get; set; }
    public string LastModified { get; set; } = "";
}

public class FileReadResult
{
    public bool Success { get; set; }
    public string Content { get; set; } = "";
    public string Encoding { get; set; } = "utf-8";
    public long SizeBytes { get; set; }
    public string? Error { get; set; }
}

public class FileAccessService
{
    private static readonly string[] AllowedRoots = GetAllowedRoots();

    private static readonly string[] BlockedPaths = new[]
    {
        Environment.GetFolderPath(Environment.SpecialFolder.System),
        Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
    };

    private static readonly HashSet<string> BlockedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".dll", ".sys", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".scr", ".com"
    };

    private const int MaxBrowseItems = 200;
    private const int MaxReadSizeBytes = 1_048_576; // 1 MB

    private static string[] GetAllowedRoots()
    {
        var roots = new List<string>
        {
            Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar)
        };
        return roots.Where(r => !string.IsNullOrEmpty(r)).ToArray();
    }

    public bool IsAllowed(string path)
    {
        try
        {
            var fullPath = Path.GetFullPath(path);

            // Check against blocked paths
            foreach (var blocked in BlockedPaths)
            {
                if (!string.IsNullOrEmpty(blocked) && fullPath.StartsWith(blocked, StringComparison.OrdinalIgnoreCase))
                    return false;
            }

            // Check against allowed roots
            foreach (var root in AllowedRoots)
            {
                if (fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    return true;
            }

            return false;
        }
        catch
        {
            return false;
        }
    }

    public List<FileEntry> Browse(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (!IsAllowed(fullPath))
            throw new UnauthorizedAccessException($"Access denied: path '{path}' is outside allowed directories");

        if (!Directory.Exists(fullPath))
            throw new DirectoryNotFoundException($"Directory not found: {path}");

        var entries = new List<FileEntry>();

        // Directories first
        try
        {
            foreach (var dir in Directory.GetDirectories(fullPath))
            {
                if (entries.Count >= MaxBrowseItems) break;
                var info = new DirectoryInfo(dir);
                if ((info.Attributes & FileAttributes.Hidden) != 0) continue;
                entries.Add(new FileEntry
                {
                    Name = info.Name,
                    Type = "dir",
                    SizeBytes = 0,
                    LastModified = info.LastWriteTimeUtc.ToString("o")
                });
            }
        }
        catch (UnauthorizedAccessException) { }

        // Then files
        try
        {
            foreach (var file in Directory.GetFiles(fullPath))
            {
                if (entries.Count >= MaxBrowseItems) break;
                var info = new FileInfo(file);
                if ((info.Attributes & FileAttributes.Hidden) != 0) continue;
                entries.Add(new FileEntry
                {
                    Name = info.Name,
                    Type = "file",
                    SizeBytes = info.Length,
                    LastModified = info.LastWriteTimeUtc.ToString("o")
                });
            }
        }
        catch (UnauthorizedAccessException) { }

        return entries;
    }

    public FileReadResult ReadFile(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (!IsAllowed(fullPath))
            return new FileReadResult { Success = false, Error = $"Access denied: path '{path}' is outside allowed directories" };

        if (!File.Exists(fullPath))
            return new FileReadResult { Success = false, Error = $"File not found: {path}" };

        var ext = Path.GetExtension(fullPath);
        if (BlockedExtensions.Contains(ext))
            return new FileReadResult { Success = false, Error = $"File type '{ext}' is not allowed for reading" };

        var fileInfo = new FileInfo(fullPath);
        if (fileInfo.Length > MaxReadSizeBytes)
            return new FileReadResult { Success = false, Error = $"File too large ({fileInfo.Length / 1024}KB). Maximum is {MaxReadSizeBytes / 1024}KB." };

        try
        {
            // Check for binary content (null bytes in first 8KB)
            var sample = new byte[Math.Min(8192, (int)fileInfo.Length)];
            using (var fs = File.OpenRead(fullPath))
            {
                fs.Read(sample, 0, sample.Length);
            }
            if (sample.Any(b => b == 0))
                return new FileReadResult { Success = false, Error = "File appears to be binary and cannot be displayed as text" };

            var content = File.ReadAllText(fullPath);
            return new FileReadResult
            {
                Success = true,
                Content = content,
                Encoding = "utf-8",
                SizeBytes = fileInfo.Length
            };
        }
        catch (Exception ex)
        {
            Logger.Error($"File read failed: {fullPath}", ex);
            return new FileReadResult { Success = false, Error = $"Read failed: {ex.Message}" };
        }
    }

    public string GetDefaultBrowsePath()
    {
        return Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
    }
}
