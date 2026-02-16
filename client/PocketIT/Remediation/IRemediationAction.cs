namespace PocketIT.Remediation;

public class RemediationResult
{
    public string ActionId { get; set; } = "";
    public bool Success { get; set; }
    public string Message { get; set; } = "";
}

public interface IRemediationAction
{
    string ActionId { get; }
    Task<RemediationResult> ExecuteAsync();
    bool RequiresElevation => false;
}
