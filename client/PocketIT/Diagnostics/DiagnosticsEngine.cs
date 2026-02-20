namespace PocketIT.Diagnostics;

public class DiagnosticsEngine
{
    private readonly List<IDiagnosticCheck> _checks = new();

    public DiagnosticsEngine()
    {
        _checks.Add(new Checks.CpuCheck());
        _checks.Add(new Checks.MemoryCheck());
        _checks.Add(new Checks.DiskCheck());
        _checks.Add(new Checks.NetworkCheck());
        _checks.Add(new Checks.TopProcessesCheck());
        _checks.Add(new Checks.EventLogCheck());
        _checks.Add(new Checks.WindowsUpdateCheck());
        _checks.Add(new Checks.InstalledSoftwareCheck());
        _checks.Add(new Checks.ServicesCheck());
        _checks.Add(new Checks.SecurityCheck());
        _checks.Add(new Checks.BatteryCheck());
    }

    public async Task<List<DiagnosticResult>> RunAllAsync()
    {
        var results = new List<DiagnosticResult>();
        foreach (var check in _checks)
        {
            try
            {
                results.Add(await check.RunAsync());
            }
            catch (Exception ex)
            {
                results.Add(new DiagnosticResult
                {
                    CheckType = check.CheckType,
                    Status = "error",
                    Label = check.CheckType,
                    Value = $"Error: {ex.Message}"
                });
            }
        }
        return results;
    }

    public async Task<DiagnosticResult> RunCheckAsync(string checkType)
    {
        var check = _checks.FirstOrDefault(c => c.CheckType.Equals(checkType, StringComparison.OrdinalIgnoreCase));
        if (check == null)
        {
            return new DiagnosticResult
            {
                CheckType = checkType,
                Status = "error",
                Label = checkType,
                Value = "Unknown check type"
            };
        }
        return await check.RunAsync();
    }
}
