namespace PocketIT.SystemTools;

public class SystemToolResult
{
    public bool Success { get; set; }
    public object? Data { get; set; }
    public string? Error { get; set; }
}

public interface ISystemTool
{
    string ToolName { get; }
    Task<SystemToolResult> ExecuteAsync(string? paramsJson);
}
