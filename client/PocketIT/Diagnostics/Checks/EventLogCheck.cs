using System.Diagnostics;
using System.Text.RegularExpressions;
using PocketIT.Core;

namespace PocketIT.Diagnostics.Checks;

public class EventLogCheck : IDiagnosticCheck
{
    public string CheckType => "event_log";

    public async Task<DiagnosticResult> RunAsync()
    {
        try
        {
            var wevtutilPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wevtutil.exe");
            var entries = new List<Dictionary<string, object>>();

            // Query both System and Application logs
            foreach (var logName in new[] { "System", "Application" })
            {
                var query = $"*[System[TimeCreated[timediff(@SystemTime) <= 86400000] and (Level=1 or Level=2)]]";
                var info = new ProcessStartInfo(wevtutilPath, $"qe {logName} /q:\"{query}\" /c:10 /f:text")
                {
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                try
                {
                    using var process = Process.Start(info);
                    if (process != null)
                    {
                        var output = await process.StandardOutput.ReadToEndAsync();
                        await process.WaitForExitAsync();
                        ParseTextEntries(output, entries);
                    }
                }
                catch (Exception ex)
                {
                    Logger.Warn($"Event log check ({logName}): {ex.Message}");
                }
            }

            int criticals = entries.Count(e => e["level"].ToString() == "Critical");
            int errors = entries.Count(e => e["level"].ToString() == "Error");

            string status;
            if (criticals > 0)
                status = "error";
            else if (errors > 0)
                status = "warning";
            else
                status = "ok";

            string value;
            if (criticals == 0 && errors == 0)
                value = "Clean — no errors in last 24h";
            else
            {
                var parts = new List<string>();
                if (errors > 0) parts.Add($"{errors} error{(errors != 1 ? "s" : "")}");
                if (criticals > 0) parts.Add($"{criticals} critical");
                value = $"{string.Join(", ", parts)} in last 24h";
            }

            return new DiagnosticResult
            {
                CheckType = "event_log",
                Status = status,
                Label = "Event Log",
                Value = value,
                Details = new Dictionary<string, object>
                {
                    ["entries"] = entries,
                    ["criticals"] = criticals,
                    ["errors"] = errors
                }
            };
        }
        catch (Exception ex)
        {
            Logger.Warn($"Event log check failed: {ex.Message}");
            return new DiagnosticResult
            {
                CheckType = "event_log",
                Status = "error",
                Label = "Event Log",
                Value = "Unable to read event logs",
                Details = new Dictionary<string, object>
                {
                    ["error"] = ex.Message
                }
            };
        }
    }

    private static void ParseTextEntries(string output, List<Dictionary<string, object>> entries)
    {
        if (string.IsNullOrWhiteSpace(output))
            return;

        // wevtutil text format outputs blocks separated by blank lines
        // Each block has "Key: Value" lines
        var blocks = Regex.Split(output, @"\r?\n\r?\n");

        foreach (var block in blocks)
        {
            if (string.IsNullOrWhiteSpace(block))
                continue;

            var lines = block.Split('\n');
            string timestamp = "";
            string source = "";
            string level = "";
            string eventId = "";
            string message = "";

            foreach (var rawLine in lines)
            {
                var line = rawLine.Trim();
                if (line.StartsWith("Date:", StringComparison.OrdinalIgnoreCase))
                    timestamp = line.Substring(5).Trim();
                else if (line.StartsWith("Source:", StringComparison.OrdinalIgnoreCase))
                    source = line.Substring(7).Trim();
                else if (line.StartsWith("Level:", StringComparison.OrdinalIgnoreCase))
                {
                    var rawLevel = line.Substring(6).Trim();
                    level = rawLevel switch
                    {
                        "1" => "Critical",
                        "2" => "Error",
                        _ => MapLevelName(rawLevel)
                    };
                }
                else if (line.StartsWith("Event ID:", StringComparison.OrdinalIgnoreCase))
                    eventId = line.Substring(9).Trim();
                else if (line.StartsWith("Description:", StringComparison.OrdinalIgnoreCase))
                    message = line.Substring(12).Trim();
            }

            // Only add if we got at least a source or event ID
            if (!string.IsNullOrEmpty(source) || !string.IsNullOrEmpty(eventId))
            {
                entries.Add(new Dictionary<string, object>
                {
                    ["timestamp"] = timestamp,
                    ["source"] = source,
                    ["level"] = level,
                    ["eventId"] = eventId,
                    ["message"] = message
                });
            }
        }
    }

    private static string MapLevelName(string levelText)
    {
        return levelText.ToLowerInvariant() switch
        {
            "critical" => "Critical",
            "error" => "Error",
            _ => levelText
        };
    }
}
