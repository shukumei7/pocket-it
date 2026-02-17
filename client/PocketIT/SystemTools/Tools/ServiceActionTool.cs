using System;
using System.ServiceProcess;
using System.Text.Json;
using System.Threading.Tasks;
using PocketIT.Core;

namespace PocketIT.SystemTools.Tools;

public class ServiceActionTool : ISystemTool
{
    public string ToolName => "service_action";

    public async Task<SystemToolResult> ExecuteAsync(string? paramsJson)
    {
        try
        {
            if (string.IsNullOrEmpty(paramsJson))
                return new SystemToolResult { Success = false, Error = "Missing params: serviceName, action required" };

            using var doc = JsonDocument.Parse(paramsJson);
            var root = doc.RootElement;

            var serviceName = root.GetProperty("serviceName").GetString() ?? "";
            var action = root.GetProperty("action").GetString() ?? "";

            if (string.IsNullOrEmpty(serviceName) || string.IsNullOrEmpty(action))
                return new SystemToolResult { Success = false, Error = "serviceName and action are required" };

            using var svc = new ServiceController(serviceName);
            var timeout = TimeSpan.FromSeconds(30);

            switch (action.ToLower())
            {
                case "start":
                    if (svc.Status == ServiceControllerStatus.Running)
                        return new SystemToolResult { Success = true, Data = new { serviceName, status = "Running", message = "Service is already running" } };
                    svc.Start();
                    await Task.Run(() => svc.WaitForStatus(ServiceControllerStatus.Running, timeout));
                    break;

                case "stop":
                    if (svc.Status == ServiceControllerStatus.Stopped)
                        return new SystemToolResult { Success = true, Data = new { serviceName, status = "Stopped", message = "Service is already stopped" } };
                    svc.Stop();
                    await Task.Run(() => svc.WaitForStatus(ServiceControllerStatus.Stopped, timeout));
                    break;

                case "restart":
                    if (svc.Status == ServiceControllerStatus.Running)
                    {
                        svc.Stop();
                        await Task.Run(() => svc.WaitForStatus(ServiceControllerStatus.Stopped, timeout));
                    }
                    svc.Start();
                    await Task.Run(() => svc.WaitForStatus(ServiceControllerStatus.Running, timeout));
                    break;

                default:
                    return new SystemToolResult { Success = false, Error = $"Unknown action: {action}. Use start, stop, or restart." };
            }

            svc.Refresh();
            Logger.Info($"Service action: {action} {serviceName} -> {svc.Status}");

            return new SystemToolResult
            {
                Success = true,
                Data = new { serviceName, status = svc.Status.ToString(), message = $"Service {serviceName} {action} completed" }
            };
        }
        catch (System.ServiceProcess.TimeoutException)
        {
            return new SystemToolResult { Success = false, Error = "Service operation timed out after 30 seconds" };
        }
        catch (InvalidOperationException ex)
        {
            return new SystemToolResult { Success = false, Error = $"Service operation failed: {ex.Message}" };
        }
        catch (Exception ex)
        {
            return new SystemToolResult { Success = false, Error = ex.Message };
        }
    }
}
