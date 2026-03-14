using System.Reflection;

namespace PocketIT.Core;

public static class AppVersion
{
    public static string Current { get; } = GetVersion();

    private static string GetVersion()
    {
        var attr = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>();
        var version = attr?.InformationalVersion ?? "0.0.0";
        // Strip any +metadata suffix (e.g. "0.11.0+sha.abc123")
        var plusIndex = version.IndexOf('+');
        return plusIndex >= 0 ? version[..plusIndex] : version;
    }
}
