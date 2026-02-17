using System;
using System.Collections.Generic;
using System.Linq;
using System.ServiceProcess;
using System.Text.Json;
using System.Threading.Tasks;

namespace PocketIT.SystemTools.Tools;

public class ServiceListTool : ISystemTool
{
    public string ToolName => "service_list";

    public Task<SystemToolResult> ExecuteAsync(string? paramsJson)
    {
        try
        {
            string? filter = null;
            if (!string.IsNullOrEmpty(paramsJson))
            {
                using var doc = JsonDocument.Parse(paramsJson);
                if (doc.RootElement.TryGetProperty("filter", out var filterProp))
                    filter = filterProp.GetString();
            }

            var services = ServiceController.GetServices();
            var result = new List<object>();

            foreach (var svc in services)
            {
                var status = svc.Status.ToString();

                // Apply filter
                if (filter == "running" && svc.Status != ServiceControllerStatus.Running) continue;
                if (filter == "stopped" && svc.Status != ServiceControllerStatus.Stopped) continue;

                result.Add(new
                {
                    name = svc.ServiceName,
                    displayName = svc.DisplayName,
                    status = status,
                    startType = svc.StartType.ToString()
                });

                svc.Dispose();
            }

            var sorted = result.OrderBy(s => ((dynamic)s).displayName).ToList();

            return Task.FromResult(new SystemToolResult
            {
                Success = true,
                Data = new { services = sorted, count = sorted.Count }
            });
        }
        catch (Exception ex)
        {
            return Task.FromResult(new SystemToolResult { Success = false, Error = ex.Message });
        }
    }
}
