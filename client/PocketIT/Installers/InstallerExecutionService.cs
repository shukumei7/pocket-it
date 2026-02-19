using System.Diagnostics;
using System.Text.RegularExpressions;
using PocketIT.Core;

namespace PocketIT.Installers;

public class InstallerResult
{
    public bool Success { get; set; }
    public string Output { get; set; } = "";
    public string ErrorOutput { get; set; } = "";
    public int ExitCode { get; set; }
    public long DurationMs { get; set; }
    public bool TimedOut { get; set; }
    public string? ValidationError { get; set; }
}

public class InstallerExecutionService
{
    private static readonly string ExecDir = Path.Combine(Path.GetTempPath(), "PocketIT-Exec");
    private const int MaxOutputBytes = 524_288; // 512 KB

    /// <summary>
    /// Validates installer parameters. Only allows files from the ExecDir, .exe and .msi extensions.
    /// </summary>
    public (bool IsValid, string? RejectionReason) ValidateInstaller(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
            return (false, "File path is empty");

        // Path traversal prevention: resolve and check prefix
        var fullPath = Path.GetFullPath(filePath);
        var execDirFull = Path.GetFullPath(ExecDir);
        if (!fullPath.StartsWith(execDirFull, StringComparison.OrdinalIgnoreCase))
            return (false, $"File must be in {ExecDir}");

        if (!File.Exists(fullPath))
            return (false, "File does not exist");

        var ext = Path.GetExtension(fullPath).ToLowerInvariant();
        if (ext != ".exe" && ext != ".msi")
            return (false, "Only .exe and .msi files are supported");

        return (true, null);
    }

    /// <summary>
    /// Execute an installer silently. Timeout 30-600s.
    /// </summary>
    public async Task<InstallerResult> ExecuteAsync(string filePath, string? silentArgs = null, int timeoutSeconds = 300)
    {
        timeoutSeconds = Math.Clamp(timeoutSeconds, 30, 600);

        var (isValid, rejectionReason) = ValidateInstaller(filePath);
        if (!isValid)
        {
            return new InstallerResult
            {
                Success = false,
                ValidationError = rejectionReason
            };
        }

        var fullPath = Path.GetFullPath(filePath);
        var ext = Path.GetExtension(fullPath).ToLowerInvariant();

        ProcessStartInfo psi;
        if (ext == ".msi")
        {
            // msiexec /i "path" /qn [args]
            var msiArgs = $"/i \"{fullPath}\" /qn";
            if (!string.IsNullOrWhiteSpace(silentArgs))
                msiArgs += " " + silentArgs;
            psi = new ProcessStartInfo
            {
                FileName = "msiexec.exe",
                Arguments = msiArgs,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
        }
        else
        {
            // .exe with custom args or default /S
            var exeArgs = string.IsNullOrWhiteSpace(silentArgs) ? "/S" : silentArgs;
            psi = new ProcessStartInfo
            {
                FileName = fullPath,
                Arguments = exeArgs,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
        }

        var sw = Stopwatch.StartNew();
        var result = new InstallerResult();

        try
        {
            using var proc = Process.Start(psi);
            if (proc == null)
            {
                return new InstallerResult { Success = false, ErrorOutput = "Failed to start installer process" };
            }

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));

            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();

            try
            {
                await proc.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
                sw.Stop();
                result.TimedOut = true;
                result.Success = false;
                result.Output = await ReadWithTimeout(stdoutTask);
                result.ErrorOutput = $"Installer timed out after {timeoutSeconds} seconds";
                result.DurationMs = sw.ElapsedMilliseconds;
                return TruncateIfNeeded(result);
            }

            sw.Stop();
            result.Output = await stdoutTask;
            result.ErrorOutput = await stderrTask;
            result.ExitCode = proc.ExitCode;
            result.Success = proc.ExitCode == 0;
            result.DurationMs = sw.ElapsedMilliseconds;

            Logger.Info($"Installer executed: exit={proc.ExitCode}, duration={sw.ElapsedMilliseconds}ms");

            return TruncateIfNeeded(result);
        }
        catch (Exception ex)
        {
            sw.Stop();
            Logger.Error("Installer execution failed", ex);
            return new InstallerResult
            {
                Success = false,
                ErrorOutput = $"Execution failed: {ex.Message}",
                DurationMs = sw.ElapsedMilliseconds
            };
        }
    }

    /// <summary>
    /// Ensures the exec directory exists and returns the path.
    /// </summary>
    public static string EnsureExecDir()
    {
        if (!Directory.Exists(ExecDir))
            Directory.CreateDirectory(ExecDir);
        return ExecDir;
    }

    private static InstallerResult TruncateIfNeeded(InstallerResult result)
    {
        if (result.Output.Length > MaxOutputBytes)
        {
            result.Output = result.Output[..MaxOutputBytes] + "\n\n--- OUTPUT TRUNCATED ---";
        }
        if (result.ErrorOutput.Length > MaxOutputBytes)
        {
            result.ErrorOutput = result.ErrorOutput[..MaxOutputBytes] + "\n\n--- ERROR OUTPUT TRUNCATED ---";
        }
        return result;
    }

    private static async Task<string> ReadWithTimeout(Task<string> readTask)
    {
        try
        {
            if (await Task.WhenAny(readTask, Task.Delay(2000)) == readTask)
                return await readTask;
            return "(output unavailable after timeout)";
        }
        catch
        {
            return "(output read failed)";
        }
    }
}
