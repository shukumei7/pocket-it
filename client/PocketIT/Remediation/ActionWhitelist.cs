namespace PocketIT.Remediation;

public record RemediationInfo(string ActionId, string Name, string Description, string Risk, bool CanAutoApprove = false);

public static class ActionWhitelist
{
    private static readonly Dictionary<string, RemediationInfo> _actions = new()
    {
        ["flush_dns"] = new RemediationInfo(
            "flush_dns",
            "Flush DNS Cache",
            "Clears the local DNS resolver cache. This can fix issues where websites aren't loading due to stale DNS entries.",
            "Low",
            CanAutoApprove: true
        ),
        ["clear_temp"] = new RemediationInfo(
            "clear_temp",
            "Clear Temporary Files",
            "Removes temporary files from your user temp folder to free up disk space.",
            "Low",
            CanAutoApprove: true
        ),
        ["restart_spooler"] = new RemediationInfo(
            "restart_spooler",
            "Restart Print Spooler",
            "Stops and restarts the Windows Print Spooler service. Fixes stuck print jobs and printer connectivity issues.",
            "Medium"
        ),
        ["repair_network"] = new RemediationInfo(
            "repair_network",
            "Repair Network Stack",
            "Resets Winsock, TCP/IP, flushes DNS, and renews IP address. Fixes most network connectivity issues. May require a restart.",
            "Medium"
        ),
        ["clear_browser_cache"] = new RemediationInfo(
            "clear_browser_cache",
            "Clear Browser Cache",
            "Removes cached files from Chrome, Edge, and Firefox. Fixes stale page loads and some website errors.",
            "Low",
            CanAutoApprove: true
        ),
        ["kill_process"] = new RemediationInfo(
            "kill_process",
            "Kill Process",
            "Terminates a specific process by its PID. Protected system processes are blocked.",
            "High"
        ),
        ["restart_service"] = new RemediationInfo(
            "restart_service",
            "Restart Service",
            "Stops and restarts a Windows service by name. Only whitelisted services are allowed.",
            "Medium"
        ),
        ["restart_explorer"] = new RemediationInfo(
            "restart_explorer",
            "Restart Windows Explorer",
            "Restarts explorer.exe to fix frozen taskbar, start menu, or file explorer windows.",
            "Medium"
        ),
        ["sfc_scan"] = new RemediationInfo(
            "sfc_scan",
            "System File Checker",
            "Runs SFC /scannow to detect and repair corrupted Windows system files. This may take several minutes.",
            "Medium"
        ),
        ["dism_repair"] = new RemediationInfo(
            "dism_repair",
            "DISM Image Repair",
            "Runs DISM /Online /Cleanup-Image /RestoreHealth to repair the Windows system image. This may take 10-15 minutes.",
            "Medium"
        ),
        ["clear_update_cache"] = new RemediationInfo(
            "clear_update_cache",
            "Clear Windows Update Cache",
            "Stops Windows Update service, clears the SoftwareDistribution folder, and restarts the service. Fixes stuck or failed updates.",
            "Medium"
        ),
        ["reset_network_adapter"] = new RemediationInfo(
            "reset_network_adapter",
            "Reset Network Adapter",
            "Disables and re-enables the primary network adapter. Fixes stuck or unresponsive network connections.",
            "Medium"
        )
    };

    public static bool IsAllowed(string actionId) => _actions.ContainsKey(actionId);

    public static RemediationInfo? GetInfo(string actionId) =>
        _actions.TryGetValue(actionId, out var info) ? info : null;

    public static IReadOnlyDictionary<string, RemediationInfo> GetAll() => _actions;
}
