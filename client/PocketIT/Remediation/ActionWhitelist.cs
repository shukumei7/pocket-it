namespace PocketIT.Remediation;

public record RemediationInfo(string ActionId, string Name, string Description, string Risk);

public static class ActionWhitelist
{
    private static readonly Dictionary<string, RemediationInfo> _actions = new()
    {
        ["flush_dns"] = new RemediationInfo(
            "flush_dns",
            "Flush DNS Cache",
            "Clears the local DNS resolver cache. This can fix issues where websites aren't loading due to stale DNS entries.",
            "Low"
        ),
        ["clear_temp"] = new RemediationInfo(
            "clear_temp",
            "Clear Temporary Files",
            "Removes temporary files from your user temp folder to free up disk space.",
            "Low"
        )
    };

    public static bool IsAllowed(string actionId) => _actions.ContainsKey(actionId);

    public static RemediationInfo? GetInfo(string actionId) =>
        _actions.TryGetValue(actionId, out var info) ? info : null;

    public static IReadOnlyDictionary<string, RemediationInfo> GetAll() => _actions;
}
