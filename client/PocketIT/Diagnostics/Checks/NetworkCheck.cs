using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace PocketIT.Diagnostics.Checks;

public class NetworkCheck : IDiagnosticCheck
{
    public string CheckType => "network";

    public async Task<DiagnosticResult> RunAsync()
    {
        bool internetReachable = false;
        long pingMs = -1;
        bool dnsWorking = false;
        string adapterStatus = "Unknown";

        // Check network adapter
        try
        {
            var adapters = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up
                    && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .ToList();
            adapterStatus = adapters.Count > 0 ? $"{adapters.Count} adapter(s) up" : "No active adapters";
        }
        catch { }

        // Ping test
        try
        {
            using var ping = new Ping();
            var reply = await ping.SendPingAsync("8.8.8.8", 3000);
            if (reply.Status == IPStatus.Success)
            {
                internetReachable = true;
                pingMs = reply.RoundtripTime;
            }
        }
        catch { }

        // DNS test
        try
        {
            var addresses = await System.Net.Dns.GetHostAddressesAsync("google.com");
            dnsWorking = addresses.Length > 0;
        }
        catch { }

        string status;
        if (internetReachable && dnsWorking)
            status = pingMs > 200 ? "warning" : "ok";
        else if (internetReachable)
            status = "warning"; // Internet works but DNS issues
        else
            status = "error";

        string summary = status switch
        {
            "ok" => $"Connected ({pingMs}ms ping)",
            "warning" when !dnsWorking => "Internet OK but DNS issues detected",
            "warning" => $"Connected but slow ({pingMs}ms ping)",
            _ => "No internet connection"
        };

        return new DiagnosticResult
        {
            CheckType = "network",
            Status = status,
            Label = "Network",
            Value = summary,
            Details = new Dictionary<string, object>
            {
                ["internetReachable"] = internetReachable,
                ["pingMs"] = pingMs,
                ["dnsWorking"] = dnsWorking,
                ["adapterStatus"] = adapterStatus
            }
        };
    }
}
