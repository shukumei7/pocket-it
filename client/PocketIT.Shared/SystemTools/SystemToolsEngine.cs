using System.Collections.Generic;
using System.Threading.Tasks;
using PocketIT.Core;
using PocketIT.SystemTools.Tools;

namespace PocketIT.SystemTools;

public class SystemToolsEngine
{
    private readonly Dictionary<string, ISystemTool> _tools = new();

    public SystemToolsEngine()
    {
        Register(new ProcessListTool());
        Register(new ProcessKillTool());
        Register(new ServiceListTool());
        Register(new ServiceActionTool());
        Register(new EventLogQueryTool());
    }

    private void Register(ISystemTool tool) => _tools[tool.ToolName] = tool;

    public async Task<SystemToolResult> ExecuteAsync(string toolName, string? paramsJson)
    {
        if (!_tools.TryGetValue(toolName, out var tool))
        {
            return new SystemToolResult { Success = false, Error = $"Unknown tool: {toolName}" };
        }

        try
        {
            return await tool.ExecuteAsync(paramsJson);
        }
        catch (System.Exception ex)
        {
            Logger.Error($"SystemTool '{toolName}' failed", ex);
            return new SystemToolResult { Success = false, Error = ex.Message };
        }
    }
}
