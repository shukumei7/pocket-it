namespace PocketIT.Remediation;

public class RemediationEngine
{
    private readonly Dictionary<string, IRemediationAction> _actions = new();

    public RemediationEngine()
    {
        RegisterAction(new Actions.FlushDnsAction());
        RegisterAction(new Actions.ClearTempFilesAction());
    }

    private void RegisterAction(IRemediationAction action)
    {
        _actions[action.ActionId] = action;
    }

    public async Task<RemediationResult> ExecuteAsync(string actionId)
    {
        // Verify against whitelist
        if (!ActionWhitelist.IsAllowed(actionId))
        {
            return new RemediationResult
            {
                ActionId = actionId,
                Success = false,
                Message = $"Action '{actionId}' is not in the whitelist."
            };
        }

        if (!_actions.TryGetValue(actionId, out var action))
        {
            return new RemediationResult
            {
                ActionId = actionId,
                Success = false,
                Message = $"Action '{actionId}' is whitelisted but has no implementation."
            };
        }

        try
        {
            return await action.ExecuteAsync();
        }
        catch (Exception ex)
        {
            return new RemediationResult
            {
                ActionId = actionId,
                Success = false,
                Message = $"Action failed: {ex.Message}"
            };
        }
    }

    public RemediationInfo? GetActionInfo(string actionId) => ActionWhitelist.GetInfo(actionId);
}
