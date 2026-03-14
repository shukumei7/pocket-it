namespace PocketIT.Diagnostics;

public class DiagnosticResult
{
    public string CheckType { get; set; } = "";
    public string Status { get; set; } = "ok"; // ok, warning, error
    public string Label { get; set; } = "";
    public string Value { get; set; } = "";
    public Dictionary<string, object> Details { get; set; } = new();
}

public interface IDiagnosticCheck
{
    string CheckType { get; }
    Task<DiagnosticResult> RunAsync();
}
