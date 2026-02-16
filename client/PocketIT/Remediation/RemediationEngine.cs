using PocketIT.Core;

namespace PocketIT.Remediation;

public class RemediationEngine
{
    private readonly Dictionary<string, IRemediationAction> _actions = new();

    public RemediationEngine()
    {
        RegisterAction(new Actions.FlushDnsAction());
        RegisterAction(new Actions.ClearTempFilesAction());
        RegisterAction(new Actions.RestartSpoolerAction());
        RegisterAction(new Actions.RepairNetworkAction());
        RegisterAction(new Actions.ClearBrowserCacheAction());
        RegisterAction(new Actions.KillProcessAction());
        RegisterAction(new Actions.GenericRestartServiceAction());
    }

    private void RegisterAction(IRemediationAction action)
    {
        _actions[action.ActionId] = action;
    }

    public async Task<RemediationResult> ExecuteAsync(string actionId)
    {
        if (!_actions.TryGetValue(actionId, out var action))
        {
            return new RemediationResult { ActionId = actionId, Success = false, Message = $"Action '{actionId}' is not registered." };
        }

        if (action.RequiresElevation && !IsRunningElevated())
        {
            Logger.Warn($"Action '{actionId}' requires elevation but app is not running as admin");
            return new RemediationResult { ActionId = actionId, Success = false, Message = $"Action '{actionId}' requires administrator privileges. Please run Pocket IT as administrator." };
        }

        try
        {
            return await action.ExecuteAsync();
        }
        catch (Exception ex)
        {
            Logger.Error($"Remediation '{actionId}' failed", ex);
            return new RemediationResult { ActionId = actionId, Success = false, Message = $"Action failed: {ex.Message}" };
        }
    }

    public async Task<RemediationResult> ExecuteAsync(string actionId, string? parameter)
    {
        if (!_actions.TryGetValue(actionId, out var action))
        {
            return new RemediationResult { ActionId = actionId, Success = false, Message = $"Action '{actionId}' is not registered." };
        }

        if (action.RequiresParameter && string.IsNullOrWhiteSpace(parameter))
        {
            return new RemediationResult { ActionId = actionId, Success = false, Message = $"Action '{actionId}' requires a parameter: {action.ParameterLabel}" };
        }

        if (action.RequiresElevation && !IsRunningElevated())
        {
            Logger.Warn($"Action '{actionId}' requires elevation but app is not running as admin");
            return new RemediationResult { ActionId = actionId, Success = false, Message = $"Action '{actionId}' requires administrator privileges. Please run Pocket IT as administrator." };
        }

        try
        {
            if (!string.IsNullOrWhiteSpace(parameter))
                return await action.ExecuteAsync(parameter);
            return await action.ExecuteAsync();
        }
        catch (Exception ex)
        {
            Logger.Error($"Remediation '{actionId}' failed", ex);
            return new RemediationResult { ActionId = actionId, Success = false, Message = $"Action failed: {ex.Message}" };
        }
    }

    private static bool IsRunningElevated()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var principal = new System.Security.Principal.WindowsPrincipal(identity);
        return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
    }

    public RemediationInfo? GetActionInfo(string actionId) => ActionWhitelist.GetInfo(actionId);

    public bool IsRegistered(string actionId) => _actions.ContainsKey(actionId);
}
