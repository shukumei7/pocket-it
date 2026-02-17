using System.Diagnostics;
using System.Text.RegularExpressions;
using PocketIT.Core;

namespace PocketIT.Scripts;

public class ScriptResult
{
    public bool Success { get; set; }
    public string Output { get; set; } = "";
    public string ErrorOutput { get; set; } = "";
    public int ExitCode { get; set; }
    public long DurationMs { get; set; }
    public bool Truncated { get; set; }
    public bool TimedOut { get; set; }
    public string? ValidationError { get; set; }
}

public class ScriptExecutionService
{
    private const int MaxOutputBytes = 524_288; // 512 KB

    private static readonly Regex[] DangerousPatterns = new[]
    {
        new Regex(@"Remove-Item\s+.*-Recurse\s+.*[A-Z]:\\$", RegexOptions.IgnoreCase),
        new Regex(@"Format-Volume", RegexOptions.IgnoreCase),
        new Regex(@"Clear-Disk", RegexOptions.IgnoreCase),
        new Regex(@"Stop-Computer", RegexOptions.IgnoreCase),
        new Regex(@"Restart-Computer", RegexOptions.IgnoreCase),
        new Regex(@"rd\s+/s\s+/q\s+[A-Z]:\\$", RegexOptions.IgnoreCase),
        new Regex(@"del\s+/[fqs]\s+.*[A-Z]:\\", RegexOptions.IgnoreCase),
        new Regex(@"format\s+[A-Z]:", RegexOptions.IgnoreCase),
        new Regex(@"Initialize-Disk", RegexOptions.IgnoreCase),
        new Regex(@"Remove-Partition", RegexOptions.IgnoreCase),
        new Regex(@"Set-ExecutionPolicy\s+Unrestricted", RegexOptions.IgnoreCase),
        new Regex(@"Invoke-Expression.*\bhttp", RegexOptions.IgnoreCase),
        new Regex(@"iex\s*\(.*downloadstring", RegexOptions.IgnoreCase),
        new Regex(@"New-Service", RegexOptions.IgnoreCase),
        new Regex(@"sc\s+delete", RegexOptions.IgnoreCase),
        // v0.9.1: Encoded command bypass
        new Regex(@"-e(nc(odedcommand)?)?[\s]+", RegexOptions.IgnoreCase),
        // Download cradles
        new Regex(@"Invoke-WebRequest|wget|curl", RegexOptions.IgnoreCase),
        new Regex(@"Start-BitsTransfer", RegexOptions.IgnoreCase),
        new Regex(@"Net\.WebClient", RegexOptions.IgnoreCase),
        new Regex(@"FromBase64String", RegexOptions.IgnoreCase),
        // Defender tampering
        new Regex(@"Add-MpPreference.*ExclusionPath", RegexOptions.IgnoreCase),
        new Regex(@"Set-MpPreference.*DisableRealtimeMonitoring", RegexOptions.IgnoreCase),
        // Persistence mechanisms
        new Regex(@"reg\s+add.*\\Run\b", RegexOptions.IgnoreCase),
        new Regex(@"schtasks\s+/create", RegexOptions.IgnoreCase),
        new Regex(@"New-ItemProperty.*\\Run\b", RegexOptions.IgnoreCase),
        // Dangerous system changes
        new Regex(@"Disable-WindowsOptionalFeature", RegexOptions.IgnoreCase),
        new Regex(@"\bnet\s+user\s+.*\s+/add", RegexOptions.IgnoreCase),
    };

    public (bool IsValid, string? RejectionReason) ValidateScript(string script)
    {
        if (string.IsNullOrWhiteSpace(script))
            return (false, "Script content is empty");

        if (script.Length > 50_000)
            return (false, "Script exceeds maximum length of 50,000 characters");

        foreach (var pattern in DangerousPatterns)
        {
            if (pattern.IsMatch(script))
                return (false, $"Script contains blocked dangerous command: {pattern}");
        }

        return (true, null);
    }

    public async Task<ScriptResult> ExecuteAsync(string script, int timeoutSeconds = 60, bool requiresElevation = false)
    {
        timeoutSeconds = Math.Clamp(timeoutSeconds, 5, 300);

        var (isValid, rejectionReason) = ValidateScript(script);
        if (!isValid)
        {
            return new ScriptResult
            {
                Success = false,
                ValidationError = rejectionReason
            };
        }

        if (requiresElevation && !IsRunningElevated())
        {
            return new ScriptResult
            {
                Success = false,
                ErrorOutput = "Script requires administrator privileges. Please run Pocket IT as administrator."
            };
        }

        var psPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");

        var psi = new ProcessStartInfo
        {
            FileName = psPath,
            Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& {{ {EscapeScript(script)} }}\"",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        var sw = Stopwatch.StartNew();
        var result = new ScriptResult();

        try
        {
            using var proc = Process.Start(psi);
            if (proc == null)
            {
                return new ScriptResult { Success = false, ErrorOutput = "Failed to start PowerShell process" };
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
                result.ErrorOutput = $"Script timed out after {timeoutSeconds} seconds";
                result.DurationMs = sw.ElapsedMilliseconds;
                return TruncateIfNeeded(result);
            }

            sw.Stop();
            result.Output = await stdoutTask;
            result.ErrorOutput = await stderrTask;
            result.ExitCode = proc.ExitCode;
            result.Success = proc.ExitCode == 0;
            result.DurationMs = sw.ElapsedMilliseconds;

            Logger.Info($"Script executed: exit={proc.ExitCode}, duration={sw.ElapsedMilliseconds}ms, output={result.Output.Length} chars");

            return TruncateIfNeeded(result);
        }
        catch (Exception ex)
        {
            sw.Stop();
            Logger.Error("Script execution failed", ex);
            return new ScriptResult
            {
                Success = false,
                ErrorOutput = $"Execution failed: {ex.Message}",
                DurationMs = sw.ElapsedMilliseconds
            };
        }
    }

    private static string EscapeScript(string script)
    {
        // Escape double quotes for the command line
        return script.Replace("`", "``").Replace("\"", "`\"");
    }

    private static ScriptResult TruncateIfNeeded(ScriptResult result)
    {
        if (result.Output.Length > MaxOutputBytes)
        {
            result.Output = result.Output[..MaxOutputBytes] + "\n\n--- OUTPUT TRUNCATED (exceeded 512KB limit) ---";
            result.Truncated = true;
        }
        if (result.ErrorOutput.Length > MaxOutputBytes)
        {
            result.ErrorOutput = result.ErrorOutput[..MaxOutputBytes] + "\n\n--- ERROR OUTPUT TRUNCATED ---";
            result.Truncated = true;
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

    private static bool IsRunningElevated()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var principal = new System.Security.Principal.WindowsPrincipal(identity);
        return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
    }
}
