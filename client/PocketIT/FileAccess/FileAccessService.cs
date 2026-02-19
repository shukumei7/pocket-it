using PocketIT.Core;

namespace PocketIT.FileAccess;

public class FileEntry
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "file"; // "file", "dir", or "drive"
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

    public List<FileEntry> ListDrives()
    {
        var entries = new List<FileEntry>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            if (!drive.IsReady) continue;
            entries.Add(new FileEntry
            {
                Name = drive.Name, // "C:\"
                Type = "drive",
                SizeBytes = drive.TotalSize,
                LastModified = ""
            });
        }
        return entries;
    }

    public List<FileEntry> Browse(string path, bool unrestricted = false)
    {
        // Empty path = list drives
        if (string.IsNullOrWhiteSpace(path))
            return ListDrives();

        var fullPath = Path.GetFullPath(path);

        if (!unrestricted)
        {
            // AI-initiated: strict allowed-roots + blocked-paths check
            if (!IsAllowed(fullPath))
                throw new UnauthorizedAccessException($"Access denied: path '{path}' is outside allowed directories");
        }

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

    public FileReadResult ReadFile(string path, bool unrestricted = false)
    {
        var fullPath = Path.GetFullPath(path);
        if (!unrestricted && !IsAllowed(fullPath))
            return new FileReadResult { Success = false, Error = $"Access denied: path '{path}' is outside allowed directories" };

        if (!File.Exists(fullPath))
            return new FileReadResult { Success = false, Error = $"File not found: {path}" };

        var ext = Path.GetExtension(fullPath);
        if (!unrestricted && BlockedExtensions.Contains(ext))
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

    // ---- IT-initiated file management methods (unrestricted) ----

    private static readonly string[] ProtectedPaths = new[]
    {
        Environment.GetFolderPath(Environment.SpecialFolder.System),
        Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData)
    };

    private bool IsProtectedPath(string fullPath)
    {
        foreach (var p in ProtectedPaths)
        {
            if (!string.IsNullOrEmpty(p) && fullPath.StartsWith(p, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    public List<(string Path, bool Ok, string? Error)> DeleteFiles(string[] paths)
    {
        var results = new List<(string, bool, string?)>();
        foreach (var path in paths)
        {
            var full = Path.GetFullPath(path);
            if (IsProtectedPath(full))
            {
                results.Add((path, false, "Cannot delete: protected system path"));
                continue;
            }
            try
            {
                if (Directory.Exists(full))
                    Directory.Delete(full, recursive: true);
                else if (File.Exists(full))
                    File.Delete(full);
                else
                {
                    results.Add((path, false, "Not found"));
                    continue;
                }
                results.Add((path, true, null));
            }
            catch (Exception ex)
            {
                results.Add((path, false, ex.Message));
            }
        }
        return results;
    }

    public List<(string Path, bool Ok, string? Error)> CopyOrMoveFiles(string[] paths, string destination, bool move)
    {
        var results = new List<(string, bool, string?)>();
        var destFull = Path.GetFullPath(destination);
        if (!Directory.Exists(destFull))
        {
            results.Add((destination, false, "Destination directory not found"));
            return results;
        }
        foreach (var path in paths)
        {
            var srcFull = Path.GetFullPath(path);
            var name = Path.GetFileName(srcFull);
            var target = Path.Combine(destFull, name);
            try
            {
                if (move && IsProtectedPath(srcFull))
                {
                    results.Add((path, false, "Cannot move: protected system path"));
                    continue;
                }
                if (Directory.Exists(srcFull))
                {
                    CopyDirectory(srcFull, target);
                    if (move) Directory.Delete(srcFull, true);
                }
                else if (File.Exists(srcFull))
                {
                    File.Copy(srcFull, target, overwrite: true);
                    if (move) File.Delete(srcFull);
                }
                else
                {
                    results.Add((path, false, "Not found"));
                    continue;
                }
                results.Add((path, true, null));
            }
            catch (Exception ex)
            {
                results.Add((path, false, ex.Message));
            }
        }
        return results;
    }

    private void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source))
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
        foreach (var dir in Directory.GetDirectories(source))
            CopyDirectory(dir, Path.Combine(destination, Path.GetFileName(dir)));
    }

    public Dictionary<string, object> GetFileProperties(string path)
    {
        var full = Path.GetFullPath(path);
        var props = new Dictionary<string, object>();

        if (File.Exists(full))
        {
            var info = new FileInfo(full);
            props["name"] = info.Name;
            props["fullPath"] = info.FullName;
            props["type"] = "file";
            props["size"] = info.Length;
            props["created"] = info.CreationTimeUtc.ToString("o");
            props["modified"] = info.LastWriteTimeUtc.ToString("o");
            props["accessed"] = info.LastAccessTimeUtc.ToString("o");
            props["isReadOnly"] = info.IsReadOnly;
            props["isHidden"] = (info.Attributes & FileAttributes.Hidden) != 0;
            props["isSystem"] = (info.Attributes & FileAttributes.System) != 0;
            props["extension"] = info.Extension;
        }
        else if (Directory.Exists(full))
        {
            var info = new DirectoryInfo(full);
            props["name"] = info.Name;
            props["fullPath"] = info.FullName;
            props["type"] = "directory";
            props["created"] = info.CreationTimeUtc.ToString("o");
            props["modified"] = info.LastWriteTimeUtc.ToString("o");
            props["accessed"] = info.LastAccessTimeUtc.ToString("o");
            props["isHidden"] = (info.Attributes & FileAttributes.Hidden) != 0;
            props["isSystem"] = (info.Attributes & FileAttributes.System) != 0;
            try
            {
                props["fileCount"] = Directory.GetFiles(full).Length;
                props["folderCount"] = Directory.GetDirectories(full).Length;
            }
            catch { }
        }

        return props;
    }

    public (bool Ok, string? Error) WriteUploadedFile(string destinationDir, string filename, byte[] data)
    {
        try
        {
            var destFull = Path.GetFullPath(Path.Combine(destinationDir, filename));
            if (!destFull.StartsWith(Path.GetFullPath(destinationDir), StringComparison.OrdinalIgnoreCase))
                return (false, "Invalid filename: path traversal detected");
            File.WriteAllBytes(destFull, data);
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public (byte[]? Data, string? Error) ReadFileBytes(string path, long maxSize = 52_428_800)
    {
        try
        {
            var full = Path.GetFullPath(path);
            if (!File.Exists(full))
                return (null, "File not found");
            var info = new FileInfo(full);
            if (info.Length > maxSize)
                return (null, $"File too large ({info.Length / (1024 * 1024)}MB). Maximum is {maxSize / (1024 * 1024)}MB.");
            return (File.ReadAllBytes(full), null);
        }
        catch (Exception ex)
        {
            return (null, ex.Message);
        }
    }
}
