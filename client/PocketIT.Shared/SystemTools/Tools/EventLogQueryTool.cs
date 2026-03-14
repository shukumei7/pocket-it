using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace PocketIT.SystemTools.Tools;

public class EventLogQueryTool : ISystemTool
{
    public string ToolName => "event_log_query";

    public Task<SystemToolResult> ExecuteAsync(string? paramsJson)
    {
        try
        {
            // Defaults
            string logName = "System";
            string level = "error"; // error, warning, information, critical
            int hours = 24;
            int maxEvents = 100;
            string? source = null;

            if (!string.IsNullOrEmpty(paramsJson))
            {
                using var doc = JsonDocument.Parse(paramsJson);
                var root = doc.RootElement;
                if (root.TryGetProperty("logName", out var lnProp)) logName = lnProp.GetString() ?? "System";
                if (root.TryGetProperty("level", out var lvProp)) level = lvProp.GetString() ?? "error";
                if (root.TryGetProperty("hours", out var hProp)) hours = hProp.GetInt32();
                if (root.TryGetProperty("maxEvents", out var meProp)) maxEvents = meProp.GetInt32();
                if (root.TryGetProperty("source", out var sProp)) source = sProp.GetString();
            }

            // Clamp
            if (hours < 1) hours = 1;
            if (hours > 168) hours = 168; // Max 7 days
            if (maxEvents < 1) maxEvents = 1;
            if (maxEvents > 500) maxEvents = 500;

            // Map level string to EventLogEntryType
            var levelTypes = new HashSet<EventLogEntryType>();
            foreach (var l in level.Split(','))
            {
                switch (l.Trim().ToLower())
                {
                    case "critical":
                    case "error":
                        levelTypes.Add(EventLogEntryType.Error);
                        break;
                    case "warning":
                        levelTypes.Add(EventLogEntryType.Warning);
                        break;
                    case "information":
                    case "info":
                        levelTypes.Add(EventLogEntryType.Information);
                        break;
                }
            }
            if (levelTypes.Count == 0) levelTypes.Add(EventLogEntryType.Error);

            var cutoff = DateTime.Now.AddHours(-hours);
            var events = new List<object>();

            using var eventLog = new EventLog(logName);
            // Read entries in reverse (newest first)
            for (int i = eventLog.Entries.Count - 1; i >= 0 && events.Count < maxEvents; i--)
            {
                try
                {
                    var entry = eventLog.Entries[i];
                    if (entry.TimeGenerated < cutoff) break; // Entries are chronological, stop when past cutoff

                    if (!levelTypes.Contains(entry.EntryType)) continue;
                    if (source != null && !entry.Source.Contains(source, StringComparison.OrdinalIgnoreCase)) continue;

                    events.Add(new
                    {
                        time = entry.TimeGenerated.ToString("o"),
                        level = entry.EntryType.ToString(),
                        source = entry.Source,
                        eventId = entry.InstanceId,
                        message = entry.Message.Length > 500 ? entry.Message[..500] + "..." : entry.Message
                    });
                }
                catch { continue; } // Skip inaccessible entries
            }

            return Task.FromResult(new SystemToolResult
            {
                Success = true,
                Data = new { events, count = events.Count, logName, level, hours, maxEvents }
            });
        }
        catch (Exception ex)
        {
            return Task.FromResult(new SystemToolResult { Success = false, Error = ex.Message });
        }
    }
}
